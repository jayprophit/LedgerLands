import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createMatchState,
  replayCommands,
  TEAM_2V2_RULES,
  TEAM_2V2_V1,
  normalizeSeat,
  areTeammates,
  isOpponent,
  seatAlternatingTeams,
  solventMemberCount,
  teamIdOf,
  validateTeams,
} from "../src/index.js";
import type { MatchState, PlayerId, TeamState } from "@ledgerlands/shared-types";
import { FixtureDriver } from "./oracle/driver.js";
import { checkInvariants } from "./oracle/invariants.js";
import { eventsHash, stateHash } from "./oracle/canonical.js";

/**
 * The 2v2 test matrix from the design directive.
 *
 * Governing principle under test: **a player owns the economy, a team owns the
 * victory.** Almost every assertion here is a refusal to pool — balances stay
 * per-player, property stays with the buyer, and the only thing a team changes
 * is who is still standing.
 */

const TEAMS: TeamState[] = [
  { teamId: "alpha", memberIds: ["a1", "a2"], eliminated: false },
  { teamId: "bravo", memberIds: ["b1", "b2"], eliminated: false },
];

const ROSTER = [
  { id: "a1", name: "A1", balance: 30_000 },
  { id: "a2", name: "A2", balance: 30_000 },
  { id: "b1", name: "B1", balance: 30_000 },
  { id: "b2", name: "B2", balance: 30_000 },
];

function teamMatch(seed = 7001, roster = ROSTER, teams = TEAMS): FixtureDriver {
  const d = FixtureDriver.createTeams(roster, teams, seed, "team-matrix");
  d.run("system", { type: "START_MATCH" });
  return d;
}

/** Seat a specific player and put the match in ACTION phase. */
function actAs(d: FixtureDriver, playerId: PlayerId): void {
  const index = d.state.players.findIndex((p) => p.id === playerId);
  d.setCurrentPlayer(index);
  d.setTurnPhase("ACTION");
}

function grant(d: FixtureDriver, tileId: string, ownerId: PlayerId): void {
  d.seam(`grant ${tileId} to ${ownerId}`, (state) => {
    state.properties[tileId]!.ownerId = ownerId;
    state.properties[tileId]!.development = 0;
    state.properties[tileId]!.mortgaged = false;
  });
}

function balanceOf(d: FixtureDriver, playerId: PlayerId): number {
  return d.state.players.find((p) => p.id === playerId)!.balance;
}

function bankrupt(d: FixtureDriver, playerId: PlayerId): void {
  d.seam(`${playerId} is wiped out`, (state) => {
    const p = state.players.find((x) => x.id === playerId)!;
    p.bankrupt = true;
    p.balance = 0;
  });
}

describe("team setup and seating", () => {
  it("seats alternating teams, so no two consecutive seats share a team", () => {
    const d = FixtureDriver.createTeams(ROSTER, TEAMS, 1);
    const order = d.state.players.map((p) => p.id);
    expect(order).toEqual(["a1", "b1", "a2", "b2"]);
    for (let i = 1; i < order.length; i += 1) {
      expect(teamIdOf(d.state, order[i - 1]!)).not.toBe(teamIdOf(d.state, order[i]!));
    }
  });

  it("is deterministic regardless of roster order", () => {
    const shuffled = [ROSTER[2]!, ROSTER[0]!, ROSTER[3]!, ROSTER[1]!];
    const a = FixtureDriver.createTeams(ROSTER, TEAMS, 1).state.players.map((p) => p.id);
    const b = FixtureDriver.createTeams(shuffled, TEAMS, 1).state.players.map((p) => p.id);
    expect(b).toEqual(a);
    expect(seatAlternatingTeams(shuffled, TEAMS).map((p) => p.id)).toEqual(a);
  });

  it("records the mode, the teams and the rule set in authoritative state", () => {
    const state = teamMatch().state;
    expect(state.mode).toBe("TEAM_2V2");
    expect(state.rulesetVersion).toBe("team-v1");
    expect(state.teamRules).toEqual(TEAM_2V2_RULES);
    expect(state.teams?.map((t) => t.teamId).sort()).toEqual(["alpha", "bravo"]);
  });

  it("gives every player the full standard balance (D5), never a share", () => {
    const state = teamMatch().state;
    for (const p of state.players) expect(p.balance).toBe(30_000);
    // Two players per team, so a team holds twice a solo bankroll. Deliberate.
    const total = state.players.reduce((sum, p) => sum + p.balance, 0);
    expect(total).toBe(120_000);
  });

  it("refuses malformed team structures", () => {
    const base = { players: [], teams: TEAMS };
    expect(validateTeams({ ...base, teams: [] })).toEqual([
      { code: "TEAMS_TOO_FEW", detail: "a team match needs at least 2 teams, got 0" },
    ]);
    expect(validateTeams({ ...base, teams: [{ teamId: "t", memberIds: ["a1", "a2"], eliminated: false }] })).toEqual([
      { code: "TEAMS_TOO_FEW", detail: "a team match needs at least 2 teams, got 1" },
    ]);
    const doubleSeat = validateTeams({
      players: [{ id: "a1" }, { id: "a2" }, { id: "b1" }, { id: "a1" }] as never,
      teams: TEAMS,
    });
    expect(doubleSeat.some((i) => i.code === "UNSEATED")).toBe(true);
    expect(doubleSeat.some((i) => i.code === "DUPLICATE_PLAYER")).toBe(true);

    // A player claimed by two teams.
    const split = validateTeams({
      players: [{ id: "a1" }, { id: "a2" }, { id: "b1" }, { id: "a1" }] as never,
      teams: [
        { teamId: "alpha", memberIds: ["a1", "a2"], eliminated: false },
        { teamId: "bravo", memberIds: ["b1", "a1"], eliminated: false },
      ],
    });
    expect(split.some((i) => i.code === "PLAYER_ON_MULTIPLE_TEAMS")).toBe(true);

    // A team of the wrong size.
    expect(
      validateTeams({
        players: [{ id: "a1" }, { id: "a2" }, { id: "b1" }, { id: "b2" }] as never,
        teams: [
          { teamId: "alpha", memberIds: ["a1", "a2"], eliminated: false },
          { teamId: "bravo", memberIds: ["b1"], eliminated: false },
        ],
      }).some((i) => i.code === "TEAM_SIZE"),
    ).toBe(true);

    // The canonical alternating order is accepted with no issues at all.
    expect(
      validateTeams({
        players: [{ id: "a1" }, { id: "b1" }, { id: "a2" }, { id: "b2" }] as never,
        teams: TEAMS,
      }),
    ).toEqual([]);
  });

  it("rejects a player seated on the same team as their neighbour", () => {
    const state = createMatchState({
      id: "bad-seat",
      seed: 1,
      players: ROSTER,
      teams: [
        { teamId: "alpha", memberIds: ["a1", "a2"], eliminated: false },
        { teamId: "bravo", memberIds: ["b1", "b2"], eliminated: false },
      ],
      mode: "TEAM_2V2",
    });
    // Re-seat badly, bypassing the engine's own seating, and re-validate.
    const bad = {
      players: [state.players[0]!, state.players[2]!, state.players[1]!, state.players[3]!],
      teams: state.teams,
    };
    const issues = validateTeams(bad);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("treats everyone else as an opponent in individual play", () => {
    const solo = createMatchState({
      id: "solo",
      seed: 1,
      players: [
        { id: "p0", name: "P0" },
        { id: "p1", name: "P1" },
      ],
    });
    expect(isOpponent(solo, "p0", "p1")).toBe(true);
    expect(areTeammates(solo, "p0", "p1")).toBe(false);
    expect(areTeammates(solo, "p0", "p0")).toBe(false);
  });
});

describe("D1 — rent and teammate immunity", () => {
  it("charges an opponent full rent to the individual owner", () => {
    const d = teamMatch();
    grant(d, "copper-01", "a1");
    // Balances are read AFTER the wait: waiting lets earlier seats take real
    // turns, and they may legitimately spend along the way.
    expect(d.waitForTurn("b1")).toBe(true);
    const a1Before = balanceOf(d, "a1");
    const b1Before = balanceOf(d, "b1");
    expect(d.rollOnto("copper-01")).toBe(true);
    const passReward = d.lastPassReward();
    const rent = d.state.log.filter((e) => e.type === "RENT_PAID").at(-1);
    expect(rent).toBeDefined();
    if (!rent || rent.type !== "RENT_PAID") throw new Error("no rent charged");
    expect(rent.fromPlayerId).toBe("b1");
    expect(rent.toPlayerId).toBe("a1");
    expect(rent.amount).toBeGreaterThan(0);
    expect(balanceOf(d, "a1")).toBe(a1Before + rent.amount);
    // The payer may also have crossed the origin, so the pass reward is
    // accounted for explicitly rather than assumed away.
    expect(balanceOf(d, "b1")).toBe(b1Before - rent.amount + passReward);
  });

  it("charges a teammate nothing and records the exemption (D1)", () => {
    const d = teamMatch();
    grant(d, "copper-01", "a1");
    expect(d.waitForTurn("a2")).toBe(true);
    const a1Before = balanceOf(d, "a1");
    const a2Before = balanceOf(d, "a2");

    expect(d.rollOnto("copper-01")).toBe(true);
    const passReward = d.lastPassReward();

    const exempt = d.state.log.filter((e) => e.type === "TEAMMATE_RENT_EXEMPT").at(-1);
    expect(exempt).toBeDefined();
    if (!exempt || exempt.type !== "TEAMMATE_RENT_EXEMPT") throw new Error("no exemption recorded");
    expect(exempt.playerId).toBe("a2");
    expect(exempt.teammateId).toBe("a1");
    expect(exempt.teamId).toBe("alpha");
    expect(exempt.tileId).toBe("copper-01");
    // No rent moved: no RENT_PAID at all, and the only balance change is the
    // pass-start reward the roll happened to collect.
    expect(d.state.log.some((e) => e.type === "RENT_PAID")).toBe(false);
    expect(balanceOf(d, "a1")).toBe(a1Before);
    expect(balanceOf(d, "a2")).toBe(a2Before + passReward);
  });

  it("still charges monopoly rent to opponents and exempts teammates", () => {
    const d = teamMatch(7002);
    for (const id of ["copper-01", "copper-02", "copper-03"]) grant(d, id, "a1");
    expect(d.waitForTurn("b1")).toBe(true);
    expect(d.rollOnto("copper-02")).toBe(true);
    expect(d.state.log.some((e) => e.type === "RENT_PAID")).toBe(true);
    expect(d.state.log.some((e) => e.type === "TEAMMATE_RENT_EXEMPT")).toBe(false);

    const d2 = teamMatch(7003);
    for (const id of ["copper-01", "copper-02", "copper-03"]) grant(d2, id, "a1");
    expect(d2.waitForTurn("a2")).toBe(true);
    expect(d2.rollOnto("copper-02")).toBe(true);
    expect(d2.state.log.some((e) => e.type === "TEAMMATE_RENT_EXEMPT")).toBe(true);
    expect(d2.state.log.some((e) => e.type === "RENT_PAID")).toBe(false);
  });

  it("exempts a teammate on transit and service too", () => {
    const d = teamMatch(7004);
    grant(d, "transit-01", "a1");
    expect(d.waitForTurn("a2")).toBe(true);
    expect(d.rollOnto("transit-01")).toBe(true);
    expect(d.state.log.some((e) => e.type === "TEAMMATE_RENT_EXEMPT")).toBe(true);
  });
});

describe("D1/D5 — the economy stays individual", () => {
  it("keeps purchase, mortgage and development on the individual player", () => {
    const d = teamMatch(7010);
    d.waitForTurn("a1");
    expect(d.rollOnto("copper-01")).toBe(true);
    expect(d.buyCurrent()).toBe(true);
    expect(d.state.properties["copper-01"]!.ownerId).toBe("a1");
    expect(d.state.players.find((p) => p.id === "a2")!.balance).toBe(30_000);

    // Teammate must not be able to act on the partner's tile.
    actAs(d, "a2");
    expect(d.tryRun("a2", { type: "MORTGAGE_PROPERTY", playerId: "a2", tileId: "copper-01" })).toBe(false);
    expect(d.tryRun("a2", { type: "DEVELOP_PROPERTY", playerId: "a2", tileId: "copper-01" })).toBe(false);
    expect(d.state.properties["copper-01"]!.ownerId).toBe("a1");

    actAs(d, "a1");
    expect(d.mortgage("copper-01")).toBe(true);
    expect(d.state.properties["copper-01"]!.mortgaged).toBe(true);
    expect(d.unmortgage("copper-01")).toBe(true);
    expect(d.state.properties["copper-01"]!.mortgaged).toBe(false);
  });

  it("develops only for the owner, and only with the full group", () => {
    const d = teamMatch(7011);
    for (const id of ["copper-01", "copper-02", "copper-03"]) grant(d, id, "a1");
    actAs(d, "a1");
    // Partial group: refused.
    d.seam("a1 gives up copper-03", (state) => {
      delete state.properties["copper-03"]!.ownerId;
    });
    expect(d.develop("copper-01")).toBe(false);
    grant(d, "copper-03", "a1");
    expect(d.developEvenly(["copper-01", "copper-02", "copper-03"], 1)).toBe(3);
    expect(d.state.properties["copper-01"]!.development).toBe(1);
    expect(d.state.properties["copper-02"]!.development).toBe(1);
    expect(d.state.properties["copper-03"]!.development).toBe(1);
    // The teammate cannot develop the partner's buildings.
    actAs(d, "a2");
    expect(d.develop("copper-01")).toBe(false);
  });
});

describe("D4 — auctions and trades are individual, teammates included", () => {
  it("lets a teammate bid in a public auction (D4)", () => {
    const d = teamMatch(7020);
    actAs(d, "a1");
    expect(d.tryRun("a1", { type: "START_AUCTION", playerId: "a1", tileId: "gold-03" })).toBe(true);
    // The teammate bids as themselves, at their own funds.
    expect(d.tryRun("a2", { type: "PLACE_BID", playerId: "a2", amount: 2_000 })).toBe(true);
    expect(d.tryRun("b1", { type: "PLACE_BID", playerId: "b1", amount: 3_000 })).toBe(true);
    expect(d.state.auction?.bids).toEqual([
      { playerId: "a2", amount: 2_000 },
      { playerId: "b1", amount: 3_000 },
    ]);
    expect(d.tryRun("a2", { type: "COMPLETE_AUCTION", playerId: "a2" })).toBe(true);
    // The highest bidder, an opponent, wins it.
    expect(d.state.properties["gold-03"]!.ownerId).toBe("b1");
  });

  it("settles a teammate win into that teammate's own wallet, not a team pool", () => {
    const d = teamMatch(7021);
    actAs(d, "a1");
    d.tryRun("a1", { type: "START_AUCTION", playerId: "a1", tileId: "gold-03" });
    d.tryRun("a2", { type: "PLACE_BID", playerId: "a2", amount: 2_000 });
    d.tryRun("a2", { type: "COMPLETE_AUCTION", playerId: "a2" });
    const a2 = d.state.players.find((p) => p.id === "a2")!;
    const a1 = d.state.players.find((p) => p.id === "a1")!;
    expect(d.state.properties["gold-03"]!.ownerId).toBe("a2");
    expect(a2.balance).toBe(30_000 - 2_000);
    expect(a1.balance).toBe(30_000);
  });

  it("permits a teammate trade through the ordinary propose/accept path (D4)", () => {
    const d = teamMatch(7022);
    grant(d, "copper-01", "a1");
    const before = { a1: 30_000, a2: 30_000 };
    expect(
      d.tryRun("a1", {
        type: "PROPOSE_TRADE",
        playerId: "a1",
        toPlayerId: "a2",
        offer: { propertyIds: ["copper-01"] },
        request: { sats: 1_000 },
      }),
    ).toBe(true);
    const trade = d.state.trades?.at(-1);
    expect(trade?.status).toBe("PROPOSED");
    expect(d.tryRun("a2", { type: "ACCEPT_TRADE", playerId: "a2", tradeId: trade!.id })).toBe(true);
    // Authoritative settlement: property and sats move individually.
    expect(d.state.properties["copper-01"]!.ownerId).toBe("a2");
    expect(d.state.players.find((p) => p.id === "a1")!.balance).toBe(before.a1 + 1_000);
    expect(d.state.players.find((p) => p.id === "a2")!.balance).toBe(before.a2 - 1_000);
  });

  it("permits an opponent trade on the same terms", () => {
    const d = teamMatch(7023);
    grant(d, "copper-01", "a1");
    expect(
      d.tryRun("a1", {
        type: "PROPOSE_TRADE",
        playerId: "a1",
        toPlayerId: "b1",
        offer: { propertyIds: ["copper-01"] },
        request: { sats: 2_000 },
      }),
    ).toBe(true);
    const trade = d.state.trades?.at(-1);
    expect(d.tryRun("b1", { type: "ACCEPT_TRADE", playerId: "b1", tradeId: trade!.id })).toBe(true);
    expect(d.state.properties["copper-01"]!.ownerId).toBe("b1");
  });

  it("still refuses a self-trade and a trade of property the proposer does not own", () => {
    const d = teamMatch(7024);
    expect(
      d.tryRun("a1", {
        type: "PROPOSE_TRADE",
        playerId: "a1",
        toPlayerId: "a1",
        offer: { sats: 10 },
        request: {},
      }),
    ).toBe(false);
    expect(
      d.tryRun("a1", {
        type: "PROPOSE_TRADE",
        playerId: "a1",
        toPlayerId: "a2",
        offer: { propertyIds: ["copper-01"] },
        request: { sats: 10 },
      }),
    ).toBe(false);
  });
});

describe("D2/D3", () => {
  it("keeps the team alive when one member is bankrupt (D2)", () => {
    const d = teamMatch(7030);
    d.bankrupt("a1");
    const alpha = d.state.teams!.find((t) => t.teamId === "alpha")!;
    expect(alpha.eliminated).toBe(false);
    expect(solventMemberCount(d.state, alpha)).toBe(1);
    expect(d.state.status).toBe("ACTIVE");
    // The partner can still take a real turn.
    expect(d.waitForTurn("a2")).toBe(true);
    expect(d.rollOnto("copper-01")).toBe(true);
  });

  it("eliminates the team only when every member is bankrupt (D2)", () => {
    const d = teamMatch(7031);
    d.bankrupt("a1");
    expect(d.state.teams!.find((t) => t.teamId === "alpha")!.eliminated).toBe(false);

    grant(d, "gold-01", "b1");
    expect(d.waitForTurn("a2")).toBe(true);
    d.seam("a2 cannot cover gold rent", (state) => {
      state.players.find((p) => p.id === "a2")!.balance = 5;
    });
    expect(d.rollOnto("gold-01")).toBe(true);

    expect(d.state.players.find((p) => p.id === "a2")!.bankrupt).toBe(true);
    const alpha = d.state.teams!.find((t) => t.teamId === "alpha")!;
    expect(alpha.eliminated).toBe(true);
    expect(alpha.eliminatedAtRevision).toBeGreaterThan(0);
    const event = d.state.log.filter((e) => e.type === "TEAM_ELIMINATED").at(-1);
    expect(event).toBeDefined();
    if (event && event.type === "TEAM_ELIMINATED") expect(event.teamId).toBe("alpha");
    // Bravo is still standing, so it wins.
    expect(d.state.status).toBe("COMPLETED");
    expect(d.state.winnerTeamId).toBe("bravo");
  });

  it("declares the opposing team the winner once a team is out (D3)", () => {
    const d = teamMatch(7032);
    grant(d, "gold-01", "b1");
    d.bankrupt("a1");
    expect(d.waitForTurn("a2")).toBe(true);
    d.seam("a2 cannot cover gold rent", (state) => {
      state.players.find((p) => p.id === "a2")!.balance = 5;
    });
    expect(d.rollOnto("gold-01")).toBe(true);

    expect(d.state.teams!.find((t) => t.teamId === "alpha")!.eliminated).toBe(true);
    expect(d.state.teams!.find((t) => t.teamId === "bravo")!.eliminated).toBe(false);
    expect(d.state.status).toBe("COMPLETED");
    expect(d.state.winnerTeamId).toBe("bravo");
    const completed = d.state.log.filter((e) => e.type === "MATCH_COMPLETED").at(-1);
    expect(completed).toBeDefined();
    if (completed && completed.type === "MATCH_COMPLETED") {
      expect(completed.winnerTeamId).toBe("bravo");
      // No individual winner in a team match.
      expect(completed.winnerId).toBeUndefined();
    }
  });

  it("does not hand a bankrupt player's estate to their teammate (D2)", () => {
    const d = teamMatch(7033);
    grant(d, "copper-01", "a1");
    grant(d, "gold-01", "b1");
    const a2Before = balanceOf(d, "a2");
    expect(d.waitForTurn("a1")).toBe(true);
    d.seam("a1 owes gold rent it cannot pay", (state) => {
      state.players.find((p) => p.id === "a1")!.balance = 5;
    });
    expect(d.rollOnto("gold-01")).toBe(true);

    expect(d.state.players.find((p) => p.id === "a1")!.bankrupt).toBe(true);
    // The estate goes to the creditor that was owed, not to the teammate.
    expect(d.state.properties["copper-01"]!.ownerId).toBe("b1");
    expect(d.state.players.find((p) => p.id === "a2")!.balance).toBe(a2Before);
  });

  it("returns an uncollected estate to the bank when there is no creditor (D2)", () => {
    const d = teamMatch(7034);
    grant(d, "copper-01", "a1");
    d.jailPlayer("a1", 0);
    d.seam("a1 has one turn of detention left and cannot pay", (state) => {
      const p = state.players.find((x) => x.id === "a1")!;
      p.balance = 5;
      p.detentionTurns = 2; // maxDetentionTurns is 3, so this roll charges the fine
    });
    // Serving the turn charges the fine automatically, and 5 < 50 goes negative.
    expect(d.rollOnto("copper-01") || d.tryRun("a1", { type: "ROLL_DICE" })).toBe(true);
    expect(d.state.players.find((p) => p.id === "a1")!.bankrupt).toBe(true);
    expect(d.state.log.some((e) => e.type === "DETENTION_FINE_PAID")).toBe(true);
    expect(d.state.properties["copper-01"]!.ownerId).toBeUndefined();
    expect(d.state.properties["copper-01"]!.development).toBe(0);
  });

  it("closes a team match even if every player is eliminated (D3)", () => {
    const d = teamMatch(7035);
    for (const id of ["a1", "a2", "b1", "b2"]) d.bankrupt(id);
    // Nobody is solvent, so the match must close on the restore path rather
    // than strand the current player with no legal command. That is exactly
    // what `PersistentMatchStore` does after a rebuild.
    const restored = normalizeSeat(d.state);
    expect(restored.status).toBe("COMPLETED");
    expect(restored.winnerTeamId).toBeUndefined();
    const completed = restored.log.filter((e) => e.type === "MATCH_COMPLETED").at(-1);
    expect(completed).toBeDefined();
    if (completed && completed.type === "MATCH_COMPLETED") {
      expect(completed.winnerId).toBeUndefined();
      expect(completed.winnerTeamId).toBeUndefined();
    }
  });

  it("keeps playing while a team still has a solvent member (D3)", () => {
    const d = teamMatch(7036);
    d.bankrupt("a1");
    expect(d.state.status).toBe("ACTIVE");
    for (let i = 0; i < 8 && d.state.status === "ACTIVE"; i += 1) d.advanceOneTurn();
    // a2 is still in the match and still solvent.
    expect(d.state.players.find((p) => p.id === "a2")!.bankrupt).toBe(false);
    expect(d.state.teams!.find((t) => t.teamId === "alpha")!.eliminated).toBe(false);
  });
});

describe("individual mechanics still behave in team mode", () => {
  it("jails, charges a fine, and uses a pardon chip per player", () => {
    const d = teamMatch(7040);
    d.jailPlayer("a1", 1);
    expect(d.serveJailTurn("a1", "pay")).toBe(true);
    expect(d.state.log.some((e) => e.type === "DETENTION_FINE_PAID" && e.playerId === "a1")).toBe(true);

    const d2 = teamMatch(7041);
    d2.jailPlayer("b2", 1);
    expect(d2.serveJailTurn("b2", "card")).toBe(true);
    expect(d2.state.log.some((e) => e.type === "DETENTION_CARD_USED" && e.playerId === "b2")).toBe(true);
  });

  it("draws and applies cards per player", () => {
    const d = teamMatch(7042);
    for (let i = 0; i < 400 && d.state.status === "ACTIVE"; i += 1) d.advanceOneTurn();
    expect(d.state.log.some((e) => e.type === "CARD_DRAWN")).toBe(true);
    // Cards move money between individuals, never between teams.
    for (const e of d.state.log) {
      if (e.type === "RENT_PAID") {
        expect(areTeammates(d.state, e.fromPlayerId, e.toPlayerId)).toBe(false);
      }
    }
  });

  it("surrenders one player without ending a team match on its own", () => {
    const d = teamMatch(7043);
    actAs(d, "a1");
    expect(d.surrender()).toBe(true);
    expect(d.state.log.some((e) => e.type === "PLAYER_SURRENDERED")).toBe(true);
    // Alpha still has a2, so the match continues.
    expect(d.state.teams!.find((t) => t.teamId === "alpha")!.eliminated).toBe(false);
    expect(d.state.status).toBe("ACTIVE");
  });

  it("holds every invariant the individual-mode oracle enforces", () => {
    for (const seed of [7050, 7051, 7052, 7053]) {
      const d = FixtureDriver.createTeams(ROSTER, TEAMS, seed, `team-inv-${seed}`);
      d.run("system", { type: "START_MATCH" });
      for (let i = 0; i < 300 && d.state.status === "ACTIVE"; i += 1) d.advanceOneTurn();
      const violations = checkInvariants(d.state);
      expect(violations, `seed ${seed}: ${violations.map((v) => `${v.invariant}/${v.detail}`).join("; ")}`).toEqual([]);
    }
  });
});

describe("replay, determinism and persistence in team mode", () => {
  it("replays a team match to an identical state and event stream", () => {
    const d = FixtureDriver.createTeams(ROSTER, TEAMS, 7060, "team-replay");
    d.run("system", { type: "START_MATCH" });
    for (let i = 0; i < 120 && d.state.status === "ACTIVE"; i += 1) d.advanceOneTurn();

    const rebuilt = replayCommands(structuredClone(d.initial), d.commands.map((c) => c.command));
    expect(stateHash(rebuilt)).toBe(stateHash(d.state));
    expect(eventsHash(rebuilt.log)).toBe(eventsHash(d.state.log));
    expect(rebuilt).toEqual(d.state);
  });

  it("is deterministic across runs with the same seed and seating", () => {
    const run = () => {
      const d = FixtureDriver.createTeams(ROSTER, TEAMS, 7061, "team-determinism");
      d.run("system", { type: "START_MATCH" });
      for (let i = 0; i < 100 && d.state.status === "ACTIVE"; i += 1) d.advanceOneTurn();
      return d.state;
    };
    const a = run();
    const b = run();
    expect(stateHash(b)).toBe(stateHash(a));
    expect(eventsHash(b.log)).toBe(eventsHash(a.log));
  });

  it("serialises a team match through the store contract and rebuilds it", async () => {
    const { MemoryBackend, PersistentMatchStore } = await import("@ledgerlands/match-store");
    const d = FixtureDriver.createTeams(ROSTER, TEAMS, 7062, "team-store");
    d.run("system", { type: "START_MATCH" });
    for (let i = 0; i < 60 && d.state.status === "ACTIVE"; i += 1) d.advanceOneTurn();

    const backend = new MemoryBackend();
    await backend.save("team-store", {
      initial: d.initial,
      commands: d.commands.map((c) => ({
        command: c.command,
        commandId: `cmd-${c.resultRevision}`,
        actorPlayerId: c.actorId,
        at: "2026-01-01T00:00:00.000Z",
        resultRevision: c.resultRevision,
      })),
      snapshots: [],
      corrections: [],
      seenCommandIds: d.commands.map((c) => `cmd-${c.resultRevision}`),
      botDifficulty: "NORMAL",
      solo: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      meta: { status: d.state.status, stateRevision: d.state.revision, totalCommands: d.commands.length },
    });

    // Resume: a fresh store over the same backend must reproduce the live state.
    const store = new PersistentMatchStore(backend);
    const resumed = await store.get("team-store");
    expect(resumed).toBeDefined();
    expect(resumed!.mode).toBe("TEAM_2V2");
    expect(resumed!.teams?.map((t) => t.teamId).sort()).toEqual(["alpha", "bravo"]);
    expect(resumed!.rulesetVersion).toBe("team-v1");
    expect(resumed!.teamRules).toEqual(TEAM_2V2_RULES);
    expect(stateHash(resumed as MatchState)).toBe(stateHash(d.state));
  });
});

describe("the team rule set is a versioned mode, not a flag", () => {
  it("keeps team rules absent from every individual ruleset", () => {
    expect(TEAM_2V2_V1.teamRules).toBeDefined();
    expect(TEAM_2V2_V1.version).toBe("team-v1");
    // Individual play is byte-identical to before teams existed.
    const state = createMatchState({
      id: "classic",
      seed: 1,
      players: [
        { id: "p0", name: "P0" },
        { id: "p1", name: "P1" },
      ],
    });
    expect(state.mode).toBeUndefined();
    expect(state.teams).toBeUndefined();
    expect(state.teamRules).toBeUndefined();
    expect(state.rulesetVersion).toBe("classic-v1");
  });

  it("states every team decision explicitly", () => {
    expect(TEAM_2V2_RULES).toEqual({
      economy: "INDIVIDUAL",
      propertyOwnership: "INDIVIDUAL",
      teammateRent: "EXEMPT",
      bankruptcy: "INDIVIDUAL",
      elimination: "ALL_MEMBERS",
      victory: "LAST_SOLVENT_TEAM",
      auctionParticipation: "INDIVIDUAL",
      teammateTrading: "ALLOWED",
      startingBalance: "STANDARD_PER_PLAYER",
    });
  });
});
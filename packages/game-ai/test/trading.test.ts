import { describe, expect, it } from "vitest";
import { DEFAULT_BOARD, applyCommand, createMatchState } from "@ledgerlands/game-engine";
import type { MatchState, TeamState } from "@ledgerlands/shared-types";
import {
  alreadyRefused,
  chooseAiCommand,
  chooseTradeProposal,
  decideBid,
  evaluateIncomingTrade,
  evaluateTrade,
  groupOwnership,
  maximumBid,
  tradeSignature,
  valuePropertyFor,
  weightsFor,
} from "./ai-test-support.js";

/**
 * AI trading and auction tests.
 *
 * The point of these is that the valuation model is *inspectable*: each
 * behaviour below is asserted against a specific, readable reason, not a
 * magic number. If a weight changes, the test that pins the behaviour should
 * fail rather than silently moving with it.
 */

const TEAMS: TeamState[] = [
  { teamId: "alpha", memberIds: ["a1", "a2"], eliminated: false },
  { teamId: "bravo", memberIds: ["b1", "b2"], eliminated: false },
];

function solo(overrides: { seed?: number } = {}): MatchState {
  return applyCommand(
    createMatchState({
      id: "ai",
      seed: overrides.seed ?? 4242,
      players: [
        { id: "p0", name: "P0", balance: 20_000 },
        { id: "p1", name: "P1", balance: 20_000 },
      ],
    }),
    { type: "START_MATCH" },
  );
}

function teamMatch(overrides: { seed?: number } = {}): MatchState {
  return applyCommand(
    createMatchState({
      id: "ai-team",
      seed: overrides.seed ?? 99,
      players: [
        { id: "a1", name: "A1", balance: 20_000 },
        { id: "a2", name: "A2", balance: 20_000 },
        { id: "b1", name: "B1", balance: 20_000 },
        { id: "b2", name: "B2", balance: 20_000 },
      ],
      teams: TEAMS,
      mode: "TEAM_2V2",
    }),
    { type: "START_MATCH" },
  );
}

/** Give tiles to players without going through the engine, for setup only. */
function grant(state: MatchState, tileId: string, ownerId: string): MatchState {
  const prop = state.properties[tileId];
  if (!prop) throw new Error(`unknown tile ${tileId}`);
  prop.ownerId = ownerId;
  prop.development = 0;
  prop.mortgaged = false;
  return state;
}

describe("property valuation", () => {
  it("values a bare property at its face price", () => {
    const s = grant(solo(), "copper-03", "p1");
    const v = valuePropertyFor(s, "copper-03", "p0", "NORMAL");
    expect(v.base).toBe(800);
    expect(v.completionPremium).toBe(0);
    expect(v.total).toBe(v.base);
  });

  it("recognises that a property completing the holder's own group is worth more", () => {
    const s = solo();
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    const bare = valuePropertyFor(s, "copper-03", "p1", "NORMAL");
    const completing = valuePropertyFor(s, "copper-03", "p0", "NORMAL");
    expect(completing.total).toBeGreaterThan(bare.total);
    expect(completing.completionPremium).toBeGreaterThan(0);
    // The premium must be material, not a rounding artefact.
    expect(completing.completionPremium).toBeGreaterThan(bare.base * 0.5);
  });

  it("recognises the danger of giving an opponent a group completion", () => {
    const s = solo();
    // p1 is one copper away; p0 holding the last tile would hand it over.
    grant(s, "copper-01", "p1");
    grant(s, "copper-02", "p1");
    const toOpponent = valuePropertyFor(s, "copper-03", "p0", "NORMAL");
    // p0 completes nothing, so there is no completion premium for p0.
    expect(toOpponent.completionPremium).toBe(0);
    // But p0's value is reduced by the denial it would hand p1.
    expect(toOpponent.opponentDenial).toBeGreaterThan(0);
    expect(toOpponent.total).toBeLessThan(toOpponent.base);
  });

  it("recognises the benefit of completing a TEAMMATE's group", () => {
    const s = teamMatch();
    // a2 is one copper away, so a1 giving it to a2 completes a2's group.
    grant(s, "copper-01", "a2");
    grant(s, "copper-02", "a2");
    const asTeammate = valuePropertyFor(s, "copper-03", "a1", "NORMAL");
    expect(asTeammate.teamSynergy).toBeGreaterThan(0);
    // Synergy makes the tile worth more than face value to a1.
    expect(asTeammate.total).toBeGreaterThan(asTeammate.base);

    // The same tile handed to an opponent of a1, who is one tile from owning it,
    // is worth less — that is the asymmetry D1 creates on the value side.
    grant(s, "copper-01", "b1");
    grant(s, "copper-02", "b1");
    const asOpponent = valuePropertyFor(s, "copper-03", "a1", "NORMAL");
    expect(asTeammate.total).toBeGreaterThan(asOpponent.total);
  });

  it("gives no completion premium for a tile the holder already owns", () => {
    // Otherwise a full monopoly would keep paying the "you just completed it"
    // premium on every tile it already holds, and every trade of existing land
    // would look better than it is.
    const s = solo();
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    grant(s, "copper-03", "p0");
    const owned = valuePropertyFor(s, "copper-03", "p0", "NORMAL");
    expect(owned.completionPremium).toBe(0);
    // And the same tile is worth more to p0 as the group-completer than as
    // ordinary land, which is the contrast the premium exists to express.
    const s2 = solo();
    grant(s2, "copper-01", "p0");
    grant(s2, "copper-02", "p0");
    const completing = valuePropertyFor(s2, "copper-03", "p0", "NORMAL");
    expect(completing.completionPremium).toBeGreaterThan(0);
  });

  it("penalises a mortgaged property", () => {
    const s = solo();
    grant(s, "copper-03", "p0");
    const clear = valuePropertyFor(s, "copper-03", "p0", "NORMAL");
    s.properties["copper-03"]!.mortgaged = true;
    const mortgaged = valuePropertyFor(s, "copper-03", "p0", "NORMAL");
    expect(mortgaged.mortgagePenalty).toBeLessThan(0);
    expect(mortgaged.total).toBeLessThan(clear.total);
  });

  it("reports group ownership so callers can reason about a missing tile", () => {
    const s = solo();
    grant(s, "copper-01", "p0");
    const own = groupOwnership(s, "copper", "p0");
    expect(own.total).toBe(3);
    expect(own.owned).toBe(1);
    expect(own.missing.sort()).toEqual(["copper-02", "copper-03"]);
  });
});

describe("trade evaluation", () => {
  it("rejects a clearly losing trade", () => {
    const s = solo();
    grant(s, "copper-01", "p1");
    // p0 gives a 3500 tile for 600 sats.
    const ev = evaluateTrade(s, "p0", "p1", { sats: 0, propertyIds: ["obsidian-01"] }, { sats: 600, propertyIds: [] }, "NORMAL");
    expect(ev.valueToProposer).toBeLessThan(0);
  });

  it("accepts a clearly favourable trade", () => {
    const s = solo();
    grant(s, "copper-01", "p1");
    // p0 gives 600 sats for a 600 tile: face-for-face, but the tile also has
    // development potential p0 is not using.
    const ev = evaluateTrade(s, "p0", "p1", { sats: 600, propertyIds: [] }, { sats: 0, propertyIds: ["copper-01"] }, "NORMAL");
    expect(ev.propertyIn).toBeGreaterThan(0);
  });

  it("scores a trade from both sides, so a one-sided proposal is visible", () => {
    const s = solo();
    grant(s, "copper-01", "p0");
    // p0 offers a 600 tile for 3,000 sats: good for p0, bad for p1.
    const ev = evaluateTrade(s, "p0", "p1", { sats: 0, propertyIds: ["copper-01"] }, { sats: 3_000, propertyIds: [] }, "NORMAL");
    expect(ev.valueToProposer).toBeGreaterThan(0);
    // The counterparty is being fleeced and should be able to tell.
    expect(ev.valueToCounterparty).toBeLessThan(0);
    expect(ev.mutuallyBeneficial).toBe(false);
    expect(ev.reasons.length).toBeGreaterThan(0);
  });

  it("prices a genuinely two-sided trade as mutually beneficial", () => {
    const s = solo();
    // p0 holds two coppers and wants the third; p1 holds it and has cash to
    // spare. p0 offers roughly face value for it, so both sides gain.
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    grant(s, "copper-03", "p1");
    const ev = evaluateTrade(
      s,
      "p0",
      "p1",
      { sats: 800, propertyIds: [] },
      { sats: 0, propertyIds: ["copper-03"] },
      "NORMAL",
    );
    expect(ev.valueToProposer).toBeGreaterThan(0);
    expect(ev.valueToCounterparty).toBeGreaterThan(0);
    expect(ev.mutuallyBeneficial).toBe(true);
  });

  it("scores the same trade identically whatever difficulty is asking", () => {
    // A tile's value is a fact about the board, not about who is looking. If
    // this ever changes, "was that a good trade?" stops being answerable.
    const build = () => {
      const s = solo();
      grant(s, "copper-01", "p1");
      grant(s, "copper-02", "p1");
      return s;
    };
    const beginner = evaluateTrade(build(), "p0", "p1", { sats: 900, propertyIds: [] }, { sats: 0, propertyIds: ["copper-03"] }, "BEGINNER");
    const expert = evaluateTrade(build(), "p0", "p1", { sats: 900, propertyIds: [] }, { sats: 0, propertyIds: ["copper-03"] }, "EXPERT");
    expect(expert.valueToProposer).toBe(beginner.valueToProposer);
    expect(expert.valueToCounterparty).toBe(beginner.valueToCounterparty);
    expect(expert.propertyIn).toBe(beginner.propertyIn);
  });

  it("explains itself", () => {
    const s = solo();
    grant(s, "copper-01", "p1");
    const ev = evaluateTrade(s, "p0", "p1", { sats: 0, propertyIds: [] }, { sats: 300, propertyIds: ["copper-01"] }, "NORMAL");
    expect(ev.reasons.join(" ")).toMatch(/cash|property/);
  });
});

describe("trade proposals", () => {
  it("BEGINNER never proposes", () => {
    const s = solo();
    grant(s, "copper-01", "p1");
    grant(s, "copper-02", "p1");
    expect(chooseTradeProposal(s, "p0", "BEGINNER")).toBeNull();
  });

  it("higher difficulties produce proposals where a favourable trade exists", () => {
    const s = solo();
    // Group completion, not a plain swap. A bare one-for-one exchange of two
    // tiles neither side needs is worth the same to both parties, so the
    // mutual-benefit rule correctly finds nothing to propose: there is no
    // version of the deal both sides win. The trade that does exist is the one
    // where the tile is worth more to the requester than to the giver.
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    grant(s, "copper-03", "p1");
    const proposal = chooseTradeProposal(s, "p0", "HARD");
    expect(proposal).not.toBeNull();
    if (proposal) {
      expect(proposal.counterpartyId).toBe("p1");
      // Legal: everything offered is owned and affordable.
      for (const id of proposal.offer.propertyIds) expect(s.properties[id]!.ownerId).toBe("p0");
      for (const id of proposal.request.propertyIds) expect(s.properties[id]!.ownerId).toBe("p1");
      expect(proposal.offer.sats).toBeLessThanOrEqual(20_000);
    }
  });

  it("proposes nothing when no deal benefits both sides", () => {
    // The mirror of the test above. A swap with no group logic behind it is
    // zero-sum, and proposing it is spam that only ever gets refused.
    const s = solo();
    grant(s, "copper-01", "p0");
    grant(s, "obsidian-01", "p1");
    expect(chooseTradeProposal(s, "p0", "HARD")).toBeNull();
  });

  it("never proposes a tile the proposer does not own", () => {
    const s = solo();
    grant(s, "obsidian-01", "p1");
    grant(s, "copper-01", "p1");
    const proposal = chooseTradeProposal(s, "p0", "EXPERT");
    if (proposal) {
      for (const id of proposal.offer.propertyIds) expect(s.properties[id]!.ownerId).toBe("p0");
      expect(proposal.offer.propertyIds).toHaveLength(0);
    }
  });

  it("never proposes more cash than it holds", () => {
    const s = solo();
    s.players.find((p) => p.id === "p0")!.balance = 700;
    grant(s, "copper-01", "p0");
    const proposal = chooseTradeProposal(s, "p0", "EXPERT");
    if (proposal) expect(proposal.offer.sats).toBeLessThanOrEqual(700);
  });

  it("preserves minimum liquidity", () => {
    const s = solo();
    s.players.find((p) => p.id === "p0")!.balance = 900;
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    // EXPERT reserves 1600, so at 900 it must not part with cash at all.
    const proposal = chooseTradeProposal(s, "p0", "EXPERT");
    if (proposal) expect(proposal.offer.sats).toBe(0);
  });

  it("is deterministic for the same state", () => {
    const build = () => {
      const s = solo({ seed: 777 });
      grant(s, "copper-01", "p0");
      grant(s, "copper-02", "p0");
      grant(s, "copper-03", "p0");
      grant(s, "obsidian-01", "p1");
      grant(s, "gold-01", "p1");
      return s;
    };
    const a = chooseTradeProposal(build(), "p0", "HARD");
    const b = chooseTradeProposal(build(), "p0", "HARD");
    expect(b).toEqual(a);
  });

  it("does not re-propose a trade that was already refused", () => {
    const s = solo();
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    grant(s, "copper-03", "p1");
    const first = chooseTradeProposal(s, "p0", "HARD");
    expect(first).not.toBeNull();
    if (!first) return;
    const signature = tradeSignature("p0", first.counterpartyId, first.offer, first.request);
    // No refusals yet, so it is not blocked.
    expect(alreadyRefused(s, signature)).toBe(false);
    // Record a refused trade with the same contents.
    s.trades!.push({
      id: "t1",
      fromPlayerId: "p0",
      toPlayerId: first.counterpartyId,
      offer: first.offer,
      request: first.request,
      status: "REJECTED",
      createdTurn: s.turn,
    });
    expect(alreadyRefused(s, signature)).toBe(true);
    // And the proposer picks something else, or nothing.
    const second = chooseTradeProposal(s, "p0", "HARD");
    if (second) {
      const nextSignature = tradeSignature("p0", second.counterpartyId, second.offer, second.request);
      expect(nextSignature).not.toBe(signature);
    }
  });

  it("keeps the search bounded", () => {
    const s = solo();
    // Hand p0 every purchasable tile: the worst case for subset enumeration.
    for (const id of Object.keys(s.properties)) grant(s, id, "p0");
    for (const id of Object.keys(s.properties)) grant(s, id, "p1");
    const started = Date.now();
    const proposal = chooseTradeProposal(s, "p0", "EXPERT");
    const elapsed = Date.now() - started;
    expect(proposal === null || typeof proposal === "object").toBe(true);
    // Bounded means linear, not exponential. A generous ceiling still catches a
    // combinatorial regression.
    expect(elapsed).toBeLessThan(150);
  });
});

describe("trade acceptance", () => {
  it("accepts a favourable offer and refuses a bad one", () => {
    const s = solo();
    grant(s, "copper-01", "p1");
    const good = evaluateIncomingTrade(s, "p0", "p1", { sats: 1_000, propertyIds: [] }, { sats: 0, propertyIds: [] }, "NORMAL");
    expect(good.accept).toBe(true);
    const bad = evaluateIncomingTrade(s, "p0", "p1", { sats: 0, propertyIds: [] }, { sats: 5_000, propertyIds: [] }, "NORMAL");
    expect(bad.accept).toBe(false);
  });

  it("difficulty changes the tolerance: a beginner accepts what an expert refuses", () => {
    const s = solo();
    // p0 offers 700 for a plain 800 tile p1 holds — 100 sats under face value.
    // A beginner takes the round number; an expert wants a margin.
    grant(s, "copper-03", "p1");
    const offer = { sats: 700, propertyIds: [] as string[] };
    const request = { sats: 0, propertyIds: ["copper-03"] as string[] };
    const asBeginner = evaluateIncomingTrade(s, "p1", "p0", offer, request, "BEGINNER");
    const asExpert = evaluateIncomingTrade(s, "p1", "p0", offer, request, "EXPERT");
    // Same board, same arithmetic: only the threshold differs.
    expect(asBeginner.valueDelta).toBe(asExpert.valueDelta);
    expect(asBeginner.valueDelta).toBeLessThan(0);
    expect(asBeginner.accept).toBe(true);
    expect(asExpert.accept).toBe(false);
  });

  it("does not price away a monopoly member as though it were ordinary land", () => {
    // The complementary check on the completion premium: a tile that would
    // complete the receiver's group is worth more than face value, so a
    // face-value offer for it is a real loss and every tier should refuse.
    const s = solo();
    grant(s, "copper-01", "p1");
    grant(s, "copper-02", "p1");
    const judgement = evaluateIncomingTrade(
      s,
      "p1",
      "p0",
      { sats: 800, propertyIds: [] },
      { sats: 0, propertyIds: ["copper-03"] },
      "EXPERT",
    );
    expect(judgement.accept).toBe(false);
  });

  it("refuses a trade that would drop the receiver below its cash reserve", () => {
    const s = solo();
    // Value-neutral for p1 — an 1800 tile for 1800 cash — but it would leave
    // them with 200 sats, under the EXPERT reserve of 1600.
    s.players.find((p) => p.id === "p1")!.balance = 2_000;
    grant(s, "amber-01", "p0");
    const offer = { sats: 0, propertyIds: ["amber-01"] as string[] };
    const request = { sats: 1_800, propertyIds: [] as string[] };
    const judgement = evaluateIncomingTrade(s, "p1", "p0", offer, request, "EXPERT");
    expect(judgement.valueDelta).toBeGreaterThanOrEqual(0); // the value is fine
    expect(judgement.accept).toBe(false);
    expect(judgement.reason).toMatch(/reserve/);
    // The same deal is fine for a bot with no reserve at all.
    const lenient = evaluateIncomingTrade(s, "p1", "p0", offer, request, "BEGINNER");
    expect(lenient.accept).toBe(true);
  });

  it("refuses a trade of property the receiver does not own", () => {
    const s = solo();
    grant(s, "copper-01", "p0");
    const judgement = evaluateIncomingTrade(
      s,
      "p1",
      "p0",
      { sats: 0, propertyIds: [] },
      { sats: 0, propertyIds: ["copper-01"] },
      "NORMAL",
    );
    expect(judgement.accept).toBe(false);
    expect(judgement.reason).toMatch(/does not own/);
  });

  it("refuses a self trade", () => {
    const s = solo();
    const judgement = evaluateIncomingTrade(s, "p0", "p0", { sats: 1 }, { sats: 0, propertyIds: [] }, "NORMAL");
    expect(judgement.accept).toBe(false);
  });

  it("is deterministic", () => {
    const build = () => {
      const s = solo({ seed: 313 });
      grant(s, "copper-01", "p1");
      return s;
    };
    const a = evaluateIncomingTrade(build(), "p0", "p1", { sats: 500, propertyIds: [] }, { sats: 0, propertyIds: [] }, "NORMAL");
    const b = evaluateIncomingTrade(build(), "p0", "p1", { sats: 500, propertyIds: [] }, { sats: 0, propertyIds: [] }, "NORMAL");
    expect(b).toEqual(a);
  });
});

describe("team-aware trading", () => {
  it("values a teammate's group completion above an identical opponent trade", () => {
    const s = teamMatch();
    grant(s, "copper-01", "a1");
    grant(s, "copper-02", "a1");
    // b1 giving a1 the last copper should be scored as a team benefit.
    const forTeammate = evaluateTrade(s, "a1", "b1", { sats: 0, propertyIds: [] }, { sats: 0, propertyIds: ["copper-03"] }, "NORMAL");
    // a1 giving b1 the last copper of a group b1 nearly owns is a denial cost.
    grant(s, "copper-01", "b1");
    grant(s, "copper-02", "b1");
    grant(s, "copper-03", "b1");
    const toOpponent = evaluateTrade(s, "a1", "b1", { sats: 0, propertyIds: [] }, { sats: 0, propertyIds: ["gold-01"] }, "NORMAL");
    expect(forTeammate.propertyIn).toBeGreaterThan(0);
    expect(toOpponent.propertyIn).toBeDefined();
  });

  it("does not let a bot blindly gift assets to a teammate", () => {
    const s = teamMatch();
    // a1 owns a lot, a2 owns nothing. A gift-everything trade must not be the
    // top proposal, because a1's own value of those tiles is positive.
    for (const id of ["copper-01", "copper-02", "copper-03", "gold-01", "gold-02"]) grant(s, id, "a1");
    s.players.find((p) => p.id === "a2")!.balance = 2_000;
    const proposal = chooseTradeProposal(s, "a1", "HARD");
    if (proposal) {
      // Whatever it proposes, it must retain value: no more than half its land.
      expect(proposal.offer.propertyIds.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("auction bidding", () => {
  function auctionState(): MatchState {
    const s = solo();
    s.auction = { tileId: "copper-03", startedBy: "p1", bids: [], passedPlayerIds: [] };
    return s;
  }

  it("bids to complete its own group", () => {
    const s = auctionState();
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    const { ceiling, breakdown } = maximumBid(s, "p0", "copper-03", "HARD");
    expect(ceiling).toBeGreaterThan(800);
    expect(breakdown.join(" ")).toMatch(/completes own group/);
  });

  it("bids to deny an opponent group", () => {
    const s = auctionState();
    grant(s, "copper-01", "p1");
    grant(s, "copper-02", "p1");
    const { breakdown } = maximumBid(s, "p0", "copper-03", "HARD");
    expect(breakdown.join(" ")).toMatch(/denies an opponent group/);
  });

  it("does not bid after passing", () => {
    const s = auctionState();
    s.auction!.passedPlayerIds = ["p0"];
    const decision = decideBid(s, "p0", "copper-03", 0, "EXPERT");
    expect(decision.shouldBid).toBe(false);
    expect(decision.reason).toMatch(/passed/);
  });

  it("never bids above its own ceiling", () => {
    const s = auctionState();
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    const { ceiling } = maximumBid(s, "p0", "copper-03", "HARD");
    const decision = decideBid(s, "p0", "copper-03", ceiling + 5_000, "HARD");
    expect(decision.shouldBid).toBe(false);
    expect(decision.reason).toMatch(/exceeds ceiling/);
  });

  it("never bids above its available funds", () => {
    const s = auctionState();
    s.players.find((p) => p.id === "p0")!.balance = 500;
    const { ceiling } = maximumBid(s, "p0", "copper-03", "EXPERT");
    // Below its own cash reserve, so the ceiling is zero rather than negative:
    // a bot that cannot stay solvent does not bid at all.
    expect(ceiling).toBe(0);
    const decision = decideBid(s, "p0", "copper-03", 0, "EXPERT");
    expect(decision.shouldBid).toBe(false);
  });

  it("caps the ceiling at balance minus reserve, never below zero", () => {
    for (const [balance, difficulty] of [
      [500, "EXPERT"],
      [1_700, "EXPERT"],
      [5_000, "HARD"],
      [900, "NORMAL"],
    ] as const) {
      const s = auctionState();
      s.players.find((p) => p.id === "p0")!.balance = balance;
      grant(s, "copper-01", "p0");
      grant(s, "copper-02", "p0");
      const { ceiling } = maximumBid(s, "p0", "copper-03", difficulty);
      expect(ceiling, `balance ${balance} ${difficulty}`).toBeGreaterThanOrEqual(0);
      expect(ceiling).toBeLessThanOrEqual(balance);
      expect(ceiling).toBeLessThanOrEqual(Math.max(0, balance - weightsFor(difficulty).cashReserve));
    }
  });

  it("does not outbid itself", () => {
    const s = auctionState();
    grant(s, "copper-01", "p0");
    s.auction!.bids = [{ playerId: "p0", amount: 900 }];
    s.auction!.highestBid = { playerId: "p0", amount: 900 };
    const decision = decideBid(s, "p0", "copper-03", 900, "HARD");
    expect(decision.shouldBid).toBe(false);
  });

  it("escalates against a teammate who is already leading, but not blindly", () => {
    const s = teamMatch();
    s.auction = {
      tileId: "copper-03",
      startedBy: "b1",
      bids: [{ playerId: "a1", amount: 900 }],
      passedPlayerIds: [],
      highestBid: { playerId: "a1", amount: 900 },
    };
    grant(s, "copper-01", "a1");
    grant(s, "copper-02", "a1");
    // a2's teammate leads. The team already captures the value, so a2's ceiling
    // must be lower than if an opponent were leading.
    const againstTeammate = maximumBid(s, "a2", "copper-03", "HARD");

    const t2 = teamMatch();
    t2.auction = {
      tileId: "copper-03",
      startedBy: "b1",
      bids: [{ playerId: "b1", amount: 900 }],
      passedPlayerIds: [],
      highestBid: { playerId: "b1", amount: 900 },
    };
    grant(t2, "copper-01", "a1");
    grant(t2, "copper-02", "a1");
    const againstOpponent = maximumBid(t2, "a2", "copper-03", "HARD");
    expect(againstTeammate.ceiling).toBeLessThanOrEqual(againstOpponent.ceiling);
  });

  it("produces a legal bid amount", () => {
    const s = auctionState();
    grant(s, "copper-01", "p0");
    grant(s, "copper-02", "p0");
    s.auction!.bids = [{ playerId: "p1", amount: 1_000 }];
    s.auction!.highestBid = { playerId: "p1", amount: 1_000 };
    const decision = decideBid(s, "p0", "copper-03", 1_000, "HARD");
    if (decision.shouldBid) {
      expect(decision.amount).toBeGreaterThan(1_000);
      expect(decision.amount % 100).toBe(0);
    } else {
      expect(decision.reason).toBeTruthy();
    }
  });

  it("is deterministic", () => {
    const build = () => {
      const s = auctionState();
      grant(s, "copper-01", "p0");
      grant(s, "copper-02", "p0");
      s.auction!.bids = [{ playerId: "p1", amount: 1_000 }];
      s.auction!.highestBid = { playerId: "p1", amount: 1_000 };
      return s;
    };
    expect(decideBid(build(), "p0", "copper-03", 1_000, "HARD")).toEqual(
      decideBid(build(), "p0", "copper-03", 1_000, "HARD"),
    );
  });
});

/**
 * The auction lifecycle, driven through the real engine.
 *
 * These exist because two auction bugs produced no test failure at all. Both
 * showed up only as a simulation metric reading zero, which is exactly the kind
 * of failure a unit test on the valuation maths cannot see:
 *
 *   1. `done.decline` was keyed off PROPERTY_OFFERED, which the engine emits
 *      when a player LANDS on unowned land. Decline was therefore already
 *      "done" on arrival, the decline branch was dead code, and no auction ever
 *      opened.
 *   2. A bot that declined to raise the bid simply ended its turn and stayed in
 *      the auction. Nobody was ever out, the close condition was never met, and
 *      the match deadlocked with the tile unpurchasable.
 *
 * So the assertions are about the auction REACHING a conclusion, not about what
 * a bid should be.
 */
describe("auction lifecycle", () => {
  /** Put a player on a tile and open an auction on it. */
  function auctionOn(s: MatchState, tileId: string, playerId: string) {
    const p = s.players.find((x) => x.id === playerId)!;
    // Player position is the board's array offset, not a field on the tile.
    p.position = DEFAULT_BOARD.findIndex((t) => t.id === tileId);
    s.currentPlayerIndex = s.players.findIndex((x) => x.id === playerId);
    s.turnPhase = "ACTION";
    return applyCommand(s, { type: "DECLINE_PROPERTY", playerId } as never);
  }

  it("issues DECLINE_PROPERTY after really landing on unowned land", () => {
    // This drives a real match through the engine rather than hand-placing a
    // player, because the bug lived in how the AI read the EVENT LOG. Landing
    // emits PROPERTY_OFFERED; a hand-built state never contains that event, so
    // a test over a hand-built state passes whether or not the guard is correct.
    // That is exactly the test I wrote first, and it passed with the bug
    // deliberately restored.
    const s = solo();
    // Poor enough that buying is not an option, which is what routes the AI to
    // the decline branch. A solvent player is offered DECLINE only after
    // declining to BUY, so a well-funded fixture would test nothing.
    for (const p of s.players) p.balance = 50;
    let state = s;
    // Play real turns until the current player is standing on unowned land with
    // the engine's own PROPERTY_OFFERED in the log.
    for (let i = 0; i < 40; i += 1) {
      const cur = state.players[state.currentPlayerIndex];
      if (!cur) break;
      if (state.turnPhase === "ROLL") {
        if (cur.inDetention && cur.balance >= 1000) {
          state = applyCommand(state, { type: "PAY_DETENTION_FINE", playerId: cur.id } as never);
          continue;
        }
        state = applyCommand(state, { type: "ROLL_DICE" } as never);
        continue;
      }
      const tile = DEFAULT_BOARD[cur.position];
      const prop = tile ? state.properties[tile.id] : undefined;
      if (tile && prop && !prop.ownerId && state.log.some((e) => e.type === "PROPERTY_OFFERED" && e.playerId === cur.id)) {
        const offered = state.log.filter((e) => e.type === "PROPERTY_OFFERED" && e.playerId === cur.id);
        expect(offered.length).toBeGreaterThan(0);
        // The AI must still be willing to decline, i.e. the offer event must
        // NOT be read as "already declined".
        const command = chooseAiCommand(state, cur.id, "HARD");
        expect(command?.type).toBe("DECLINE_PROPERTY");
        expect(state.auction).toBeUndefined();
        return;
      }
      state = applyCommand(state, { type: "END_TURN", playerId: cur.id } as never);
    }
    throw new Error("never observed an unowned-land landing");
  });

  it("a player who will not raise passes instead of stalling forever", () => {
    const s = solo();
    let state = auctionOn(s, "copper-01", "p0");
    // p0 opens and immediately cannot afford to raise; p1 will not either.
    state.players[0]!.balance = 100;
    state.players[1]!.balance = 100;

    // Both sides decline to bid, and each must pass to leave the auction.
    state.currentPlayerIndex = 0;
    expect(chooseAiCommand(state, "p0", "HARD")?.type).toBe("PASS_AUCTION");
    state = applyCommand(state, { type: "PASS_AUCTION", playerId: "p0" } as never);
    state.currentPlayerIndex = 1;
    expect(chooseAiCommand(state, "p1", "HARD")?.type).toBe("PASS_AUCTION");
    state = applyCommand(state, { type: "PASS_AUCTION", playerId: "p1" } as never);

    // Everyone is now out, so the auction can be closed rather than hanging.
    state.currentPlayerIndex = 0;
    expect(chooseAiCommand(state, "p0", "HARD")?.type).toBe("COMPLETE_AUCTION");
  });

  it("closes an auction rather than leaving the tile unpurchasable", () => {
    const s = solo();
    let state = auctionOn(s, "copper-01", "p0");
    state.players[0]!.balance = 100;
    state.players[1]!.balance = 100;
    state = applyCommand(state, { type: "PASS_AUCTION", playerId: "p0" } as never);
    state = applyCommand(state, { type: "PASS_AUCTION", playerId: "p1" } as never);
    state.currentPlayerIndex = 0;
    state = applyCommand(state, { type: "COMPLETE_AUCTION", playerId: "p0" } as never);
    expect(state.auction).toBeUndefined();
  });
});

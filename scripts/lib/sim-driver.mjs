/**
 * Shared simulation driver for the economy experiments.
 *
 * Both `simulate.mjs` and the team-economy experiment play matches the same way:
 * four bots on the standard board, the AI choosing a command when it can and a
 * mechanical policy otherwise. Keeping the driver in one place means the FFA and
 * TEAM_2V2 arms of any comparison differ only in the team rules, which is the
 * only way a paired comparison means anything.
 *
 * Metrics are computed from the finished `MatchState` and its event log. Nothing
 * here reaches into engine internals, and every number is derivable from the
 * same data a replay export would contain.
 */

import { applyCommand, createMatchState, DEFAULT_BOARD } from "../../packages/game-engine/dist/index.js";
import { chooseAiCommand } from "../../packages/game-ai/dist/index.js";

export const PLAYER_IDS = ["p0", "p1", "p2", "p3"];

export const FFA_TEAMS = null;
export const TEAM_2V2_TEAMS = [
  { teamId: "red", memberIds: ["p0", "p1"], eliminated: false },
  { teamId: "blue", memberIds: ["p2", "p3"], eliminated: false },
];

export function playMatch({ seed, teams, difficulty = "NORMAL", startingBalance = 30_000, safety = 1200 }) {
  const players = PLAYER_IDS.map((id) => ({ id, name: id, balance: startingBalance }));
  let state = createMatchState(
    teams ? { id: `sim-${seed}`, seed, players, teams, mode: "TEAM_2V2" } : { id: `sim-${seed}`, seed, players },
  );
  state = applyCommand(state, { type: "START_MATCH" });

  // Counted, never swallowed. An earlier version of this driver discarded AI
  // failures with an empty catch, which hid an AI whose every DEVELOP_PROPERTY
  // was illegal: the simulation ran, produced plausible numbers, and the
  // development step simply never happened. Illegal commands are a bug in the
  // AI and the metric makes them impossible to miss.
  const diagnostics = { aiCommands: 0, aiRejected: 0, aiByType: {}, rejectedByType: {}, steps: 0 };

  let steps = 0;
  while (state.status === "ACTIVE" && steps++ < safety) {
    const cur = state.players[state.currentPlayerIndex];
    if (!cur || cur.bankrupt) break;

    // The AI speaks first and only through real commands. It may decline; the
    // mechanical policy below is the floor that guarantees progress.
    const ai = chooseAiCommand(state, cur.id, difficulty);
    if (ai) {
      diagnostics.aiCommands += 1;
      diagnostics.aiByType[ai.type] = (diagnostics.aiByType[ai.type] ?? 0) + 1;
      try {
        state = applyCommand(state, ai);
        continue;
      } catch (error) {
        diagnostics.aiRejected += 1;
        diagnostics.rejectedByType[ai.type] = (diagnostics.rejectedByType[ai.type] ?? 0) + 1;
        void error;
      }
    }

    if (state.turnPhase === "ROLL") {
      if (cur.inDetention && cur.balance >= 1000) {
        try {
          state = applyCommand(state, { type: "PAY_DETENTION_FINE", playerId: cur.id });
          continue;
        } catch {}
      }
      try {
        state = applyCommand(state, { type: "ROLL_DICE" });
      } catch {
        break;
      }
      continue;
    }

    const tile = DEFAULT_BOARD[cur.position];
    const prop = tile ? state.properties[tile.id] : undefined;
    const price = tile?.economics?.purchasePrice ?? tile?.amount ?? 0;
    if (tile && prop && !prop.ownerId && price > 0 && cur.balance - price >= 2000) {
      try {
        state = applyCommand(state, { type: "BUY_PROPERTY", playerId: cur.id, tileId: tile.id });
        continue;
      } catch {}
    } else if (tile && prop && !prop.ownerId && price > 0 && state.auction === undefined) {
      try {
        state = applyCommand(state, { type: "DECLINE_PROPERTY", playerId: cur.id });
        try {
          state = applyCommand(state, { type: "PLACE_BID", playerId: cur.id, amount: Math.min(price, cur.balance) });
        } catch {}
        try {
          state = applyCommand(state, { type: "COMPLETE_AUCTION", playerId: cur.id });
        } catch {}
      } catch {}
    }
    try {
      state = applyCommand(state, { type: "END_TURN", playerId: cur.id });
    } catch {
      break;
    }
  }
  diagnostics.steps = steps;
  return { state, diagnostics };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const round = (n, d = 2) => +n.toFixed(d);

export function summarise(label, states) {
  const completed = states.filter((s) => s.status === "COMPLETED");
  const turns = states.map((s) => s.turn);

  const of = (fn) => states.flatMap((s) => s.log.filter(fn));
  const bankrupts = of((e) => e.type === "PLAYER_BANKRUPT");
  const surrenders = of((e) => e.type === "PLAYER_SURRENDERED");
  const rents = of((e) => e.type === "RENT_PAID");
  const exemptions = of((e) => e.type === "TEAMMATE_RENT_EXEMPT");
  const proposed = of((e) => e.type === "TRADE_PROPOSED");
  const accepted = of((e) => e.type === "TRADE_ACCEPTED");
  const rejected = of((e) => e.type === "TRADE_REJECTED");
  const auctionStarted = of((e) => e.type === "AUCTION_STARTED");
  const auctionDone = of((e) => e.type === "AUCTION_COMPLETED");
  const auctionBids = of((e) => e.type === "AUCTION_BID");
  const cards = of((e) => e.type === "CARD_DRAWN");

  // Trade cash and property movement, taken from ACCEPTED trades only.
  let tradeCash = 0;
  let tradeProperties = 0;
  for (const s of states) {
    for (const t of s.trades ?? []) {
      if (t.status !== "ACCEPTED") continue;
      tradeCash += (t.offer.sats ?? 0) + (t.request.sats ?? 0);
      tradeProperties += (t.offer.propertyIds?.length ?? 0) + (t.request.propertyIds?.length ?? 0);
    }
  }

  // Teammate vs opponent trades, resolved by looking each accepted trade up in
  // its match. The event log carries ids, not the relationship.
  const tradeKinds = [];
  for (const s of states) {
    for (const t of s.trades ?? []) {
      if (t.status !== "ACCEPTED") continue;
      const sameTeam = s.teams?.some(
        (team) => team.memberIds.includes(t.fromPlayerId) && team.memberIds.includes(t.toPlayerId),
      );
      tradeKinds.push(sameTeam ? "teammate" : "opponent");
    }
  }

  const concentrations = states.map((s) => topHolderShare(s));
  const winners = {};
  for (const s of completed) {
    const key = s.winnerTeamId ?? s.winnerId ?? "none";
    winners[key] = (winners[key] ?? 0) + 1;
  }

  return {
    label,
    games: states.length,
    completed: completed.length,
    completionRate: round(completed.length / states.length, 4),
    avgTurns: round(mean(turns), 1),
    medianTurns: median(turns),
    bankruptciesPerGame: round(bankrupts.length / states.length, 3),
    surrendersPerGame: round(surrenders.length / states.length, 3),
    rentPerGame: round(rents.length / states.length, 2),
    avgRent: Math.round(mean(rents.map((e) => e.amount))),
    teammateRentExemptions: exemptions.length,
    exemptionsPerGame: round(exemptions.length / states.length, 2),
    tradeProposals: proposed.length,
    tradeProposalsPerGame: round(proposed.length / states.length, 2),
    tradeAcceptances: accepted.length,
    tradeAcceptRate: proposed.length ? round(accepted.length / proposed.length, 4) : 0,
    tradeRejections: rejected.length,
    teammateTrades: tradeKinds.filter((k) => k === "teammate").length,
    opponentTrades: tradeKinds.filter((k) => k === "opponent").length,
    cashThroughTrades: tradeCash,
    cashThroughTradesPerGame: Math.round(tradeCash / states.length),
    propertiesThroughTrades: tradeProperties,
    auctionsStarted: auctionStarted.length,
    auctionsCompleted: auctionDone.length,
    auctionBids: auctionBids.length,
    bidsPerAuction: auctionDone.length ? round(auctionBids.length / auctionDone.length, 2) : 0,
    cardsDrawn: cards.length,
    avgTopHolderShare: round(mean(concentrations), 3),
    maxTopHolderShare: concentrations.length ? round(Math.max(...concentrations), 3) : 0,
    winners,
  };
}

function topHolderShare(state) {
  const owned = Object.values(state.properties).filter((p) => p.ownerId);
  if (owned.length === 0) return 0;
  const byOwner = new Map();
  for (const p of owned) byOwner.set(p.ownerId, (byOwner.get(p.ownerId) ?? 0) + 1);
  return Math.max(...byOwner.values()) / owned.length;
}

/**
 * Team-concentration and degenerate-strategy metrics.
 *
 * These exist to answer the directive's actual question: not "how do we stop
 * teammates cooperating" - cooperation is intended - but "does the cooperation
 * the rules permit create degenerate or exploitable strategy?" Nothing here
 * prohibits anything. It counts, so a rule change later has evidence behind it.
 */
export function teamDiagnostics(states) {
  const withTeams = states.filter((s) => s.teams && s.teams.length >= 2);
  if (withTeams.length === 0) return null;

  let propertyConcentration = [];
  let cashConcentration = [];
  let setConcentration = [];
  let transfersBeforeCompletion = [];
  let sacrifices = 0;
  let sacrificeValue = 0;
  let sacrificeWins = 0;
  let teammateAuctionGames = 0;
  let teammateVsTeammateBids = 0;
  let teammateAuctionWasted = 0;
  let circularTrades = 0;

  const GROUPS = new Map();
  for (const tile of DEFAULT_BOARD) {
    if (!tile.group) continue;
    GROUPS.set(tile.group, [...(GROUPS.get(tile.group) ?? []), tile.id]);
  }

  for (const s of withTeams) {
    // 1. Does one member end up owning most of the team's land?
    for (const team of s.teams) {
      const owned = Object.values(s.properties).filter((p) => p.ownerId && team.memberIds.includes(p.ownerId));
      if (owned.length > 0) {
        const byMember = new Map();
        for (const p of owned) byMember.set(p.ownerId, (byMember.get(p.ownerId) ?? 0) + 1);
        propertyConcentration.push(Math.max(...byMember.values()) / owned.length);
      }
      const cash = team.memberIds.map((id) => s.players.find((p) => p.id === id)?.balance ?? 0);
      const totalCash = cash.reduce((a, b) => a + b, 0);
      if (totalCash > 0) cashConcentration.push(Math.max(...cash) / totalCash);
    }

    // 2. How are completed sets distributed inside a team?
    for (const [, members] of GROUPS) {
      const owners = new Set(members.map((id) => s.properties[id]?.ownerId).filter(Boolean));
      if (owners.size !== 1) continue;
      const [owner] = [...owners];
      const team = s.teams.find((t) => t.memberIds.includes(owner));
      if (!team) continue;
      const ownerTeamSets = [...GROUPS.values()].filter(
        (g) => g.every((id) => s.properties[id]?.ownerId === owner),
      ).length;
      const teamSets = [...GROUPS.values()].filter((g) =>
        g.every((id) => team.memberIds.includes(s.properties[id]?.ownerId ?? "")),
      ).length;
      if (teamSets > 0) setConcentration.push(ownerTeamSets / teamSets);
    }

    // 3. How many teammate transfers happened before a group was completed?
    for (const [, members] of GROUPS) {
      const owners = new Set(members.map((id) => s.properties[id]?.ownerId).filter(Boolean));
      if (owners.size !== 1) continue;
      const [owner] = [...owners];
      const team = s.teams.find((t) => t.memberIds.includes(owner));
      if (!team) continue;
      const other = team.memberIds.find((id) => id !== owner);
      const count = (s.trades ?? []).filter(
        (t) =>
          t.status === "ACCEPTED" &&
          new Set([t.fromPlayerId, t.toPlayerId]).has(other) &&
          (t.offer.propertyIds ?? []).concat(t.request.propertyIds ?? []).some((id) => members.includes(id)),
      ).length;
      transfersBeforeCompletion.push(count);
    }

    // 4. SACRIFICIAL STRATEGY: a player hands value to a teammate, then goes out.
    for (const t of s.trades ?? []) {
      if (t.status !== "ACCEPTED") continue;
      const sameTeam = s.teams.some(
        (team) => team.memberIds.includes(t.fromPlayerId) && team.memberIds.includes(t.toPlayerId),
      );
      if (!sameTeam) continue;
      const giver = s.players.find((p) => p.id === t.fromPlayerId);
      if (!giver || !giver.bankrupt) continue;
      const value =
        (t.offer.sats ?? 0) + (t.offer.propertyIds?.length ?? 0) * 1000 + (t.request.sats ?? 0);
      sacrifices += 1;
      sacrificeValue += value;
      if (s.winnerTeamId && s.teams.find((x) => x.teamId === s.winnerTeamId)?.memberIds.includes(t.toPlayerId)) {
        sacrificeWins += 1;
      }
    }

    // 5. A teammate trading assets straight back is a zero-sum loop.
    const accepted = (s.trades ?? []).filter((t) => t.status === "ACCEPTED");
    for (let i = 0; i + 1 < accepted.length; i += 1) {
      const a = accepted[i];
      const b = accepted[i + 1];
      if (a.fromPlayerId === b.toPlayerId && a.toPlayerId === b.fromPlayerId) circularTrades += 1;
    }

    // 6. TEammates bidding against each other in one auction.
    const auctions = s.log.filter((e) => e.type === "AUCTION_COMPLETED" && e.winnerId !== undefined);
    for (const done of auctions) {
      const bids = s.log.filter(
        (e) =>
          e.type === "AUCTION_BID" &&
          e.tileId === done.tileId &&
          e.atRevision <= done.atRevision &&
          e.atRevision >= 0,
      );
      const bidders = [...new Set(bids.map((b) => b.playerId))];
      const teamsOfBidders = bidders.map(
        (id) => s.teams.find((t) => t.memberIds.includes(id))?.teamId,
      );
      const firstTeam = teamsOfBidders[0];
      const sameTeamBidding = teamsOfBidders.filter((t) => t === firstTeam).length > 1;
      if (sameTeamBidding) {
        teammateAuctionGames += 1;
        teammateVsTeammateBids += Math.max(0, teamsOfBidders.filter((t) => t === firstTeam).length - 1);
        const winner = done.winnerId;
        if (winner && firstTeam) {
          // Liquidity destroyed if a teammate outbid the other side and won.
          const highest = Math.max(0, ...bids.filter((b) => b.playerId === winner).map((b) => b.amount));
          teammateAuctionWasted += highest;
        }
      }
      void auctions;
    }
  }

  return {
    teamGames: withTeams.length,
    avgLargestMemberPropertyShare: round(mean(propertyConcentration), 3),
    avgLargestMemberCashShare: round(mean(cashConcentration), 3),
    avgSetConcentrationOnOneMember: round(mean(setConcentration), 3),
    avgTeammateTransfersBeforeCompletion: round(mean(transfersBeforeCompletion), 2),
    maxTeammateTransfersBeforeCompletion: transfersBeforeCompletion.length ? Math.max(...transfersBeforeCompletion) : 0,
    // SACRIFICIAL STRATEGY — counted, not prohibited.
    sacrificialTrades: sacrifices,
    sacrificialTradesPerGame: round(sacrifices / withTeams.length, 4),
    sacrificialValueTransferred: sacrificeValue,
    sacrificialTradesOnWinningTeams: sacrificeWins,
    // TEAM AUCTION INFLATION — counted, not prohibited.
    auctionsWithTeammateRivalry: teammateAuctionGames,
    teammateVsTeammateBids: teammateVsTeammateBids,
    teammateAuctionSatsDestroyed: teammateAuctionWasted,
    // Repeated zero-sum swapping.
    circularTradePairs: circularTrades,
  };
}

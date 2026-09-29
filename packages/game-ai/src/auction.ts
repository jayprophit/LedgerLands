/**
 * Auction participation.
 *
 * The previous behaviour was "bid once, and only up to 1.2x the purchase
 * price", which produced roughly one bid per auction and made auctions
 * behaviourally inert. This module computes an explicit `maximumBid` from the
 * same valuation model trades use, so a bot's ceiling and its trade valuation
 * come from one place and cannot disagree.
 *
 * Two properties matter more than aggressiveness:
 *
 *  - SAFETY. A bot must never bid above its funds, above its valuation, or after
 *    passing. Every bound here is checked against the state before a command is
 *    produced, and the engine enforces them again.
 *  - TEAMMATE ESCALATION IS A CONSEQUENCE, NOT A RULE. D4 allows teammates to
 *    compete, and a bot may reduce its willingness to outbid a teammate when the
 *    team already holds the asset's value. That falls out of valuing the tile to
 *    the TEAM: the second bidder on a teammate's win sees less marginal team
 *    value, so its ceiling is lower. No `if teammate then stop` anywhere.
 */

import type { MatchState, PlayerId, TileId } from "@ledgerlands/shared-types";
import { areTeammates } from "@ledgerlands/game-engine";
import { groupOwnership, groupOf, valuePropertyFor, weightsFor } from "./valuation.js";

export interface BidDecision {
  shouldBid: boolean;
  amount: number;
  ceiling: number;
  reason: string;
}

/** The minimum legal increment the engine will accept. */
export const MIN_INCREMENT = 100;

/**
 * Highest amount this bot will pay for `tileId` right now.
 *
 * Built from the same components as trade valuation: face value, the completion
 * premium it would unlock for itself, what denying an opponent is worth, team
 * synergy, minus what it must keep liquid.
 */
export function maximumBid(
  state: MatchState,
  playerId: PlayerId,
  tileId: TileId,
  difficulty: string,
): { ceiling: number; breakdown: string[] } {
  const w = weightsFor(difficulty);
  const me = state.players.find((p) => p.id === playerId);
  const breakdown: string[] = [];
  if (!me || me.bankrupt) return { ceiling: 0, breakdown: ["player is out"] };

  const value = valuePropertyFor(state, tileId, playerId, difficulty);
  breakdown.push(`face ${value.base}`);

  // value.total is this tile valued to US, which already includes our own group
  // completion premium and any opponent-denial penalty. Denial is upside for us
  // though, so it is added back rather than netted.
  let willingness = value.total + value.opponentDenial;

  // If a teammate already owns this tile, there is nothing left to win for the
  // team, so the marginal team value collapses to roughly face value.
  const ownedByTeammate = state.players.some(
    (p) => p.id !== playerId && !p.bankrupt && areTeammates(state, playerId, p.id) && state.properties[tileId]?.ownerId === p.id,
  );
  if (ownedByTeammate) {
    const current = state.auction?.highestBid;
    // If a teammate is already winning, only outbid them if the difference is
    // small. This is the escalation brake, and it is a value comparison, not a
    // blanket refusal.
    if (current && areTeammates(state, playerId, current.playerId)) {
      willingness = Math.min(willingness, value.base * 1.05);
      breakdown.push("teammate leading: capped near face value");
    } else {
      breakdown.push("teammate owns it: marginal team value is low");
    }
  }

  // Never bid away liquidity that keeps the bot solvent.
  const reserve = w.cashReserve;
  const affordable = Math.max(0, me.balance - reserve);
  if (willingness > affordable) {
    breakdown.push(`capped by liquidity: ${affordable}`);
    willingness = affordable;
  }

  // A bot will not chase a tile it does not want, even if it could afford it.
  const group = groupOf(tileId);
  const myGroup = group ? groupOwnership(state, group, playerId) : null;
  const completesOwnGroup = myGroup !== null && myGroup.missing.includes(tileId) && myGroup.missing.length === 1;
  const denialTarget = hasOpponentNearGroup(state, playerId, tileId);
  if (!completesOwnGroup && !denialTarget) {
    breakdown.push("no strategic reason: completion or denial");
    willingness *= 0.85;
  } else if (completesOwnGroup) {
    breakdown.push("completes own group");
  } else {
    breakdown.push("denies an opponent group");
  }

  const ceiling = Math.max(0, Math.floor(willingness));
  breakdown.push(`ceiling ${ceiling}`);
  return { ceiling, breakdown };
}

/** Is some opponent one tile away from owning this tile's group? */
function hasOpponentNearGroup(state: MatchState, playerId: PlayerId, tileId: TileId): boolean {
  const group = groupOf(tileId);
  if (!group) return false;
  return state.players.some((other) => {
    if (other.id === playerId || other.bankrupt) return false;
    if (areTeammates(state, playerId, other.id)) return false;
    const theirs = groupOwnership(state, group, other.id);
    return theirs.missing.includes(tileId) && theirs.missing.length === 1;
  });
}

/**
 * Decide whether to bid, and how much.
 *
 * Returns a decision rather than a command so the caller decides when to act:
 * an auction is asynchronous, and a bot in the ACTION phase may have better
 * uses of its turn.
 */
export function decideBid(
  state: MatchState,
  playerId: PlayerId,
  tileId: TileId,
  currentHighest: number,
  difficulty: string,
): BidDecision {
  const auction = state.auction;
  if (!auction) return { shouldBid: false, amount: 0, ceiling: 0, reason: "no auction" };
  if (auction.passedPlayerIds.includes(playerId)) {
    return { shouldBid: false, amount: 0, ceiling: 0, reason: "already passed" };
  }
  const me = state.players.find((p) => p.id === playerId);
  if (!me || me.bankrupt) return { shouldBid: false, amount: 0, ceiling: 0, reason: "player is out" };

  const { ceiling, breakdown } = maximumBid(state, playerId, tileId, difficulty);
  if (ceiling <= 0) return { shouldBid: false, amount: 0, ceiling, reason: breakdown.join("; ") };

  const next = currentHighest + MIN_INCREMENT;
  // Never chase your own bid: a bot that is already the high bidder has nothing
  // to gain by raising its own ceiling.
  const lastBid = auction.bids[auction.bids.length - 1];
  if (lastBid && lastBid.playerId === playerId) {
    return { shouldBid: false, amount: 0, ceiling, reason: "already the high bidder" };
  }

  if (next > ceiling) {
    return { shouldBid: false, amount: 0, ceiling, reason: `next bid ${next} exceeds ceiling ${ceiling}` };
  }
  return {
    shouldBid: true,
    amount: next,
    ceiling,
    reason: `${breakdown.join("; ")}; current high ${currentHighest}`,
  };
}

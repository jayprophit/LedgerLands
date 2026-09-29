/**
 * Property and trade valuation.
 *
 * A single reusable model, deliberately kept out of the command chooser so the
 * weights are inspectable in one place and configurable per difficulty. No magic
 * numbers are scattered through AI code.
 *
 * The central claim this model encodes, and the reason a naive `purchase price`
 * comparison produces bad trades:
 *
 *     value(single property) != value(property that completes a group)
 *
 * and symmetrically, giving an opponent the last tile of a group they are one
 * tile from is worth far MORE to them than the tile's face value, so it costs
 * the giver more than face value too. Both are priced explicitly here rather
 * than left to intuition.
 *
 * Everything is derived from authoritative, public match state. There is no
 * hidden knowledge: a bot evaluating a trade uses the same `MatchState` every
 * other player can see.
 */

import { DEFAULT_BOARD, getRuleset, purchasePriceFor } from "@ledgerlands/game-engine";
import { areTeammates, isOpponent } from "@ledgerlands/game-engine";
import type { BoardTile, MatchState, PlayerId, TileId } from "@ledgerlands/shared-types";

export type { Difficulty } from "./index.js";

/** Weights per difficulty. Multipliers on the components below. */
export interface ValuationWeights {
  /** Multiplier on the completion premium for one's own group. */
  groupCompletion: number;
  /** Multiplier on the penalty for handing an opponent a group completion. */
  opponentDenial: number;
  /** Multiplier on the premium for completing a TEAMMATE's group. */
  teamSynergy: number;
  /** Multiplier on liquidity (cash on hand) in trade evaluation. */
  liquidity: number;
  /** Multiplier on development potential (own developable, unmortgaged land). */
  development: number;
  /**
   * Cash a bot insists on keeping. Trades that would drop it below this are
   * refused regardless of strategic value. Starts deliberately simple; the
   * reserve is measured in simulation before it grows.
   */
  cashReserve: number;
  /**
   * How much better a trade must be, in value terms, before a bot proposes it.
   * Higher = pickier.
   */
  proposeMargin: number;
  /**
   * How much better an incoming trade must be before it is accepted. Higher =
   * pickier. Negative values mean "accept a slightly losing trade", which is
   * what a beginner does.
   */
  acceptTolerance: number;
  /** Whether the bot bothers proposing trades at all. */
  willPropose: boolean;
}

export const VALUATION_WEIGHTS: Record<string, ValuationWeights> = {
  BEGINNER: {
    groupCompletion: 0.4,
    opponentDenial: 0.2,
    teamSynergy: 0.4,
    liquidity: 0.2,
    development: 0.2,
    // No reserve at all: a beginner will happily go bust on a bad trade.
    cashReserve: 0,
    proposeMargin: 0.05,
    // Accepts clearly losing offers, which is the beginner's defining trait.
    acceptTolerance: -0.25,
    willPropose: false,
  },
  EASY: {
    groupCompletion: 1.0,
    opponentDenial: 0.3,
    teamSynergy: 0.6,
    liquidity: 0.5,
    development: 0.5,
    cashReserve: 300,
    proposeMargin: 0.12,
    acceptTolerance: -0.1,
    willPropose: true,
  },
  NORMAL: {
    groupCompletion: 1.4,
    opponentDenial: 0.8,
    teamSynergy: 0.8,
    liquidity: 0.8,
    development: 0.8,
    cashReserve: 700,
    proposeMargin: 0.18,
    acceptTolerance: 0.0,
    willPropose: true,
  },
  HARD: {
    groupCompletion: 1.8,
    opponentDenial: 1.2,
    teamSynergy: 1.0,
    liquidity: 1.0,
    development: 1.1,
    cashReserve: 1200,
    proposeMargin: 0.22,
    acceptTolerance: 0.05,
    willPropose: true,
  },
  EXPERT: {
    groupCompletion: 2.2,
    opponentDenial: 1.6,
    teamSynergy: 1.2,
    liquidity: 1.2,
    development: 1.4,
    cashReserve: 1600,
    proposeMargin: 0.25,
    acceptTolerance: 0.1,
    willPropose: true,
  },
};

export function weightsFor(difficulty: string): ValuationWeights {
  return VALUATION_WEIGHTS[difficulty] ?? VALUATION_WEIGHTS.NORMAL!;
}

const tileCache = new Map<TileId, BoardTile>();
function tile(tileId: TileId): BoardTile | undefined {
  let t = tileCache.get(tileId);
  if (t === undefined) {
    t = DEFAULT_BOARD.find((b) => b.id === tileId);
    if (t) tileCache.set(tileId, t);
  }
  return t;
}

const groupCache = new Map<string, TileId[]>();
/** All tile ids in a colour group, in board order. */
export function groupTiles(group: string): TileId[] {
  let list = groupCache.get(group);
  if (!list) {
    list = DEFAULT_BOARD.filter((t) => t.group === group).map((t) => t.id);
    groupCache.set(group, list);
  }
  return list;
}

export function groupOf(tileId: TileId): string | undefined {
  return tile(tileId)?.group;
}

/** How many of a group's tiles `ownerId` holds, and how many exist. */
export function groupOwnership(
  state: MatchState,
  group: string,
  ownerId: PlayerId,
): { owned: number; total: number; missing: TileId[] } {
  const members = groupTiles(group);
  const missing = members.filter((id) => state.properties[id]?.ownerId !== ownerId);
  return { owned: members.length - missing.length, total: members.length, missing };
}

export interface PropertyValuation {
  tileId: TileId;
  /** Face value: what it costs to buy outright. */
  base: number;
  /** Extra value because it completes (or nearly completes) the holder's group. */
  completionPremium: number;
  /** Extra value because it completes a TEAMMATE's group. */
  teamSynergy: number;
  /** Value lost because it hands an opponent a group completion. */
  opponentDenial: number;
  /** What it could earn as rent if the holder developed it. */
  developmentPotential: number;
  /** Penalty for being mortgaged (it earns nothing while mortgaged). */
  mortgagePenalty: number;
  /** base + premiums - penalties. */
  total: number;
}

/**
 * Value of `tileId` **to `ownerId`**, in the current position.
 *
 * Denominated in sats so it is comparable with cash directly. This is a
 * heuristic, not an economic model: the components are documented and tunable
 * above, and the weights are per-difficulty.
 */
export function valuePropertyFor(
  state: MatchState,
  tileId: TileId,
  ownerId: PlayerId,
  difficulty: string = REFERENCE_DIFFICULTY,
): PropertyValuation {
  const w = weightsFor(difficulty);
  const t = tile(tileId);
  const base = t ? purchasePriceFor(t) : 0;
  const prop = state.properties[tileId];
  const group = t?.group;

  let completionPremium = 0;
  let teamSynergy = 0;
  let opponentDenial = 0;
  let developmentPotential = 0;

  if (group) {
    const mine = groupOwnership(state, group, ownerId);
    const alreadyOwns = prop?.ownerId === ownerId;
    const isCompletion = mine.missing.length <= 1 && mine.missing.includes(tileId) && !alreadyOwns;
    if (isCompletion && mine.total > 1) {
      // Worth more the closer you already are: the last tile is the expensive one.
      const closeness = 1 - Math.max(0, mine.missing.length - 1) / mine.total;
      completionPremium = base * w.groupCompletion * (0.5 + 0.5 * closeness);
    }

    // Does handing this tile complete a group for somebody else?
    for (const other of state.players) {
      if (other.id === ownerId || other.bankrupt) continue;
      const theirs = groupOwnership(state, group, other.id);
      if (theirs.owned === theirs.total - 1) {
        if (areTeammates(state, ownerId, other.id)) {
          // A teammate completing a group is genuinely good for the team, so it
          // is a premium rather than a penalty. It still has to be *priced*,
          // which is what stops a bot from gifting everything.
          teamSynergy += base * w.teamSynergy;
        } else if (isOpponent(state, ownerId, other.id)) {
          opponentDenial += base * w.opponentDenial;
        }
      }
    }
  }

  // Development potential: the top-rent the tile could reach, discounted, and
  // only if the holder could actually develop it (owns the group, level 0).
  if (t?.economics && group) {
    const ladder = t.economics.rentByDevelopment;
    const top = ladder[ladder.length - 1] ?? 0;
    const mine = groupOwnership(state, group, ownerId);
    const developable = mine.missing.length === 0 && (prop?.mortgaged ?? false) === false;
    if (developable) {
      developmentPotential = (top * 4 + (t.economics.houseCost ?? 0) * 2) * w.development;
    }
  }

  const mortgagePenalty = prop?.mortgaged ? -base * 0.5 : 0;
  const total =
    base +
    completionPremium +
    teamSynergy +
    developmentPotential +
    mortgagePenalty -
    opponentDenial;

  return {
    tileId,
    base,
    completionPremium,
    teamSynergy,
    opponentDenial,
    developmentPotential,
    mortgagePenalty,
    total,
  };
}

/**
 * The difficulty used to compute board value.
 *
 * A tile's value is a fact about the board, not about who is looking at it. If
 * value were computed per-difficulty then a BEGINNER would literally perceive a
 * different board from an EXPERT, which makes "did this bot make a good trade?"
 * unanswerable and makes the tolerance table incoherent. So value is always
 * computed at a reference difficulty, and difficulty changes only the
 * *thresholds* a bot applies to that value.
 */
export const REFERENCE_DIFFICULTY = "NORMAL";

/** Value of a set of tiles to a holder, as the sum of their individual values. */
export function valueTilesFor(
  state: MatchState,
  tileIds: readonly TileId[],
  ownerId: PlayerId,
  difficulty: string = REFERENCE_DIFFICULTY,
): number {
  let sum = 0;
  for (const id of tileIds) sum += valuePropertyFor(state, id, ownerId, difficulty).total;
  return sum;
}

export interface TradeEvaluation {
  /** Sats the proposer receives. */
  cashIn: number;
  /** Sats the proposer surrenders. */
  cashOut: number;
  /** Value of property the proposer receives, to the proposer. */
  propertyIn: number;
  /** Value of property the proposer surrenders, to the proposer. */
  propertyOut: number;
  /** `propertyIn + cashIn - propertyOut - cashOut`. */
  valueToProposer: number;
  /** Same trade valued from the counterparty's side. */
  valueToCounterparty: number;
  /** True when the two sides disagree enough that both bots would be happy. */
  mutuallyBeneficial: boolean;
  /** Why this trade was chosen, for debugging and for the analysis metrics. */
  reasons: string[];
}

/**
 * Evaluate a proposed trade from a specific player's point of view.
 *
 * Both sides are valued, because a trade is only worth proposing if the other
 * side can also be made to see value in it. Valuing it once and assuming the
 * other side agrees is how a bot ends up spamming proposals that get rejected.
 */
export function evaluateTrade(
  state: MatchState,
  proposerId: PlayerId,
  counterpartyId: PlayerId,
  offer: { sats?: number; propertyIds?: TileId[] },
  request: { sats?: number; propertyIds?: TileId[] },
  difficulty: string,
): TradeEvaluation {
  const offerProps = offer.propertyIds ?? [];
  const requestProps = request.propertyIds ?? [];
  const offerSats = offer.sats ?? 0;
  const requestSats = request.sats ?? 0;

  const proposer = state.players.find((p) => p.id === proposerId);
  const counterparty = state.players.find((p) => p.id === counterpartyId);
  const proposerCash = proposer?.balance ?? 0;
  const counterpartyCash = counterparty?.balance ?? 0;
  const w = weightsFor(difficulty);

  // Board value is computed at the REFERENCE difficulty, not the caller's, so
  // both sides of a trade are scored against the same facts. `difficulty` is
  // still accepted, and still used, for the reason list — but the numbers that
  // get compared do not move when the assessing bot changes tier.
  void difficulty;
  // What the proposer gives up, valued to the proposer (opponent denial applies).
  const propertyOut = valueTilesFor(state, offerProps, proposerId, REFERENCE_DIFFICULTY);
  // What the proposer receives, valued to the proposer (completion premium applies).
  const propertyIn = valueTilesFor(state, requestProps, proposerId, REFERENCE_DIFFICULTY);

  // The counterparty's view, which is what decides whether it will accept.
  const propertyOutForCounterparty = valueTilesFor(state, requestProps, counterpartyId, REFERENCE_DIFFICULTY);
  const propertyInForCounterparty = valueTilesFor(state, offerProps, counterpartyId, REFERENCE_DIFFICULTY);

  const cashOut = offerSats + counterpartyCash * w.liquidity;
  const cashIn = requestSats + proposerCash * w.liquidity;

  const valueToProposer = propertyIn + requestSats - propertyOut - offerSats;
  const valueToCounterparty = propertyInForCounterparty + offerSats - propertyOutForCounterparty - requestSats;

  const reasons: string[] = [];
  if (propertyIn - propertyOut > 0) reasons.push("better property received");
  if (requestSats > offerSats) reasons.push("net cash gain");
  if (valueToCounterparty > 0) reasons.push("counterparty also benefits");
  for (const id of requestProps) {
    const v = valuePropertyFor(state, id, proposerId, REFERENCE_DIFFICULTY);
    if (v.teamSynergy > 0) reasons.push(`team synergy: ${id}`);
    if (v.completionPremium > 0) reasons.push(`own group completion: ${id}`);
  }
  for (const id of offerProps) {
    const v = valuePropertyFor(state, id, proposerId, REFERENCE_DIFFICULTY);
    if (v.opponentDenial > 0) reasons.push(`denies opponent group: ${id}`);
  }
  if (cashOut - propertyOut > proposerCash * 0.5) reasons.push("would endanger proposer liquidity");

  return {
    cashIn: requestSats,
    cashOut: offerSats,
    propertyIn,
    propertyOut,
    valueToProposer,
    valueToCounterparty,
    mutuallyBeneficial: valueToProposer > 0 && valueToCounterparty > 0,
    reasons,
  };
}

/**
 * Would this trade leave the proposer able to keep playing?
 *
 * Deliberately simple per the directive: current balance, minus the cash it
 * surrenders, against the reserve. More inputs (board threat, tax exposure)
 * are a later refinement and should only be added against measurement.
 */
export function preservesLiquidity(
  state: MatchState,
  playerId: PlayerId,
  cashOut: number,
  difficulty: string,
): boolean {
  const w = weightsFor(difficulty);
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return false;
  return player.balance - cashOut >= w.cashReserve;
}

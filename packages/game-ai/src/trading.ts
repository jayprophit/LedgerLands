/**
 * Trade generation and acceptance.
 *
 * Bots speak only through the engine's trade commands — `PROPOSE_TRADE`,
 * `ACCEPT_TRADE`, `REJECT_TRADE` — and never touch balances, property or team
 * state directly. There is no simulator-only shortcut and no team vault: if a
 * teammate helps another player, it does so because a proposal was made and
 * accepted through the normal path, which means it is in the event log and
 * survives replay.
 *
 * Candidate generation is deliberately BOUNDED. Enumerating every subset of
 * every owned tile to search for a good deal is exponential, and on a 4-player
 * board with 28 purchasable tiles it would be the dominant cost of a command —
 * exactly the kind of cost the determinism oracle exists to catch. The shapes
 * considered are listed in TRADE_SHAPES and nothing else.
 */

import type { GameCommand, MatchState, PlayerId, TileId } from "@ledgerlands/shared-types";
import { DEFAULT_BOARD, areTeammates, isOpponent, purchasePriceFor } from "@ledgerlands/game-engine";
import {
  evaluateTrade,
  groupOwnership,
  groupOf,
  preservesLiquidity,
  valuePropertyFor,
  weightsFor,
} from "./valuation.js";

export type { Difficulty } from "./index.js";

/** A trade shape the proposer is willing to consider. */
export interface TradeShape {
  label: string;
  /** How many of the proposer's own tiles to offer. */
  give: number;
  /** How many of the counterparty's tiles to request. */
  want: number;
  /** Include sats alongside property. */
  cash: boolean;
}

/**
 * The whole search space. Bounded by construction: at most 4 shapes x a handful
 * of candidate tiles, so the decision cost is linear in owned tiles, not
 * exponential.
 */
export const TRADE_SHAPES: TradeShape[] = [
  { label: "1for1", give: 1, want: 1, cash: true },
  { label: "prop-for-cash", give: 1, want: 0, cash: true },
  { label: "cash-for-prop", give: 0, want: 1, cash: true },
  { label: "1for1-nocash", give: 1, want: 1, cash: false },
  { label: "2for1", give: 2, want: 1, cash: true },
  { label: "1for2", give: 1, want: 2, cash: true },
];

export interface TradeProposal {
  counterpartyId: PlayerId;
  offer: { sats: number; propertyIds: TileId[] };
  request: { sats: number; propertyIds: TileId[] };
  /** Estimated value to the proposer, for ranking candidates. */
  score: number;
  reasons: string[];
  shape: string;
}

/** Tiles `playerId` owns that are legally tradeable (developed land cannot be sold). */
function tradeableTiles(state: MatchState, playerId: PlayerId): TileId[] {
  return Object.values(state.properties)
    .filter((p) => p.ownerId === playerId && p.development === 0)
    .map((p) => p.tileId)
    .sort();
}

/** Counterparties this bot would consider: teammates first, then opponents. */
function counterpartyOrder(state: MatchState, playerId: PlayerId): PlayerId[] {
  return state.players
    .filter((p) => p.id !== playerId && !p.bankrupt)
    .map((p) => ({ id: p.id, teammate: areTeammates(state, playerId, p.id) }))
    // Teammates first: a group completion for a teammate is priced as a premium,
    // so it often outranks a merely fair swap. Not a rule, an ordering.
    .sort((a, b) => Number(b.teammate) - Number(a.teammate) || a.id.localeCompare(b.id))
    .map((p) => p.id);
}

/**
 * The best trade this bot can see, or null.
 *
 * Deterministic: candidate order is derived from board order and player id, so
 * ties always resolve the same way for the same state. No randomness, no clock.
 */
export function chooseTradeProposal(
  state: MatchState,
  playerId: PlayerId,
  difficulty: string,
  options: { maxCandidates?: number } = {},
): TradeProposal | null {
  const w = weightsFor(difficulty);
  if (!w.willPropose) return null;
  const me = state.players.find((p) => p.id === playerId);
  if (!me || me.bankrupt) return null;
  if (state.status !== "ACTIVE") return null;

  const maxCandidates = options.maxCandidates ?? 40;
  const mine = tradeableTiles(state, playerId);
  if (mine.length === 0) return null;

  let best: TradeProposal | null = null;
  let considered = 0;

  for (const counterpartyId of counterpartyOrder(state, playerId)) {
    const theirs = tradeableTiles(state, counterpartyId);
    if (theirs.length === 0) continue;

    for (const shape of TRADE_SHAPES) {
      const giveOptions = pickUpTo(state, mine, shape.give, counterpartyId, "give");
      const wantOptions = pickUpTo(state, theirs, shape.want, counterpartyId, "want");
      if (giveOptions.length === 0 && shape.give > 0) continue;
      if (wantOptions.length === 0 && shape.want > 0) continue;

      for (const give of giveOptions) {
        for (const want of wantOptions) {
          // Never trade a tile for itself.
          if (give.some((g) => want.includes(g))) continue;

          for (const cashSide of cashAmounts(state, me, shape, counterpartyId, give, want)) {
            const offer = { sats: cashSide.offerSats, propertyIds: give };
            const request = { sats: cashSide.requestSats, propertyIds: want };
            if (offer.sats === 0 && offer.propertyIds.length === 0) continue;
            if (request.sats === 0 && request.propertyIds.length === 0) continue;
            // The engine refuses these, so do not build them.
            if (offer.sats > me.balance) continue;

            const ev = evaluateTrade(state, playerId, counterpartyId, offer, request, difficulty);
            if (!preservesLiquidity(state, playerId, offer.sats, difficulty)) continue;
            // Must clear the proposer's own margin, else it is not a trade the
            // proposer wants. The receiver judges acceptability separately.
            if (ev.valueToProposer <= 0) continue;
            // Refuse to re-propose something already refused in this match.
            // Without this, two bots can bounce identical terms forever and the
            // simulation never terminates.
            if (
              alreadyRefused(
                state,
                tradeSignature(playerId, counterpartyId, offer, request),
              )
            ) {
              continue;
            }
            if (considered++ > maxCandidates) break;

            const score = ev.valueToProposer * (1 + w.proposeMargin);
            // A wildly one-sided deal in the counterparty's favour is spam even
            // if the proposer likes it.
            if (ev.valueToCounterparty <= -me.balance * 0.5) continue;
            if (!best || score > best.score || (score === best.score && shape.label < best.shape)) {
              best = {
                counterpartyId,
                offer,
                request,
                score,
                reasons: ev.reasons,
                shape: shape.label,
              };
            }
          }
        }
      }
    }
  }
  return best;
}

/** Up to `n` candidate tiles to put on one side of a trade, best-first. */
function pickUpTo(
  state: MatchState,
  tiles: TileId[],
  n: number,
  counterpartyId: PlayerId,
  side: "give" | "want",
): TileId[][] {
  if (n === 0) return [[]];
  if (tiles.length === 0) return [];
  const ordered = [...tiles].sort((a, b) => {
    if (side === "want") {
      // Most valuable to the requester first.
      const av = valuePropertyFor(state, a, counterpartyId, "NORMAL").total;
      const bv = valuePropertyFor(state, b, counterpartyId, "NORMAL").total;
      return bv - av || a.localeCompare(b);
    }
    // Cheapest to give away first, so single-tile trades offer the low cost.
    const av = valuePropertyFor(state, a, counterpartyId, "NORMAL").base;
    const bv = valuePropertyFor(state, b, counterpartyId, "NORMAL").base;
    return av - bv || a.localeCompare(b);
  });
  const out: TileId[][] = [];
  // The top few singletons, plus the top one or two combined. Bounded on
  // purpose: this is the whole combinatorial budget.
  const singles = ordered.slice(0, 3).map((t) => [t]);
  out.push(...singles);
  if (n > 1) {
    for (let i = 0; i < Math.min(2, ordered.length - 1); i += 1) {
      out.push([ordered[i]!, ordered[i + 1]!].sort());
    }
  }
  return out.slice(0, 5);
}

/** Cash legs to consider, kept to a small fixed ladder. */
function cashAmounts(
  state: MatchState,
  me: MatchState["players"][number],
  shape: TradeShape,
  counterpartyId: PlayerId,
  give: TileId[],
  want: TileId[],
): Array<{ offerSats: number; requestSats: number }> {
  if (!shape.cash) return [{ offerSats: 0, requestSats: 0 }];
  const counterparty = state.players.find((p) => p.id === counterpartyId);
  const theirCash = counterparty?.balance ?? 0;

  const options: Array<{ offerSats: number; requestSats: number }> = [{ offerSats: 0, requestSats: 0 }];

  // Asking for cash alongside property: three price points, so a receiver has
  // something in range rather than an all-or-nothing demand.
  if (want.length > 0) {
    const askFor = faceValue(want);
    for (const factor of [0.6, 0.8, 1.0]) {
      const amount = roundStep(askFor * factor);
      if (amount > 0 && amount <= theirCash) options.push({ offerSats: 0, requestSats: amount });
    }
  }
  // Offering cash for property: derived from what we are giving up, so the ask
  // scales with the deal instead of being a fixed number.
  if (give.length > 0 && want.length === 0) {
    const ask = roundStep(faceValue(give) * 0.5);
    if (ask > 0 && ask <= me.balance) options.push({ offerSats: ask, requestSats: 0 });
  }
  return options;
}

function faceValue(tileIds: readonly TileId[]): number {
  let sum = 0;
  for (const id of tileIds) {
    const t = DEFAULT_BOARD.find((b) => b.id === id);
    if (t) sum += purchasePriceFor(t);
  }
  return sum;
}

/** Round to a step that scales with magnitude, so asks are legible. */
function roundStep(amount: number): number {
  if (amount <= 0) return 0;
  const step = amount > 2000 ? 500 : 100;
  return Math.floor(amount / step) * step;
}

/**
 * Judge an incoming proposal as the RECEIVER, independently of whoever sent it.
 *
 * The receiver applies its own tolerance, so a beginner can accept a trade a
 * hard bot rejects — which is what makes difficulty observable rather than
 * cosmetic.
 */
export function evaluateIncomingTrade(
  state: MatchState,
  receiverId: PlayerId,
  proposerId: PlayerId,
  offer: { sats?: number; propertyIds?: TileId[] },
  request: { sats?: number; propertyIds?: TileId[] },
  difficulty: string,
): { accept: boolean; valueDelta: number; reason: string } {
  const w = weightsFor(difficulty);
  const me = state.players.find((p) => p.id === receiverId);
  if (!me || me.bankrupt) return { accept: false, valueDelta: 0, reason: "receiver is out" };
  if (proposerId === receiverId) return { accept: false, valueDelta: 0, reason: "self trade" };

  // The receiver sees the mirrored proposal: what it gets is the proposer's
  // `offer`, what it gives is the proposer's `request`.
  const ev = evaluateTrade(
    state,
    receiverId,
    proposerId,
    { sats: request.sats ?? 0, propertyIds: request.propertyIds ?? [] },
    { sats: offer.sats ?? 0, propertyIds: offer.propertyIds ?? [] },
    difficulty,
  );
  const valueDelta = ev.valueToProposer;

  // Never accept into insolvency.
  if (!preservesLiquidity(state, receiverId, request.sats ?? 0, difficulty)) {
    return { accept: false, valueDelta, reason: "would breach the cash reserve" };
  }
  // Never accept a trade the engine will reject anyway.
  if ((request.sats ?? 0) > me.balance) {
    return { accept: false, valueDelta, reason: "cannot cover the sats owed" };
  }
  for (const id of request.propertyIds ?? []) {
    if (state.properties[id]?.ownerId !== receiverId) {
      return { accept: false, valueDelta, reason: `does not own ${id}` };
    }
  }

  // Tolerance is a fraction of the largest value involved, so it scales with
  // the size of the deal rather than being an absolute number. A NEGATIVE
  // tolerance means "accept a deal this much worse than break-even", which is
  // what makes a beginner lenient; a positive one demands a margin.
  const scale = Math.max(1, Math.abs(ev.propertyIn) + Math.abs(ev.propertyOut) + (offer.sats ?? 0) + (request.sats ?? 0));
  const threshold = w.acceptTolerance * scale;
  if (valueDelta < threshold) {
    return { accept: false, valueDelta, reason: `value ${Math.round(valueDelta)} below tolerance ${Math.round(threshold)}` };
  }
  return { accept: true, valueDelta, reason: `value ${Math.round(valueDelta)} clears tolerance ${Math.round(threshold)}` };
}

/**
 * Should a bot act on a pending trade at all?
 *
 * Only the two parties may respond, and only to a still-open trade. Anti-loop
 * protection is in the caller (`alreadyRefused`), which is a content check
 * rather than a per-trade flag.
 */
export function shouldRespondToTrade(
  state: MatchState,
  playerId: PlayerId,
  trade: {
    id: string;
    fromPlayerId: PlayerId;
    toPlayerId: PlayerId;
    status: string;
    offer: { sats?: number; propertyIds?: TileId[] };
    request: { sats?: number; propertyIds?: TileId[] };
  },
): boolean {
  if (trade.status !== "PROPOSED") return false;
  if (trade.fromPlayerId !== playerId && trade.toPlayerId !== playerId) return false;
  // A proposer cannot accept their own proposal; the receiver responds.
  if (trade.fromPlayerId === playerId) return false;
  return state.status === "ACTIVE";
}

/** A stable signature for a trade, used to detect an exact repeat. */
export function tradeSignature(
  fromPlayerId: PlayerId,
  toPlayerId: PlayerId,
  offer: { sats?: number; propertyIds?: TileId[] },
  request: { sats?: number; propertyIds?: TileId[] },
): string {
  const part = (o: { sats?: number; propertyIds?: TileId[] }) =>
    `${o.sats ?? 0}:${[...(o.propertyIds ?? [])].sort().join("+")}`;
  return `${fromPlayerId}>${toPlayerId}|${part(offer)}|${part(request)}`;
}

/** Has this exact trade already been proposed and refused in this match? */
export function alreadyRefused(
  state: MatchState,
  signature: string,
): boolean {
  // The log records trade ids, not signatures, so a repeat is detected by
  // matching the same (proposer, counterparty, assets) triple against every
  // trade the match has seen. Cheap because trades are rare in a match.
  const seen = new Set<string>();
  for (const t of state.trades ?? []) {
    seen.add(tradeSignature(t.fromPlayerId, t.toPlayerId, t.offer, t.request));
  }
  if (seen.has(signature)) {
    // Proposed before. Only refuse again if it was actually rejected; a trade
    // still open or accepted is not a loop.
    for (const t of state.trades ?? []) {
      if (t.status === "PROPOSED" || t.status === "ACCEPTED") continue;
      if (tradeSignature(t.fromPlayerId, t.toPlayerId, t.offer, t.request) === signature) return true;
    }
  }
  return false;
}

/** Does this bot own a group-completing tile for the given player? */
export function completesGroupFor(state: MatchState, tileId: TileId, playerId: PlayerId): boolean {
  const group = groupOf(tileId);
  if (!group) return false;
  const { missing } = groupOwnership(state, group, playerId);
  return missing.includes(tileId);
}

/** Is `otherId` an opponent of `playerId`, for denial reasoning? */
export function isOpponentOf(state: MatchState, playerId: PlayerId, otherId: PlayerId): boolean {
  return isOpponent(state, playerId, otherId);
}

/** The command a bot issues to accept a pending trade. */
export function acceptTradeCommand(playerId: PlayerId, tradeId: string): GameCommand {
  return { type: "ACCEPT_TRADE", playerId, tradeId };
}

/** The command a bot issues to reject a pending trade. */
export function rejectTradeCommand(playerId: PlayerId, tradeId: string): GameCommand {
  return { type: "REJECT_TRADE", playerId, tradeId };
}

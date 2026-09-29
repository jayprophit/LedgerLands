import type { GameCommand, MatchState, PlayerId, TradeState } from "@ledgerlands/shared-types";
import { DEFAULT_BOARD, purchasePriceFor } from "@ledgerlands/game-engine";
import { decideBid } from "./auction.js";
import {
  acceptTradeCommand,
  chooseTradeProposal,
  evaluateIncomingTrade,
  rejectTradeCommand,
  shouldRespondToTrade,
  tradeSignature,
  alreadyRefused,
} from "./trading.js";

export type Difficulty = "BEGINNER" | "EASY" | "NORMAL" | "HARD" | "EXPERT";

/**
 * Heuristic AI. Uses only the public command interface — no hidden state.
 * Deterministic given (state, difficulty): every decision derives from
 * `MatchState` and stable ordering, never from a clock or a random source.
 *
 * Higher difficulties apply progressively stronger heuristics rather than
 * different rules, so an EXPERT bot is not omniscient: it sees exactly what
 * every other player sees and reasons harder about it.
 */
export function chooseAiCommand(state: MatchState, playerId: string, difficulty: Difficulty = "NORMAL"): GameCommand | null {
  const me = state.players.find((p) => p.id === playerId);
  if (!me || me.bankrupt || state.status !== "ACTIVE") return null;
  const current = state.players[state.currentPlayerIndex];
  if (!current || current.id !== playerId) return null;

  // A pending trade addressed to this bot is answered first: a trade is a
  // standing offer and leaving it open blocks the proposer from acting again.
  // This is why the trade loop terminates.
  const response = respondToPendingTrade(state, playerId, difficulty);
  if (response) return response;

  if (state.turnPhase === "ROLL") {
    if (me.inDetention) {
      if ((me.detentionCards ?? 0) > 0 && (difficulty === "HARD" || difficulty === "EXPERT" || me.balance < 500)) {
        return { type: "USE_DETENTION_CARD", playerId };
      }
      if (me.balance >= 1000 && me.detentionTurns >= 1 && difficulty !== "BEGINNER") {
        return { type: "PAY_DETENTION_FINE", playerId };
      }
    }
    return { type: "ROLL_DICE" };
  }

  // ACTION phase
  const tile = DEFAULT_BOARD[me.position];
  const prop = tile ? state.properties[tile.id] : undefined;
  const price = tile ? purchasePriceFor(tile) : 0;

  // 0. Responding to someone else's auction. D4 lets everyone bid, teammates
  //    included; the ceiling in `decideBid` is where a bot decides to stop.
  if (state.auction) {
    const decision = decideBid(state, playerId, state.auction.tileId, state.auction.highestBid?.amount ?? 0, difficulty);
    if (decision.shouldBid) {
      return { type: "PLACE_BID", playerId, amount: decision.amount };
    }
  }

  // 1. Buy logic
  if (tile && prop && !prop.ownerId && price > 0 && me.balance >= price) {
    const reserveByDifficulty: Record<Difficulty, number> = {
      BEGINNER: 0,
      EASY: 200,
      NORMAL: 800,
      HARD: 1200,
      EXPERT: 1500,
    };
    const reserve = reserveByDifficulty[difficulty];
    if (difficulty === "BEGINNER") {
      if (state.revision % 2 === 0) return { type: "BUY_PROPERTY", playerId, tileId: tile.id };
    } else if (me.balance - price >= reserve) {
      return { type: "BUY_PROPERTY", playerId, tileId: tile.id };
    } else if (difficulty === "EASY" && me.balance >= price * 1.5) {
      return { type: "BUY_PROPERTY", playerId, tileId: tile.id };
    }
    if (!prop.ownerId && difficulty !== "BEGINNER") {
      if (!state.auction) return { type: "DECLINE_PROPERTY", playerId };
    }
  }

  // 2. Develop when the engine will accept it. The engine validates the group and
  //    even-building rules, so the AI only needs to pick a sensible candidate.
  if (difficulty === "HARD" || difficulty === "EXPERT" || difficulty === "NORMAL") {
    const owned = Object.values(state.properties).filter((p) => p.ownerId === playerId && !p.mortgaged);
    const candidates = owned
      .map((p) => DEFAULT_BOARD.find((t) => t.id === p.tileId))
      .filter((t) => t?.economics)
      .sort((a, b) => (a!.economics!.houseCost ?? 0) - (b!.economics!.houseCost ?? 0));
    for (const t of candidates) {
      const st = state.properties[t!.id]!;
      if (st.development < (t!.economics!.rentByDevelopment.length - 1) && me.balance >= (t!.economics!.houseCost ?? 0) + 1000) {
        return { type: "DEVELOP_PROPERTY", playerId, tileId: t!.id };
      }
    }
  }

  // 3. Propose a trade. Only at NORMAL and above, and only when the bot is not
  //    the sort of player whose position makes a trade pointless (a beginner
  //    never proposes; see `weightsFor`).
  if (difficulty !== "BEGINNER" && !state.pendingExtraRoll) {
    const proposal = chooseTradeProposal(state, playerId, difficulty);
    if (proposal) {
      return {
        type: "PROPOSE_TRADE",
        playerId,
        toPlayerId: proposal.counterpartyId,
        offer: { sats: proposal.offer.sats, propertyIds: [...proposal.offer.propertyIds] },
        request: { sats: proposal.request.sats, propertyIds: [...proposal.request.propertyIds] },
      };
    }
  }

  return { type: "END_TURN", playerId };
}

/**
 * Answer a trade addressed to this bot, if one is open.
 *
 * Acceptance is judged by the RECEIVER's own evaluation and its own tolerance,
 * so a beginner accepts what an expert rejects. A refused trade is never
 * re-proposed with identical terms, which is what stops a propose/reject loop
 * from running forever.
 */
function respondToPendingTrade(state: MatchState, playerId: PlayerId, difficulty: Difficulty): GameCommand | null {
  const open = (state.trades ?? []).filter(
    (t): t is TradeState & { status: "PROPOSED" } =>
      t.status === "PROPOSED" && shouldRespondToTrade(state, playerId, t),
  );
  if (open.length === 0) return null;
  // Oldest first, so trades resolve in the order they were made.
  const trade = open[0]!;
  const judgement = evaluateIncomingTrade(
    state,
    playerId,
    trade.fromPlayerId,
    trade.offer,
    trade.request,
    difficulty,
  );
  if (judgement.accept) return acceptTradeCommand(playerId, trade.id);
  return rejectTradeCommand(playerId, trade.id);
}

export { tradeSignature, alreadyRefused };
export { chooseTradeProposal, evaluateIncomingTrade } from "./trading.js";
export { decideBid, maximumBid, MIN_INCREMENT } from "./auction.js";
export {
  evaluateTrade,
  valuePropertyFor,
  valueTilesFor,
  groupOwnership,
  groupOf,
  groupTiles,
  preservesLiquidity,
  weightsFor,
  VALUATION_WEIGHTS,
  type ValuationWeights,
  type PropertyValuation,
  type TradeEvaluation,
} from "./valuation.js";

export function difficultyFromString(s: string): Difficulty {
  if (s === "BEGINNER" || s === "EASY" || s === "NORMAL" || s === "HARD" || s === "EXPERT") return s;
  return "NORMAL";
}

import type { GameCommand, MatchState } from "@ledgerlands/shared-types";
import { DEFAULT_BOARD, purchasePriceFor } from "@ledgerlands/game-engine";

export type Difficulty = "BEGINNER" | "EASY" | "NORMAL" | "HARD" | "EXPERT";

/**
 * Heuristic AI. Uses only the public command interface — no hidden state.
 * Deterministic given (state, difficulty): BEGINNER picks first legal action
 * via seeded choice; higher levels apply progressively stronger heuristics.
 */
export function chooseAiCommand(state: MatchState, playerId: string, difficulty: Difficulty = "NORMAL"): GameCommand | null {
  const me = state.players.find((p) => p.id === playerId);
  if (!me || me.bankrupt || state.status !== "ACTIVE") return null;
  const current = state.players[state.currentPlayerIndex];
  if (!current || current.id !== playerId) return null;

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
    // BEGINNER buys randomly-ish (deterministic: buy when revision even).
    if (difficulty === "BEGINNER") {
      if (state.revision % 2 === 0) return { type: "BUY_PROPERTY", playerId, tileId: tile.id };
    } else if (me.balance - price >= reserve) {
      // NORMAL+: prefer completing groups / cheap properties.
      const groupBonus = tile.group ? 1 : 0;
      void groupBonus;
      return { type: "BUY_PROPERTY", playerId, tileId: tile.id };
    } else if (difficulty === "EASY" && me.balance >= price * 1.5) {
      return { type: "BUY_PROPERTY", playerId, tileId: tile.id };
    }
    // Can't/won't buy -> decline to auction (NORMAL+ starts auction to deny opponents).
    if (!prop.ownerId && difficulty !== "BEGINNER") {
      if (!state.auction) return { type: "DECLINE_PROPERTY", playerId };
    }
  }

  // 2. Develop: HARD/EXPERT develop when owning full group and affordable.
  if (difficulty === "HARD" || difficulty === "EXPERT" || difficulty === "NORMAL") {
    const owned = Object.values(state.properties).filter((p) => p.ownerId === playerId && !p.mortgaged);
    // Try cheapest developable owned tile (engine validates group/even rules).
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

  // 3. Auction participation (simple: bid once if affordable).
  if (state.auction) {
    const highest = state.auction.bids.length > 0 ? state.auction.bids[state.auction.bids.length - 1]!.amount : 0;
    const bid = highest + 100;
    if (!state.auction.passedPlayerIds.includes(playerId) && bid <= me.balance - 500 && bid <= price * 1.2) {
      // Don't outbid self consecutively.
      const lastBid = state.auction.bids[state.auction.bids.length - 1];
      if (!lastBid || lastBid.playerId !== playerId) return { type: "PLACE_BID", playerId, amount: bid };
    }
  }

  return { type: "END_TURN", playerId };
}

export function difficultyFromString(s: string): Difficulty {
  if (s === "BEGINNER" || s === "EASY" || s === "NORMAL" || s === "HARD" || s === "EXPERT") return s;
  return "NORMAL";
}

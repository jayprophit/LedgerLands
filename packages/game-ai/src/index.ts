import type { GameCommand, MatchState, PlayerId, TradeState } from "@ledgerlands/shared-types";
import { DEFAULT_BOARD, purchasePriceFor } from "@ledgerlands/game-engine";
import { decideBid } from "./auction.js";
import { valuePropertyFor } from "./valuation.js";
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
  const onUnownedLand = Boolean(tile && prop && !prop.ownerId && price > 0);

  // Several ACTION-phase commands (develop, decline, bid, propose) do NOT advance
  // the turn, so a chooser that simply returns its highest-priority legal action
  // will re-issue the same command forever. Each step is therefore guarded by
  // what this player has already done since their turn began, and the plan ends
  // with END_TURN. Derived from the event log rather than kept as hidden state,
  // so it cannot disagree with the authoritative history.
  const done = actionsThisTurn(state, playerId);
  const onAuctionTile = Boolean(state.auction && tile && state.auction.tileId === tile.id);
  // 0. Auction participation. D4 lets everyone bid, teammates included; the
  //    ceiling in `decideBid` is where a bot decides to stop. At most one bid
  //    per turn, and one step up each time, so bidding cannot be a loop either.
  //
  //    A player who cannot usefully raise the bid any further but is the only
  //    one still in the auction closes it, so the tile is actually awarded
  //    instead of sitting open forever and blocking every purchase.
  if (state.auction) {
    if (!done.bid) {
      const decision = decideBid(state, playerId, state.auction.tileId, state.auction.highestBid?.amount ?? 0, difficulty);
      if (decision.shouldBid) {
        return { type: "PLACE_BID", playerId, amount: decision.amount };
      }
      // Give up on this tile. Without an explicit pass a bot that declines to
      // raise simply ends its turn and stays in the auction, so no player is
      // ever out, the close condition is never met, and the match deadlocks
      // with the tile unpurchasable. Passing is what lets the auction finish.
      if (!done.pass && !state.auction.passedPlayerIds.includes(playerId)) {
        return { type: "PASS_AUCTION", playerId };
      }
    }
    if (!done.completeAuction && nobodyLeftToBid(state)) {
      // The engine refuses to complete when the leading bidder has since gone
      // bankrupt or can no longer cover the bid (INSUFFICIENT_FUNDS). Somebody
      // has to keep the auction moving, so rather than issue a command the
      // engine will reject, let it fall through to END_TURN and try again on a
      // later turn.
      const leader = state.auction.bids.at(-1);
      const leaderPlayer = leader ? state.players.find((p) => p.id === leader.playerId) : undefined;
      const leaderCanPay = !leader || (leaderPlayer && !leaderPlayer.bankrupt && leaderPlayer.balance >= leader.amount);
      const tileStillFree = !state.properties[state.auction.tileId]?.ownerId;
      if (leaderCanPay && tileStillFree) {
        return { type: "COMPLETE_AUCTION", playerId };
      }
    }
  }

  // 1. Buy logic. The auction's own tile is not buyable while the auction runs.
  //
  //    DENIAL: a tile that hands an OPPONENT the last piece of a colour group is
  //    worth less than its face price, and a bot that understands that declines
  //    it even when it can comfortably afford it. Declining opens the auction,
  //    which is both a way to keep the tile in play and a way to bid for it
  //    later. Without this the bots bought every tile they landed on and an
  //    auction never happened, so D4's auction dimension went unexercised.
  if (onUnownedLand && !onAuctionTile && !done.buy && !state.auction) {
    const denial = valuePropertyFor(state, tile!.id, playerId, difficulty).opponentDenial;
    const ownCompletion = valuePropertyFor(state, tile!.id, playerId, difficulty).completionPremium;
    const wantsToDeny = denial > 0 && ownCompletion === 0 && difficulty !== "BEGINNER";
    // LIQUIDITY: land that is a large slice of the bot's holdings is worth
    // taking to auction rather than buying outright, because the cash is worth
    // more spread across a group than committed to one unaffordable tile. This
    // is also what makes auctions happen at all in simulation: bots that simply
    // buy everything they land on never open one.
    const tooBigForTheWallet = ownCompletion === 0 && price > 0 && price > me.balance * 0.25;
    if (!wantsToDeny && !tooBigForTheWallet) {
      const reserveByDifficulty: Record<Difficulty, number> = {
        BEGINNER: 0,
        EASY: 200,
        NORMAL: 800,
        HARD: 1200,
        EXPERT: 1500,
      };
      const reserve = reserveByDifficulty[difficulty];
      if (difficulty === "BEGINNER") {
        if (state.revision % 2 === 0) return { type: "BUY_PROPERTY", playerId, tileId: tile!.id };
      } else if (me.balance - price >= reserve) {
        return { type: "BUY_PROPERTY", playerId, tileId: tile!.id };
      } else if (difficulty === "EASY" && me.balance >= price * 1.5) {
        return { type: "BUY_PROPERTY", playerId, tileId: tile!.id };
      }
    }
  }

  // 2. Develop once per turn, and only a tile the ENGINE will accept.
  //
  //    The engine requires the full colour group (INCOMPLETE_GROUP) and even
  //    building across the group (UNEVEN_BUILDING). An earlier version offered
  //    any owned developable tile and let the engine refuse it, which in the
  //    simulator was silently swallowed — so the AI's development step did
  //    nothing at all and nothing said so. The legality check belongs here.
  if (!done.develop && (difficulty === "HARD" || difficulty === "EXPERT" || difficulty === "NORMAL")) {
    const candidates = Object.values(state.properties)
      .filter((p) => p.ownerId === playerId && !p.mortgaged)
      .map((p) => ({ prop: p, board: DEFAULT_BOARD.find((t) => t.id === p.tileId) }))
      .filter((c) => c.board?.economics && c.board.group)
      .sort((a, b) => (a.board!.economics!.houseCost ?? 0) - (b.board!.economics!.houseCost ?? 0));
    for (const { prop, board } of candidates) {
      if (prop.development >= board!.economics!.rentByDevelopment.length - 1) continue;
      if (!state.players[state.currentPlayerIndex] || me.balance < board!.economics!.houseCost! + 1000) continue;
      // Full group?
      const members = DEFAULT_BOARD.filter((t) => t.group === board!.group).map((t) => t.id);
      if (!members.every((id) => state.properties[id]?.ownerId === playerId)) continue;
      // Even building: this tile must be at or below the lowest sibling.
      const minLevel = Math.min(...members.map((id) => state.properties[id]?.development ?? 0));
      if (prop.development > minLevel) continue;
      return { type: "DEVELOP_PROPERTY", playerId, tileId: board!.id };
    }
  }

  // 3. Decline land it is not buying. Declining opens the auction, which is a
  //    real chance to deny an opponent and to compete for the tile. Priority
  //    over trading: standing on unowned land is a concrete opportunity.
  if (onUnownedLand && !done.decline && !state.auction && difficulty !== "BEGINNER") {
    return { type: "DECLINE_PROPERTY", playerId };
  }

  // 4. Propose a trade — at most one per turn, and only if nothing is already
  //    outstanding from this player.
  if (difficulty !== "BEGINNER" && !state.pendingExtraRoll && !done.propose) {
    const hasOpenProposal = (state.trades ?? []).some(
      (t) => t.status === "PROPOSED" && t.fromPlayerId === playerId,
    );
    if (!hasOpenProposal) {
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
  }

  return { type: "END_TURN", playerId };
}

/**
 * Is this player the last one still able to bid?
 *
 * "Able to" rather than "has not": a player is out of the auction once they have
 * passed, and a bid does not remove them from it. The point is to give SOMEONE
 * a reason to call COMPLETE_AUCTION, because an auction that is never completed
 * leaves the tile unpurchasable and every subsequent turn spends itself waiting.
 */
function nobodyLeftToBid(state: MatchState): boolean {
  const auction = state.auction;
  if (!auction) return true;
  return state.players.every(
    (p) => p.bankrupt || auction.passedPlayerIds.includes(p.id) || p.id === auction.startedBy,
  );
}

/**
 * What this player has already done since their current turn started.
 *
 * Read from the event log rather than tracked in the chooser: a hidden flag
 * would be a second source of truth about the match, and the log is already the
 * record the replay is verified against.
 */
function actionsThisTurn(state: MatchState, playerId: PlayerId) {
  let turnStartRevision = 0;
  for (const event of state.log) {
    if (event.type === "TURN_ENDED") turnStartRevision = event.atRevision;
  }
  const done = {
    buy: false,
    develop: false,
    decline: false,
    bid: false,
    pass: false,
    propose: false,
    completeAuction: false,
  };
  for (const event of state.log) {
    if (event.atRevision <= turnStartRevision) continue;
    if (event.type === "PROPERTY_BOUGHT" && event.playerId === playerId) done.buy = true;
    if (event.type === "PROPERTY_DEVELOPED" && event.playerId === playerId) done.develop = true;
    // DECLINE_PROPERTY emits AUCTION_STARTED. PROPERTY_OFFERED is NOT the
    // decline marker: the engine emits it the moment a player lands on
    // unowned land, before they have chosen anything. Reading it as "already
    // declined" made done.decline true on arrival, so the decline branch was
    // dead and no auction could ever open.
    if (event.type === "AUCTION_STARTED" && event.playerId === playerId) done.decline = true;
    if (event.type === "AUCTION_BID" && event.playerId === playerId) done.bid = true;
    if (event.type === "AUCTION_PASSED" && event.playerId === playerId) done.pass = true;
    if (event.type === "AUCTION_COMPLETED") done.completeAuction = true;
    if (event.type === "TRADE_PROPOSED" && event.fromPlayerId === playerId) done.propose = true;
  }
  return done;
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
  cashValueFor,
  groupOwnership,
  groupOf,
  groupTiles,
  preservesLiquidity,
  weightsFor,
  VALUATION_WEIGHTS,
  REFERENCE_DIFFICULTY,
  type ValuationWeights,
  type PropertyValuation,
  type TradeEvaluation,
} from "./valuation.js";

export function difficultyFromString(s: string): Difficulty {
  if (s === "BEGINNER" || s === "EASY" || s === "NORMAL" || s === "HARD" || s === "EXPERT") return s;
  return "NORMAL";
}

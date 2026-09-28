import type {
  BoardTile,
  GameCommand,
  GameEvent,
  MatchState,
  PlayerId,
  PlayerState,
  PropertyState,
  TradeState,
} from "@ledgerlands/shared-types";
import { DEFAULT_BOARD, DETENTION_INDEX } from "./board.js";
import { drawCardIndex, SIGNAL_DECK } from "./cards.js";
import { getRuleset, type Ruleset } from "./rules.js";

export interface EngineOptions {
  board?: readonly BoardTile[];
  passStartReward?: number;
  detentionFine?: number;
  rulesetVersion?: string;
}

const DEFAULT_OPTIONS: Required<Omit<EngineOptions, "rulesetVersion">> & { rulesetVersion: string } = {
  board: DEFAULT_BOARD,
  passStartReward: 200,
  detentionFine: 50,
  rulesetVersion: "classic-v1",
};

export class GameRuleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

function resolveRules(stateRuleset: string | undefined, overrides: EngineOptions): Ruleset {
  const base = getRuleset(stateRuleset ?? overrides.rulesetVersion ?? "classic-v1");
  return {
    ...base,
    passStartReward: overrides.passStartReward ?? base.passStartReward,
    detentionFine: overrides.detentionFine ?? base.detentionFine,
  };
}

export function createMatchState(params: {
  id: string;
  seed: number;
  players: Array<{ id: string; name: string; balance?: number }>;
  options?: EngineOptions;
}): MatchState {
  const options = { ...DEFAULT_OPTIONS, ...params.options };
  if (params.players.length < 1 || params.players.length > 4) {
    throw new GameRuleError("INVALID_PLAYER_COUNT", "A match requires 1 to 4 players.");
  }

  const properties: Record<string, PropertyState> = {};
  for (const tile of options.board) {
    if (tile.economics || tile.type === "TRANSIT" || tile.type === "SERVICE") {
      properties[tile.id] = { tileId: tile.id, development: 0, mortgaged: false };
    }
  }

  const players: PlayerState[] = params.players.map((p) => ({
    id: p.id,
    name: p.name,
    position: 0,
    balance: p.balance ?? 15000,
    inDetention: false,
    detentionTurns: 0,
    doublesStreak: 0,
    bankrupt: false,
    detentionCards: 0,
  }));

  return {
    id: params.id,
    status: "LOBBY",
    turn: 0,
    currentPlayerIndex: 0,
    turnPhase: "ROLL",
    pendingExtraRoll: false,
    players,
    properties,
    seed: params.seed >>> 0,
    rngState: params.seed >>> 0,
    revision: 0,
    log: [],
    trades: [],
    deckCursor: 0,
    rulesetVersion: options.rulesetVersion,
  };
}

function nextRandom(state: MatchState): number {
  let x = state.rngState || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState = x >>> 0;
  return state.rngState / 0x1_0000_0000;
}

function rollDie(state: MatchState): number {
  return 1 + Math.floor(nextRandom(state) * 6);
}

function currentPlayer(state: MatchState): PlayerState {
  const player = state.players[state.currentPlayerIndex];
  if (!player) throw new GameRuleError("NO_CURRENT_PLAYER", "No current player exists.");
  return player;
}

function getPlayer(state: MatchState, id: PlayerId): PlayerState {
  const player = state.players.find((p) => p.id === id);
  if (!player) throw new GameRuleError("PLAYER_NOT_FOUND", `Player ${id} was not found.`);
  return player;
}

function cardsOf(player: PlayerState): number {
  return player.detentionCards ?? 0;
}

type StripRevision<T> = T extends unknown ? Omit<T, "atRevision"> : never;
type EventWithoutRevision = StripRevision<GameEvent>;

function pushEvent(state: MatchState, event: EventWithoutRevision): void {
  state.revision += 1;
  state.log.push({ ...event, atRevision: state.revision } as GameEvent);
}

function settleBankruptcy(state: MatchState, player: PlayerState, creditorId?: PlayerId): void {
  if (player.balance >= 0 || player.bankrupt) return;
  player.bankrupt = true;
  player.balance = 0;
  if (player.detentionCards) player.detentionCards = 0;
  const creditor = creditorId ? state.players.find((p) => p.id === creditorId && !p.bankrupt) : undefined;
  for (const property of Object.values(state.properties)) {
    if (property.ownerId === player.id) {
      if (creditor) {
        property.ownerId = creditor.id;
      } else {
        delete property.ownerId;
        property.development = 0;
        property.mortgaged = false;
      }
    }
  }
  // Cancel pending trades involving the bankrupt player.
  for (const t of state.trades ?? []) {
    if (t.status === "PROPOSED" && (t.fromPlayerId === player.id || t.toPlayerId === player.id)) {
      t.status = "CANCELLED";
      pushEvent(state, { type: "TRADE_CANCELLED", tradeId: t.id });
    }
  }
  // Cancel auction started by bankrupt player.
  if (state.auction && state.auction.startedBy === player.id) {
    const tileId = state.auction.tileId;
    delete state.auction;
    pushEvent(state, { type: "AUCTION_COMPLETED", tileId });
  }
  pushEvent(state, { type: "PLAYER_BANKRUPT", playerId: player.id });
  maybeCompleteMatch(state);
}

function markBankruptIfNeeded(state: MatchState, player: PlayerState, creditorId?: PlayerId): void {
  settleBankruptcy(state, player, creditorId);
}

function activePlayers(state: MatchState): PlayerState[] {
  return state.players.filter((p) => !p.bankrupt);
}

function maybeCompleteMatch(state: MatchState): void {
  const active = activePlayers(state);
  if (state.status === "ACTIVE" && state.players.length > 1 && active.length === 1) {
    state.status = "COMPLETED";
    state.winnerId = active[0]!.id;
    pushEvent(state, { type: "MATCH_COMPLETED", winnerId: active[0]!.id });
  }
}

function purchasableTiles(board: readonly BoardTile[]): BoardTile[] {
  return board.filter((t) => t.economics || t.type === "TRANSIT" || t.type === "SERVICE");
}

export function purchasePriceFor(tile: BoardTile): number {
  return tile.economics?.purchasePrice ?? tile.amount ?? 0;
}

export function mortgageValueFor(tile: BoardTile): number {
  if (tile.economics?.mortgageValue !== undefined) return tile.economics.mortgageValue;
  return Math.floor(purchasePriceFor(tile) / 2);
}

function groupTiles(board: readonly BoardTile[], group: string): BoardTile[] {
  return board.filter((t) => t.group === group && t.economics);
}

function ownsFullGroup(state: MatchState, playerId: string, board: readonly BoardTile[], group: string): boolean {
  const tiles = groupTiles(board, group);
  if (tiles.length === 0) return false;
  return tiles.every((t) => state.properties[t.id]?.ownerId === playerId);
}

function countOwnedByType(state: MatchState, ownerId: string, board: readonly BoardTile[], type: "TRANSIT" | "SERVICE"): number {
  return board.filter((t) => t.type === type && state.properties[t.id]?.ownerId === ownerId).length;
}

function rentFor(state: MatchState, tile: BoardTile, property: PropertyState, rules: Ruleset, board: readonly BoardTile[]): number {
  if (tile.type === "TRANSIT") {
    const count = Math.max(1, countOwnedByType(state, property.ownerId ?? "", board, "TRANSIT"));
    return rules.transitBaseRent * count;
  }
  if (tile.type === "SERVICE") {
    const count = Math.max(1, countOwnedByType(state, property.ownerId ?? "", board, "SERVICE"));
    return rules.serviceBaseRent * count;
  }
  if (tile.economics) {
    const levels = tile.economics.rentByDevelopment;
    const base = levels[Math.min(property.development, levels.length - 1)] ?? 0;
    if (property.development === 0 && tile.group && property.ownerId && ownsFullGroup(state, property.ownerId, board, tile.group)) {
      return base * rules.monopolyRentMultiplier;
    }
    return base;
  }
  return 0;
}

function taxFor(tile: BoardTile, playerBalance: number): number {
  const fixed = tile.amount ?? 0;
  if (tile.percent !== undefined && tile.percent > 0) {
    const pct = Math.floor(playerBalance * tile.percent);
    if (fixed > 0) return Math.min(fixed, pct);
    return pct;
  }
  return fixed;
}

function applyCardEffect(
  state: MatchState,
  player: PlayerState,
  cardIndex: number,
  board: readonly BoardTile[],
  rules: Ruleset,
): void {
  const card = SIGNAL_DECK[cardIndex % SIGNAL_DECK.length]!;
  state.deckCursor = (state.deckCursor ?? 0) + 1;
  let amount: number | undefined;
  switch (card.effect) {
    case "GAIN":
    case "COLLECT_FROM_BANK":
      amount = card.amount ?? 0;
      player.balance += amount;
      pushEvent(state, { type: "CARD_DRAWN", playerId: player.id, cardId: card.id, title: card.title, amount });
      break;
    case "PAY":
      amount = card.amount ?? 0;
      player.balance -= amount;
      pushEvent(state, { type: "CARD_DRAWN", playerId: player.id, cardId: card.id, title: card.title, amount });
      markBankruptIfNeeded(state, player);
      break;
    case "GET_OUT_CARD":
      player.detentionCards = cardsOf(player) + 1;
      pushEvent(state, { type: "CARD_DRAWN", playerId: player.id, cardId: card.id, title: card.title });
      break;
    case "GO_TO_DETENTION":
      player.position = DETENTION_INDEX;
      player.inDetention = true;
      player.detentionTurns = 0;
      player.doublesStreak = 0;
      pushEvent(state, { type: "CARD_DRAWN", playerId: player.id, cardId: card.id, title: card.title });
      pushEvent(state, { type: "SENT_TO_DETENTION", playerId: player.id });
      break;
    case "ADVANCE":
    case "RETREAT": {
      const spaces = card.spaces ?? 0;
      const from = player.position;
      const delta = card.effect === "ADVANCE" ? spaces : -spaces;
      const raw = from + delta;
      let to = raw % board.length;
      if (to < 0) to += board.length;
      if (card.effect === "ADVANCE" && raw >= board.length) {
        player.balance += rules.passStartReward;
        pushEvent(state, { type: "PASSED_START", playerId: player.id, amount: rules.passStartReward });
      }
      player.position = to;
      pushEvent(state, { type: "CARD_DRAWN", playerId: player.id, cardId: card.id, title: card.title });
      pushEvent(state, { type: "PLAYER_MOVED", playerId: player.id, from, to });
      // Resolve the destination once (no chained card draws to avoid recursion loops).
      resolveLandingSimple(state, player, board, rules);
      break;
    }
  }
}

function resolveLandingSimple(state: MatchState, player: PlayerState, board: readonly BoardTile[], rules: Ruleset): void {
  const tile = board[player.position];
  if (!tile) throw new GameRuleError("INVALID_TILE", "Player landed outside the board.");

  if (tile.type === "TAX") {
    const amount = taxFor(tile, player.balance);
    player.balance -= amount;
    pushEvent(state, { type: "TAX_PAID", playerId: player.id, tileId: tile.id, amount });
    markBankruptIfNeeded(state, player);
    return;
  }

  if (tile.type === "GO_TO_DETENTION") {
    player.position = DETENTION_INDEX;
    player.inDetention = true;
    player.detentionTurns = 0;
    player.doublesStreak = 0;
    pushEvent(state, { type: "SENT_TO_DETENTION", playerId: player.id });
    return;
  }

  const property = state.properties[tile.id];
  if (property?.ownerId && property.ownerId !== player.id && !property.mortgaged) {
    const owner = getPlayer(state, property.ownerId);
    const amount = rentFor(state, tile, property, rules, board);
    player.balance -= amount;
    owner.balance += amount;
    pushEvent(state, {
      type: "RENT_PAID",
      fromPlayerId: player.id,
      toPlayerId: owner.id,
      tileId: tile.id,
      amount,
    });
    markBankruptIfNeeded(state, player, owner.id);
    return;
  }

  if (property && !property.ownerId && (tile.economics || tile.type === "TRANSIT" || tile.type === "SERVICE")) {
    pushEvent(state, { type: "PROPERTY_OFFERED", playerId: player.id, tileId: tile.id });
  }
}

function resolveLanding(state: MatchState, player: PlayerState, board: readonly BoardTile[], rules: Ruleset): void {
  const tile = board[player.position];
  if (!tile) throw new GameRuleError("INVALID_TILE", "Player landed outside the board.");

  if (tile.type === "EVENT") {
    const idx = drawCardIndex(nextRandom(state));
    applyCardEffect(state, player, idx, board, rules);
    return;
  }
  resolveLandingSimple(state, player, board, rules);
}

function advanceTurn(state: MatchState): void {
  if (state.status !== "ACTIVE") return;
  const current = currentPlayer(state);
  const active = activePlayers(state);
  if (active.length <= 1 && state.players.length > 1) {
    maybeCompleteMatch(state);
    return;
  }

  let nextIndex = state.currentPlayerIndex;
  for (let i = 0; i < state.players.length; i += 1) {
    nextIndex = (nextIndex + 1) % state.players.length;
    if (!state.players[nextIndex]!.bankrupt) break;
  }
  state.currentPlayerIndex = nextIndex;
  state.turn += 1;
  const next = currentPlayer(state);
  pushEvent(state, { type: "TURN_ENDED", playerId: current.id, nextPlayerId: next.id });
}

function requireActionPhase(state: MatchState): void {
  if (state.turnPhase !== "ACTION") throw new GameRuleError("ROLL_REQUIRED", "Roll before acting.");
}

function validateTradeSides(
  state: MatchState,
  fromId: PlayerId,
  toId: PlayerId,
  offer: TradeState["offer"],
  request: TradeState["request"],
): void {
  if (fromId === toId) throw new GameRuleError("INVALID_TRADE", "Cannot trade with yourself.");
  const from = getPlayer(state, fromId);
  const to = getPlayer(state, toId);
  if (from.bankrupt || to.bankrupt) throw new GameRuleError("INVALID_TRADE", "Bankrupt players cannot trade.");
  for (const amt of [offer.sats ?? 0, request.sats ?? 0]) {
    if (!Number.isSafeInteger(amt) || amt < 0) throw new GameRuleError("INVALID_TRADE", "Trade sats must be non-negative integers.");
  }
  const checkProps = (ownerId: string, ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      const prop = state.properties[id];
      if (!prop) throw new GameRuleError("INVALID_TRADE", `Unknown property ${id}.`);
      if (prop.ownerId !== ownerId) throw new GameRuleError("INVALID_TRADE", `Player does not own ${id}.`);
      if (prop.development > 0) throw new GameRuleError("DEVELOPED_PROPERTY", "Sell buildings before trading a property.");
    }
  };
  checkProps(fromId, offer.propertyIds);
  checkProps(toId, request.propertyIds);
  if ((offer.sats ?? 0) > from.balance) throw new GameRuleError("INSUFFICIENT_FUNDS", "Offeror lacks offered sats.");
  if ((request.sats ?? 0) > to.balance) throw new GameRuleError("INSUFFICIENT_FUNDS", "Counterparty lacks requested sats.");
  if ((offer.sats ?? 0) === 0 && (offer.propertyIds ?? []).length === 0) {
    throw new GameRuleError("INVALID_TRADE", "Offer must include sats or a property.");
  }
}

export function applyCommand(
  original: MatchState,
  command: GameCommand,
  engineOptions?: EngineOptions,
): MatchState {
  const options = { ...DEFAULT_OPTIONS, ...engineOptions };
  const board = options.board;
  const state = structuredClone(original) as MatchState;
  if (!state.trades) state.trades = [];
  if (state.deckCursor === undefined) state.deckCursor = 0;
  if (!state.rulesetVersion) state.rulesetVersion = options.rulesetVersion;
  const rules = resolveRules(state.rulesetVersion, options);

  if (command.type === "START_MATCH") {
    if (state.status !== "LOBBY") throw new GameRuleError("MATCH_ALREADY_STARTED", "Match already started.");
    state.status = "ACTIVE";
    state.turnPhase = "ROLL";
    state.pendingExtraRoll = false;
    pushEvent(state, { type: "MATCH_STARTED" });
    return state;
  }

  if (state.status !== "ACTIVE") {
    throw new GameRuleError("MATCH_NOT_ACTIVE", "Command requires an active match.");
  }

  if (command.type === "ROLL_DICE") {
    if (state.turnPhase !== "ROLL") throw new GameRuleError("ACTION_REQUIRED", "Finish the current turn actions first.");
    const player = currentPlayer(state);
    if (player.bankrupt) throw new GameRuleError("BANKRUPT_PLAYER", "Bankrupt player cannot roll.");

    const d1 = rollDie(state);
    const d2 = rollDie(state);
    state.lastDice = [d1, d2];
    pushEvent(state, { type: "DICE_ROLLED", playerId: player.id, dice: [d1, d2] });

    const isDouble = d1 === d2;
    if (player.inDetention) {
      player.detentionTurns += 1;
      if (isDouble) {
        player.inDetention = false;
        player.detentionTurns = 0;
      } else if (player.detentionTurns >= rules.maxDetentionTurns) {
        player.balance -= rules.detentionFine;
        player.inDetention = false;
        player.detentionTurns = 0;
        pushEvent(state, { type: "DETENTION_FINE_PAID", playerId: player.id, amount: rules.detentionFine });
        markBankruptIfNeeded(state, player);
        if (player.bankrupt) return state;
      } else {
        state.turnPhase = "ROLL";
        state.pendingExtraRoll = false;
        advanceTurn(state);
        return state;
      }
    }

    player.doublesStreak = isDouble ? player.doublesStreak + 1 : 0;
    if (player.doublesStreak >= 3) {
      player.position = DETENTION_INDEX;
      player.inDetention = true;
      player.detentionTurns = 0;
      player.doublesStreak = 0;
      pushEvent(state, { type: "SENT_TO_DETENTION", playerId: player.id });
      state.turnPhase = "ROLL";
      state.pendingExtraRoll = false;
      advanceTurn(state);
      return state;
    }

    const from = player.position;
    const steps = d1 + d2;
    const raw = from + steps;
    const to = raw % board.length;
    if (raw >= board.length) {
      player.balance += rules.passStartReward;
      pushEvent(state, { type: "PASSED_START", playerId: player.id, amount: rules.passStartReward });
    }
    player.position = to;
    pushEvent(state, { type: "PLAYER_MOVED", playerId: player.id, from, to });
    resolveLanding(state, player, board, rules);

    if (player.bankrupt || player.inDetention || state.status !== "ACTIVE") {
      state.turnPhase = "ROLL";
      state.pendingExtraRoll = false;
      if (state.status === "ACTIVE") advanceTurn(state);
      return state;
    }

    state.turnPhase = "ACTION";
    state.pendingExtraRoll = isDouble;
    return state;
  }

  if (command.type === "BUY_PROPERTY") {
    requireActionPhase(state);
    const player = getPlayer(state, command.playerId);
    if (currentPlayer(state).id !== player.id) throw new GameRuleError("NOT_YOUR_TURN", "Only current player may buy.");
    if (player.bankrupt) throw new GameRuleError("BANKRUPT_PLAYER", "Bankrupt player cannot buy.");
    const tile = board[player.position];
    if (!tile || tile.id !== command.tileId) throw new GameRuleError("NOT_ON_TILE", "Player is not on requested tile.");
    const property = state.properties[tile.id];
    if (!property) throw new GameRuleError("NOT_PURCHASABLE", "Tile is not purchasable.");
    if (property.ownerId) throw new GameRuleError("ALREADY_OWNED", "Property is already owned.");
    const price = purchasePriceFor(tile);
    if (price <= 0) throw new GameRuleError("NO_PRICE", "Property has no purchase price.");
    if (player.balance < price) throw new GameRuleError("INSUFFICIENT_FUNDS", "Not enough practice balance.");
    player.balance -= price;
    property.ownerId = player.id;
    pushEvent(state, { type: "PROPERTY_BOUGHT", playerId: player.id, tileId: tile.id, amount: price });
    return state;
  }

  if (command.type === "DECLINE_PROPERTY") {
    requireActionPhase(state);
    const player = getPlayer(state, command.playerId);
    if (currentPlayer(state).id !== player.id) throw new GameRuleError("NOT_YOUR_TURN", "Only current player may decline.");
    const tile = board[player.position];
    if (!tile) throw new GameRuleError("INVALID_TILE", "Player is not on a tile.");
    const property = state.properties[tile.id];
    if (!property || property.ownerId) throw new GameRuleError("NOT_AUCTIONABLE", "Current tile cannot be auctioned.");
    if (state.auction) throw new GameRuleError("AUCTION_ACTIVE", "An auction is already active.");
    state.auction = { tileId: tile.id, startedBy: player.id, bids: [], passedPlayerIds: [] };
    pushEvent(state, { type: "AUCTION_STARTED", playerId: player.id, tileId: tile.id });
    return state;
  }

  if (command.type === "START_AUCTION") {
    const player = getPlayer(state, command.playerId);
    if (player.bankrupt) throw new GameRuleError("BANKRUPT_PLAYER", "Bankrupt player cannot start auctions.");
    const tile = board.find((t) => t.id === command.tileId);
    if (!tile) throw new GameRuleError("INVALID_TILE", "Unknown tile.");
    const property = state.properties[tile.id];
    if (!property || property.ownerId) throw new GameRuleError("NOT_AUCTIONABLE", "Tile cannot be auctioned.");
    if (state.auction) throw new GameRuleError("AUCTION_ACTIVE", "An auction is already active.");
    state.auction = { tileId: tile.id, startedBy: player.id, bids: [], passedPlayerIds: [] };
    pushEvent(state, { type: "AUCTION_STARTED", playerId: player.id, tileId: tile.id });
    return state;
  }

  if (command.type === "PLACE_BID") {
    const auction = state.auction;
    if (!auction) throw new GameRuleError("NO_AUCTION", "No active auction.");
    const player = getPlayer(state, command.playerId);
    if (player.bankrupt) throw new GameRuleError("BANKRUPT_PLAYER", "Bankrupt player cannot bid.");
    if (!Number.isSafeInteger(command.amount) || command.amount <= 0) {
      throw new GameRuleError("INVALID_BID", "Bid must be a positive integer.");
    }
    const highest = auction.bids.length > 0 ? auction.bids[auction.bids.length - 1]! : undefined;
    if (highest && command.amount <= highest.amount) {
      throw new GameRuleError("BID_TOO_LOW", "Bid must exceed the current highest bid.");
    }
    if (command.amount > player.balance) throw new GameRuleError("INSUFFICIENT_FUNDS", "Bid exceeds balance.");
    auction.bids.push({ playerId: player.id, amount: command.amount });
    auction.highestBid = { playerId: player.id, amount: command.amount };
    auction.passedPlayerIds = auction.passedPlayerIds.filter((id) => id !== player.id);
    pushEvent(state, { type: "AUCTION_BID", playerId: player.id, tileId: auction.tileId, amount: command.amount });
    return state;
  }

  if (command.type === "PASS_AUCTION") {
    const auction = state.auction;
    if (!auction) throw new GameRuleError("NO_AUCTION", "No active auction.");
    const player = getPlayer(state, command.playerId);
    if (!auction.passedPlayerIds.includes(player.id)) auction.passedPlayerIds.push(player.id);
    pushEvent(state, { type: "AUCTION_PASSED", playerId: player.id, tileId: auction.tileId });
    return state;
  }

  if (command.type === "COMPLETE_AUCTION") {
    const auction = state.auction;
    if (!auction) throw new GameRuleError("NO_AUCTION", "No active auction.");
    getPlayer(state, command.playerId); // validates actor exists
    const highest = auction.bids.length > 0 ? auction.bids[auction.bids.length - 1]! : undefined;
    const tileId = auction.tileId;
    if (!highest) {
      delete state.auction;
      pushEvent(state, { type: "AUCTION_COMPLETED", tileId });
      return state;
    }
    const winner = getPlayer(state, highest.playerId);
    const property = state.properties[tileId];
    if (!property || property.ownerId) throw new GameRuleError("NOT_AUCTIONABLE", "Auction tile is no longer available.");
    if (winner.bankrupt) throw new GameRuleError("BANKRUPT_PLAYER", "Auction winner is bankrupt.");
    if (winner.balance < highest.amount) throw new GameRuleError("INSUFFICIENT_FUNDS", "Winner can no longer cover the bid.");
    winner.balance -= highest.amount;
    property.ownerId = winner.id;
    delete state.auction;
    pushEvent(state, { type: "AUCTION_COMPLETED", tileId, winnerId: winner.id, amount: highest.amount });
    return state;
  }

  if (command.type === "DEVELOP_PROPERTY") {
    requireActionPhase(state);
    const player = getPlayer(state, command.playerId);
    const tile = board.find((t) => t.id === command.tileId);
    if (!tile?.economics) throw new GameRuleError("NOT_DEVELOPABLE", "Tile cannot be developed.");
    const property = state.properties[command.tileId];
    if (!property || property.ownerId !== player.id) throw new GameRuleError("NOT_OWNER", "Player does not own this property.");
    if (property.mortgaged) throw new GameRuleError("MORTGAGED", "Cannot develop a mortgaged property.");
    if (tile.group && !ownsFullGroup(state, player.id, board, tile.group)) {
      throw new GameRuleError("INCOMPLETE_GROUP", "Own the full group before developing.");
    }
    const maxLevel = Math.min(tile.economics.rentByDevelopment.length - 1, rules.maxDevelopmentLevel);
    if (property.development >= maxLevel) {
      throw new GameRuleError("MAX_DEVELOPMENT", "Property is fully developed.");
    }
    if (rules.evenBuilding && tile.group) {
      const siblings = groupTiles(board, tile.group);
      const levels = siblings.map((s) => state.properties[s.id]?.development ?? 0);
      const min = Math.min(...levels);
      if (property.development > min) {
        throw new GameRuleError("UNEVEN_BUILDING", "Develop evenly across the group.");
      }
    }
    if (player.balance < tile.economics.houseCost) throw new GameRuleError("INSUFFICIENT_FUNDS", "Not enough balance to develop.");
    player.balance -= tile.economics.houseCost;
    property.development += 1;
    pushEvent(state, {
      type: "PROPERTY_DEVELOPED",
      playerId: player.id,
      tileId: command.tileId,
      level: property.development,
      amount: tile.economics.houseCost,
    });
    return state;
  }

  if (command.type === "MORTGAGE_PROPERTY") {
    const player = getPlayer(state, command.playerId);
    const tile = board.find((t) => t.id === command.tileId);
    if (!tile) throw new GameRuleError("INVALID_TILE", "Unknown tile.");
    const property = state.properties[command.tileId];
    if (!property || property.ownerId !== player.id) throw new GameRuleError("NOT_OWNER", "Player does not own this property.");
    if (property.mortgaged) throw new GameRuleError("ALREADY_MORTGAGED", "Property is already mortgaged.");
    if (property.development > 0) throw new GameRuleError("DEVELOPED_PROPERTY", "Sell buildings before mortgaging.");
    const amount = mortgageValueFor(tile);
    property.mortgaged = true;
    player.balance += amount;
    pushEvent(state, { type: "PROPERTY_MORTGAGED", playerId: player.id, tileId: tile.id, amount });
    return state;
  }

  if (command.type === "UNMORTGAGE_PROPERTY") {
    const player = getPlayer(state, command.playerId);
    const tile = board.find((t) => t.id === command.tileId);
    if (!tile) throw new GameRuleError("INVALID_TILE", "Unknown tile.");
    const property = state.properties[command.tileId];
    if (!property || property.ownerId !== player.id) throw new GameRuleError("NOT_OWNER", "Player does not own this property.");
    if (!property.mortgaged) throw new GameRuleError("NOT_MORTGAGED", "Property is not mortgaged.");
    const base = mortgageValueFor(tile);
    const amount = Math.ceil((base * (10000 + rules.unmortgageInterestBps)) / 10000);
    if (player.balance < amount) throw new GameRuleError("INSUFFICIENT_FUNDS", "Not enough balance to unmortgage.");
    player.balance -= amount;
    property.mortgaged = false;
    pushEvent(state, { type: "PROPERTY_UNMORTGAGED", playerId: player.id, tileId: tile.id, amount });
    return state;
  }

  if (command.type === "PROPOSE_TRADE") {
    const from = getPlayer(state, command.playerId);
    if (from.bankrupt) throw new GameRuleError("BANKRUPT_PLAYER", "Bankrupt player cannot trade.");
    validateTradeSides(state, command.playerId, command.toPlayerId, command.offer, command.request);
    const id = `t${(state.trades?.length ?? 0) + 1}-r${state.revision + 1}`;
    const trade: TradeState = {
      id,
      fromPlayerId: command.playerId,
      toPlayerId: command.toPlayerId,
      offer: { sats: command.offer.sats ?? 0, propertyIds: [...(command.offer.propertyIds ?? [])] },
      request: { sats: command.request.sats ?? 0, propertyIds: [...(command.request.propertyIds ?? [])] },
      status: "PROPOSED",
      createdTurn: state.turn,
    };
    state.trades?.push(trade);
    pushEvent(state, { type: "TRADE_PROPOSED", tradeId: id, fromPlayerId: trade.fromPlayerId, toPlayerId: trade.toPlayerId });
    return state;
  }

  if (command.type === "ACCEPT_TRADE") {
    const trade = (state.trades ?? []).find((t) => t.id === command.tradeId);
    if (!trade) throw new GameRuleError("TRADE_NOT_FOUND", "Trade was not found.");
    if (trade.status !== "PROPOSED") throw new GameRuleError("TRADE_NOT_PROPOSED", "Trade is no longer open.");
    if (trade.toPlayerId !== command.playerId) throw new GameRuleError("NOT_TRADE_PARTY", "Only the counterparty may accept.");
    validateTradeSides(state, trade.fromPlayerId, trade.toPlayerId, trade.offer, trade.request);
    const from = getPlayer(state, trade.fromPlayerId);
    const to = getPlayer(state, trade.toPlayerId);
    const offerSats = trade.offer.sats ?? 0;
    const requestSats = trade.request.sats ?? 0;
    from.balance -= offerSats;
    to.balance += offerSats;
    to.balance -= requestSats;
    from.balance += requestSats;
    for (const pid of trade.offer.propertyIds ?? []) {
      state.properties[pid]!.ownerId = to.id;
    }
    for (const pid of trade.request.propertyIds ?? []) {
      state.properties[pid]!.ownerId = from.id;
    }
    trade.status = "ACCEPTED";
    pushEvent(state, { type: "TRADE_ACCEPTED", tradeId: trade.id });
    return state;
  }

  if (command.type === "REJECT_TRADE") {
    const trade = (state.trades ?? []).find((t) => t.id === command.tradeId);
    if (!trade) throw new GameRuleError("TRADE_NOT_FOUND", "Trade was not found.");
    if (trade.status !== "PROPOSED") throw new GameRuleError("TRADE_NOT_PROPOSED", "Trade is no longer open.");
    if (trade.toPlayerId !== command.playerId) throw new GameRuleError("NOT_TRADE_PARTY", "Only the counterparty may reject.");
    trade.status = "REJECTED";
    pushEvent(state, { type: "TRADE_REJECTED", tradeId: trade.id });
    return state;
  }

  if (command.type === "CANCEL_TRADE") {
    const trade = (state.trades ?? []).find((t) => t.id === command.tradeId);
    if (!trade) throw new GameRuleError("TRADE_NOT_FOUND", "Trade was not found.");
    if (trade.status !== "PROPOSED") throw new GameRuleError("TRADE_NOT_PROPOSED", "Trade is no longer open.");
    if (trade.fromPlayerId !== command.playerId) throw new GameRuleError("NOT_TRADE_PARTY", "Only the proposer may cancel.");
    trade.status = "CANCELLED";
    pushEvent(state, { type: "TRADE_CANCELLED", tradeId: trade.id });
    return state;
  }

  if (command.type === "PAY_DETENTION_FINE") {
    const player = getPlayer(state, command.playerId);
    if (!player.inDetention) throw new GameRuleError("NOT_DETAINED", "Player is not detained.");
    if (player.balance < rules.detentionFine) throw new GameRuleError("INSUFFICIENT_FUNDS", "Not enough balance.");
    player.balance -= rules.detentionFine;
    player.inDetention = false;
    player.detentionTurns = 0;
    pushEvent(state, { type: "DETENTION_FINE_PAID", playerId: player.id, amount: rules.detentionFine });
    return state;
  }

  if (command.type === "USE_DETENTION_CARD") {
    const player = getPlayer(state, command.playerId);
    if (!player.inDetention) throw new GameRuleError("NOT_DETAINED", "Player is not detained.");
    if (cardsOf(player) <= 0) throw new GameRuleError("NO_CARD", "Player has no pardon chip.");
    player.detentionCards = cardsOf(player) - 1;
    player.inDetention = false;
    player.detentionTurns = 0;
    pushEvent(state, { type: "DETENTION_CARD_USED", playerId: player.id });
    return state;
  }

  if (command.type === "SURRENDER") {
    const player = getPlayer(state, command.playerId);
    if (player.bankrupt) return state;
    player.bankrupt = true;
    player.balance = Math.min(player.balance, 0);
    if (player.balance < 0) player.balance = 0;
    for (const property of Object.values(state.properties)) {
      if (property.ownerId === player.id) {
        delete property.ownerId;
        property.development = 0;
        property.mortgaged = false;
      }
    }
    for (const t of state.trades ?? []) {
      if (t.status === "PROPOSED" && (t.fromPlayerId === player.id || t.toPlayerId === player.id)) {
        t.status = "CANCELLED";
        pushEvent(state, { type: "TRADE_CANCELLED", tradeId: t.id });
      }
    }
    pushEvent(state, { type: "PLAYER_SURRENDERED", playerId: player.id });
    maybeCompleteMatch(state);
    return state;
  }

  if (command.type === "END_TURN") {
    if (currentPlayer(state).id !== command.playerId) throw new GameRuleError("NOT_YOUR_TURN", "Only current player can end turn.");
    if (state.turnPhase !== "ACTION") throw new GameRuleError("ACTION_NOT_READY", "Roll before ending the turn.");
    if (state.pendingExtraRoll) {
      state.turnPhase = "ROLL";
      state.pendingExtraRoll = false;
      return state;
    }
    state.turnPhase = "ROLL";
    state.pendingExtraRoll = false;
    advanceTurn(state);
    return state;
  }

  return state;
}

/** Rebuild current state from event history + initial snapshot (replay helper for tests/disputes). */
export function replayCommands(
  initial: MatchState,
  commands: GameCommand[],
  engineOptions?: EngineOptions,
): MatchState {
  let state = structuredClone(initial);
  for (const cmd of commands) {
    state = applyCommand(state, cmd, engineOptions);
  }
  return state;
}

export function purchasableTileIds(board: readonly BoardTile[] = DEFAULT_BOARD): string[] {
  return purchasableTiles(board).map((t) => t.id);
}

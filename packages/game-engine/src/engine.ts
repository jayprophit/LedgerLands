import type {
  BoardTile,
  GameCommand,
  GameEvent,
  MatchState,
  PlayerId,
  PlayerState,
  PropertyState,
} from "@ledgerlands/shared-types";
import { DEFAULT_BOARD, DETENTION_INDEX } from "./board.js";

export interface EngineOptions {
  board?: readonly BoardTile[];
  passStartReward?: number;
  detentionFine?: number;
}

const DEFAULT_OPTIONS: Required<EngineOptions> = {
  board: DEFAULT_BOARD,
  passStartReward: 200,
  detentionFine: 50,
};

export class GameRuleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
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

type StripRevision<T> = T extends unknown ? Omit<T, "atRevision"> : never;
type EventWithoutRevision = StripRevision<GameEvent>;

function pushEvent(state: MatchState, event: EventWithoutRevision): void {
  state.revision += 1;
  state.log.push({ ...event, atRevision: state.revision } as GameEvent);
}

function markBankruptIfNeeded(state: MatchState, player: PlayerState): void {
  if (player.balance >= 0 || player.bankrupt) return;
  player.bankrupt = true;
  for (const property of Object.values(state.properties)) {
    if (property.ownerId === player.id) {
      delete property.ownerId;
      property.development = 0;
      property.mortgaged = false;
    }
  }
  pushEvent(state, { type: "PLAYER_BANKRUPT", playerId: player.id });
  maybeCompleteMatch(state);
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

function rentFor(tile: BoardTile, property: PropertyState): number {
  if (tile.economics) {
    const levels = tile.economics.rentByDevelopment;
    return levels[Math.min(property.development, levels.length - 1)] ?? 0;
  }
  if (tile.type === "TRANSIT") return 250;
  if (tile.type === "SERVICE") return 150;
  return 0;
}

function resolveLanding(state: MatchState, player: PlayerState, options: Required<EngineOptions>): void {
  const tile = options.board[player.position];
  if (!tile) throw new GameRuleError("INVALID_TILE", "Player landed outside the board.");

  if (tile.type === "TAX") {
    const amount = tile.amount ?? 0;
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
    const amount = rentFor(tile, property);
    player.balance -= amount;
    owner.balance += amount;
    pushEvent(state, {
      type: "RENT_PAID",
      fromPlayerId: player.id,
      toPlayerId: owner.id,
      tileId: tile.id,
      amount,
    });
    markBankruptIfNeeded(state, player);
  }
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

export function applyCommand(
  original: MatchState,
  command: GameCommand,
  engineOptions?: EngineOptions,
): MatchState {
  const options = { ...DEFAULT_OPTIONS, ...engineOptions };
  const state = structuredClone(original) as MatchState;

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
      } else if (player.detentionTurns >= 3) {
        player.balance -= options.detentionFine;
        player.inDetention = false;
        player.detentionTurns = 0;
        pushEvent(state, { type: "DETENTION_FINE_PAID", playerId: player.id, amount: options.detentionFine });
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
    const to = raw % options.board.length;
    if (raw >= options.board.length) {
      player.balance += options.passStartReward;
      pushEvent(state, { type: "PASSED_START", playerId: player.id, amount: options.passStartReward });
    }
    player.position = to;
    pushEvent(state, { type: "PLAYER_MOVED", playerId: player.id, from, to });
    resolveLanding(state, player, options);

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
    if (state.turnPhase !== "ACTION") throw new GameRuleError("ROLL_REQUIRED", "Roll before buying.");
    const player = getPlayer(state, command.playerId);
    if (currentPlayer(state).id !== player.id) throw new GameRuleError("NOT_YOUR_TURN", "Only current player may buy.");
    const tile = options.board[player.position];
    if (!tile || tile.id !== command.tileId) throw new GameRuleError("NOT_ON_TILE", "Player is not on requested tile.");
    const property = state.properties[tile.id];
    if (!property) throw new GameRuleError("NOT_PURCHASABLE", "Tile is not purchasable.");
    if (property.ownerId) throw new GameRuleError("ALREADY_OWNED", "Property is already owned.");
    const price = tile.economics?.purchasePrice ?? tile.amount ?? 0;
    if (price <= 0) throw new GameRuleError("NO_PRICE", "Property has no purchase price.");
    if (player.balance < price) throw new GameRuleError("INSUFFICIENT_FUNDS", "Not enough practice balance.");
    player.balance -= price;
    property.ownerId = player.id;
    pushEvent(state, { type: "PROPERTY_BOUGHT", playerId: player.id, tileId: tile.id, amount: price });
    return state;
  }

  if (command.type === "DEVELOP_PROPERTY") {
    if (state.turnPhase !== "ACTION") throw new GameRuleError("ROLL_REQUIRED", "Roll before developing.");
    const player = getPlayer(state, command.playerId);
    const tile = options.board.find((t) => t.id === command.tileId);
    if (!tile?.economics) throw new GameRuleError("NOT_DEVELOPABLE", "Tile cannot be developed.");
    const property = state.properties[command.tileId];
    if (!property || property.ownerId !== player.id) throw new GameRuleError("NOT_OWNER", "Player does not own this property.");
    if (property.development >= tile.economics.rentByDevelopment.length - 1) {
      throw new GameRuleError("MAX_DEVELOPMENT", "Property is fully developed.");
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

  if (command.type === "PAY_DETENTION_FINE") {
    const player = getPlayer(state, command.playerId);
    if (!player.inDetention) throw new GameRuleError("NOT_DETAINED", "Player is not detained.");
    if (player.balance < options.detentionFine) throw new GameRuleError("INSUFFICIENT_FUNDS", "Not enough balance.");
    player.balance -= options.detentionFine;
    player.inDetention = false;
    player.detentionTurns = 0;
    pushEvent(state, { type: "DETENTION_FINE_PAID", playerId: player.id, amount: options.detentionFine });
    return state;
  }

  if (command.type === "SURRENDER") {
    const player = getPlayer(state, command.playerId);
    if (player.bankrupt) return state;
    player.bankrupt = true;
    player.balance = Math.min(player.balance, 0);
    for (const property of Object.values(state.properties)) {
      if (property.ownerId === player.id) {
        delete property.ownerId;
        property.development = 0;
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

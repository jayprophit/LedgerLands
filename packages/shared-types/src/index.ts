export type PlayerId = string;
export type MatchId = string;
export type TileId = string;

export type BalanceKind =
  | "practice"
  | "promotional"
  | "locked"
  | "withdrawable"
  | "staked"
  | "pending"
  | "tournament_escrow";

export type TileType =
  | "START"
  | "PROPERTY"
  | "SERVICE"
  | "TRANSIT"
  | "TAX"
  | "EVENT"
  | "DETENTION"
  | "REST"
  | "GO_TO_DETENTION";

export interface PropertyEconomics {
  purchasePrice: number;
  houseCost: number;
  rentByDevelopment: readonly number[];
  mortgageValue?: number;
}

export interface BoardTile {
  id: TileId;
  name: string;
  type: TileType;
  group?: string;
  economics?: PropertyEconomics;
  amount?: number;
}

export interface PropertyState {
  tileId: TileId;
  ownerId?: PlayerId;
  development: number;
  mortgaged: boolean;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  position: number;
  balance: number;
  inDetention: boolean;
  detentionTurns: number;
  doublesStreak: number;
  bankrupt: boolean;
}

export type MatchStatus = "LOBBY" | "ACTIVE" | "COMPLETED" | "CANCELLED";

export interface MatchState {
  id: MatchId;
  status: MatchStatus;
  turn: number;
  currentPlayerIndex: number;
  turnPhase: "ROLL" | "ACTION";
  pendingExtraRoll: boolean;
  players: PlayerState[];
  properties: Record<TileId, PropertyState>;
  winnerId?: PlayerId;
  seed: number;
  rngState: number;
  revision: number;
  lastDice?: readonly [number, number];
  log: GameEvent[];
}

export type GameCommand =
  | { type: "START_MATCH" }
  | { type: "ROLL_DICE" }
  | { type: "BUY_PROPERTY"; playerId: PlayerId; tileId: TileId }
  | { type: "DEVELOP_PROPERTY"; playerId: PlayerId; tileId: TileId }
  | { type: "END_TURN"; playerId: PlayerId }
  | { type: "PAY_DETENTION_FINE"; playerId: PlayerId }
  | { type: "SURRENDER"; playerId: PlayerId };

export type GameEvent =
  | { type: "MATCH_STARTED"; atRevision: number }
  | { type: "DICE_ROLLED"; playerId: PlayerId; dice: readonly [number, number]; atRevision: number }
  | { type: "PLAYER_MOVED"; playerId: PlayerId; from: number; to: number; atRevision: number }
  | { type: "PASSED_START"; playerId: PlayerId; amount: number; atRevision: number }
  | { type: "PROPERTY_BOUGHT"; playerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "RENT_PAID"; fromPlayerId: PlayerId; toPlayerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "TAX_PAID"; playerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "PROPERTY_DEVELOPED"; playerId: PlayerId; tileId: TileId; level: number; amount: number; atRevision: number }
  | { type: "SENT_TO_DETENTION"; playerId: PlayerId; atRevision: number }
  | { type: "DETENTION_FINE_PAID"; playerId: PlayerId; amount: number; atRevision: number }
  | { type: "PLAYER_BANKRUPT"; playerId: PlayerId; atRevision: number }
  | { type: "PLAYER_SURRENDERED"; playerId: PlayerId; atRevision: number }
  | { type: "TURN_ENDED"; playerId: PlayerId; nextPlayerId?: PlayerId; atRevision: number }
  | { type: "MATCH_COMPLETED"; winnerId: PlayerId; atRevision: number };

export interface MatchCreateRequest {
  playerName: string;
  startingBalance?: number;
  seed?: number;
}

export interface MatchJoinRequest {
  playerName: string;
  startingBalance?: number;
}

export interface MatchCommandRequest {
  playerId: PlayerId;
  command: GameCommand;
}

export interface AetheriusAppManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: string;
  entrypoint: string;
  healthEndpoint: string;
  capabilities: string[];
  requiredPermissions: string[];
  optionalPermissions: string[];
  supportedPlatforms: string[];
  integrationEndpoints: Record<string, string>;
}

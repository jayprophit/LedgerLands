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
  /** Optional percent (0-1) for income-style tax tiles. Effective tax = min(fixed amount, floor(balance * percent)) when both present. */
  percent?: number;
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
  /** Get-out-of-detention cards held. Undefined treated as 0 for backwards compat. */
  detentionCards?: number;
}

export type MatchStatus = "LOBBY" | "ACTIVE" | "COMPLETED" | "CANCELLED";

export interface AuctionBid {
  playerId: PlayerId;
  amount: number;
}

export interface AuctionState {
  tileId: TileId;
  startedBy: PlayerId;
  bids: AuctionBid[];
  passedPlayerIds: PlayerId[];
  /** Highest bid derived from bids; stored for convenience. */
  highestBid?: AuctionBid;
}

export type TradeStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED";

export interface TradeOffer {
  /** Sats offered by proposer (must have funds at accept time). */
  sats?: number;
  /** Property tile ids offered by proposer (must own at accept time). */
  propertyIds?: TileId[];
}

export interface TradeState {
  id: string;
  fromPlayerId: PlayerId;
  toPlayerId: PlayerId;
  offer: TradeOffer;
  request: TradeOffer;
  status: TradeStatus;
  createdTurn: number;
}

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
  /** Active property auction, if any. Only one at a time in MVP. */
  auction?: AuctionState;
  /** Player-to-player trades (history + pending). */
  trades?: TradeState[];
  /** Count of event cards drawn (drives deterministic deck cursor alongside rngState). */
  deckCursor?: number;
  /** Versioned ruleset id, e.g. "classic-v1". Defaults to classic-v1 when absent. */
  rulesetVersion?: string;
}

export type GameCommand =
  | { type: "START_MATCH" }
  | { type: "ROLL_DICE" }
  | { type: "BUY_PROPERTY"; playerId: PlayerId; tileId: TileId }
  | { type: "DECLINE_PROPERTY"; playerId: PlayerId }
  | { type: "START_AUCTION"; playerId: PlayerId; tileId: TileId }
  | { type: "PLACE_BID"; playerId: PlayerId; amount: number }
  | { type: "PASS_AUCTION"; playerId: PlayerId }
  | { type: "COMPLETE_AUCTION"; playerId: PlayerId }
  | { type: "DEVELOP_PROPERTY"; playerId: PlayerId; tileId: TileId }
  | { type: "MORTGAGE_PROPERTY"; playerId: PlayerId; tileId: TileId }
  | { type: "UNMORTGAGE_PROPERTY"; playerId: PlayerId; tileId: TileId }
  | { type: "PROPOSE_TRADE"; playerId: PlayerId; toPlayerId: PlayerId; offer: TradeOffer; request: TradeOffer }
  | { type: "ACCEPT_TRADE"; playerId: PlayerId; tradeId: string }
  | { type: "REJECT_TRADE"; playerId: PlayerId; tradeId: string }
  | { type: "CANCEL_TRADE"; playerId: PlayerId; tradeId: string }
  | { type: "END_TURN"; playerId: PlayerId }
  | { type: "PAY_DETENTION_FINE"; playerId: PlayerId }
  | { type: "USE_DETENTION_CARD"; playerId: PlayerId }
  | { type: "SURRENDER"; playerId: PlayerId };

export type GameEvent =
  | { type: "MATCH_STARTED"; atRevision: number }
  | { type: "DICE_ROLLED"; playerId: PlayerId; dice: readonly [number, number]; atRevision: number }
  | { type: "PLAYER_MOVED"; playerId: PlayerId; from: number; to: number; atRevision: number }
  | { type: "PASSED_START"; playerId: PlayerId; amount: number; atRevision: number }
  | { type: "PROPERTY_BOUGHT"; playerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "PROPERTY_OFFERED"; playerId: PlayerId; tileId: TileId; atRevision: number }
  | { type: "RENT_PAID"; fromPlayerId: PlayerId; toPlayerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "TAX_PAID"; playerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "CARD_DRAWN"; playerId: PlayerId; cardId: string; title: string; amount?: number; atRevision: number }
  | { type: "PROPERTY_DEVELOPED"; playerId: PlayerId; tileId: TileId; level: number; amount: number; atRevision: number }
  | { type: "PROPERTY_MORTGAGED"; playerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "PROPERTY_UNMORTGAGED"; playerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "AUCTION_STARTED"; playerId: PlayerId; tileId: TileId; atRevision: number }
  | { type: "AUCTION_BID"; playerId: PlayerId; tileId: TileId; amount: number; atRevision: number }
  | { type: "AUCTION_PASSED"; playerId: PlayerId; tileId: TileId; atRevision: number }
  | { type: "AUCTION_COMPLETED"; tileId: TileId; winnerId?: PlayerId; amount?: number; atRevision: number }
  | { type: "TRADE_PROPOSED"; tradeId: string; fromPlayerId: PlayerId; toPlayerId: PlayerId; atRevision: number }
  | { type: "TRADE_ACCEPTED"; tradeId: string; atRevision: number }
  | { type: "TRADE_REJECTED"; tradeId: string; atRevision: number }
  | { type: "TRADE_CANCELLED"; tradeId: string; atRevision: number }
  | { type: "SENT_TO_DETENTION"; playerId: PlayerId; atRevision: number }
  | { type: "DETENTION_FINE_PAID"; playerId: PlayerId; amount: number; atRevision: number }
  | { type: "DETENTION_CARD_USED"; playerId: PlayerId; atRevision: number }
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

/** Versioned ruleset id. `classic-v1` is the MVP default. */
export type RulesetVersion = "classic-v1" | "ranked-v1" | "quick-v1";

export type RarityTier =
  | "COMMON"
  | "UNCOMMON"
  | "RARE"
  | "EPIC"
  | "LEGENDARY"
  | "MYTHIC"
  | "EXOTIC"
  | "UNIQUE";

export interface CollectibleToken {
  id: string;
  name: string;
  description: string;
  rarity: RarityTier;
  emoji: string;
  unlockMethod: "STARTER" | "QUEST" | "SHOP" | "EVENT" | "TOURNAMENT" | "ACHIEVEMENT";
  purchasable: boolean;
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

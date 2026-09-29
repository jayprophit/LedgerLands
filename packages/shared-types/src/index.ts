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

/**
 * Match shape. `TEAM_2V2` is the first team mode; the others are individual
 * modes and are unaffected by any team rule.
 */
export type MatchMode = "SOLO" | "FREE_FOR_ALL" | "TEAM_2V2";

export type TeamId = string;

/**
 * A team owns victory, not economy. Members keep their own balances, property,
 * mortgages, development and jail state. A team is eliminated only once every
 * member has been eliminated.
 */
export interface TeamState {
  teamId: TeamId;
  memberIds: PlayerId[];
  eliminated: boolean;
  eliminatedAtRevision?: number;
}

/**
 * The team rule set, stated explicitly rather than scattered through
 * conditionals. Every field is a decision, not a default: a future variant
 * (shared treasury, shared property, team loans) is a different value here, not
 * a different engine.
 *
 * TYPES ONLY. The corresponding runtime value lives in
 * `packages/game-engine/src/rules.ts` (`TEAM_2V2_RULES`) because this package's
 * tsconfig path maps resolve to a `.d.ts`, which has no runtime exports. See the
 * warning in `tsconfig.base.json`.
 */
export interface TeamRules {
  /** Wallets are never pooled. */
  economy: "INDIVIDUAL";
  /** Property is owned by the individual player who bought it. */
  propertyOwnership: "INDIVIDUAL";
  /** A teammate landing on a teammate's property pays nothing. */
  teammateRent: "EXEMPT";
  /** Bankruptcy is resolved per player, creditor-aware, as in free-for-all. */
  bankruptcy: "INDIVIDUAL";
  /** A team is out only when all of its members are out. */
  elimination: "ALL_MEMBERS";
  /** The last team with a solvent member wins. No timed scoring. */
  victory: "LAST_SOLVENT_TEAM";
  /** Everyone, including teammates, bids and settles as themselves. */
  auctionParticipation: "INDIVIDUAL";
  /** Teammates may trade, through the ordinary propose/validate/accept path. */
  teammateTrading: "ALLOWED";
  /** Each player starts with the full standard ruleset balance. */
  startingBalance: "STANDARD_PER_PLAYER";
}
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
  /**
   * Match shape. Absent or `FREE_FOR_ALL` means individual play, and every
   * team rule is inert. Seating order is the `players` array order, so an
   * alternating team seating is authoritative state, not a display concern.
   */
  mode?: MatchMode;
  /** Present only in team modes. */
  teams?: TeamState[];
  /** The rule set in force. Recorded on the state so a replay cannot change it. */
  teamRules?: TeamRules;
  /** Set when a team wins. Absent in individual modes. */
  winnerTeamId?: TeamId;
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
  | { type: "MATCH_COMPLETED"; winnerId?: PlayerId; winnerTeamId?: TeamId; atRevision: number }
  // Team mode. A teammate landing on a teammate's property is charged nothing,
  // and the exemption is recorded rather than silently swallowed.
  | { type: "TEAMMATE_RENT_EXEMPT"; playerId: PlayerId; teammateId: PlayerId; teamId: TeamId; tileId: TileId; atRevision: number }
  | { type: "TEAM_ELIMINATED"; teamId: TeamId; atRevision: number };

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
export type RulesetVersion = "classic-v1" | "ranked-v1" | "quick-v1" | "team-v1";

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

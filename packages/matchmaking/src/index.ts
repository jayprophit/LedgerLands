/**
 * LedgerLands matchmaking.
 *
 * - `service.ts` — pure in-process pairing logic (unchanged behaviour).
 * - `durable.ts` — durable/distributed service built on `MatchmakingStore`.
 * - `store.ts`   — the storage contract plus memory and PostgreSQL stores.
 *
 * Redis is intentionally absent as a requirement: PostgreSQL is the durable
 * source of truth and is sufficient for correctness. A Redis layer would only
 * be added later for ephemeral coordination (presence, leases).
 */

export * from "./service.js";
// `store-types` re-exports `QueueName` for convenience; the service module owns
// it, so the barrel avoids re-exporting that name twice.
export type {
  MatchmakingStore,
  QueueEntryStatus,
  QueueRow,
} from "./store-types.js";
export {
  MemoryMatchmakingStore,
  PostgresMatchmakingStore,
  type MatchmakingTx,
  type QueueRowDb,
  type SqlExecutor,
} from "./store.js";
export {
  DurableMatchmakingRunner,
  DurableMatchmakingService,
  DEFAULT_DURABLE_CONFIG,
  formTwoVTwoTeams,
  type Assignment,
  type GameMode,
  type MatchFactory,
  type MatchmakingConfig,
} from "./durable.js";

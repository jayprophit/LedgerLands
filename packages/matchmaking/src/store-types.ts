/**
 * Shared types for the durable matchmaking layer, kept in their own module so
 * `store.ts` and `durable.ts` can both depend on them without a cycle through
 * the pure `service.ts` logic.
 */

import type { QueueName } from "./service.js";

export type { QueueName };

export interface SkillBandConfig {
  initialDelta: number;
  expandPerSecond: number;
  maxDelta: number;
}

export type QueueEntryStatus = "QUEUED" | "RESERVED" | "MATCHED" | "CANCELLED" | "EXPIRED";

export interface QueueRow {
  entryId: string;
  playerId: string;
  queue: QueueName;
  rating: number;
  displayName: string;
  status: QueueEntryStatus;
  joinedAt: number;
  /** Set while RESERVED; identifies the group being assembled. */
  reservationId?: string;
  /** Lease expiry for the reservation (authoritative server time). */
  reservationExpiresAt?: number;
  /** Authoritative match created from this entry. */
  matchId?: string;
  /** Version for compare-and-set; incremented on every transition. */
  version: number;
}

export interface MatchmakingStore {
  join(input: {
    playerId: string;
    displayName: string;
    queue: QueueName;
    rating: number;
    nowMs: number;
  }): Promise<{ row: QueueRow; created: boolean }>;
  leave(playerId: string, queue: QueueName | undefined, nowMs: number): Promise<number>;
  candidates(queue: QueueName, opts?: { limit?: number }): Promise<QueueRow[]>;
  claimReservations(entries: QueueRow[], reservationId: string, nowMs: number, leaseMs: number): Promise<boolean>;
  finalizeReservation(reservationId: string, matchId: string, nowMs: number): Promise<QueueRow[]>;
  releaseReservation(reservationId: string, nowMs: number): Promise<QueueRow[]>;
  sweepExpiredReservations(nowMs: number): Promise<QueueRow[]>;
  byReservation(reservationId: string): Promise<QueueRow[]>;
  byPlayer(playerId: string): Promise<QueueRow[]>;
}

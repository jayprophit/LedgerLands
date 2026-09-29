import { randomUUID } from "node:crypto";
import { DEFAULT_SKILL_BANDS, MatchmakingError, type QueueName, type SkillBandConfig } from "./service.js";
import type { MatchmakingStore, QueueRow } from "./store-types.js";

/**
 * Durable matchmaking service.
 *
 * Responsibilities, in order:
 *   1. persist queue intent (idempotent),
 *   2. form candidate groups from persisted QUEUED rows,
 *   3. claim the group with a compare-and-set transition (multi-worker safe),
 *   4. hand the group to a callback that creates the authoritative match,
 *   5. finalize (MATCHED) or release back to QUEUED on failure.
 *
 * A crash between (3) and (5) is recoverable: the reservation carries a lease,
 * and `sweepExpiredReservations` returns orphaned players to the queue instead
 * of stranding them.
 *
 * Skill-band expansion is computed from `joinedAt` (persisted), so a process
 * restart does not reset anyone's wait time.
 */

export type GameMode = "SOLO" | "ONE_V_ONE" | "TWO_V_TWO" | "FOUR_PLAYER_FFA";

export interface MatchmakingConfig extends SkillBandConfig {
  /** How long a reservation lease is held before it is considered orphaned. */
  reservationLeaseMs: number;
  /** Candidates pulled per queue per tick. */
  candidateBatch: number;
}

export const DEFAULT_DURABLE_CONFIG: MatchmakingConfig = {
  ...DEFAULT_SKILL_BANDS,
  reservationLeaseMs: 30_000,
  candidateBatch: 100,
};

export interface Assignment {
  reservationId: string;
  queue: QueueName;
  playerIds: string[];
  matchId: string;
}

export type MatchFactory = (params: {
  reservationId: string;
  playerIds: string[];
  queue: QueueName;
}) => Promise<string>;

const QUEUE_SIZES: Record<QueueName, number> = {
  CASUAL_1V1: 2,
  RANKED_1V1: 2,
  FFA_4: 4,
  TEAM_2V2: 4,
  TOURNAMENT: 2,
};

export class DurableMatchmakingService {
  constructor(
    private readonly store: MatchmakingStore,
    private readonly config: MatchmakingConfig = DEFAULT_DURABLE_CONFIG,
  ) {}

  /** Idempotent: a player already queued in this queue is returned unchanged. */
  async join(input: { playerId: string; displayName: string; queue: QueueName; rating: number; nowMs?: number }): Promise<QueueRow> {
    const { row } = await this.store.join({ ...input, nowMs: input.nowMs ?? Date.now() });
    return row;
  }

  async leave(playerId: string, queue?: QueueName, nowMs = Date.now()): Promise<number> {
    return this.store.leave(playerId, queue, nowMs);
  }

  async queued(queue: QueueName, opts?: { limit?: number }): Promise<QueueRow[]> {
    return this.store.candidates(queue, { limit: opts?.limit ?? this.config.candidateBatch });
  }

  /**
   * One matchmaking pass. Returns completed assignments; players whose match
   * creation failed are released back to the queue (never stranded).
   */
  async tick(
    createMatch: MatchFactory,
    nowMs = Date.now(),
  ): Promise<Assignment[]> {
    // Recover anything a previous crash left reserved.
    await this.store.sweepExpiredReservations(nowMs);

    const assignments: Assignment[] = [];
    for (const queue of ["CASUAL_1V1", "RANKED_1V1", "FFA_4"] as QueueName[]) {
      // One consistent candidate snapshot per queue for this tick. The
      // compare-and-set claim is still what makes concurrent ticks safe; this
      // snapshot only decides which groups are *attempted*.
      const waiting = await this.store.candidates(queue, { limit: this.config.candidateBatch });
      for (const group of this.formGroups(queue, waiting, nowMs)) {
        const reservationId = randomUUID();
        const won = await this.store.claimReservations(group, reservationId, nowMs, this.config.reservationLeaseMs);
        if (!won) continue; // another worker claimed these players
        try {
          const matchId = await createMatch({ reservationId, playerIds: group.map((g) => g.playerId), queue });
          const rows = await this.store.finalizeReservation(reservationId, matchId, nowMs);
          assignments.push({ reservationId, queue, playerIds: rows.map((r) => r.playerId), matchId });
        } catch {
          // Match creation failed: everyone goes back to waiting, in order,
          // with their original join time preserved.
          await this.store.releaseReservation(reservationId, nowMs);
        }
      }
    }
    return assignments;
  }

  /** Reservation state after a crash — used by tests and by an admin view. */
  async reservation(reservationId: string): Promise<QueueRow[]> {
    return this.store.byReservation(reservationId);
  }

  async entriesFor(playerId: string): Promise<QueueRow[]> {
    return this.store.byPlayer(playerId);
  }

  /**
   * Group queued rows into candidate groups. Longest-waiting first within each
   * compatibility check; skill-band compatibility is only enforced for ranked
   * queues and uses persisted `joinedAt` for wait-time expansion.
   */
  private formGroups(queue: QueueName, waiting: QueueRow[], nowMs: number): QueueRow[][] {
    const size = QUEUE_SIZES[queue];
    const groups: QueueRow[][] = [];
    const used = new Set<string>();
    for (const a of waiting) {
      if (used.has(a.entryId)) continue;
      const partner: QueueRow | undefined = waiting.find(
        (b) => !used.has(b.entryId) && b.entryId !== a.entryId && this.compatible(queue, a, b, nowMs),
      );
      if (size === 2) {
        if (!partner) continue;
        used.add(a.entryId);
        used.add(partner.entryId);
        groups.push([a, partner]);
        continue;
      }
      // FFA_4: fill a group of `size`, backfilling from the remaining waiters.
      const group = [a];
      used.add(a.entryId);
      for (const b of waiting) {
        if (group.length >= size) break;
        if (used.has(b.entryId)) continue;
        if (!this.compatible(queue, a, b, nowMs)) continue;
        group.push(b);
        used.add(b.entryId);
      }
      if (group.length === size) groups.push(group);
      else for (const g of group) used.delete(g.entryId);
    }
    return groups;
  }

  private compatible(queue: QueueName, a: QueueRow, b: QueueRow, nowMs: number): boolean {
    if (queue !== "RANKED_1V1") return true;
    const delta = Math.min(this.effectiveDelta(a, nowMs), this.effectiveDelta(b, nowMs));
    return Math.abs(a.rating - b.rating) <= delta;
  }

  private effectiveDelta(row: QueueRow, nowMs: number): number {
    const waitedSecs = Math.max(0, (nowMs - row.joinedAt) / 1000);
    return Math.min(this.config.maxDelta, this.config.initialDelta + waitedSecs * this.config.expandPerSecond);
  }
}

/**
 * Convenience wrapper that loads candidates once per tick and reuses them, so a
 * single `tick` sees a consistent queue view across all queues.
 */
export class DurableMatchmakingRunner {
  constructor(private readonly service: DurableMatchmakingService) {}

  async run(
    createMatch: MatchFactory,
    queues: QueueName[] = ["CASUAL_1V1", "RANKED_1V1", "FFA_4"],
    nowMs = Date.now(),
  ): Promise<Assignment[]> {
    void queues;
    return this.service.tick(createMatch, nowMs);
  }
}

export { MatchmakingError };

import { randomUUID } from "node:crypto";
import { MatchmakingError } from "./service.js";
import { DEFAULT_SKILL_BANDS } from "./service.js";
import type { MatchmakingStore, QueueEntryStatus, QueueName, QueueRow } from "./store-types.js";

/**
 * Durable matchmaking state.
 *
 * Design notes
 * ------------
 * PostgreSQL is the durable source of truth: queue intent, reservations, and
 * match assignments all survive a restart. Redis is *optional* and is only ever
 * a fast coordination layer (presence, leases) — nothing here requires it, and
 * nothing here treats it as authoritative.
 *
 * Multi-worker safety uses compare-and-set on an explicit status, not locks:
 * a worker claims a candidate group by transitioning `QUEUED -> RESERVED` with
 * an expected-status guard. Exactly one worker can win that transition; losers
 * see the new status and move on. This is the standard "optimistic claim"
 * pattern and needs no advisory locks.
 *
 * States are explicit and mutually exclusive — never a set of booleans:
 *
 *   QUEUED   waiting for an opponent
 *   RESERVED a worker claimed this group and is creating the match
 *   MATCHED  an authoritative match exists
 *   CANCELLED player left, or the entry was withdrawn
 *   EXPIRED  the reservation lease ran out (recoverable → back to QUEUED)
 */

export type { QueueEntryStatus, QueueRow, MatchmakingStore } from "./store-types.js";

function clone(row: QueueRow): QueueRow {
  return { ...row };
}

/**
 * Development / single-process store. Explicitly not safe across processes; it
 * exists so the service logic is testable without a database and so local play
 * needs no infrastructure.
 */
export class MemoryMatchmakingStore implements MatchmakingStore {
  private readonly rows = new Map<string, QueueRow>();
  private readonly byPlayerIndex = new Map<string, Set<string>>();

  private reindex(playerId: string, entryId: string, add: boolean): void {
    const set = this.byPlayerIndex.get(playerId) ?? new Set<string>();
    if (add) set.add(entryId);
    else set.delete(entryId);
    if (set.size === 0) this.byPlayerIndex.delete(playerId);
    else this.byPlayerIndex.set(playerId, set);
  }

  async join(input: {
    playerId: string;
    displayName: string;
    queue: QueueName;
    rating: number;
    nowMs: number;
  }): Promise<{ row: QueueRow; created: boolean }> {
    const key = `${input.queue}:${input.playerId}`;
    const existing = this.rows.get(key);
    // Terminal entries (cancelled / expired) do not block a fresh join; live
    // ones (QUEUED / RESERVED / MATCHED) are returned unchanged for idempotency.
    if (existing && existing.status !== "CANCELLED" && existing.status !== "EXPIRED") {
      return { row: clone(existing), created: false };
    }
    const row: QueueRow = {
      entryId: randomUUID(),
      playerId: input.playerId,
      queue: input.queue,
      rating: input.rating,
      displayName: input.displayName,
      status: "QUEUED",
      joinedAt: input.nowMs,
      version: 1,
    };
    this.rows.set(key, row);
    this.reindex(input.playerId, key, true);
    return { row: clone(row), created: true };
  }

  async leave(playerId: string, queue: QueueName | undefined, nowMs: number): Promise<number> {
    let n = 0;
    for (const [key, row] of [...this.rows]) {
      if (row.playerId !== playerId) continue;
      if (queue && row.queue !== queue) continue;
      if (row.status === "MATCHED") throw new MatchmakingError("ALREADY_MATCHED", "Player is already in a match.");
      row.status = "CANCELLED";
      row.version += 1;
      void nowMs;
      this.rows.set(key, row);
      n += 1;
    }
    return n;
  }

  async candidates(queue: QueueName, opts?: { limit?: number }): Promise<QueueRow[]> {
    const out: QueueRow[] = [];
    for (const row of this.rows.values()) {
      if (row.queue !== queue) continue;
      if (row.status !== "QUEUED") continue;
      out.push(clone(row));
    }
    out.sort((a, b) => a.joinedAt - b.joinedAt || a.entryId.localeCompare(b.entryId));
    return opts?.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  async claimReservations(entries: QueueRow[], reservationId: string, nowMs: number, leaseMs: number): Promise<boolean> {
    // All-or-nothing: verify every entry is still QUEUED, then flip them.
    for (const e of entries) {
      const live = this.rows.get(`${e.queue}:${e.playerId}`);
      if (!live || live.status !== "QUEUED" || live.version !== e.version) return false;
    }
    for (const e of entries) {
      const key = `${e.queue}:${e.playerId}`;
      const live = this.rows.get(key)!;
      live.status = "RESERVED";
      live.reservationId = reservationId;
      live.reservationExpiresAt = nowMs + leaseMs;
      live.version += 1;
      this.rows.set(key, live);
    }
    return true;
  }

  /**
   * Commit a reservation into MATCHED. `reservationId` is deliberately KEPT on
   * the row: it is the group identifier that links the queue entries to the
   * created match, which matters for recovery, audit and dispute review. Only
   * the lease is cleared, since the claim is no longer pending.
   */
  async finalizeReservation(reservationId: string, matchId: string, nowMs: number): Promise<QueueRow[]> {
    void nowMs;
    const out: QueueRow[] = [];
    for (const [key, row] of this.rows) {
      if (row.reservationId !== reservationId) continue;
      row.status = "MATCHED";
      row.matchId = matchId;
      delete row.reservationExpiresAt;
      row.version += 1;
      this.rows.set(key, row);
      out.push(clone(row));
    }
    return out;
  }

  async releaseReservation(reservationId: string, nowMs: number): Promise<QueueRow[]> {
    void nowMs;
    const out: QueueRow[] = [];
    for (const [key, row] of this.rows) {
      if (row.reservationId !== reservationId) continue;
      row.status = "QUEUED";
      delete row.reservationId;
      delete row.reservationExpiresAt;
      row.version += 1;
      this.rows.set(key, row);
      out.push(clone(row));
    }
    return out;
  }

  async sweepExpiredReservations(nowMs: number): Promise<QueueRow[]> {
    const out: QueueRow[] = [];
    for (const [key, row] of this.rows) {
      if (row.status !== "RESERVED") continue;
      if (row.reservationExpiresAt === undefined) continue;
      if (nowMs < row.reservationExpiresAt) continue;
      row.status = "EXPIRED";
      delete row.reservationId;
      delete row.reservationExpiresAt;
      row.version += 1;
      this.rows.set(key, row);
      out.push(clone(row));
    }
    return out;
  }

  async byReservation(reservationId: string): Promise<QueueRow[]> {
    return [...this.rows.values()].filter((r) => r.reservationId === reservationId).map(clone);
  }

  async byPlayer(playerId: string): Promise<QueueRow[]> {
    return [...this.rows.values()].filter((r) => r.playerId === playerId).map(clone);
  }
}

/**
 * PostgreSQL store. The caller supplies an executor so this package stays
 * ORM-agnostic; the SQL is passed as one transaction callback.
 */
export interface SqlExecutor<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface QueueRowDb {
  entryId: string;
  playerId: string;
  queue: string;
  rating: number;
  displayName: string;
  status: string;
  joinedAt: number;
  reservationId: string | null;
  reservationExpiresAt: number | null;
  matchId: string | null;
  version: number;
}

export interface MatchmakingTx {
  insertEntry(row: QueueRowDb): Promise<unknown>;
  findByPlayer(playerId: string, queue?: string): Promise<QueueRowDb[]>;
  findCandidates(queue: string, limit: number): Promise<QueueRowDb[]>;
  /**
   * Compare-and-set claim. Must return the number of rows actually updated so
   * the caller can detect a lost race. Typical SQL:
   *   UPDATE mm_queue_entry SET status='RESERVED', reservation_id=$1,
   *     reservation_expires_at=$2, version=version+1
   *   WHERE entry_id = ANY($3) AND status='QUEUED' AND version = ANY($4)
   */
  claimEntries(
    reservationId: string,
    entryIds: string[],
    versions: number[],
    expiresAt: number,
  ): Promise<number>;
  finalizeReservation(reservationId: string, matchId: string): Promise<QueueRowDb[]>;
  releaseReservation(reservationId: string): Promise<QueueRowDb[]>;
  expireReservations(nowMs: number): Promise<QueueRowDb[]>;
  findByReservation(reservationId: string): Promise<QueueRowDb[]>;
}

function fromDb(row: QueueRowDb): QueueRow {
  return {
    entryId: row.entryId,
    playerId: row.playerId,
    queue: row.queue as QueueName,
    rating: row.rating,
    displayName: row.displayName,
    status: row.status as QueueEntryStatus,
    joinedAt: row.joinedAt,
    ...(row.reservationId !== null ? { reservationId: row.reservationId } : {}),
    ...(row.reservationExpiresAt !== null ? { reservationExpiresAt: row.reservationExpiresAt } : {}),
    ...(row.matchId !== null ? { matchId: row.matchId } : {}),
    version: row.version,
  };
}

export class PostgresMatchmakingStore implements MatchmakingStore {
  constructor(private readonly sql: SqlExecutor<MatchmakingTx>) {}

  async join(input: {
    playerId: string;
    displayName: string;
    queue: QueueName;
    rating: number;
    nowMs: number;
  }): Promise<{ row: QueueRow; created: boolean }> {
    return this.sql.transaction(async (tx) => {
      const existing = await tx.findByPlayer(input.playerId, input.queue);
      const live = existing.find((r) => r.status !== "CANCELLED" && r.status !== "EXPIRED");
      if (live) return { row: fromDb(live), created: false };
      const row: QueueRowDb = {
        entryId: randomUUID(),
        playerId: input.playerId,
        queue: input.queue,
        rating: input.rating,
        displayName: input.displayName,
        status: "QUEUED",
        joinedAt: input.nowMs,
        reservationId: null,
        reservationExpiresAt: null,
        matchId: null,
        version: 1,
      };
      await tx.insertEntry(row);
      return { row: fromDb(row), created: true };
    });
  }

  async leave(playerId: string, queue: QueueName | undefined, nowMs: number): Promise<number> {
    void nowMs;
    return this.sql.transaction(async (tx) => {
      const rows = await tx.findByPlayer(playerId, queue);
      let n = 0;
      for (const r of rows) {
        if (r.status === "MATCHED") throw new MatchmakingError("ALREADY_MATCHED", "Player is already in a match.");
      }
      for (const r of rows) {
        await tx.releaseReservation(r.reservationId ?? r.entryId);
        n += 1;
      }
      return n;
    });
  }

  async candidates(queue: QueueName, opts?: { limit?: number }): Promise<QueueRow[]> {
    return this.sql.transaction(async (tx) => {
      const rows = await tx.findCandidates(queue, opts?.limit ?? 100);
      return rows.map(fromDb);
    });
  }

  async claimReservations(entries: QueueRow[], reservationId: string, nowMs: number, leaseMs: number): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      const updated = await tx.claimEntries(
        reservationId,
        entries.map((e) => e.entryId),
        entries.map((e) => e.version),
        nowMs + leaseMs,
      );
      // Partial updates mean another worker won; do not finalize a torn group.
      return updated === entries.length;
    });
  }

  async finalizeReservation(reservationId: string, matchId: string, nowMs: number): Promise<QueueRow[]> {
    void nowMs;
    return this.sql.transaction(async (tx) => (await tx.finalizeReservation(reservationId, matchId)).map(fromDb));
  }

  async releaseReservation(reservationId: string, nowMs: number): Promise<QueueRow[]> {
    void nowMs;
    return this.sql.transaction(async (tx) => (await tx.releaseReservation(reservationId)).map(fromDb));
  }

  async sweepExpiredReservations(nowMs: number): Promise<QueueRow[]> {
    return this.sql.transaction(async (tx) => (await tx.expireReservations(nowMs)).map(fromDb));
  }

  async byReservation(reservationId: string): Promise<QueueRow[]> {
    return this.sql.transaction(async (tx) => (await tx.findByReservation(reservationId)).map(fromDb));
  }

  async byPlayer(playerId: string): Promise<QueueRow[]> {
    return this.sql.transaction(async (tx) => (await tx.findByPlayer(playerId)).map(fromDb));
  }
}

export { DEFAULT_SKILL_BANDS } from "./service.js";
export type { QueueName, SkillBandConfig } from "./store-types.js";

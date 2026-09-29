import { randomUUID } from "node:crypto";

/**
 * Matchmaking queue. Forms groups, then the API creates a normal authoritative
 * match via PersistentMatchStore — there is no separate matchmaking engine.
 */

export type QueueName = "CASUAL_1V1" | "RANKED_1V1" | "FFA_4" | "TEAM_2V2" | "TOURNAMENT";

const SUPPORTED_QUEUES: QueueName[] = ["CASUAL_1V1", "RANKED_1V1", "FFA_4"];

export interface QueueEntry {
  playerId: string;
  displayName: string;
  queue: QueueName;
  rating: number;
  joinedAt: number;
}

export interface SkillBandConfig {
  initialDelta: number;
  expandPerSecond: number;
  maxDelta: number;
}

export const DEFAULT_SKILL_BANDS: SkillBandConfig = {
  initialDelta: 100,
  expandPerSecond: 5,
  maxDelta: 400,
};

export interface MatchFound {
  reservationId: string;
  queue: QueueName;
  playerIds: string[];
}

export class MatchmakingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "MatchmakingError";
    this.code = code;
  }
}

export class MatchmakingService {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly reservations = new Map<string, MatchFound>();
  private readonly busyPlayers = new Set<string>();
  constructor(private readonly bands: SkillBandConfig = DEFAULT_SKILL_BANDS) {}

  /** Idempotent join: same player+queue returns the existing entry. */
  join(entry: Omit<QueueEntry, "joinedAt">, nowMs = Date.now()): { entry: QueueEntry; position: number } {
    if (!SUPPORTED_QUEUES.includes(entry.queue)) {
      throw new MatchmakingError("QUEUE_NOT_SUPPORTED", `${entry.queue} is reserved (2v2 needs team rules; tournament uses TournamentService).`);
    }
    const key = `${entry.queue}:${entry.playerId}`;
    const existing = this.entries.get(key);
    if (existing) return { entry: { ...existing }, position: this.position(entry.queue, entry.playerId) };
    if (this.busyPlayers.has(entry.playerId)) {
      throw new MatchmakingError("ALREADY_MATCHED", "Player already has a pending match reservation.");
    }
    for (const [k, e] of this.entries) {
      if (e.playerId === entry.playerId && k !== key) {
        throw new MatchmakingError("ALREADY_QUEUED", `Player is already queued in ${e.queue}.`);
      }
    }
    const full: QueueEntry = { ...entry, joinedAt: nowMs };
    this.entries.set(key, full);
    return { entry: { ...full }, position: this.position(entry.queue, entry.playerId) };
  }

  leave(playerId: string, queue?: QueueName): boolean {
    let removed = false;
    for (const [k, e] of [...this.entries]) {
      if (e.playerId === playerId && (!queue || e.queue === queue)) {
        this.entries.delete(k);
        removed = true;
      }
    }
    return removed;
  }

  /** Form matches from waiting entries. Matched players leave the queue into reservations. */
  tick(nowMs = Date.now()): MatchFound[] {
    const found: MatchFound[] = [];
    found.push(...this.formPairs("CASUAL_1V1", nowMs, () => true));
    found.push(...this.formPairs("RANKED_1V1", nowMs, (a, b) =>
      Math.abs(a.rating - b.rating) <= Math.min(this.effectiveDelta(a, nowMs), this.effectiveDelta(b, nowMs)),
    ));
    found.push(...this.formGroups("FFA_4", 4));
    for (const m of found) {
      this.reservations.set(m.reservationId, m);
      for (const pid of m.playerIds) {
        this.busyPlayers.add(pid);
        this.entries.delete(`${m.queue}:${pid}`);
      }
    }
    return found;
  }

  /** Claim a reservation (exactly once) so the API can create the authoritative match. */
  claim(reservationId: string): MatchFound {
    const r = this.reservations.get(reservationId);
    if (!r) throw new MatchmakingError("NO_RESERVATION", "Reservation not found or already claimed.");
    this.reservations.delete(reservationId);
    for (const pid of r.playerIds) this.busyPlayers.delete(pid);
    return { ...r, playerIds: [...r.playerIds] };
  }

  /** Remove entries waiting longer than maxWaitMs. Returns removed count. */
  sweepStale(nowMs: number, maxWaitMs: number): number {
    let removed = 0;
    for (const [k, e] of [...this.entries]) {
      if (nowMs - e.joinedAt >= maxWaitMs) {
        this.entries.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  queued(queue: QueueName): QueueEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.queue === queue)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((e) => ({ ...e }));
  }

  private position(queue: QueueName, playerId: string): number {
    const q = this.queued(queue);
    const i = q.findIndex((e) => e.playerId === playerId);
    return i < 0 ? -1 : i + 1;
  }

  private effectiveDelta(e: QueueEntry, nowMs: number): number {
    const waitedSecs = Math.max(0, (nowMs - e.joinedAt) / 1000);
    return Math.min(this.bands.maxDelta, this.bands.initialDelta + waitedSecs * this.bands.expandPerSecond);
  }

  private formPairs(queue: QueueName, nowMs: number, compatible: (a: QueueEntry, b: QueueEntry) => boolean): MatchFound[] {
    const waiting = this.queued(queue);
    const found: MatchFound[] = [];
    const used = new Set<string>();
    for (const a of waiting) {
      if (used.has(a.playerId)) continue;
      const partner = waiting.find((b) => b.playerId !== a.playerId && !used.has(b.playerId) && compatible(a, b));
      if (!partner) continue;
      used.add(a.playerId);
      used.add(partner.playerId);
      found.push({ reservationId: randomUUID(), queue, playerIds: [a.playerId, partner.playerId] });
    }
    void nowMs;
    return found;
  }

  private formGroups(queue: QueueName, size: number): MatchFound[] {
    const waiting = this.queued(queue);
    const found: MatchFound[] = [];
    for (let i = 0; i + size <= waiting.length; i += size) {
      found.push({ reservationId: randomUUID(), queue, playerIds: waiting.slice(i, i + size).map((e) => e.playerId) });
    }
    return found;
  }
}

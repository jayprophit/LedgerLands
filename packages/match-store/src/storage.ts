import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GameCommand, MatchState, MatchStatus } from "@ledgerlands/shared-types";
import type { Difficulty } from "@ledgerlands/game-ai";

/** A command persisted to the event log. Bot commands are persisted too, so replay is exact. */
export interface PersistedCommand {
  command: GameCommand;
  commandId: string;
  actorPlayerId: string;
  at: string;
  /** Engine revision after applying the command (set by the store; used by PostgresBackend). */
  resultRevision?: number;
}

export interface MatchSnapshot {
  revision: number;
  state: MatchState;
  at: string;
  /**
   * Command-log sequence this snapshot covers (exclusive lower bound for a
   * suffix read). Backends that persist an ordered command log should set it;
   * when absent, callers fall back to a revision-only range query.
   */
  seq?: number;
}

/** Post-replay corrections that are NOT engine commands (e.g. lobby timeout cancel). */
export interface MatchCorrection {
  kind: "CANCEL_LOBBY_TIMEOUT" | "ADMIN_NOTE";
  at: string;
  detail: string;
}

export interface StoredMatch {
  initial: MatchState;
  commands: PersistedCommand[];
  snapshots: MatchSnapshot[];
  corrections: MatchCorrection[];
  seenCommandIds: string[];
  botDifficulty: Difficulty;
  solo: boolean;
  createdAt: string;
  updatedAt: string;
  /** Denormalized lifecycle (kept in sync by the store; lets backends avoid replay on read). */
  meta: { status: MatchStatus; stateRevision: number; totalCommands: number };
}

/**
 * Range-oriented command read. `afterRevision` is exclusive: only commands whose
 * `resultRevision` is strictly greater are returned, in ascending order.
 * `afterSeq` additionally bounds by the durable command sequence when the
 * backend has one (Postgres); memory/file backends ignore it and filter by
 * revision only. The contract is intentionally backend-agnostic — no Prisma
 * query semantics leak into MatchStore.
 */
export interface CommandRange {
  afterRevision: number;
  /** Optional exclusive lower bound on the storage-level sequence. */
  afterSeq?: number;
  /** Optional upper bound (exclusive) on the storage-level sequence. */
  throughSeq?: number;
  limit?: number;
}

export interface SuffixReadResult {
  commands: PersistedCommand[];
  /** Total number of commands the backend holds for this match. */
  totalCommands: number;
  /**
   * Number of commands the backend excluded because they are at or before the
   * requested lower bound. Together with `totalCommands` this lets a caller
   * verify it received the complete suffix without a second read.
   */
  commandsExcluded: number;
  /** Highest sequence the backend holds (1-based command count). */
  maxSeq?: number;
}

export interface StorageBackend {
  save(matchId: string, record: StoredMatch): Promise<void>;
  /** Full read: metadata + every command + snapshots + corrections. */
  load(matchId: string): Promise<StoredMatch | undefined>;
  /**
   * Header-only read: metadata, snapshots and corrections but NO command log.
   * This is what makes suffix reconstruction a genuine saving — the full
   * command history is never transferred when a usable snapshot exists.
   */
  loadHeader(matchId: string): Promise<StoredMatch | undefined>;
  list(): Promise<string[]>;
  /**
   * Read only the command suffix after a known revision. Backends that cannot
   * do partial physical I/O (e.g. single-JSON-file stores) may still satisfy
   * this logically by deserializing and filtering; that is explicitly NOT the
   * same as partial file I/O and is documented per implementation.
   */
  readCommandsAfter(matchId: string, range: CommandRange): Promise<SuffixReadResult>;
}

/** A `StoredMatch` returned by `loadHeader` carries no commands. */
export function isHeaderOnly(record: StoredMatch): boolean {
  return record.commands.length === 0 && record.meta.totalCommands > 0;
}

/**
 * Development backend. `save` keeps the caller's record by reference instead of
 * deep-cloning on every command (that clone was the dominant cost of match
 * play, O(commands²)). Reads still deep-clone, so callers can never mutate
 * stored state by accident. Not durable and not multi-process safe.
 */
export class MemoryBackend implements StorageBackend {
  private readonly data = new Map<string, StoredMatch>();
  async save(matchId: string, record: StoredMatch): Promise<void> {
    this.data.set(matchId, record);
  }
  async load(matchId: string): Promise<StoredMatch | undefined> {
    const r = this.data.get(matchId);
    return r ? structuredClone(r) : undefined;
  }
  async list(): Promise<string[]> {
    return [...this.data.keys()];
  }
  /**
   * Header-only read: shares the record by reference, so callers must treat the
   * result as read-only. `commands` is emptied to make accidental full replay
   * impossible; `meta.totalCommands` still reports the true length.
   */
  async loadHeader(matchId: string): Promise<StoredMatch | undefined> {
    const r = this.data.get(matchId);
    if (!r) return undefined;
    return { ...r, commands: [] };
  }
  /**
   * Logical suffix selection over the in-memory array. No physical I/O is
   * involved here, so this is a genuine range query; the returned array is a
   * fresh copy so callers cannot mutate stored commands.
   */
  async readCommandsAfter(matchId: string, range: CommandRange): Promise<SuffixReadResult> {
    const record = this.data.get(matchId);
    if (!record) return { commands: [], totalCommands: 0, commandsExcluded: 0, maxSeq: 0 };
    const all = record.commands;
    const out: PersistedCommand[] = [];
    let excluded = 0;
    // The array index IS the storage sequence: commands are append-only and
    // stored zero-based, so `afterSeq` is an index bound.
    //
    // Filtering on `resultRevision` alone was wrong. The engine only advances
    // the revision when a command emits an event, so a command that is accepted
    // but emits nothing shares the previous command's revision. A snapshot
    // taken between two such commands therefore has a revision boundary that
    // does not line up with the command boundary, and the revision filter both
    // dropped a command the snapshot had not covered and kept one it had.
    for (let seq = 0; seq < all.length; seq += 1) {
      const c = all[seq]!;
      if (range.afterSeq !== undefined) {
        // A storage sequence is present, so it is the WHOLE answer. Applying the
        // revision bound as well is not a belt-and-braces check, it is a second
        // and wrong filter: the engine only advances the revision when a command
        // emits an event, so the first command after a snapshot can legitimately
        // carry the snapshot's own revision and would be silently dropped, making
        // a complete suffix look short and forcing a full replay.
        if (seq < range.afterSeq) {
          excluded += 1;
          continue;
        }
      } else if ((c.resultRevision ?? 0) <= range.afterRevision) {
        // No sequence: fall back to the revision bound alone.
        excluded += 1;
        continue;
      }
      if (range.throughSeq !== undefined && seq >= range.throughSeq) break;
      out.push(c);
    }
    if (range.limit !== undefined && out.length > range.limit) out.length = range.limit;
    return { commands: out, totalCommands: all.length, commandsExcluded: excluded, maxSeq: all.length };
  }
}

/** File-backed JSON store (one file per match, atomic tmp+rename writes). */
export class FileBackend implements StorageBackend {
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = dataDir;
    mkdirSync(this.dir, { recursive: true });
  }
  private path(matchId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(matchId)) throw new Error("Invalid match id");
    return join(this.dir, `${matchId}.json`);
  }
  async save(matchId: string, record: StoredMatch): Promise<void> {
    const tmp = `${this.path(matchId)}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, this.path(matchId));
  }
  async load(matchId: string): Promise<StoredMatch | undefined> {
    const p = this.path(matchId);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as StoredMatch;
  }
  /** Header-only read; see `load` for the same single-document caveat. */
  async loadHeader(matchId: string): Promise<StoredMatch | undefined> {
    const record = await this.load(matchId);
    if (!record) return undefined;
    return { ...record, commands: [] };
  }
  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map((f) => f.slice(0, -".json".length));
  }
  /**
   * LOGICAL suffix selection, not physical partial I/O.
   *
   * The on-disk format is one atomically-renamed JSON document per match, so
   * the file must be read and parsed in full before any suffix can be extracted.
   * Changing to an append-only/segmented format would enable true partial
   * reads, but that requires a format version plus migration; compatibility wins
   * for this milestone. See docs/PERSISTENCE.md.
   */
  async readCommandsAfter(matchId: string, range: CommandRange): Promise<SuffixReadResult> {
    const record = await this.load(matchId);
    if (!record) return { commands: [], totalCommands: 0, commandsExcluded: 0, maxSeq: 0 };
    const commands: PersistedCommand[] = [];
    let excluded = 0;
    // Same index-bound semantics as MemoryBackend: array index is the storage
    // sequence, and `afterSeq`/`throughSeq` bound it. See the note there for why
    // a revision-only filter is not sufficient.
    for (let seq = 0; seq < record.commands.length; seq += 1) {
      const c = record.commands[seq]!;
      if (range.afterSeq !== undefined) {
        if (seq < range.afterSeq) {
          excluded += 1;
          continue;
        }
      } else if ((c.resultRevision ?? 0) <= range.afterRevision) {
        excluded += 1;
        continue;
      }
      if (range.throughSeq !== undefined && seq >= range.throughSeq) break;
      commands.push(c);
    }
    if (range.limit !== undefined && commands.length > range.limit) commands.length = range.limit;
    return { commands, totalCommands: record.commands.length, commandsExcluded: excluded, maxSeq: record.commands.length };
  }
}

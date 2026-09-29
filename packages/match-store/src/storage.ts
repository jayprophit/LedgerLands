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
  meta: { status: MatchStatus; stateRevision: number };
}

export interface StorageBackend {
  save(matchId: string, record: StoredMatch): Promise<void>;
  load(matchId: string): Promise<StoredMatch | undefined>;
  list(): Promise<string[]>;
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
  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map((f) => f.slice(0, -".json".length));
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GameCommand, MatchState } from "@ledgerlands/shared-types";
import type { Difficulty } from "@ledgerlands/game-ai";

/** A command persisted to the event log. Bot commands are persisted too, so replay is exact. */
export interface PersistedCommand {
  command: GameCommand;
  commandId: string;
  actorPlayerId: string;
  at: string;
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
}

export interface StorageBackend {
  save(matchId: string, record: StoredMatch): void;
  load(matchId: string): StoredMatch | undefined;
  list(): string[];
}

export class MemoryBackend implements StorageBackend {
  private readonly data = new Map<string, StoredMatch>();
  save(matchId: string, record: StoredMatch): void {
    this.data.set(matchId, structuredClone(record));
  }
  load(matchId: string): StoredMatch | undefined {
    const r = this.data.get(matchId);
    return r ? structuredClone(r) : undefined;
  }
  list(): string[] {
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
  save(matchId: string, record: StoredMatch): void {
    const tmp = `${this.path(matchId)}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, this.path(matchId));
  }
  load(matchId: string): StoredMatch | undefined {
    const p = this.path(matchId);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as StoredMatch;
  }
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map((f) => f.slice(0, -".json".length));
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { GameCommand, MatchState } from "@ledgerlands/shared-types";
import {
  applyCommand,
  BOARD_VERSION,
  createMatchState,
  GameRuleError,
  normalizeSeat,
  replayCommands,
  RULESET_VERSION,
} from "@ledgerlands/game-engine";
import { chooseAiCommand, difficultyFromString, type Difficulty } from "@ledgerlands/game-ai";
import {
  FileBackend,
  MemoryBackend,
  type MatchSnapshot,
  type PersistedCommand,
  type StorageBackend,
  type StoredMatch,
  type SuffixReadResult,
} from "./storage.js";

export * from "./storage.js";
export * from "./postgres.js";
export * from "./replay-manifest.js";
export * from "./disputes.js";

export interface CreateParams {
  playerName: string;
  startingBalance?: number;
  seed?: number;
  solo?: boolean;
  difficulty?: string;
  matchId?: string;
  humanId?: string;
}

export interface CommandOpts {
  commandId?: string;
  expectedRevision?: number;
}

export interface ReplayExport {
  rulesetVersion: string;
  boardVersion: string;
  matchId: string;
  seed: number;
  players: Array<{ id: string; name: string }>;
  commands: PersistedCommand[];
  events: MatchState["log"];
  finalState: MatchState;
  settlement: { winnerId?: string; balances: Record<string, number> };
  chainHash: string;
}

const SNAPSHOT_EVERY_COMMANDS = 25;

/**
 * Newest snapshot that is not ahead of the persisted command log.
 *
 * A snapshot claiming a sequence beyond `meta.totalCommands` (truncated write,
 * lost row, or a snapshot copied from a longer run of the same match) is
 * unusable and the caller must full-replay. When the record carries commands
 * (a full `load`, e.g. in tests), the revision is cross-checked against them too.
 */
function latestUsableSnapshot(stored: StoredMatch): MatchSnapshot | undefined {
  const total = stored.meta.totalCommands;
  const candidates = [...stored.snapshots]
    // A snapshot cannot cover more commands than the log holds.
    .filter((s) => (s.seq === undefined ? true : s.seq <= total))
    .sort((a, b) => b.revision - a.revision || (b.seq ?? 0) - (a.seq ?? 0));
  if (stored.commands.length > 0) {
    // Full record in hand: cross-check the claimed revision against the log.
    const revs = new Set(stored.commands.map((c) => c.resultRevision ?? 0));
    return candidates.find((s) => revs.has(s.revision));
  }
  return candidates[0];
}

/**
 * A suffix may be used only when it is a gap-free run (strictly increasing
 * result revisions), starts strictly after the snapshot revision, and accounts
 * for every command the backend holds. Anything else means snapshot and log
 * disagree — including a tampered snapshot whose `revision` lies about where it
 * sits — so the only safe answer is a full replay.
 */
function suffixIsComplete(suffix: SuffixReadResult, snapshot: MatchSnapshot): boolean {
  if (snapshot.seq === undefined) return false; // cannot be validated
  if (snapshot.seq > suffix.totalCommands) return false; // snapshot ahead of the log
  // The authoritative check: a snapshot covering `seq` commands must be
  // followed by exactly `total - seq` more. This catches a snapshot whose
  // revision lies, because the returned suffix then has the wrong length.
  if (suffix.commands.length !== suffix.totalCommands - snapshot.seq) return false;
  // And the returned run must not go BACKWARDS relative to the claimed revision.
  //
  // Non-decreasing, not strictly increasing. The engine only advances
  // `revision` when a command emits an event, so a command that is accepted but
  // produces no event leaves the revision where it was. Two consecutive
  // commands can therefore share a `resultRevision`, and requiring strict
  // increase made a perfectly valid suffix look corrupt and forced a full
  // replay. Completeness is established by the command-COUNT check above, which
  // is authoritative; this only rejects a suffix that runs backwards.
  let prev = snapshot.revision;
  for (const c of suffix.commands) {
    const r = c.resultRevision ?? 0;
    if (r < prev) return false;
    prev = r;
  }
  return true;
}

export function chainHashForEvents(events: MatchState["log"]): string {
  let prev = "GENESIS";
  for (const e of events) {
    prev = createHash("sha256").update(prev + JSON.stringify(e)).digest("hex");
  }
  return prev;
}

export type RebuildPath = "suffix" | "full-replay";

export class PersistentMatchStore {
  private readonly states = new Map<string, MatchState>();
  /** Observability: which reconstruction path the last rebuild took. */
  lastRebuild: { matchId: string; path: RebuildPath; at: string } | undefined;
  constructor(private readonly backend: StorageBackend = new MemoryBackend()) {}

  static withFileBackend(dataDir: string): PersistentMatchStore {
    return new PersistentMatchStore(new FileBackend(dataDir));
  }

  async create(params: CreateParams): Promise<{ match: MatchState; playerId: string }> {
    const name = params.playerName.trim();
    if (!name) throw new GameRuleError("INVALID_NAME", "playerName is required.");
    if (name.length > 40) throw new GameRuleError("INVALID_NAME", "playerName too long.");
    const solo = params.solo ?? true;
    const difficulty = difficultyFromString(params.difficulty ?? "NORMAL");
    const matchId = params.matchId ?? randomUUID();
    const humanId = params.humanId ?? randomUUID();
    const players = [{ id: humanId, name, balance: params.startingBalance ?? 15000 }];
    if (solo) {
      players.push({ id: `bot-${randomUUID()}`, name: `Aether Bot (${difficulty})`, balance: params.startingBalance ?? 15000 });
    }
    const initial = createMatchState({ id: matchId, seed: params.seed ?? Math.floor(Date.now() % 0xffff_ffff), players });
    const now = new Date().toISOString();
    const stored: StoredMatch = {
      initial: structuredClone(initial),
      commands: [],
      snapshots: [],
      corrections: [],
      seenCommandIds: [],
      botDifficulty: difficulty,
      solo,
      createdAt: now,
      updatedAt: now,
      meta: { status: "LOBBY", stateRevision: 0, totalCommands: 0 },
    };
    let live = structuredClone(initial);
    if (solo) {
      live = this.applyAndPersist(matchId, stored, live, humanId, { type: "START_MATCH" }, `sys-start-${matchId}`);
    }
    this.syncMeta(stored, live);
    await this.backend.save(matchId, stored);
    this.states.set(matchId, live);
    return { match: structuredClone(live), playerId: humanId };
  }

  async get(matchId: string): Promise<MatchState | undefined> {
    const live = this.states.get(matchId);
    if (live) return structuredClone(live);
    const rebuilt = await this.rebuild(matchId);
    return rebuilt ? structuredClone(rebuilt) : undefined;
  }

  async join(matchId: string, playerName: string, startingBalance = 15000): Promise<{ match: MatchState; playerId: string }> {
    const stored = await this.requireStored(matchId);
    const live = await this.liveState(matchId, stored);
    if (live.status !== "LOBBY") throw new GameRuleError("MATCH_ALREADY_RUNNING", "Cannot join after the match has started.");
    if (live.players.length >= 4) throw new GameRuleError("MATCH_FULL", "Match already has four players.");
    if (live.players.some((p) => p.id.startsWith("bot-"))) throw new GameRuleError("SOLO_MATCH", "Cannot join a solo match.");
    const name = playerName.trim();
    if (!name) throw new GameRuleError("INVALID_NAME", "playerName is required.");
    live.players.push({
      id: randomUUID(),
      name,
      position: 0,
      balance: startingBalance,
      inDetention: false,
      detentionTurns: 0,
      doublesStreak: 0,
      bankrupt: false,
      detentionCards: 0,
    });
    // Join mutates the lobby roster (pre-start): persist by replacing initial.
    stored.initial = this.lobbySnapshot(live);
    this.syncMeta(stored, live);
    this.touch(stored);
    await this.backend.save(matchId, stored);
    this.states.set(matchId, live);
    const player = live.players.at(-1)!;
    return { match: structuredClone(live), playerId: player.id };
  }

  async start(matchId: string): Promise<MatchState> {
    const stored = await this.requireStored(matchId);
    const live = await this.liveState(matchId, stored);
    if (live.status !== "LOBBY") throw new GameRuleError("MATCH_ALREADY_STARTED", "Match already started.");
    if (live.players.length < 2) throw new GameRuleError("NOT_ENOUGH_PLAYERS", "Need at least 2 players to start.");
    const next = this.applyAndPersist(matchId, stored, live, live.players[0]!.id, { type: "START_MATCH" }, `sys-start-${matchId}-${stored.commands.length}`);
    this.syncMeta(stored, next);
    await this.backend.save(matchId, stored);
    this.states.set(matchId, next);
    return structuredClone(next);
  }

  async command(matchId: string, actorPlayerId: string, command: GameCommand, opts?: CommandOpts): Promise<MatchState> {
    const stored = await this.requireStored(matchId);
    const commandId = opts?.commandId ?? randomUUID();
    if (stored.seenCommandIds.includes(commandId)) {
      return structuredClone(await this.liveState(matchId, stored));
    }
    const live = await this.liveState(matchId, stored);
    if (opts?.expectedRevision !== undefined && live.revision !== opts.expectedRevision) {
      throw new GameRuleError("STALE_STATE", `Expected revision ${opts.expectedRevision} but match is at ${live.revision}.`);
    }
    const actor = "playerId" in command ? (command as { playerId: string }).playerId : actorPlayerId;
    if (actor !== actorPlayerId) throw new GameRuleError("ACTOR_MISMATCH", "Command player does not match authenticated actor.");
    let next = this.applyAndPersist(matchId, stored, live, actorPlayerId, command, commandId);
    next = this.runBotTurns(matchId, stored, next);
    this.syncMeta(stored, next);
    await this.backend.save(matchId, stored);
    this.states.set(matchId, next);
    return structuredClone(next);
  }

  /** Events after a revision — for reconnect/event-sync. */
  async eventsSince(matchId: string, sinceRevision: number): Promise<MatchState["log"]> {
    const live = await this.liveState(matchId, await this.requireStored(matchId));
    return live.log.filter((e) => e.atRevision > sinceRevision);
  }

  /** Opaque resume token binding a client to a match revision. */
  async resumeToken(matchId: string): Promise<string> {
    const live = await this.liveState(matchId, await this.requireStored(matchId));
    return Buffer.from(`llr1.${matchId}.${live.revision}`, "utf8").toString("base64url");
  }

  async resume(token: string): Promise<{ match: MatchState; currentRevision: number; stale: boolean }> {
    let decoded: string;
    try {
      decoded = Buffer.from(token, "base64url").toString("utf8");
    } catch {
      throw new GameRuleError("INVALID_TOKEN", "Resume token is malformed.");
    }
    const parts = decoded.split(".");
    if (parts.length !== 3 || parts[0] !== "llr1") throw new GameRuleError("INVALID_TOKEN", "Resume token is malformed.");
    const [, matchId, revStr] = parts as [string, string, string];
    const live = await this.liveState(matchId!, await this.requireStored(matchId!));
    const want = Number(revStr);
    return { match: structuredClone(live), currentRevision: live.revision, stale: live.revision !== want };
  }

  /** Cancel stale LOBBY matches. Returns cancelled ids. */
  async sweepLobbyTimeouts(nowMs: number, lobbyTimeoutMs: number): Promise<string[]> {
    const cancelled: string[] = [];
    for (const matchId of await this.backend.list()) {
      const stored = await this.backend.load(matchId);
      if (!stored) continue;
      const live = await this.liveState(matchId, stored);
      if (live.status !== "LOBBY") continue;
      if (nowMs - Date.parse(stored.createdAt) < lobbyTimeoutMs) continue;
      stored.corrections.push({ kind: "CANCEL_LOBBY_TIMEOUT", at: new Date(nowMs).toISOString(), detail: `lobby idle > ${lobbyTimeoutMs}ms` });
      stored.meta = { status: "CANCELLED", stateRevision: live.revision, totalCommands: stored.commands.length };
      this.touch(stored);
      await this.backend.save(matchId, stored);
      this.states.delete(matchId);
      cancelled.push(matchId);
    }
    return cancelled;
  }

  async exportReplay(matchId: string): Promise<ReplayExport> {
    const stored = await this.requireStored(matchId);
    const live = await this.liveState(matchId, stored);
    if (live.status === "LOBBY") throw new GameRuleError("MATCH_NOT_STARTED", "Match has not started.");
    const balances: Record<string, number> = {};
    for (const p of live.players) balances[p.name] = p.balance;
    const export_: ReplayExport = {
      rulesetVersion: live.rulesetVersion ?? RULESET_VERSION,
      boardVersion: BOARD_VERSION,
      matchId,
      seed: live.seed,
      players: live.players.map((p) => ({ id: p.id, name: p.name })),
      commands: stored.commands.map((c) => ({ ...c })),
      events: live.log.map((e) => ({ ...e })),
      finalState: structuredClone(live),
      settlement: {
        ...(live.winnerId ? { winnerId: live.players.find((p) => p.id === live.winnerId)?.name ?? live.winnerId } : {}),
        balances,
      },
      chainHash: chainHashForEvents(live.log),
    };
    return export_;
  }

  async list(): Promise<MatchState[]> {
    const ids = await this.backend.list();
    const out: MatchState[] = [];
    for (const id of ids) out.push(structuredClone(await this.liveState(id, await this.requireStored(id))));
    return out;
  }

  // ---- internals ----

  private async requireStored(matchId: string): Promise<StoredMatch> {
    const stored = await this.backend.load(matchId);
    if (!stored) throw new GameRuleError("MATCH_NOT_FOUND", `Match ${matchId} was not found.`);
    return stored;
  }

  private async liveState(matchId: string, stored: StoredMatch): Promise<MatchState> {
    const cached = this.states.get(matchId);
    if (cached && !stored.corrections.some((c) => c.kind === "CANCEL_LOBBY_TIMEOUT")) return cached;
    const rebuilt = await this.rebuild(matchId);
    if (!rebuilt) throw new GameRuleError("MATCH_NOT_FOUND", `Match ${matchId} was not found.`);
    return rebuilt;
  }

  /**
   * Deterministic rebuild. Preferred path is a *suffix read*: load the record
   * header, pick the newest usable snapshot, then ask the backend for only the
   * commands after that revision. If no snapshot is usable (or a suffix read
   * fails), it falls back to a full replay from `initial`.
   *
   * `lastRebuild` records which path ran, so callers/tests can assert that the
   * suffix path is actually taken rather than silently degenerating.
   */
  async rebuild(matchId: string): Promise<MatchState | undefined> {
    // Header first: the command log is fetched only if it is actually needed.
    const header = await this.backend.loadHeader(matchId);
    if (!header) return undefined;
    let state: MatchState;
    let path: RebuildPath;
    try {
      const rebuilt = await this.rebuildFromSuffix(matchId, header);
      state = rebuilt.state;
      path = rebuilt.path;
    } catch {
      // Suffix read failed (transient backend error): fall back to a full read
      // so a read never returns nothing just because a range query failed.
      const full = await this.backend.load(matchId);
      if (!full) return undefined;
      state = normalizeSeat(replayCommands(structuredClone(full.initial), full.commands.map((c) => c.command)));
      path = "full-replay";
    }
    if (header.corrections.some((c) => c.kind === "CANCEL_LOBBY_TIMEOUT")) {
      state = { ...state, status: "CANCELLED" };
    }
    this.states.set(matchId, state);
    this.lastRebuild = { matchId, path, at: new Date().toISOString() };
    return state;
  }

  /** Snapshot + suffix replay, with a full-replay fallback. */
  private async rebuildFromSuffix(
    matchId: string,
    stored: StoredMatch,
  ): Promise<{ state: MatchState; path: RebuildPath }> {
    const snapshot = latestUsableSnapshot(stored);
    if (!snapshot) {
      // No usable snapshot: read the whole log and replay from the beginning.
      const full = await this.backend.load(matchId);
      if (!full) throw new Error("match not found during rebuild");
      return {
        state: normalizeSeat(replayCommands(structuredClone(full.initial), full.commands.map((c) => c.command))),
        path: "full-replay",
      };
    }
    const suffix = await this.backend.readCommandsAfter(matchId, {
      afterRevision: snapshot.revision,
      ...(snapshot.seq !== undefined ? { afterSeq: snapshot.seq } : {}),
    });
    if (!suffixIsComplete(suffix, snapshot)) {
      const full = await this.backend.load(matchId);
      if (!full) throw new Error("match not found during rebuild");
      return {
        state: normalizeSeat(replayCommands(structuredClone(full.initial), full.commands.map((c) => c.command))),
        path: "full-replay",
      };
    }
    return {
      state: normalizeSeat(replayCommands(structuredClone(snapshot.state), suffix.commands.map((c) => c.command))),
      path: "suffix",
    };
  }

  private applyAndPersist(
    matchId: string,
    stored: StoredMatch,
    live: MatchState,
    actorPlayerId: string,
    command: GameCommand,
    commandId: string,
  ): MatchState {
    const next = applyCommand(live, command);
    stored.commands.push({ command, commandId, actorPlayerId, at: new Date().toISOString(), resultRevision: next.revision });
    stored.seenCommandIds.push(commandId);
    if (stored.commands.length % SNAPSHOT_EVERY_COMMANDS === 0) {
      // `seq` is the count of commands already applied, so a suffix read can
      // start at exactly the next sequence.
      stored.snapshots.push({
        revision: next.revision,
        seq: stored.commands.length,
        state: structuredClone(next),
        at: new Date().toISOString(),
      });
      if (stored.snapshots.length > 8) stored.snapshots.shift();
    }
    this.touch(stored);
    void matchId;
    return next;
  }

  private runBotTurns(matchId: string, stored: StoredMatch, state: MatchState): MatchState {
    let safety = 0;
    let current = state;
    while (current.status === "ACTIVE" && safety++ < 40) {
      const player = current.players[current.currentPlayerIndex];
      if (!player?.id.startsWith("bot-")) return current;
      try {
        const cmd = chooseAiCommand(current, player.id, stored.botDifficulty);
        if (!cmd) return current;
        const actor = "playerId" in cmd ? (cmd as { playerId: string }).playerId : player.id;
        current = this.applyAndPersist(matchId, stored, current, actor, cmd, `bot-${matchId}-${stored.commands.length}`);
        if (cmd.type === "END_TURN" && !current.pendingExtraRoll) continue;
        if (cmd.type !== "ROLL_DICE" && cmd.type !== "END_TURN") continue;
      } catch {
        try {
          current = this.applyAndPersist(matchId, stored, current, player.id, { type: "END_TURN", playerId: player.id }, `bot-end-${matchId}-${stored.commands.length}`);
        } catch {
          return current;
        }
      }
    }
    return current;
  }

  /** Capture the pre-start lobby roster back into `initial` (join is pre-start only). */
  private lobbySnapshot(live: MatchState): MatchState {
    return {
      ...structuredClone(live),
      status: "LOBBY",
      turn: 0,
      currentPlayerIndex: 0,
      turnPhase: "ROLL",
      pendingExtraRoll: false,
      revision: 0,
      log: [],
      rngState: live.seed,
    };
  }

  private touch(stored: StoredMatch): void {
    stored.updatedAt = new Date().toISOString();
  }

  private syncMeta(stored: StoredMatch, live: MatchState): void {
    const cancelled = stored.corrections.some((c) => c.kind === "CANCEL_LOBBY_TIMEOUT");
    stored.meta = {
      status: cancelled ? "CANCELLED" : live.status,
      stateRevision: live.revision,
      totalCommands: stored.commands.length,
    };
  }
}

export type { Difficulty };

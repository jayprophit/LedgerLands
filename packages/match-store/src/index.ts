import { createHash, randomUUID } from "node:crypto";
import type { GameCommand, MatchState } from "@ledgerlands/shared-types";
import {
  applyCommand,
  BOARD_VERSION,
  createMatchState,
  GameRuleError,
  replayCommands,
  RULESET_VERSION,
} from "@ledgerlands/game-engine";
import { chooseAiCommand, difficultyFromString, type Difficulty } from "@ledgerlands/game-ai";
import {
  FileBackend,
  MemoryBackend,
  type PersistedCommand,
  type StorageBackend,
  type StoredMatch,
} from "./storage.js";

export * from "./storage.js";

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

export function chainHashForEvents(events: MatchState["log"]): string {
  let prev = "GENESIS";
  for (const e of events) {
    prev = createHash("sha256").update(prev + JSON.stringify(e)).digest("hex");
  }
  return prev;
}

export class PersistentMatchStore {
  private readonly states = new Map<string, MatchState>();
  constructor(private readonly backend: StorageBackend = new MemoryBackend()) {}

  static withFileBackend(dataDir: string): PersistentMatchStore {
    return new PersistentMatchStore(new FileBackend(dataDir));
  }

  create(params: CreateParams): { match: MatchState; playerId: string } {
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
    };
    let live = structuredClone(initial);
    if (solo) {
      live = this.applyAndPersist(matchId, stored, live, humanId, { type: "START_MATCH" }, `sys-start-${matchId}`);
    }
    this.backend.save(matchId, stored);
    this.states.set(matchId, live);
    return { match: structuredClone(live), playerId: humanId };
  }

  get(matchId: string): MatchState | undefined {
    const live = this.states.get(matchId);
    if (live) return structuredClone(live);
    const rebuilt = this.rebuild(matchId);
    return rebuilt ? structuredClone(rebuilt) : undefined;
  }

  join(matchId: string, playerName: string, startingBalance = 15000): { match: MatchState; playerId: string } {
    const stored = this.requireStored(matchId);
    const live = this.liveState(matchId, stored);
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
    this.touch(stored);
    this.backend.save(matchId, stored);
    this.states.set(matchId, live);
    const player = live.players.at(-1)!;
    return { match: structuredClone(live), playerId: player.id };
  }

  start(matchId: string): MatchState {
    const stored = this.requireStored(matchId);
    const live = this.liveState(matchId, stored);
    if (live.status !== "LOBBY") throw new GameRuleError("MATCH_ALREADY_STARTED", "Match already started.");
    if (live.players.length < 2) throw new GameRuleError("NOT_ENOUGH_PLAYERS", "Need at least 2 players to start.");
    const next = this.applyAndPersist(matchId, stored, live, live.players[0]!.id, { type: "START_MATCH" }, `sys-start-${matchId}-${stored.commands.length}`);
    this.backend.save(matchId, stored);
    this.states.set(matchId, next);
    return structuredClone(next);
  }

  command(matchId: string, actorPlayerId: string, command: GameCommand, opts?: CommandOpts): MatchState {
    const stored = this.requireStored(matchId);
    const commandId = opts?.commandId ?? randomUUID();
    if (stored.seenCommandIds.includes(commandId)) {
      return structuredClone(this.liveState(matchId, stored));
    }
    const live = this.liveState(matchId, stored);
    if (opts?.expectedRevision !== undefined && live.revision !== opts.expectedRevision) {
      throw new GameRuleError("STALE_STATE", `Expected revision ${opts.expectedRevision} but match is at ${live.revision}.`);
    }
    const actor = "playerId" in command ? (command as { playerId: string }).playerId : actorPlayerId;
    if (actor !== actorPlayerId) throw new GameRuleError("ACTOR_MISMATCH", "Command player does not match authenticated actor.");
    let next = this.applyAndPersist(matchId, stored, live, actorPlayerId, command, commandId);
    next = this.runBotTurns(matchId, stored, next);
    this.backend.save(matchId, stored);
    this.states.set(matchId, next);
    return structuredClone(next);
  }

  /** Events after a revision — for reconnect/event-sync. */
  eventsSince(matchId: string, sinceRevision: number): MatchState["log"] {
    const live = this.liveState(matchId, this.requireStored(matchId));
    return live.log.filter((e) => e.atRevision > sinceRevision);
  }

  /** Opaque resume token binding a client to a match revision. */
  resumeToken(matchId: string): string {
    const live = this.liveState(matchId, this.requireStored(matchId));
    return Buffer.from(`llr1.${matchId}.${live.revision}`, "utf8").toString("base64url");
  }

  resume(token: string): { match: MatchState; currentRevision: number; stale: boolean } {
    let decoded: string;
    try {
      decoded = Buffer.from(token, "base64url").toString("utf8");
    } catch {
      throw new GameRuleError("INVALID_TOKEN", "Resume token is malformed.");
    }
    const parts = decoded.split(".");
    if (parts.length !== 3 || parts[0] !== "llr1") throw new GameRuleError("INVALID_TOKEN", "Resume token is malformed.");
    const [, matchId, revStr] = parts as [string, string, string];
    const live = this.liveState(matchId!, this.requireStored(matchId!));
    const want = Number(revStr);
    return { match: structuredClone(live), currentRevision: live.revision, stale: live.revision !== want };
  }

  /** Cancel stale LOBBY matches. Returns cancelled ids. */
  sweepLobbyTimeouts(nowMs: number, lobbyTimeoutMs: number): string[] {
    const cancelled: string[] = [];
    for (const matchId of this.backend.list()) {
      const stored = this.backend.load(matchId);
      if (!stored) continue;
      const live = this.liveState(matchId, stored);
      if (live.status !== "LOBBY") continue;
      if (nowMs - Date.parse(stored.createdAt) < lobbyTimeoutMs) continue;
      stored.corrections.push({ kind: "CANCEL_LOBBY_TIMEOUT", at: new Date(nowMs).toISOString(), detail: `lobby idle > ${lobbyTimeoutMs}ms` });
      this.touch(stored);
      this.backend.save(matchId, stored);
      this.states.delete(matchId);
      cancelled.push(matchId);
    }
    return cancelled;
  }

  exportReplay(matchId: string): ReplayExport {
    const stored = this.requireStored(matchId);
    const live = this.liveState(matchId, stored);
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

  list(): MatchState[] {
    return this.backend.list().map((id) => structuredClone(this.liveState(id, this.requireStored(id))));
  }

  // ---- internals ----

  private requireStored(matchId: string): StoredMatch {
    const stored = this.backend.load(matchId);
    if (!stored) throw new GameRuleError("MATCH_NOT_FOUND", `Match ${matchId} was not found.`);
    return stored;
  }

  private liveState(matchId: string, stored: StoredMatch): MatchState {
    const cached = this.states.get(matchId);
    if (cached && !stored.corrections.some((c) => c.kind === "CANCEL_LOBBY_TIMEOUT")) return cached;
    const rebuilt = this.rebuild(matchId);
    if (!rebuilt) throw new GameRuleError("MATCH_NOT_FOUND", `Match ${matchId} was not found.`);
    return rebuilt;
  }

  /** Deterministic rebuild: initial + persisted commands, then corrections. */
  rebuild(matchId: string): MatchState | undefined {
    const stored = this.backend.load(matchId);
    if (!stored) return undefined;
    let state = replayCommands(structuredClone(stored.initial), stored.commands.map((c) => c.command));
    if (stored.corrections.some((c) => c.kind === "CANCEL_LOBBY_TIMEOUT")) {
      state = { ...state, status: "CANCELLED" };
    }
    this.states.set(matchId, state);
    return state;
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
    stored.commands.push({ command, commandId, actorPlayerId, at: new Date().toISOString() });
    stored.seenCommandIds.push(commandId);
    if (stored.commands.length % SNAPSHOT_EVERY_COMMANDS === 0) {
      stored.snapshots.push({ revision: next.revision, state: structuredClone(next), at: new Date().toISOString() });
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
}

export type { Difficulty };

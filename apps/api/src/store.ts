import { randomUUID } from "node:crypto";
import type { GameCommand, MatchState } from "@ledgerlands/shared-types";
import { applyCommand, createMatchState, GameRuleError } from "@ledgerlands/game-engine";
import { chooseAiCommand, difficultyFromString, type Difficulty } from "@ledgerlands/game-ai";

export interface MatchRecord {
  state: MatchState;
  createdAt: string;
  updatedAt: string;
  botDifficulty: Difficulty;
  seenCommands: Set<string>;
}

export class MatchStore {
  private readonly matches = new Map<string, MatchRecord>();

  create(params: {
    playerName: string;
    startingBalance?: number;
    seed?: number;
    solo?: boolean;
    difficulty?: string;
  }): MatchState {
    const matchId = randomUUID();
    const humanId = randomUUID();
    const solo = params.solo ?? true;
    const difficulty = difficultyFromString(params.difficulty ?? "NORMAL");
    const players = [{ id: humanId, name: params.playerName, balance: params.startingBalance ?? 15000 }];
    if (solo) {
      players.push({ id: `bot-${randomUUID()}`, name: `Aether Bot (${difficulty})`, balance: params.startingBalance ?? 15000 });
    }
    let state = createMatchState({
      id: matchId,
      seed: params.seed ?? Math.floor(Date.now() % 0xffff_ffff),
      players,
    });
    const now = new Date().toISOString();
    const record: MatchRecord = { state, createdAt: now, updatedAt: now, botDifficulty: difficulty, seenCommands: new Set() };
    this.matches.set(matchId, record);
    if (solo) {
      // Solo starts immediately; multiplayer lobbies wait for explicit start.
      record.state = applyCommand(record.state, { type: "START_MATCH" });
    }
    return structuredClone(record.state);
  }

  get(matchId: string): MatchState | undefined {
    const record = this.matches.get(matchId);
    return record ? structuredClone(record.state) : undefined;
  }

  join(matchId: string, playerName: string, startingBalance = 15000): MatchState {
    const record = this.require(matchId);
    if (record.state.status !== "LOBBY") {
      throw new GameRuleError("MATCH_ALREADY_RUNNING", "Cannot join after the match has started.");
    }
    if (record.state.players.length >= 4) throw new GameRuleError("MATCH_FULL", "Match already has four players.");
    if (record.state.players.some((p) => p.id.startsWith("bot-"))) {
      throw new GameRuleError("SOLO_MATCH", "Cannot join a solo match.");
    }
    record.state.players.push({
      id: randomUUID(),
      name: playerName,
      position: 0,
      balance: startingBalance,
      inDetention: false,
      detentionTurns: 0,
      doublesStreak: 0,
      bankrupt: false,
      detentionCards: 0,
    });
    record.updatedAt = new Date().toISOString();
    return structuredClone(record.state);
  }

  start(matchId: string): MatchState {
    const record = this.require(matchId);
    if (record.state.status !== "LOBBY") throw new GameRuleError("MATCH_ALREADY_STARTED", "Match already started.");
    if (record.state.players.length < 2) throw new GameRuleError("NOT_ENOUGH_PLAYERS", "Need at least 2 players to start.");
    record.state = applyCommand(record.state, { type: "START_MATCH" });
    record.updatedAt = new Date().toISOString();
    return structuredClone(record.state);
  }

  command(
    matchId: string,
    actorPlayerId: string,
    command: GameCommand,
    opts?: { commandId?: string; expectedRevision?: number },
  ): MatchState {
    const record = this.require(matchId);
    // Idempotency: same commandId returns current state without re-applying.
    if (opts?.commandId) {
      if (record.seenCommands.has(opts.commandId)) return structuredClone(record.state);
    }
    if (opts?.expectedRevision !== undefined && record.state.revision !== opts.expectedRevision) {
      throw new GameRuleError("STALE_STATE", `Expected revision ${opts.expectedRevision} but match is at ${record.state.revision}.`);
    }
    const commandActor = "playerId" in command ? (command as { playerId: string }).playerId : actorPlayerId;
    if (commandActor !== actorPlayerId) {
      throw new GameRuleError("ACTOR_MISMATCH", "Command player does not match authenticated actor.");
    }
    record.state = applyCommand(record.state, command);
    if (opts?.commandId) record.seenCommands.add(opts.commandId);
    record.updatedAt = new Date().toISOString();
    this.runBotTurns(record);
    return structuredClone(record.state);
  }

  private runBotTurns(record: MatchRecord): void {
    let safety = 0;
    while (record.state.status === "ACTIVE" && safety++ < 40) {
      const current = record.state.players[record.state.currentPlayerIndex];
      if (!current?.id.startsWith("bot-")) return;
      try {
        const cmd = chooseAiCommand(record.state, current.id, record.botDifficulty);
        if (!cmd) return;
        record.state = applyCommand(record.state, cmd);
        // chooseAiCommand returns terminal END_TURN when done; loop continues if extra roll granted.
        if (cmd.type === "END_TURN" && !record.state.pendingExtraRoll) {
          // After END_TURN the turn advanced; continue loop to handle next bot in a row (multi-bot).
          continue;
        }
        if (cmd.type !== "ROLL_DICE" && cmd.type !== "END_TURN") {
          // After buy/develop/decline, AI still needs to end turn — run one more AI step immediately.
          continue;
        }
      } catch {
        // If bot picks an illegal move (shouldn't happen), end its turn to avoid soft-lock.
        try {
          record.state = applyCommand(record.state, { type: "END_TURN", playerId: current.id });
        } catch {
          return;
        }
      }
    }
  }

  list(): MatchState[] {
    return [...this.matches.values()].map((r) => structuredClone(r.state));
  }

  private require(matchId: string): MatchRecord {
    const record = this.matches.get(matchId);
    if (!record) throw new GameRuleError("MATCH_NOT_FOUND", `Match ${matchId} was not found.`);
    return record;
  }
}

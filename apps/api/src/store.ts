import { randomUUID } from "node:crypto";
import type { GameCommand, MatchState } from "@ledgerlands/shared-types";
import { applyCommand, createMatchState, DEFAULT_BOARD, GameRuleError } from "@ledgerlands/game-engine";

export interface MatchRecord {
  state: MatchState;
  createdAt: string;
  updatedAt: string;
}

export class MatchStore {
  private readonly matches = new Map<string, MatchRecord>();

  create(params: { playerName: string; startingBalance?: number; seed?: number; solo?: boolean }): MatchState {
    const matchId = randomUUID();
    const humanId = randomUUID();
    const players = [
      { id: humanId, name: params.playerName, balance: params.startingBalance ?? 15000 },
    ];
    if (params.solo ?? true) {
      players.push({ id: `bot-${randomUUID()}`, name: "Aether Bot", balance: params.startingBalance ?? 15000 });
    }
    let state = createMatchState({
      id: matchId,
      seed: params.seed ?? Math.floor(Date.now() % 0xffff_ffff),
      players,
    });
    state = applyCommand(state, { type: "START_MATCH" });
    const now = new Date().toISOString();
    this.matches.set(matchId, { state, createdAt: now, updatedAt: now });
    return structuredClone(state);
  }

  get(matchId: string): MatchState | undefined {
    const record = this.matches.get(matchId);
    return record ? structuredClone(record.state) : undefined;
  }

  join(matchId: string, playerName: string, startingBalance = 15000): MatchState {
    const record = this.require(matchId);
    if (record.state.status !== "LOBBY" && record.state.turn > 0) {
      throw new GameRuleError("MATCH_ALREADY_RUNNING", "Cannot join after the match has begun play.");
    }
    if (record.state.players.length >= 4) throw new GameRuleError("MATCH_FULL", "Match already has four players.");
    record.state.players.push({
      id: randomUUID(),
      name: playerName,
      position: 0,
      balance: startingBalance,
      inDetention: false,
      detentionTurns: 0,
      doublesStreak: 0,
      bankrupt: false,
    });
    record.updatedAt = new Date().toISOString();
    return structuredClone(record.state);
  }

  command(matchId: string, actorPlayerId: string, command: GameCommand): MatchState {
    const record = this.require(matchId);
    const commandActor = "playerId" in command ? command.playerId : actorPlayerId;
    if (commandActor !== actorPlayerId) {
      throw new GameRuleError("ACTOR_MISMATCH", "Command player does not match authenticated actor.");
    }
    record.state = applyCommand(record.state, command);
    record.updatedAt = new Date().toISOString();
    this.runBotTurns(record);
    return structuredClone(record.state);
  }

  private runBotTurns(record: MatchRecord): void {
    let safety = 0;
    while (record.state.status === "ACTIVE" && safety++ < 20) {
      const current = record.state.players[record.state.currentPlayerIndex];
      if (!current?.id.startsWith("bot-")) return;

      if (record.state.turnPhase === "ROLL") {
        record.state = applyCommand(record.state, { type: "ROLL_DICE" });
        continue;
      }

      const tile = DEFAULT_BOARD[current.position];
      const property = tile ? record.state.properties[tile.id] : undefined;
      const price = tile?.economics?.purchasePrice ?? (tile?.type === "TRANSIT" || tile?.type === "SERVICE" ? tile.amount ?? 0 : 0);
      if (tile && property && !property.ownerId && price > 0 && current.balance >= price * 1.5) {
        record.state = applyCommand(record.state, { type: "BUY_PROPERTY", playerId: current.id, tileId: tile.id });
      }

      record.state = applyCommand(record.state, { type: "END_TURN", playerId: current.id });
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

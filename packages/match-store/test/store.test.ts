import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameRuleError } from "@ledgerlands/game-engine";
import { FileBackend, MemoryBackend, PersistentMatchStore } from "../src/index.js";

describe("PersistentMatchStore", () => {
  it("creates solo matches started immediately", async () => {
    const store = new PersistentMatchStore(new MemoryBackend());
    const { match, playerId } = await store.create({ playerName: "Solo", seed: 7 });
    expect(match.status).toBe("ACTIVE");
    expect(match.players).toHaveLength(2);
    expect(playerId).toBe(match.players.find((p) => !p.id.startsWith("bot-"))?.id);
  });

  it("keeps multiplayer lobbies open until start", async () => {
    const store = new PersistentMatchStore(new MemoryBackend());
    const { match } = await store.create({ playerName: "Host", seed: 7, solo: false });
    expect(match.status).toBe("LOBBY");
    const joined = await store.join(match.id, "Guest");
    expect(joined.match.players).toHaveLength(2);
    const started = await store.start(match.id);
    expect(started.status).toBe("ACTIVE");
  });

  it("is idempotent on command retry and rejects stale revisions", async () => {
    const store = new PersistentMatchStore(new MemoryBackend());
    const { match, playerId } = await store.create({ playerName: "Solo", seed: 11 });
    const rev = match.revision;
    const a = await store.command(match.id, playerId, { type: "ROLL_DICE" }, { commandId: "c1", expectedRevision: rev });
    const b = await store.command(match.id, playerId, { type: "ROLL_DICE" }, { commandId: "c1", expectedRevision: rev });
    expect(a).toEqual(b);
    await expect(
      store.command(match.id, playerId, { type: "ROLL_DICE" }, { commandId: "c2", expectedRevision: rev }),
    ).rejects.toThrow(GameRuleError);
  });

  it("rebuilds identical state from the event log after cache loss", async () => {
    const backend = new MemoryBackend();
    const store = new PersistentMatchStore(backend);
    const { match, playerId } = await store.create({ playerName: "Solo", seed: 21 });
    const m = await store.command(match.id, playerId, { type: "ROLL_DICE" }, { commandId: "r1" });
    // Simulate process restart: drop in-memory cache, rebuild from backend.
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    const rebuilt = await store.get(m.id);
    expect(rebuilt).toEqual(m);
    // File backend round-trip.
    const dir = mkdtempSync(join(tmpdir(), "ll-ms-"));
    try {
      const fileStore = new PersistentMatchStore(new FileBackend(dir));
      const created = await fileStore.create({ playerName: "File", seed: 33 });
      const rolled = await fileStore.command(created.match.id, created.playerId, { type: "ROLL_DICE" }, { commandId: "f1" });
      (fileStore as unknown as { states: Map<string, unknown> }).states.clear();
      expect(await fileStore.get(rolled.id)).toEqual(rolled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports resume tokens and events-since sync", async () => {
    const store = new PersistentMatchStore(new MemoryBackend());
    const { match, playerId } = await store.create({ playerName: "Solo", seed: 44 });
    const token = await store.resumeToken(match.id);
    const same = await store.resume(token);
    expect(same.stale).toBe(false);
    const after = await store.command(match.id, playerId, { type: "ROLL_DICE" }, { commandId: "s1" });
    expect((await store.resume(token)).stale).toBe(true);
    expect((await store.eventsSince(match.id, match.revision)).length).toBeGreaterThan(0);
    expect(after.revision).toBeGreaterThan(match.revision);
  });

  it("sweeps stale lobbies and exports signed replays", async () => {
    const store = new PersistentMatchStore(new MemoryBackend());
    const { match } = await store.create({ playerName: "Host", seed: 55, solo: false });
    const cancelled = await store.sweepLobbyTimeouts(Date.now() + 60_000, 1000);
    expect(cancelled).toContain(match.id);
    expect((await store.get(match.id))?.status).toBe("CANCELLED");

    const solo = await store.create({ playerName: "Champ", seed: 56 });
    const botId = solo.match.players.find((p) => p.id.startsWith("bot-"))!.id;
    await store.command(solo.match.id, botId, { type: "SURRENDER", playerId: botId }, { commandId: "q1" });
    const replay = await store.exportReplay(solo.match.id);
    expect(replay.boardVersion).toBe("classic-v1-board-1");
    expect(replay.chainHash).toMatch(/^[0-9a-f]{64}$/);
    expect(replay.events.length).toBeGreaterThan(0);
  });
});

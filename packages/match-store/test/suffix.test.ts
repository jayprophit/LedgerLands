import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMatchState, applyCommand, GameRuleError } from "@ledgerlands/game-engine";
import { MemoryBackend, FileBackend, PersistentMatchStore, type StorageBackend } from "../src/index.js";
import {
  PostgresBackend,
  type DbCommandRow,
  type DbCorrectionRow,
  type DbMatchRow,
  type DbSnapshotRow,
  type PrismaStoreClient,
  type PrismaStoreTx,
} from "../src/postgres.js";

/**
 * Suffix-read contract. Every backend must return the same logical result, and
 * every backend must refuse to silently truncate a suffix.
 */
function fakeClient(): PrismaStoreClient & {
  commands: Array<DbCommandRow & { matchId: string }>;
  snapshots: Array<DbSnapshotRow & { matchId: string }>;
  rangeQueries: Array<{ matchId: string; gtSeq?: number; limit?: number }>;
} {
  const self = {
    matches: new Map<string, DbMatchRow>(),
    commands: [] as Array<DbCommandRow & { matchId: string }>,
    snapshots: [] as Array<DbSnapshotRow & { matchId: string }>,
    corrections: [] as Array<DbCorrectionRow & { matchId: string }>,
    rangeQueries: [] as Array<{ matchId: string; gtSeq?: number; limit?: number }>,
    async $transaction<T>(fn: (tx: PrismaStoreTx) => Promise<T>): Promise<T> {
      const tx: PrismaStoreTx = {
        match: {
          async findUnique({ where }) {
            return self.matches.get(where.id) ?? null;
          },
          async findMany() {
            return [...self.matches.keys()].map((id) => ({ id }));
          },
          async create({ data }) {
            const d = data as unknown as DbMatchRow;
            self.matches.set(d.id, { ...d });
            return {};
          },
          async update({ where, data }) {
            const row = self.matches.get(where.id);
            if (row) self.matches.set(where.id, { ...row, ...(data as Partial<DbMatchRow>) });
            return {};
          },
        },
        matchCommand: {
          async findMany({ where, orderBy }) {
            const rows = self.commands.filter((c) => c.matchId === where.matchId);
            rows.sort((a, b) => (orderBy.seq === "asc" ? a.seq - b.seq : b.seq - a.seq));
            return rows.map((r) => ({ seq: r.seq, commandId: r.commandId }));
          },
          async listAll(matchId: string) {
            return self.commands
              .filter((c) => c.matchId === matchId)
              .sort((a, b) => a.seq - b.seq)
              .map((r) => ({ seq: r.seq, commandId: r.commandId, actorId: r.actorId, command: r.command, resultRevision: r.resultRevision }));
          },
          async listRange(matchId: string, range: { gtSeq?: number; ltSeq?: number; limit?: number }) {
            let rows = self.commands.filter((c) => c.matchId === matchId).sort((a, b) => a.seq - b.seq);
            if (range.gtSeq !== undefined) rows = rows.filter((c) => c.seq > range.gtSeq!);
            if (range.ltSeq !== undefined) rows = rows.filter((c) => c.seq < range.ltSeq!);
            if (range.limit !== undefined) rows = rows.slice(0, range.limit);
            self.rangeQueries.push({ matchId, ...range });
            return rows.map((r) => ({ seq: r.seq, commandId: r.commandId, actorId: r.actorId, command: r.command, resultRevision: r.resultRevision }));
          },
          async count(matchId: string) {
            return self.commands.filter((c) => c.matchId === matchId).length;
          },
          async maxSeq(matchId: string) {
            const rows = self.commands.filter((c) => c.matchId === matchId);
            return rows.length === 0 ? null : Math.max(...rows.map((r) => r.seq));
          },
          async create({ data }) {
            const d = data as unknown as DbCommandRow & { matchId: string };
            if (self.commands.some((c) => c.matchId === d.matchId && (c.seq === d.seq || c.commandId === d.commandId))) {
              const err = { code: "P2002" } as const;
              throw err;
            }
            self.commands.push({ ...d });
            return {};
          },
        },
        matchSnapshot: {
          async findMany({ where }) {
            return self.snapshots
              .filter((s) => s.matchId === where.matchId)
              .map((r) => ({ revision: r.revision, version: r.version, state: r.state, seq: r.seq }));
          },
          async deleteMany({ where }) {
            self.snapshots = self.snapshots.filter((s) => s.matchId !== where.matchId);
            return {};
          },
          async createMany({ data }) {
            for (const d of data as Array<DbSnapshotRow & { matchId: string }>) self.snapshots.push({ ...d });
            return {};
          },
        },
        matchCorrection: {
          async findMany({ where }) {
            return self.corrections.filter((s) => s.matchId === where.matchId).map((r) => ({ kind: r.kind, detail: r.detail }));
          },
          async deleteMany({ where }) {
            self.corrections = self.corrections.filter((s) => s.matchId !== where.matchId);
            return {};
          },
          async createMany({ data }) {
            for (const d of data as Array<DbCorrectionRow & { matchId: string }>) self.corrections.push({ ...d });
            return {};
          },
        },
      };
      return fn(tx);
    },
  };
  return self as unknown as PrismaStoreClient & {
    commands: Array<DbCommandRow & { matchId: string }>;
    snapshots: Array<DbSnapshotRow & { matchId: string }>;
    rangeQueries: Array<{ matchId: string; gtSeq?: number; limit?: number }>;
  };
}

/** Build a long match with a real command log and snapshots. */
async function longMatch(backend: StorageBackend, seed = 4242) {
  const store = new PersistentMatchStore(backend);
  // Fixed ids keep the command log byte-identical across backends; the bot id
  // is still random, so cross-backend comparisons use command *shapes*.
  const { match } = await store.create({
    playerName: "Suffix",
    seed,
    difficulty: "HARD",
    matchId: "m-suffix",
    humanId: "human-1",
  });
  for (let i = 0; i < 70; i += 1) {
    const cur = await store.get(match.id);
    if (!cur || cur.status !== "ACTIVE") break;
    const p = cur.players[cur.currentPlayerIndex]!;
    try {
      await store.command(
        match.id,
        p.id,
        cur.turnPhase === "ROLL" ? { type: "ROLL_DICE" } : { type: "END_TURN", playerId: p.id },
        { commandId: `sfx-${i}` },
      );
    } catch {
      break;
    }
  }
  const expected = await store.get(match.id);
  const record = await backend.load(match.id);
  if (!record || !expected) throw new Error("setup failed");
  return { store, backend, record, expected, matchId: match.id };
}

describe("suffix read contract", () => {
  it("memory, file, and postgres return an identical suffix for the same range", async () => {
    const mem = await longMatch(new MemoryBackend());
    const dir = mkdtempSync(join(tmpdir(), "ll-sfx-"));
    try {
      const file = await longMatch(new FileBackend(dir), 4242);
      const fake = fakeClient();
      const pgBackend = new PostgresBackend(fake);
      const pg = await longMatch(pgBackend, 4242);

      const rev = mem.record.snapshots.at(-1)!.revision;
      const memSuffix = await mem.backend.readCommandsAfter(mem.matchId, { afterRevision: rev });
      const fileSuffix = await file.backend.readCommandsAfter(file.matchId, { afterRevision: rev });
      const pgSuffix = await pg.backend.readCommandsAfter(pg.matchId, { afterRevision: rev });

      // Bot ids are random per run, so compare command shapes + revisions.
      const shape = (r: Awaited<ReturnType<StorageBackend["readCommandsAfter"]>>) =>
        r.commands.map((c) => `${c.command.type}:${c.resultRevision}`);
      expect(shape(fileSuffix)).toEqual(shape(memSuffix));
      expect(shape(pgSuffix)).toEqual(shape(memSuffix));
      expect(memSuffix.totalCommands).toBe(fileSuffix.totalCommands);
      expect(memSuffix.commandsExcluded).toBe(fileSuffix.commandsExcluded);
      // Suffix is strictly shorter than the whole log.
      expect(memSuffix.commands.length).toBeGreaterThan(0);
      expect(memSuffix.commands.length).toBeLessThan(memSuffix.totalCommands);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuild takes the suffix path and produces state identical to full replay", async () => {
    const { store, backend, record, expected, matchId } = await longMatch(new MemoryBackend());
    expect(record.snapshots.length).toBeGreaterThan(0);
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    const rebuilt = await store.get(matchId);
    expect(store.lastRebuild?.path).toBe("suffix");
    expect(rebuilt).toEqual(expected);
    void backend;
  });

  it("falls back to full replay when the log has no snapshot", async () => {
    const store = new PersistentMatchStore(new MemoryBackend());
    const { match, playerId } = await store.create({ playerName: "NoSnap", seed: 9 });
    await store.command(match.id, playerId, { type: "ROLL_DICE" }, { commandId: "ns-1" });
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    const rebuilt = await store.get(match.id);
    expect(store.lastRebuild?.path).toBe("full-replay");
    expect(rebuilt?.revision).toBeGreaterThan(0);
  });

  it("falls back to full replay when a snapshot claims more commands than the log holds", async () => {
    const { store, backend, record, expected, matchId } = await longMatch(new MemoryBackend());
    const corrupted = structuredClone(record);
    for (const s of corrupted.snapshots) s.seq = 999_999;
    await backend.save(matchId, corrupted);
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    expect(await store.get(matchId)).toEqual(expected);
    expect(store.lastRebuild?.path).toBe("full-replay");
  });

  it("falls back to full replay when the suffix is short (truncated range read)", async () => {
    const { store, backend, record, expected, matchId } = await longMatch(new MemoryBackend());
    // Simulate a backend that loses rows: report fewer commands than it holds.
    const liar: StorageBackend = {
      save: (id, rec) => backend.save(id, rec),
      load: (id) => backend.load(id),
      loadHeader: (id) => backend.loadHeader(id),
      list: () => backend.list(),
      readCommandsAfter: async (id, range) => {
        const real = await backend.readCommandsAfter(id, range);
        return { ...real, commands: real.commands.slice(0, Math.max(0, real.commands.length - 1)) };
      },
    };
    const t = new PersistentMatchStore(liar);
    await liar.save(matchId, record);
    expect(await t.get(matchId)).toEqual(expected);
    expect(t.lastRebuild?.path).toBe("full-replay");
    void store;
  });

  it("postgres issues an indexed range query instead of a full read", async () => {
    const fake = fakeClient();
    const backend = new PostgresBackend(fake);
    const { matchId } = await longMatch(backend, 4242);
    const header = await backend.loadHeader(matchId);
    // Use an EARLY snapshot so a real tail exists after it.
    const snap = header!.snapshots[0]!;
    fake.rangeQueries.length = 0;
    const suffix = await backend.readCommandsAfter(matchId, {
      afterRevision: snap.revision,
      ...(snap.seq !== undefined ? { afterSeq: snap.seq } : {}),
    });
    expect(suffix.commands.length).toBeGreaterThan(0);
    // The range query was issued with the snapshot's sequence bound. `snap.seq`
    // is the COUNT of commands the snapshot covers and rows are stored
    // zero-indexed, so the exclusive SQL bound is one lower — using `snap.seq`
    // skipped the first tail command and forced a full-replay fallback.
    expect(fake.rangeQueries).toHaveLength(1);
    expect(fake.rangeQueries[0]!.gtSeq).toBe(snap.seq! - 1);
    // And it returned fewer rows than the full log.
    expect(suffix.commands.length).toBeLessThan(suffix.totalCommands);
  });

  it("header read returns no commands but reports the true count", async () => {
    const { backend, matchId } = await longMatch(new MemoryBackend());
    const header = await backend.loadHeader(matchId);
    expect(header).toBeDefined();
    expect(header!.commands).toHaveLength(0);
    expect(header!.meta.totalCommands).toBeGreaterThan(0);
  });

  it("suffix read is order-stable and honours afterRevision strictly", async () => {
    const { backend, matchId } = await longMatch(new MemoryBackend());
    const all = (await backend.load(matchId))!.commands;
    const mid = all[Math.floor(all.length / 2)]!;
    const suffix = await backend.readCommandsAfter(matchId, { afterRevision: mid.resultRevision! });
    expect(suffix.commands.every((c) => c.resultRevision! > mid.resultRevision!)).toBe(true);
    const revs = suffix.commands.map((c) => c.resultRevision!);
    expect([...revs].sort((a, b) => a - b)).toEqual(revs);
    expect(suffix.commandsExcluded).toBe(all.filter((c) => c.resultRevision! <= mid.resultRevision!).length);
  });

  it("rebuild still respects lobby cancellation corrections", async () => {
    const store = new PersistentMatchStore(new MemoryBackend());
    const { match } = await store.create({ playerName: "Lobby", seed: 3, solo: false });
    await store.sweepLobbyTimeouts(Date.now() + 60_000, 1000);
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    const rebuilt = await store.get(match.id);
    expect(rebuilt?.status).toBe("CANCELLED");
  });

  it("snapshot+tail equals full replay as an explicit invariant", () => {
    // Pure-logic check of the reconstruction rule, independent of any backend.
    const initial = createMatchState({ id: "x", seed: 5, players: [{ id: "p", name: "P" }] });
    const commands = [
      { type: "START_MATCH" } as const,
      { type: "ROLL_DICE" } as const,
      { type: "END_TURN", playerId: "p" } as const,
    ];
    const run = (from: typeof initial, tail: readonly typeof commands[number][]) => {
      let s = from;
      for (const c of tail) s = applyCommand(s, c);
      return s;
    };
    const full = run(initial, commands);
    const tailFromSnapshot = run(applyCommand(initial, commands[0]!), commands.slice(1));
    expect(tailFromSnapshot).toEqual(full);
    expect(() => applyCommand(initial, { type: "END_TURN", playerId: "p" })).toThrow(GameRuleError);
  });
});

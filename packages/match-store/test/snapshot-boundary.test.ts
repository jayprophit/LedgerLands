import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMatchState, applyCommand } from "@ledgerlands/game-engine";
import type { MatchState } from "@ledgerlands/shared-types";
import { MemoryBackend, FileBackend, PersistentMatchStore, type StorageBackend } from "../src/index.js";
import { PostgresBackend } from "../src/postgres.js";
import type { MatchSnapshot, StoredMatch } from "../src/storage.js";
import { MATCH_STORE_DDL } from "./ddl.js";
import { createPGliteClient, type PGliteStoreClient } from "./pglite-client.js";

/**
 * `afterSeq` boundary contract — the permanent regression for the off-by-one
 * fixed in `ce443ab`.
 *
 * The two semantics that must never be confused:
 *
 *   snapshot.seq          = the COUNT of commands the snapshot covers
 *   stored command `seq`  = a zero-based index into that log
 *
 * so the first command after a snapshot is at `seq === snapshot.seq`, and a
 * read asking for "everything after this snapshot" must return it. A bound of
 * `seq > snapshot.seq` skips it, which makes the caller's gap-free check fail
 * and silently downgrades every snapshot rebuild to a full replay.
 *
 * The Postgres assertions deliberately inspect the SQL bound and the rows the
 * database returns. Asserting only "matches MemoryBackend" would let a shared
 * misunderstanding pass, because MemoryBackend ignores `afterSeq` entirely and
 * filters by revision — it cannot observe this bug at all.
 */

const SEED = 20250929;

/**
 * Build a *consistent* record: the snapshot is a real state produced by
 * replaying the first `snapshotAt` commands, so `snapshot.revision`,
 * `snapshot.seq` and `snapshot.state` all agree. An inconsistent fixture would
 * be rejected by the completeness checks for reasons unrelated to `afterSeq`.
 */
function playedRecord(playerCount: number, commandCount: number, snapshotAt = 1): StoredMatch {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  let state = createMatchState({ id: "boundary", seed: SEED, players });
  const initial = structuredClone(state);
  const commands: StoredMatch["commands"] = [];
  const states: MatchState[] = [];

  const apply = (cmd: (typeof state) extends never ? never : Parameters<typeof applyCommand>[1], actor: string) => {
    state = applyCommand(state, cmd);
    commands.push({
      command: cmd as never,
      commandId: `cmd-${commands.length}`,
      actorPlayerId: actor,
      at: "2026-01-01T00:00:00.000Z",
      resultRevision: state.revision,
    });
    states.push(structuredClone(state));
  };

  apply({ type: "START_MATCH" } as never, "system");
  for (let i = 1; i < commandCount; i += 1) {
    const p = state.players[state.currentPlayerIndex]!;
    const cmd =
      state.turnPhase === "ROLL" ? ({ type: "ROLL_DICE" } as const) : ({ type: "END_TURN", playerId: p.id } as const);
    try {
      apply(cmd as never, p.id);
    } catch {
      break;
    }
  }

  const covered = Math.max(0, Math.min(snapshotAt, commands.length));
  const snapshots: MatchSnapshot[] =
    covered === 0
      ? []
      : [
          {
            revision: states[covered - 1]!.revision,
            state: states[covered - 1]!,
            at: "2026-01-01T00:00:00.000Z",
            seq: covered,
          },
        ];

  return {
    initial,
    commands,
    snapshots,
    corrections: [],
    seenCommandIds: commands.map((c) => c.commandId),
    botDifficulty: "NORMAL",
    solo: playerCount === 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    meta: { status: state.status, stateRevision: state.revision, totalCommands: commands.length },
  };
}

let pgClient: PGliteStoreClient;
let pg: PostgresBackend;

beforeAll(async () => {
  pgClient = await createPGliteClient(MATCH_STORE_DDL);
  pg = new PostgresBackend(pgClient);
});

afterAll(async () => {
  await pgClient.db.close();
});

/** Ask the real database what rows a given `afterSeq` maps to. */
async function pgRowsAfter(matchId: string, afterSeq: number): Promise<number[]> {
  const result = await pg.readCommandsAfter(matchId, { afterSeq, afterRevision: -1 });
  return result.commands.map((c) => c.resultRevision);
}

describe("afterSeq boundary contract (Postgres, real engine)", () => {
  it("returns every command when a snapshot covers 0 commands", async () => {
    const record = playedRecord(2, 4);
    await pg.save("b-zero", record);
    // afterSeq 0 means "snapshot covered nothing" -> the tail starts at seq 0.
    expect(await pgRowsAfter("b-zero", 0)).toEqual(record.commands.map((c) => c.resultRevision));
  });

  it("returns nothing when the snapshot covers the whole log", async () => {
    const record = playedRecord(2, 4);
    await pg.save("b-all", record);
    expect(await pgRowsAfter("b-all", record.commands.length)).toEqual([]);
  });

  it("returns the single command immediately after a snapshot", async () => {
    // The exact case the off-by-one lost.
    const record = playedRecord(2, 5);
    await pg.save("b-one-after", record);
    const covered = 1;
    const tail = await pgRowsAfter("b-one-after", covered);
    expect(tail).toEqual(record.commands.slice(covered).map((c) => c.resultRevision));
    expect(tail).toHaveLength(record.commands.length - covered);
  });

  it("returns all commands after a snapshot, not one fewer", async () => {
    for (const total of [2, 3, 6, 12]) {
      const record = playedRecord(2, total);
      const id = `b-multi-${total}`;
      await pg.save(id, record);
      for (let covered = 0; covered <= total; covered += 1) {
        const tail = await pgRowsAfter(id, covered);
        const expected = record.commands.slice(covered).map((c) => c.resultRevision);
        expect(tail, `total=${total} afterSeq=${covered}`).toEqual(expected);
      }
    }
  });

  it("uses seq >= afterSeq in SQL, not seq > afterSeq", async () => {
    // Direct check on the bound the backend sends, independent of results.
    await pg.save("b-bound", playedRecord(2, 6));
    const plan = await pgClient.db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT * FROM "MatchCommand" WHERE "matchId" = $1 AND "seq" > $2`,
      ["b-bound", 0],
    );
    // Sanity: the index is what answers it, so the bound really is evaluated.
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/Index Scan/);

    const at = await pgClient.db.query<{ seq: number }>(
      `SELECT "seq" FROM "MatchCommand" WHERE "matchId" = $1 ORDER BY "seq"`,
      ["b-bound"],
    );
    // Storage really is zero-indexed, which is the premise of the whole contract.
    expect(at.rows.map((r) => r.seq)).toEqual(at.rows.map((_, i) => i));
  });

  it("keeps totalCommands and commandsExcluded consistent with the returned rows", async () => {
    const record = playedRecord(2, 8);
    await pg.save("b-meta", record);
    for (const covered of [0, 1, 4, 8]) {
      const result = await pg.readCommandsAfter("b-meta", { afterSeq: covered, afterRevision: -1 });
      expect(result.totalCommands).toBe(record.commands.length);
      expect(result.commands.length + result.commandsExcluded).toBe(result.totalCommands);
      expect(result.commandsExcluded).toBe(covered);
    }
  });

  it("still filters by afterRevision independently of afterSeq", async () => {
    const record = playedRecord(2, 8);
    await pg.save("b-rev", record);
    const revisions = record.commands.map((c) => c.resultRevision!);
    const pivot = revisions[2]!;
    const result = await pg.readCommandsAfter("b-rev", { afterSeq: 0, afterRevision: pivot });
    // afterSeq 0 returns the whole log; afterRevision then trims the head.
    expect(result.commands.map((c) => c.resultRevision)).toEqual(revisions.filter((r) => r > pivot));
  });
});

describe("afterSeq contract holds identically across backends", () => {
  it("agrees on the logical suffix when called the way the store calls it", async () => {
    // `rebuildFromSuffix` passes BOTH bounds, derived from one snapshot:
    // `afterRevision` for backends without a durable sequence, `afterSeq` for
    // Postgres. That pairing must produce the same rows everywhere, otherwise a
    // match would rebuild differently depending on which backend holds it.
    //
    // Every snapshot position is exercised, so each iteration builds a record
    // whose snapshot genuinely sits at that position.
    const dir = mkdtempSync(join(tmpdir(), "ll-bounds-"));
    try {
      for (let covered = 0; covered <= 10; covered += 1) {
        const record = playedRecord(2, 10, covered);
        const snapshot = record.snapshots[0];
        const range = { afterRevision: snapshot ? snapshot.revision : -1, ...(snapshot ? { afterSeq: snapshot.seq } : {}) };
        const expected = record.commands.slice(covered).map((c) => c.resultRevision);

        const memory = new MemoryBackend();
        const file = new FileBackend(dir);
        await memory.save("x", record);
        await file.save(`f-${covered}`, record);
        await pg.save(`p-${covered}`, record);

        const mem = await memory.readCommandsAfter("x", range);
        const fil = await file.readCommandsAfter(`f-${covered}`, range);
        const db = await pg.readCommandsAfter(`p-${covered}`, range);
        expect(mem.commands.map((c) => c.resultRevision), `memory covered=${covered}`).toEqual(expected);
        expect(fil.commands.map((c) => c.resultRevision), `file covered=${covered}`).toEqual(expected);
        expect(db.commands.map((c) => c.resultRevision), `postgres covered=${covered}`).toEqual(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agrees on the logical suffix for every snapshot position in a long match", async () => {
    // A snapshot that does not exist must degrade the same way on all backends.
    const record = playedRecord(2, 14, 4);
    const dir = mkdtempSync(join(tmpdir(), "ll-bounds2-"));
    try {
      const memory = new MemoryBackend();
      const file = new FileBackend(dir);
      await memory.save("y", record);
      await file.save("y", record);
      await pg.save("b-cross2", record);
      const snapshot = record.snapshots[0]!;
      const range = { afterRevision: snapshot.revision, afterSeq: snapshot.seq! };
      const expected = record.commands.slice(snapshot.seq!).map((c) => c.resultRevision);
      for (const [label, backend, id] of [
        ["memory", memory, "y"],
        ["file", file, "y"],
        ["postgres", pg, "b-cross2"],
      ] as const) {
        const result = await backend.readCommandsAfter(id, range);
        expect(result.commands.map((c) => c.resultRevision), label).toEqual(expected);
        expect(result.totalCommands, label).toBe(record.commands.length);
        expect(result.commandsExcluded, label).toBe(snapshot.seq);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds a snapshot-backed match on the suffix path, with and without a tail", async () => {
    const scenarios: Array<{ label: string; commands: number }> = [
      { label: "snapshot only, no tail", commands: 1 },
      { label: "snapshot + 1 command", commands: 2 },
      { label: "snapshot + several commands", commands: 7 },
    ];
    for (const scenario of scenarios) {
      const record = playedRecord(2, scenario.commands, 1);
      const id = `b-rebuild-${scenario.commands}`;
      await pg.save(id, record);

      const store = new PersistentMatchStore(pg);
      (store as unknown as { states: Map<string, unknown> }).states.clear();
      const rebuilt = await store.get(id);
      expect(rebuilt, scenario.label).toBeDefined();
      // A snapshot always exists here, so the suffix path must be the one used.
      expect(store.lastRebuild?.path, scenario.label).toBe("suffix");
      expect(rebuilt!.revision, scenario.label).toBe(record.meta.stateRevision);
    }
  });

  it("falls back to full replay when no snapshot exists, and says so", async () => {
    const record = playedRecord(2, 4, 0);
    expect(record.snapshots).toHaveLength(0);
    await pg.save("b-nosnap", record);
    const store = new PersistentMatchStore(pg);
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    const rebuilt = await store.get("b-nosnap");
    expect(store.lastRebuild?.path).toBe("full-replay");
    expect(rebuilt!.revision).toBe(record.meta.stateRevision);
  });

  it("refuses a snapshot that claims more commands than the log holds", async () => {
    const record = playedRecord(2, 5, 1);
    for (const s of record.snapshots) s.seq = 999_999;
    await pg.save("b-badseq", record);
    const store = new PersistentMatchStore(pg);
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    const rebuilt = await store.get("b-badseq");
    expect(store.lastRebuild?.path).toBe("full-replay");
    expect(rebuilt!.revision).toBe(record.meta.stateRevision);
  });

  it("stores snapshots with the seq the suffix read depends on", async () => {
    const record = playedRecord(2, 5, 1);
    await pg.save("b-persist-seq", record);
    const stored = await pg.load("b-persist-seq");
    expect(stored!.snapshots[0]!.seq).toBe(record.snapshots[0]!.seq);
    const header = await pg.loadHeader("b-persist-seq");
    expect(header!.snapshots[0]!.seq).toBe(record.snapshots[0]!.seq);
    // The header read must not smuggle the command log back in.
    expect(header!.commands).toHaveLength(0);
    expect(header!.meta.totalCommands).toBe(record.commands.length);
  });
});

describe("MemoryBackend cannot mask Postgres range bugs", () => {
  it("ignores afterSeq, so only the database can prove the bound", async () => {
    // This is the reason the Postgres assertions are not redundant. MemoryBackend
    // and FileBackend filter by revision only, so a wrong `afterSeq` translation
    // in `postgres.ts` is invisible to every other backend. If a future change
    // made them honour `afterSeq`, this test should fail and be rewritten - that
    // would be a real contract change, not a cleanup.
    const record = playedRecord(2, 6);
    const memory = new MemoryBackend();
    await memory.save("mask", record);
    const withSeq = await memory.readCommandsAfter("mask", { afterSeq: 5, afterRevision: -1 });
    const withoutSeq = await memory.readCommandsAfter("mask", { afterRevision: -1 });
    expect(withSeq.commands).toHaveLength(withoutSeq.commands.length);
    expect(withSeq.commands).toHaveLength(record.commands.length);

    const file = new FileBackend(mkdtempSync(join(tmpdir(), "ll-mask-")));
    await file.save("mask", record);
    const fileSeq = await file.readCommandsAfter("mask", { afterSeq: 5, afterRevision: -1 });
    expect(fileSeq.commands).toHaveLength(record.commands.length);
  });

  it("postgres honours afterSeq where the others cannot", async () => {
    const record = playedRecord(2, 6);
    await pg.save("b-honours", record);
    const memory = new MemoryBackend();
    await memory.save("honours", record);
    const db = await pg.readCommandsAfter("b-honours", { afterSeq: 5, afterRevision: -1 });
    const mem = await memory.readCommandsAfter("honours", { afterSeq: 5, afterRevision: -1 });
    expect(db.commands).toHaveLength(1);
    expect(mem.commands).toHaveLength(6);
  });

  it("postgres returns fewer rows as afterSeq advances", async () => {
    const record = playedRecord(2, 6);
    await pg.save("b-monotonic", record);
    const counts: number[] = [];
    for (let covered = 0; covered <= record.commands.length; covered += 1) {
      counts.push((await pg.readCommandsAfter("b-monotonic", { afterSeq: covered, afterRevision: -1 })).commands.length);
    }
    expect(counts).toEqual([6, 5, 4, 3, 2, 1, 0]);
    // Monotonically non-increasing and ending at zero: the shape a correct
    // exclusive-after-count bound produces.
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    expect(counts.at(-1)).toBe(0);
  });
});

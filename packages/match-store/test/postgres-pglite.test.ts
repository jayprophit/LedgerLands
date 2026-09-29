import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryBackend, PersistentMatchStore } from "../src/index.js";
import { PostgresBackend } from "../src/postgres.js";
import type { StoredMatch } from "../src/storage.js";
import { MATCH_STORE_DDL } from "./ddl.js";
import { createPGliteClient, type PGliteStoreClient } from "./pglite-client.js";

/**
 * The same behavioural contract as `postgres.test.ts`, but executed by a real
 * PostgreSQL engine (PGlite, WASM) instead of a hand-written fake.
 *
 * What this genuinely proves, and what it does not:
 *  - PROVED: the SQL is valid, the `(matchId, seq)` range query is served by an
 *    index, unique constraints reject the collisions the backend relies on, and
 *    a failed transaction leaves no partial rows.
 *  - NOT PROVED: concurrent-writer interleaving. PGlite is single-connection, so
 *    transactions serialize. A real server can still interleave two writers
 *    between `SELECT` and `INSERT`; the unique index is what stops that, and
 *    that the index is present and enforced is verified here.
 */

let client: PGliteStoreClient;
let pg: PostgresBackend;

beforeAll(async () => {
  client = await createPGliteClient(MATCH_STORE_DDL);
  pg = new PostgresBackend(client);
});

afterAll(async () => {
  await client.db.close();
});

async function playedRecord(seed = 4242, name = "RealPG"): Promise<StoredMatch> {
  const mem = new PersistentMatchStore(new MemoryBackend());
  const { match } = await mem.create({ playerName: name, seed });
  // Alternate ROLL / END_TURN until the match ends, so the record holds a
  // multi-command log with a real range to read.
  for (let i = 0; i < 40; i += 1) {
    const cur = await mem.get(match.id);
    if (!cur || cur.status !== "ACTIVE") break;
    const p = cur.players[cur.currentPlayerIndex]!;
    const command = cur.turnPhase === "ROLL" ? { type: "ROLL_DICE" as const } : { type: "END_TURN" as const, playerId: p.id };
    try {
      await mem.command(match.id, p.id, command, { commandId: `pg-${i}` });
    } catch {
      break;
    }
  }
  const record = await (mem as unknown as { backend: MemoryBackend }).backend.load(match.id);
  if (!record) throw new Error("record missing");
  return record;
}

const strip = (s: StoredMatch): unknown =>
  JSON.parse(JSON.stringify(s, (k, v: unknown) => (k === "at" || k === "createdAt" || k === "updatedAt" ? undefined : v)));

describe("PostgresBackend against a real PostgreSQL engine", () => {
  it("round-trips a record and rebuilds identical live state", async () => {
    const record = await playedRecord();
    await pg.save("rt-1", record);
    const loaded = await pg.load("rt-1");
    expect(loaded).toBeDefined();
    expect(strip(loaded!)).toEqual(strip(record));
    expect(await pg.list()).toContain("rt-1");

    const viaPg = new PersistentMatchStore(pg);
    const live = await viaPg.get("rt-1");
    const viaMem = new PersistentMatchStore(new MemoryBackend());
    await (viaMem as unknown as { backend: MemoryBackend }).backend.save("rt-1", record);
    (viaMem as unknown as { states: Map<string, unknown> }).states.clear();
    expect(live).toEqual(await viaMem.get("rt-1"));
  });

  it("persists JSONB state, not a JSON string", async () => {
    await pg.save("jsonb-1", await playedRecord(99, "Jsonb"));
    const probe = await client.db.query<{ state: string; cmd: string }>(
      `SELECT
         (SELECT jsonb_typeof("initialState") FROM "Match" WHERE "id" = $1) AS state,
         (SELECT jsonb_typeof("command") FROM "MatchCommand" WHERE "matchId" = $1 LIMIT 1) AS cmd`,
      ["jsonb-1"],
    );
    // If these came back as 'string' the state would be double-encoded and every
    // downstream read would need a second parse.
    expect(probe.rows[0]!.state).toBe("object");
    expect(probe.rows[0]!.cmd).toBe("object");
  });

  it("enforces the (matchId, seq) unique constraint that the append guard relies on", async () => {
    await pg.save("uniq-1", await playedRecord(5, "Uniq"));
    const before = await client.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM "MatchCommand" WHERE "matchId" = $1`, [
      "uniq-1",
    ]);
    const any = await client.db.query<{ id: string; seq: number }>(
      `SELECT "id", "seq" FROM "MatchCommand" WHERE "matchId" = $1 LIMIT 1`,
      ["uniq-1"],
    );
    // A colliding (matchId, seq) must be refused by Postgres itself.
    await expect(
      client.db.query(
        `INSERT INTO "MatchCommand" ("id", "matchId", "seq", "commandId", "actorId", "command", "resultRevision") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        ["collide", "uniq-1", any.rows[0]!.seq, "collide-cmd", "p1", JSON.stringify({}), 999],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const after = await client.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM "MatchCommand" WHERE "matchId" = $1`, [
      "uniq-1",
    ]);
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });

  it("enforces commandId idempotency per match", async () => {
    await pg.save("idem-1", await playedRecord(6, "Idem"));
    const first = await client.db.query<{ commandId: string }>(
      `SELECT "commandId" FROM "MatchCommand" WHERE "matchId" = $1 ORDER BY "seq" LIMIT 1`,
      ["idem-1"],
    );
    const maxSeq = await client.db.query<{ m: string }>(`SELECT max("seq")::text AS m FROM "MatchCommand" WHERE "matchId" = $1`, [
      "idem-1",
    ]);
    await expect(
      client.db.query(
        `INSERT INTO "MatchCommand" ("id", "matchId", "seq", "commandId", "actorId", "command", "resultRevision") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        ["dupe-cmd", "idem-1", Number(maxSeq.rows[0]!.m) + 100, first.rows[0]!.commandId, "p1", JSON.stringify({}), 999],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("is idempotent on re-save and rejects a diverged or truncated log", async () => {
    const record = await playedRecord(7, "Diverged");
    await pg.save("div-1", record);
    await pg.save("div-1", structuredClone(record));
    const count = await client.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM "MatchCommand" WHERE "matchId" = $1`, [
      "div-1",
    ]);
    expect(Number(count.rows[0]!.c)).toBe(record.commands.length);

    const diverged = structuredClone(record);
    diverged.commands[0] = { ...diverged.commands[0]!, commandId: "tampered" };
    await expect(pg.save("div-1", diverged)).rejects.toThrow(/diverged|behind/i);

    const behind = structuredClone(record);
    behind.commands = [];
    await expect(pg.save("div-1", behind)).rejects.toThrow(/behind persisted log/i);
  });

  it("leaves no partial rows when a transaction fails mid-save", async () => {
    const record = await playedRecord(8, "Atomic");
    await pg.save("atomic-1", record);
    const before = await client.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM "MatchCommand" WHERE "matchId" = $1`, [
      "atomic-1",
    ]);

    // Append one good command, then one that collides on (matchId, seq).
    // The backend must roll the whole save back, not leave the good row behind.
    const good = { ...record.commands[0]!, commandId: "atomic-good" };
    const colliding = { ...record.commands[0]!, commandId: "atomic-collide" };
    const poisoned = structuredClone(record);
    poisoned.commands = [good, colliding];

    await expect(pg.save("atomic-1", poisoned)).rejects.toThrow();
    const after = await client.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM "MatchCommand" WHERE "matchId" = $1`, [
      "atomic-1",
    ]);
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
    const orphans = await client.db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM "MatchCommand" WHERE "commandId" LIKE 'atomic-%'`,
    );
    expect(Number(orphans.rows[0]!.c)).toBe(0);
  });

  it("serves the suffix range query from the (matchId, seq) index, not a scan", async () => {
    await pg.save("plan-1", await playedRecord(9, "Plan"));
    // A selective suffix range should be an index scan. If this ever degrades
    // to a sequential scan, the "partial read" claim stops being true.
    const plan = await client.db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT * FROM "MatchCommand" WHERE "matchId" = $1 AND "seq" > $2 ORDER BY "seq" ASC`,
      ["plan-1", 0],
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
    expect(text).not.toMatch(/Seq Scan/);
  });

  it("reads only the requested suffix through readCommandsAfter", async () => {
    const record = await playedRecord(10, "Suffix");
    expect(record.commands.length).toBeGreaterThanOrEqual(3);
    await pg.save("sfx-1", record);
    const total = record.commands.length;
    // `afterSeq` is the count of commands a snapshot covers; the tail starts at
    // that index. Getting this off by one silently drops a command.
    const afterSeq = total - 2;
    const result = await pg.readCommandsAfter("sfx-1", { afterSeq, afterRevision: -1 });
    expect(result.commands).toHaveLength(2);
    expect(result.totalCommands).toBe(total);
    expect(result.commandsExcluded).toBe(total - 2);
    expect(result.maxSeq).toBe(total - 1);
    // The fetched rows are the true tail, in order.
    expect(result.commands.map((c) => c.commandId)).toEqual(record.commands.slice(afterSeq).map((c) => c.commandId));
  });

  it("rebuilds from a snapshot via the suffix path, not a full replay", async () => {
    // Regression guard: an off-by-one in the seq bound made every snapshot
    // rebuild fail its gap-free check and silently degrade to full replay.
    const mem = new PersistentMatchStore(new MemoryBackend());
    const { match } = await mem.create({ playerName: "SuffixPath", seed: 31337 });
    for (let i = 0; i < 40; i += 1) {
      const cur = await mem.get(match.id);
      if (!cur || cur.status !== "ACTIVE") break;
      const p = cur.players[cur.currentPlayerIndex]!;
      const command = cur.turnPhase === "ROLL" ? { type: "ROLL_DICE" as const } : { type: "END_TURN" as const, playerId: p.id };
      try {
        await mem.command(match.id, p.id, command, { commandId: `sp-${i}` });
      } catch {
        break;
      }
    }
    const record = await (mem as unknown as { backend: MemoryBackend }).backend.load(match.id);
    expect(record!.snapshots.length).toBeGreaterThan(0);
    await pg.save(match.id, record!);

    const store = new PersistentMatchStore(pg);
    const first = await store.get(match.id);
    expect(first).toEqual(await mem.get(match.id));
    // Force a cold rebuild so the read path is exercised, not a cached state.
    (store as unknown as { states: Map<string, unknown> }).states.clear();
    const rebuilt = await store.get(match.id);
    expect(rebuilt).toEqual(await mem.get(match.id));
    const used = (store as unknown as { lastRebuild: { path: string } }).lastRebuild.path;
    expect(used).toBe("suffix");
  });

  it("honours the upper bound and the limit of a range read", async () => {
    const record = await playedRecord(11, "Range");
    await pg.save("rng-1", record);
    // afterSeq 0 means "snapshot covered nothing", so the read starts at seq 0.
    const bounded = await pg.readCommandsAfter("rng-1", { afterSeq: 0, throughSeq: 3, afterRevision: -1 });
    expect(bounded.commands.map((c) => c.commandId)).toEqual(record.commands.slice(0, 3).map((c) => c.commandId));
    const limited = await pg.readCommandsAfter("rng-1", { afterSeq: 0, limit: 2, afterRevision: -1 });
    expect(limited.commands).toHaveLength(2);
    expect(limited.commands.map((c) => c.commandId)).toEqual(record.commands.slice(0, 2).map((c) => c.commandId));
  });

  it("returns undefined for an unknown match rather than throwing", async () => {
    expect(await pg.load("missing-match")).toBeUndefined();
    expect(await pg.loadHeader("missing-match")).toBeUndefined();
  });

  it("keeps matches isolated from each other in the range query", async () => {
    const a = await playedRecord(12, "IsoA");
    const b = await playedRecord(13, "IsoB");
    await pg.save("iso-a", a);
    await pg.save("iso-b", b);
    const only = await pg.readCommandsAfter("iso-a", { afterSeq: -1, afterRevision: -1 });
    expect(only.commands).toHaveLength(a.commands.length);
    expect(only.totalCommands).toBe(a.commands.length);
  });
});

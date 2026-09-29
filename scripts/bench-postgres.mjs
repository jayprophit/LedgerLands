/**
 * Measures the Postgres suffix read against a real PostgreSQL engine (PGlite).
 *
 * Fills one match with 5,000 commands, then compares the indexed range query
 * the backend issues against a full-log read, and prints the planner's chosen
 * strategy. Run after `npm run build`:
 *
 *   node scripts/bench-postgres.mjs
 */

import { PGlite } from "@electric-sql/pglite";
import { MATCH_STORE_DDL } from "../packages/match-store/test/ddl.ts";

const COMMANDS = Number(process.env.BENCH_COMMANDS ?? 5000);
const MATCHES = Number(process.env.BENCH_MATCHES ?? 5);

const db = new PGlite();
await db.exec(MATCH_STORE_DDL);

for (let m = 0; m < MATCHES; m += 1) {
  const id = `m${m}`;
  await db.query(
    'INSERT INTO "Match" ("id", "status", "rulesetVersion", "stateRevision", "initialState", "botDifficulty", "solo") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, "ACTIVE", "classic-v1", COMMANDS, JSON.stringify({ seed: m }), "NORMAL", true],
  );
  // Insert in chunks: one 35,000-parameter statement is more than the
  // protocol wants, and the point is to size the table, not time inserts.
  const CHUNK = 500;
  for (let start = 0; start < COMMANDS; start += CHUNK) {
    const values = [];
    const args = [];
    for (let i = start; i < Math.min(start + CHUNK, COMMANDS); i += 1) {
      const b = values.length * 7;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      args.push(`${id}-c${i}`, id, i, `cmd-${i}`, "p1", JSON.stringify({ type: "ROLL_DICE", pad: "x".repeat(200) }), i + 1);
    }
    await db.query(
      'INSERT INTO "MatchCommand" ("id", "matchId", "seq", "commandId", "actorId", "command", "resultRevision") VALUES ' +
        values.join(","),
      args,
    );
  }
}

const counted = await db.query('SELECT count(*)::text AS n FROM "MatchCommand"', []);
const rows = counted?.rows ?? [];
console.log(`rows           ${Number(rows[0].n).toLocaleString()}`);
console.log(`matches        ${MATCHES} x ${COMMANDS} commands`);
console.log("");

const SNAPSHOT_SEQ = Math.floor(COMMANDS * 0.9);

async function timed(label, sql, args, repeats = 20) {
  await db.query(sql, args);
  const t = process.hrtime.bigint();
  for (let i = 0; i < repeats; i += 1) await db.query(sql, args);
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / repeats;
  console.log(`${label.padEnd(28)} ${ms.toFixed(2)} ms`);
  return ms;
}

const suffix = await timed(
  "suffix range (tail 10%)",
  'SELECT "id", "seq", "commandId", "command" FROM "MatchCommand" WHERE "matchId" = $1 AND "seq" > $2 ORDER BY "seq" ASC',
  ["m0", SNAPSHOT_SEQ - 1],
);

const full = await timed(
  "full log read",
  'SELECT "id", "seq", "commandId", "command" FROM "MatchCommand" WHERE "matchId" = $1 ORDER BY "seq" ASC',
  ["m0"],
);

const plan = await db.query(
  'EXPLAIN SELECT "id", "seq", "commandId", "command" FROM "MatchCommand" WHERE "matchId" = $1 AND "seq" > $2 ORDER BY "seq" ASC',
  ["m0", SNAPSHOT_SEQ - 1],
);
console.log("");
console.log("planner chose:");
for (const r of plan.rows) console.log(`  ${r["QUERY PLAN"]}`);
console.log("");
console.log(`suffix/full ratio  ${(suffix / full).toFixed(3)}`);
console.log(`rows fetched       ${COMMANDS - SNAPSHOT_SEQ} of ${COMMANDS} (${(((COMMANDS - SNAPSHOT_SEQ) / COMMANDS) * 100).toFixed(0)}%)`);

await db.close();

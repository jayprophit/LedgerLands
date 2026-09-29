/**
 * A PGlite-backed implementation of the Prisma-shaped client that
 * `PostgresBackend` consumes.
 *
 * This exists to close the "no live database" gap. PGlite is real PostgreSQL
 * compiled to WASM, so every query here is executed by the actual planner and
 * the actual constraint enforcement: the range query really does use the
 * `(matchId, seq)` index, and a duplicate `seq` really is rejected by a unique
 * index rather than by a hand-written fake that we hope is faithful.
 *
 * Honest limits, so nobody over-reads this:
 *  - PGlite is single-connection, so `$transaction` is a serialized critical
 *    section rather than MVCC. Genuine concurrent-writer interleaving still
 *    needs a real server. What *is* verified here is the constraint a race
 *    would collide with, enforced by Postgres itself.
 *  - The only invented behaviour is mapping Postgres error `23505` to Prisma's
 *    `P2002`, so `isUniqueViolation` in `postgres.ts` works unchanged.
 *  - DDL lives in `test/ddl.ts`, hand-kept in sync with `prisma/schema.prisma`.
 */

import { PGlite } from "@electric-sql/pglite";
import type {
  DbCommandRow,
  DbCorrectionRow,
  DbMatchRow,
  DbSnapshotRow,
  PrismaStoreClient,
  PrismaStoreTx,
} from "../src/postgres.js";

type Row = Record<string, unknown>;

/** Quoted exactly as Prisma emits identifiers; unquoted camelCase folds in PG. */
const COLUMNS: Record<string, string> = {
  match: [
    "id",
    "status",
    "rulesetVersion",
    "seedCommitment",
    "seedReveal",
    "stateRevision",
    "initialState",
    "botDifficulty",
    "solo",
    "createdAt",
    "startedAt",
    "completedAt",
  ]
    .map((c) => `"${c}"`)
    .join(", "),
  matchCommand: ["id", "matchId", "seq", "commandId", "actorId", "command", "resultRevision", "createdAt"]
    .map((c) => `"${c}"`)
    .join(", "),
  matchSnapshot: ["id", "matchId", "revision", "seq", "version", "state", "createdAt"]
    .map((c) => `"${c}"`)
    .join(", "),
  matchCorrection: ["id", "matchId", "kind", "detail", "createdAt"].map((c) => `"${c}"`).join(", "),
};

class UniqueViolation extends Error {
  readonly code = "P2002";
  constructor(readonly constraint: string) {
    super(`Unique constraint failed on: ${constraint}`);
    this.name = "UniqueViolation";
  }
}

function wrap(error: unknown): never {
  if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
    const e = error as { constraint?: string };
    throw new UniqueViolation(e.constraint ?? "unknown");
  }
  throw error;
}

/** Serialize a JS value into a Postgres bind parameter. */
function bind(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Prisma's `@default(cuid())` is generated client-side, not by the database, so
 * the backend legitimately omits `id` on insert. This is the one place the
 * adapter has to stand in for Prisma rather than for Postgres.
 */
let cuidCounter = 0;
function generateId(table: string): string {
  cuidCounter += 1;
  return `cuid_${table.toLowerCase()}_${Date.now().toString(36)}_${cuidCounter.toString(36)}`;
}

/** PGlite's extended query protocol only binds `$n` placeholders. */
function insertSql(
  table: string,
  data: Record<string, unknown>,
  autoincrement: string[] = [],
): { sql: string; args: unknown[] } {
  const row = { ...data };
  for (const col of autoincrement) {
    if (row[col] === undefined || row[col] === null) row[col] = generateId(table);
  }
  const keys = Object.keys(row);
  const cols = keys.map((k) => `"${k}"`).join(", ");
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  return {
    sql: `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`,
    args: keys.map((k) => bind(row[k])),
  };
}

async function rows(db: PGlite, sql: string, args: unknown[]): Promise<Row[]> {
  const result = await db.query(sql, args as never[]);
  return result.rows as Row[];
}

async function row(db: PGlite, sql: string, args: unknown[]): Promise<Row | null> {
  const result = await db.query(sql, args as never[]);
  return (result.rows[0] as Row | undefined) ?? null;
}

class PGliteTx implements PrismaStoreTx {
  constructor(private readonly db: PGlite) {}

  readonly match = {
    findUnique: ({ where }: { where: { id: string } }): Promise<DbMatchRow | null> =>
      row(this.db, `SELECT ${COLUMNS.match} FROM "Match" WHERE "id" = $1`, [where.id]) as Promise<DbMatchRow | null>,

    findMany: (): Promise<Array<{ id: string }>> =>
      rows(this.db, `SELECT "id" FROM "Match" ORDER BY "id"`, []) as Promise<Array<{ id: string }>>,

    create: async ({ data }: { data: Record<string, unknown> }) => {
      const { sql, args } = insertSql("Match", data);
      try {
        await this.db.query(sql, args as never[]);
      } catch (error) {
        wrap(error);
      }
      return { id: data.id };
    },

    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const keys = Object.keys(data);
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
      try {
        await this.db.query(
          `UPDATE "Match" SET ${sets} WHERE "id" = $1 RETURNING *`,
          [where.id, ...keys.map((k) => bind(data[k]))] as never[],
        );
      } catch (error) {
        wrap(error);
      }
      return { id: where.id };
    },
  };

  readonly matchCommand = {
    findMany: ({
      where,
      orderBy,
    }: {
      where: { matchId: string };
      orderBy: { seq: "asc" | "desc" };
    }): Promise<Array<{ seq: number; commandId: string }>> => {
      const dir = orderBy.seq === "desc" ? "DESC" : "ASC";
      return rows(
        this.db,
        `SELECT "seq", "commandId" FROM "MatchCommand" WHERE "matchId" = $1 ORDER BY "seq" ${dir}`,
        [where.matchId],
      ) as Promise<Array<{ seq: number; commandId: string }>>;
    },

    listRange: (matchId: string, range: { gtSeq?: number; ltSeq?: number; limit?: number }): Promise<DbCommandRow[]> => {
      const conds = ['"matchId" = $1'];
      const args: unknown[] = [matchId];
      if (range.gtSeq !== undefined) {
        args.push(range.gtSeq);
        conds.push(`"seq" > $${args.length}`);
      }
      if (range.ltSeq !== undefined) {
        args.push(range.ltSeq);
        conds.push(`"seq" < $${args.length}`);
      }
      let sql = `SELECT ${COLUMNS.matchCommand} FROM "MatchCommand" WHERE ${conds.join(" AND ")} ORDER BY "seq" ASC`;
      if (range.limit !== undefined) {
        args.push(range.limit);
        sql += ` LIMIT $${args.length}`;
      }
      return rows(this.db, sql, args) as Promise<DbCommandRow[]>;
    },

    listAll: (matchId: string): Promise<DbCommandRow[]> =>
      rows(this.db, `SELECT ${COLUMNS.matchCommand} FROM "MatchCommand" WHERE "matchId" = $1 ORDER BY "seq" ASC`, [
        matchId,
      ]) as Promise<DbCommandRow[]>,

    count: async (matchId: string): Promise<number> => {
      const r = await row(this.db, `SELECT count(*)::text AS c FROM "MatchCommand" WHERE "matchId" = $1`, [matchId]);
      return Number(r?.c ?? 0);
    },

    maxSeq: async (matchId: string): Promise<number | null> => {
      const r = await row(this.db, `SELECT max("seq")::text AS m FROM "MatchCommand" WHERE "matchId" = $1`, [matchId]);
      return r?.m === null || r?.m === undefined ? null : Number(r.m);
    },

    create: async ({ data }: { data: Record<string, unknown> }) => {
      const { sql, args } = insertSql("MatchCommand", data, ["id"]);
      try {
        await this.db.query(sql, args as never[]);
      } catch (error) {
        wrap(error);
      }
      return data;
    },
  };

  readonly matchSnapshot = {
    findMany: ({ where }: { where: { matchId: string } }): Promise<DbSnapshotRow[]> =>
      rows(
        this.db,
        `SELECT ${COLUMNS.matchSnapshot} FROM "MatchSnapshot" WHERE "matchId" = $1 ORDER BY "revision" ASC`,
        [where.matchId],
      ) as Promise<DbSnapshotRow[]>,

    deleteMany: async ({ where }: { where: { matchId: string } }) => {
      const result = await this.db.query(`DELETE FROM "MatchSnapshot" WHERE "matchId" = $1`, [where.matchId] as never[]);
      return result.affectedRows ?? 0;
    },

    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const entry of data) {
        const { sql, args } = insertSql("MatchSnapshot", entry, ["id"]);
        try {
          await this.db.query(sql, args as never[]);
        } catch (error) {
          wrap(error);
        }
      }
      return data.length;
    },
  };

  readonly matchCorrection = {
    findMany: ({ where }: { where: { matchId: string } }): Promise<DbCorrectionRow[]> =>
      rows(
        this.db,
        `SELECT ${COLUMNS.matchCorrection} FROM "MatchCorrection" WHERE "matchId" = $1 ORDER BY "id" ASC`,
        [where.matchId],
      ) as Promise<DbCorrectionRow[]>,

    deleteMany: async ({ where }: { where: { matchId: string } }) => {
      const result = await this.db.query(`DELETE FROM "MatchCorrection" WHERE "matchId" = $1`, [where.matchId] as never[]);
      return result.affectedRows ?? 0;
    },

    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const entry of data) {
        const { sql, args } = insertSql("MatchCorrection", entry, ["id"]);
        try {
          await this.db.query(sql, args as never[]);
        } catch (error) {
          wrap(error);
        }
      }
      return data.length;
    },
  };
}

export class PGliteStoreClient implements PrismaStoreClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly db: PGlite) {}

  /**
   * One connection, so transactions serialize instead of running concurrently.
   * Callers still get all-or-nothing semantics per call, which is what
   * `PostgresBackend` relies on when it appends then verifies.
   */
  async $transaction<T>(fn: (tx: PrismaStoreTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const tx = new PGliteTx(this.db);
      await this.db.exec("BEGIN");
      try {
        const result = await fn(tx);
        await this.db.exec("COMMIT");
        return result;
      } catch (error) {
        await this.db.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export async function createPGliteClient(ddl: string): Promise<PGliteStoreClient> {
  const db = new PGlite();
  await db.exec(ddl);
  return new PGliteStoreClient(db);
}

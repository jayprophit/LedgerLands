import type { MatchStatus } from "@ledgerlands/shared-types";
import type { Difficulty } from "@ledgerlands/game-ai";
import type {
  CommandRange,
  MatchCorrection,
  MatchSnapshot,
  PersistedCommand,
  StorageBackend,
  StoredMatch,
  SuffixReadResult,
} from "./storage.js";

/** Snapshot envelope version stored in `MatchSnapshot.version`. */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** Two writers raced on the same next revision. Safe to reload + retry. */
export class ConcurrencyError extends Error {
  readonly code = "CONCURRENCY_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

export class BackendError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

// ---- Minimal structural Prisma surface (real client or test fake) ----

export interface DbMatchRow {
  id: string;
  status: string;
  rulesetVersion: string;
  seedCommitment: string | null;
  stateRevision: number;
  initialState: unknown;
  botDifficulty: string;
  solo: boolean;
}

export interface DbCommandRow {
  seq: number;
  commandId: string;
  actorId: string | null;
  command: unknown;
  resultRevision: number;
}

export interface DbSnapshotRow {
  revision: number;
  version: number;
  state: unknown;
  /** Commands covered by this snapshot; drives the suffix range query. */
  seq?: number | null;
}

export interface DbCorrectionRow {
  kind: string;
  detail: string | null;
}

export interface PrismaStoreTx {
  match: {
    findUnique(args: { where: { id: string } }): Promise<DbMatchRow | null>;
    findMany(args: { select: { id: boolean } }): Promise<Array<{ id: string }>>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  matchCommand: {
    findMany(args: {
      where: { matchId: string };
      orderBy: { seq: "asc" | "desc" };
      select: { seq: boolean; commandId: boolean };
    }): Promise<Array<{ seq: number; commandId: string }>>;
    /**
     * Range query, equivalent to
     * `WHERE matchId = ? AND seq > ? [AND seq < ?] ORDER BY seq ASC [LIMIT ?]`.
     * Served by the `(matchId, seq)` unique index, so a suffix read never
     * materialises the full command history.
     */
    listRange(matchId: string, range: { gtSeq?: number; ltSeq?: number; limit?: number }): Promise<DbCommandRow[]>;
    listAll(matchId: string): Promise<DbCommandRow[]>;
    count(matchId: string): Promise<number>;
    maxSeq(matchId: string): Promise<number | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  matchSnapshot: {
    findMany(args: { where: { matchId: string } }): Promise<DbSnapshotRow[]>;
    deleteMany(args: { where: { matchId: string } }): Promise<unknown>;
    createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
  };
  matchCorrection: {
    findMany(args: { where: { matchId: string } }): Promise<DbCorrectionRow[]>;
    deleteMany(args: { where: { matchId: string } }): Promise<unknown>;
    createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
  };
}

export interface PrismaStoreClient {
  $transaction<T>(fn: (tx: PrismaStoreTx) => Promise<T>): Promise<T>;
}

/** Validate an unknown object (e.g. a real PrismaClient) exposes the needed delegates. */
export function asPrismaStoreClient(client: unknown): PrismaStoreClient {
  const c = client as Record<string, unknown>;
  for (const key of ["$transaction", "match", "matchCommand", "matchSnapshot", "matchCorrection"]) {
    if (typeof c[key] !== "function" && (key !== "$transaction" ? typeof c[key] !== "object" : true)) {
      throw new BackendError("INVALID_CLIENT", `Prisma client is missing ${key}.`);
    }
  }
  if (typeof c["$transaction"] !== "function") throw new BackendError("INVALID_CLIENT", "Prisma client is missing $transaction.");
  return client as PrismaStoreClient;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * Prisma-backed StorageBackend.
 *
 * Concurrency: every save runs in a transaction that compares the persisted
 * command-id prefix with the incoming log. Appends use per-seq unique
 * constraints, so two writers racing on the same next revision cannot both
 * commit — the loser gets ConcurrencyError (or a P2002 mapped to one).
 * Command identity is unique per match, so crash-then-retry replays are
 * idempotent: already-committed commands are skipped, never duplicated.
 */
export class PostgresBackend implements StorageBackend {
  constructor(private readonly prisma: PrismaStoreClient) {}

  async save(matchId: string, record: StoredMatch): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.match.findUnique({ where: { id: matchId } });
      if (!existing) {
        await tx.match.create({
          data: {
            id: matchId,
            status: record.meta.status,
            rulesetVersion: record.initial.rulesetVersion ?? "classic-v1",
            seedCommitment: String(record.initial.seed),
            stateRevision: record.meta.stateRevision,
            initialState: record.initial as unknown as Record<string, unknown>,
            botDifficulty: record.botDifficulty,
            solo: record.solo,
          },
        });
        await this.insertCommands(tx, matchId, record.commands, 0);
        await this.replaceSnapshots(tx, matchId, record.snapshots);
        await this.replaceCorrections(tx, matchId, record.corrections);
        return;
      }
      const rows = await tx.matchCommand.findMany({
        where: { matchId },
        orderBy: { seq: "asc" },
        select: { seq: true, commandId: true },
      });
      const recIds = record.commands.map((c) => c.commandId);
      if (recIds.length < rows.length) {
        throw new ConcurrencyError(`Local log (${recIds.length}) is behind persisted log (${rows.length}); reload first.`);
      }
      for (let i = 0; i < rows.length; i += 1) {
        if (recIds[i] !== rows[i]!.commandId) {
          throw new ConcurrencyError(`Log diverged at seq ${i}; reload first.`);
        }
      }
      const delta = record.commands.slice(rows.length);
      try {
        await this.insertCommands(tx, matchId, delta, rows.length);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConcurrencyError("Concurrent writer committed the same revision; reload and retry.");
        }
        throw error;
      }
      await this.replaceSnapshots(tx, matchId, record.snapshots);
      await this.replaceCorrections(tx, matchId, record.corrections);
      await tx.match.update({
        where: { id: matchId },
        data: {
          status: record.meta.status,
          stateRevision: record.meta.stateRevision,
          initialState: record.initial as unknown as Record<string, unknown>,
          botDifficulty: record.botDifficulty,
          solo: record.solo,
        },
      });
    });
  }

  /**
   * Header-only read: the command log is never selected, which is what makes
   * suffix reconstruction a real saving on this backend.
   */
  async loadHeader(matchId: string): Promise<StoredMatch | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.match.findUnique({ where: { id: matchId } });
      if (!row || !row.initialState) return undefined;
      const [snapshots, corrections, totalCommands] = await Promise.all([
        tx.matchSnapshot.findMany({ where: { matchId } }),
        tx.matchCorrection.findMany({ where: { matchId } }),
        tx.matchCommand.count(matchId),
      ]);
      return this.assemble(row, [], snapshots, corrections, totalCommands);
    });
  }

  async load(matchId: string): Promise<StoredMatch | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.match.findUnique({ where: { id: matchId } });
      if (!row || !row.initialState) return undefined;
      const commands = (await tx.matchCommand.listAll(matchId)).map(
        (r): PersistedCommand => ({
          command: r.command as PersistedCommand["command"],
          commandId: r.commandId,
          actorPlayerId: r.actorId ?? "unknown",
          at: new Date().toISOString(),
          resultRevision: r.resultRevision,
        }),
      );
      const [snapshots, corrections] = await Promise.all([
        tx.matchSnapshot.findMany({ where: { matchId } }),
        tx.matchCorrection.findMany({ where: { matchId } }),
      ]);
      return this.assemble(row, commands, snapshots, corrections, commands.length);
    });
  }

  private assemble(
    row: DbMatchRow,
    commands: PersistedCommand[],
    snapshotRows: DbSnapshotRow[],
    correctionRows: DbCorrectionRow[],
    totalCommands: number,
  ): StoredMatch {
    const snapshots: MatchSnapshot[] = snapshotRows.map((r) => ({
      revision: r.revision,
      state: r.state as MatchSnapshot["state"],
      at: new Date().toISOString(),
      // `seq` marks how many commands the snapshot covers; the DB keys on it
      // for the range query.
      ...(r.seq !== null && r.seq !== undefined ? { seq: r.seq } : {}),
    }));
    const corrections: MatchCorrection[] = correctionRows.map((r) => ({
      kind: r.kind as MatchCorrection["kind"],
      detail: r.detail ?? "",
      at: new Date().toISOString(),
    }));
    return {
      initial: row.initialState as StoredMatch["initial"],
      commands,
      snapshots,
      corrections,
      seenCommandIds: commands.map((c) => c.commandId),
      botDifficulty: row.botDifficulty as Difficulty,
      solo: row.solo,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meta: { status: row.status as MatchStatus, stateRevision: row.stateRevision, totalCommands },
    };
  }

  async list(): Promise<string[]> {
    // Reads are safe outside an explicit transaction for most drivers, but the
    // interface only exposes $transaction — reuse it for uniformity.
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.match.findMany({ select: { id: true } });
      return rows.map((r) => r.id);
    });
  }

  /**
   * TRUE partial read: an indexed range query on `(matchId, seq)`. Only the
   * suffix rows are fetched, never the full history. Callers pass
   * `afterSeq` derived from a snapshot; when it is omitted the query degrades
   * to a full read plus an in-memory revision filter, which is correct but not
   * partial — callers should always supply it.
   */
  async readCommandsAfter(matchId: string, range: CommandRange): Promise<SuffixReadResult> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.matchCommand.listRange(matchId, {
        ...(range.afterSeq !== undefined ? { gtSeq: range.afterSeq } : {}),
        ...(range.throughSeq !== undefined ? { ltSeq: range.throughSeq } : {}),
        ...(range.limit !== undefined ? { limit: range.limit } : {}),
      });
      const totalCommands = await tx.matchCommand.count(matchId);
      const maxSeq = (await tx.matchCommand.maxSeq(matchId)) ?? undefined;
      const commands = rows
        .filter((r) => r.resultRevision > range.afterRevision)
        .map(
          (r): PersistedCommand => ({
            command: r.command as PersistedCommand["command"],
            commandId: r.commandId,
            actorPlayerId: r.actorId ?? "unknown",
            at: new Date().toISOString(),
            resultRevision: r.resultRevision,
          }),
        );
      return {
        commands,
        totalCommands,
        commandsExcluded: totalCommands - commands.length,
        ...(maxSeq !== undefined ? { maxSeq } : {}),
      };
    });
  }

  private async insertCommands(tx: PrismaStoreTx, matchId: string, commands: PersistedCommand[], baseSeq: number): Promise<void> {
    let seq = baseSeq;
    for (const c of commands) {
      if (c.resultRevision === undefined) {
        throw new BackendError("MISSING_REVISION", `Command ${c.commandId} lacks resultRevision.`);
      }
      await tx.matchCommand.create({
        data: {
          matchId,
          seq: seq++,
          commandId: c.commandId,
          actorId: c.actorPlayerId,
          command: c.command as unknown as Record<string, unknown>,
          resultRevision: c.resultRevision,
        },
      });
    }
  }

  private async replaceSnapshots(tx: PrismaStoreTx, matchId: string, snapshots: MatchSnapshot[]): Promise<void> {
    await tx.matchSnapshot.deleteMany({ where: { matchId } });
    if (snapshots.length === 0) return;
    await tx.matchSnapshot.createMany({
      data: snapshots.map((s) => ({
        matchId,
        revision: s.revision,
        seq: s.seq ?? 0,
        version: SNAPSHOT_FORMAT_VERSION,
        state: s.state as unknown as Record<string, unknown>,
      })),
    });
  }

  private async replaceCorrections(tx: PrismaStoreTx, matchId: string, corrections: MatchCorrection[]): Promise<void> {
    await tx.matchCorrection.deleteMany({ where: { matchId } });
    if (corrections.length === 0) return;
    await tx.matchCorrection.createMany({
      data: corrections.map((c) => ({ matchId, kind: c.kind, detail: c.detail })),
    });
  }
}

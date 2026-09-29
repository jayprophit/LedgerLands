import { describe, expect, it } from "vitest";
import {
  DurableMatchmakingService,
  MemoryMatchmakingStore,
  PostgresMatchmakingStore,
  type MatchmakingStore,
  type MatchmakingTx,
  type QueueRowDb,
  type SqlExecutor,
} from "../src/index.js";

const T0 = 1_000_000;

/** A SQL executor fake that enforces the same compare-and-set guarantees. */
function fakeSql(): SqlExecutor<MatchmakingTx> & { rows: QueueRowDb[] } {
  const self = {
    rows: [] as QueueRowDb[],
    async transaction<T>(fn: (tx: MatchmakingTx) => Promise<T>): Promise<T> {
      const tx: MatchmakingTx = {
        async insertEntry(row) {
          self.rows.push({ ...row });
          return {};
        },
        async findByPlayer(playerId, queue) {
          return self.rows.filter((r) => r.playerId === playerId && (queue === undefined || r.queue === queue));
        },
        async findCandidates(queue, limit) {
          return self.rows
            .filter((r) => r.queue === queue && r.status === "QUEUED")
            .sort((a, b) => a.joinedAt - b.joinedAt)
            .slice(0, limit);
        },
        async claimEntries(reservationId, entryIds, versions, expiresAt) {
          let updated = 0;
          for (const [i, id] of entryIds.entries()) {
            const row = self.rows.find((r) => r.entryId === id);
            if (!row) continue;
            if (row.status !== "QUEUED" || row.version !== versions[i]) continue;
            row.status = "RESERVED";
            row.reservationId = reservationId;
            row.reservationExpiresAt = expiresAt;
            row.version += 1;
            updated += 1;
          }
          return updated;
        },
        async finalizeReservation(reservationId, matchId) {
          const out: QueueRowDb[] = [];
          for (const r of self.rows) {
            if (r.reservationId !== reservationId) continue;
            r.status = "MATCHED";
            r.matchId = matchId;
            r.reservationExpiresAt = null;
            r.version += 1;
            out.push({ ...r });
          }
          return out;
        },
        async releaseReservation(reservationId) {
          const out: QueueRowDb[] = [];
          for (const r of self.rows) {
            if (r.reservationId !== reservationId) continue;
            r.status = "QUEUED";
            r.reservationId = null;
            r.reservationExpiresAt = null;
            r.version += 1;
            out.push({ ...r });
          }
          return out;
        },
        async expireReservations(nowMs) {
          const out: QueueRowDb[] = [];
          for (const r of self.rows) {
            if (r.status !== "RESERVED" || r.reservationExpiresAt === null) continue;
            if (nowMs < r.reservationExpiresAt) continue;
            r.status = "EXPIRED";
            r.reservationId = null;
            r.reservationExpiresAt = null;
            r.version += 1;
            out.push({ ...r });
          }
          return out;
        },
        async findByReservation(reservationId) {
          return self.rows.filter((r) => r.reservationId === reservationId).map((r) => ({ ...r }));
        },
      };
      return fn(tx);
    },
  };
  return self;
}

async function makeService(store: MatchmakingStore, leaseMs = 30_000) {
  const service = new DurableMatchmakingService(store, {
    initialDelta: 100,
    expandPerSecond: 5,
    maxDelta: 400,
    reservationLeaseMs: leaseMs,
    candidateBatch: 100,
  });
  return service;
}

describe("durable matchmaking", () => {
  it("is idempotent on duplicate join and safe on repeated leave", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store);
    const a1 = await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    const a2 = await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 9999, nowMs: T0 + 500 });
    expect(a2.entryId).toBe(a1.entryId);
    expect(a2.joinedAt).toBe(T0); // original wait time preserved
    expect(a2.rating).toBe(1500); // not overwritten
    expect(await svc.leave("a", undefined, T0 + 1)).toBe(1);
    expect(await svc.leave("a", undefined, T0 + 2)).toBe(1); // repeatable, not cumulative
    const rows = await svc.entriesFor("a");
    expect(rows[0]!.status).toBe("CANCELLED");
  });

  it("pairs two players and finalizes into an authoritative match", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store);
    await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    await svc.join({ playerId: "b", displayName: "B", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 + 1 });
    const assignments = await svc.tick(async () => "match-1", T0 + 2);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.playerIds.sort()).toEqual(["a", "b"]);
    expect(assignments[0]!.matchId).toBe("match-1");
    const rows = await svc.entriesFor("a");
    expect(rows[0]!.status).toBe("MATCHED");
    expect(rows[0]!.matchId).toBe("match-1");
  });

  it("releases the group back to QUEUED when match creation fails", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store);
    await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    await svc.join({ playerId: "b", displayName: "B", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    const failed = await svc.tick(async () => {
      throw new Error("db down");
    }, T0 + 1);
    expect(failed).toHaveLength(0);
    for (const p of ["a", "b"]) {
      const rows = await svc.entriesFor(p);
      expect(rows[0]!.status).toBe("QUEUED");
      expect(rows[0]!.joinedAt).toBe(T0); // wait time not reset
      expect(rows[0]!.reservationId).toBeUndefined();
    }
  });

  it("two workers racing the same group produce exactly one match", async () => {
    const store = new MemoryMatchmakingStore();
    const [w1, w2] = await Promise.all([makeService(store), makeService(store)]);
    await w1.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    await w1.join({ playerId: "b", displayName: "B", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    let created = 0;
    const factory = async () => {
      created += 1;
      return `match-${created}`;
    };
    // Interleave both workers so the compare-and-set claim is genuinely contested.
    const [r1, r2] = await Promise.all([w1.tick(factory, T0 + 1), w2.tick(factory, T0 + 1)]);
    const all = [...r1, ...r2];
    expect(all).toHaveLength(1);
    expect(created).toBe(1);
    expect((await w1.entriesFor("a"))[0]!.status).toBe("MATCHED");
  });

  it("recovers an orphaned reservation after a crash via lease expiry", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store, 1_000);
    await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    await svc.join({ playerId: "b", displayName: "B", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    // Simulate a crash: claim the group but never finalize.
    const waiting = await store.candidates("CASUAL_1V1");
    expect(await store.claimReservations(waiting, "res-crash", T0, 1_000)).toBe(true);
    expect((await store.byReservation("res-crash")).length).toBe(2);
    // A fresh service (simulating restart) sweeps the expired lease.
    const swept = await store.sweepExpiredReservations(T0 + 2_000);
    expect(swept).toHaveLength(2);
    expect(swept.every((r) => r.status === "EXPIRED")).toBe(true);
    // Expired entries can rejoin cleanly.
    const again = await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 + 3_000 });
    expect(again.status).toBe("QUEUED");
  });

  it("FFA_4 claims all four players atomically and no partial group is formed", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store);
    for (const p of ["a", "b", "c", "d", "e"]) {
      await svc.join({ playerId: p, displayName: p, queue: "FFA_4", rating: 1500, nowMs: T0 });
    }
    const assignments = await svc.tick(async () => "ffa-1", T0 + 1);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.playerIds).toHaveLength(4);
    // Exactly one player is left waiting — not stranded, not half-assigned.
    const all = await Promise.all(["a", "b", "c", "d", "e"].map((p) => svc.entriesFor(p)));
    const statuses = all.map((rows) => rows[0]!.status);
    expect(statuses.filter((s) => s === "MATCHED")).toHaveLength(4);
    const waiting = all.find((rows) => rows[0]!.status === "QUEUED");
    expect(waiting).toBeDefined();
    expect(waiting![0]!.matchId).toBeUndefined();
  });

  it("a lost CAS claim does not finalize a torn group", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store);
    await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    await svc.join({ playerId: "b", displayName: "B", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    const waiting = await store.candidates("CASUAL_1V1");
    // A rival worker takes only `a`.
    expect(await store.claimReservations([waiting[0]!], "other", T0, 30_000)).toBe(true);
    // Our group claim must now fail wholesale.
    expect(await store.claimReservations(waiting, "ours", T0, 30_000)).toBe(false);
    expect((await store.byReservation("ours")).length).toBe(0);
    expect((await store.byReservation("other")).length).toBe(1);
    void svc;
  });

  it("ranked skill bands expand with persisted wait time, surviving restart", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store);
    await svc.join({ playerId: "pro", displayName: "P", queue: "RANKED_1V1", rating: 2000, nowMs: T0 });
    await svc.join({ playerId: "new", displayName: "N", queue: "RANKED_1V1", rating: 1650, nowMs: T0 });
    expect(await svc.tick(async () => "m", T0 + 1)).toHaveLength(0);
    // 350 rating gap: initial band 100 fails; after ~51s the band reaches 355.
    expect(await svc.tick(async () => "m", T0 + 51_000)).toHaveLength(1);
  });

  it("postgres store honours the same idempotency and CAS contract", async () => {
    const sql = fakeSql();
    const store = new PostgresMatchmakingStore(sql);
    const svc = await makeService(store);
    const first = await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    const dup = await svc.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 + 5 });
    expect(dup.entryId).toBe(first.entryId);
    await svc.join({ playerId: "b", displayName: "B", queue: "CASUAL_1V1", rating: 1500, nowMs: T0 });
    const assignments = await svc.tick(async () => "pg-match", T0 + 1);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.matchId).toBe("pg-match");
    expect((await svc.entriesFor("b"))[0]!.status).toBe("MATCHED");
    // A second tick finds nobody new: no duplicate match.
    expect(await svc.tick(async () => "pg-match-2", T0 + 2)).toHaveLength(0);
  });

  it("rejects leaving a queue the player never joined without side effects", async () => {
    const store = new MemoryMatchmakingStore();
    const svc = await makeService(store);
    expect(await svc.leave("ghost", "RANKED_1V1", T0)).toBe(0);
    expect((await svc.queued("RANKED_1V1")).length).toBe(0);
  });
});

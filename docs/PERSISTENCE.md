# Persistence

Canonical description of how matches are stored, reconstructed, and read.
Implements `packages/match-store`.

## Storage contract

```typescript
interface StorageBackend {
  save(matchId, record): Promise<void>;
  load(matchId): Promise<StoredMatch | undefined>;      // full read
  loadHeader(matchId): Promise<StoredMatch | undefined>;  // metadata + snapshots, NO commands
  list(): Promise<string[]>;
  readCommandsAfter(matchId, range): Promise<SuffixReadResult>;
}
```

`readCommandsAfter` is **range-oriented and backend-agnostic** — no Prisma query
semantics leak into `MatchStore`:

```typescript
interface CommandRange {
  afterRevision: number;  // exclusive, on command result revision
  afterSeq?: number;      // optional exclusive bound on the durable sequence
  throughSeq?: number;    // optional upper bound
  limit?: number;
}
interface SuffixReadResult {
  commands: PersistedCommand[];
  totalCommands: number;
  commandsExcluded: number;  // lets the caller verify completeness in one read
  maxSeq?: number;
}
```

`loadHeader` exists so a rebuild never selects the command log at all when a
usable snapshot is present. `commandsExcluded` exists so completeness can be
verified without a second round trip.

## Backends

| Backend | Suffix read | Partial physical I/O? | Durable | Multi-process safe |
|---|---|---|---|---|
| `MemoryBackend` | logical range query over an in-memory array | n/a (no I/O) | no | no |
| `FileBackend` | **logical** — file is parsed, then filtered | **no** | yes (local) | no |
| `PostgresBackend` | **true indexed range query** on `(matchId, seq)` | yes (verified) | yes | yes (transactional) |

`FileBackend` stores one atomically-renamed JSON document per match, so the file
must be read and parsed in full before any suffix can be extracted. This is
explicitly *logical* suffix selection, not partial file I/O, and is documented as
such in the code. Changing to an append-only or segmented format would enable
real partial reads but requires a format version and migration; compatibility
was chosen for this milestone.

## Verification against a real PostgreSQL engine

`packages/match-store/test/postgres-pglite.test.ts` runs the same behavioural
contract as the unit tests, but against **PGlite** — PostgreSQL compiled to
WASM, so the real planner and the real constraint enforcement are involved.
The DDL in `test/ddl.ts` mirrors `prisma/schema.prisma` by hand.

What this proves:

- the SQL is valid and the schema matches the Prisma model;
- state is stored as `jsonb`, not a double-encoded string;
- the `(matchId, seq)` and `(matchId, commandId)` unique constraints really do
  reject the collisions the append guard and idempotency depend on;
- a transaction that fails part-way leaves **no** partial rows;
- the suffix range query is served by `MatchCommand_matchId_seq_idx`, asserted
  with `EXPLAIN` — no `Seq Scan`;
- a snapshot-backed rebuild takes the `"suffix"` path and produces a state
  identical to the memory backend.

What it does **not** prove: concurrent-writer interleaving. PGlite is
single-connection, so transactions serialize where a real server could
interleave two writers between `SELECT` and `INSERT`. The unique index is what
stops that race, and that the index exists and is enforced is verified here — but
the interleaving itself still needs a networked server to observe.

### The bug this found

`snapshot.seq` is the **count** of commands a snapshot covers, and commands are
stored zero-indexed (`seq = 0..n-1`), so the first command after a snapshot sits
at `seq === snapshot.seq`. The range query used `seq > snapshot.seq`, which
skipped that row. The caller's gap-free check then failed and every
snapshot-backed rebuild silently fell back to full replay — correct results, no
performance benefit, no error. `MemoryBackend` ignores `afterSeq` and filters by
revision, so no existing test could see it.

Fixed in `postgres.ts` (`gtSeq: afterSeq - 1`) with a regression test that
asserts `lastRebuild.path === "suffix"`.

## Reconstruction

```
loadHeader(matchId)
  → newest usable snapshot?
      yes → readCommandsAfter(afterRevision = snapshot.revision, afterSeq = snapshot.seq)
              → suffix valid?  → replay(snapshot.state, suffix)      path = "suffix"
              → suffix invalid → load() + replay from initial        path = "full-replay"
      no  → load() + replay from initial                            path = "full-replay"
  → apply non-engine corrections (e.g. lobby-timeout cancel)
  → cache
```

`store.lastRebuild.path` reports which path ran, so the suffix path can be
asserted in tests instead of silently degenerating to full replay.

### When a suffix is rejected

A suffix is only trusted when all of the following hold:

1. it is gap-free — result revisions strictly increase from `snapshot.revision`;
2. it is the *complete* tail — `commandsExcluded + commands.length === totalCommands`;
3. `snapshot.seq <= totalCommands` — a snapshot cannot cover more commands than
   the log actually holds;
4. `commands.length === totalCommands - snapshot.seq`.

Condition 4 is what catches a snapshot whose `revision` lies about its position:
the length mismatch forces a full replay instead of a wrong state. Every one of
these rejections is covered by tests.

## Concurrency (PostgresBackend)

Every `save` runs in a transaction that:

1. reads the persisted `(seq, commandId)` prefix,
2. verifies the incoming log extends it without divergence (else `ConcurrencyError`),
3. appends only the delta, relying on unique `(matchId, seq)`,
4. relies on unique `(matchId, commandId)` for idempotency,
5. updates denormalized `status` / `stateRevision`.

`P2002` (unique violation) is mapped to `ConcurrencyError`, surfaced as HTTP 409.
Two writers racing on the same next sequence cannot both commit: one wins, the
other is told to reload and retry. Crash-then-retry cannot duplicate a command
because identity is persisted.

The constraint half of that claim is now verified against a real PostgreSQL
engine (PGlite): duplicate `(matchId, seq)` and duplicate `(matchId, commandId)`
inserts are rejected with SQLSTATE 23505, and a mid-transaction failure rolls
back cleanly. The **interleaving** half still needs a networked server, because
PGlite serializes transactions. The `DATABASE_URL` test remains skipped here and
is the right place to close that last gap.

## Snapshots

- Written every `SNAPSHOT_EVERY_COMMANDS = 25` commands; last 8 retained.
- `seq` records how many commands the snapshot covers, which is the lower bound
  for the suffix range query (`MatchSnapshot.seq`, indexed `(matchId, seq)`).
- Snapshots are **advisory caches**, never a source of truth. The command log is.

## Known gaps

1. No physical partial reads on `FileBackend` (see table).
2. Postgres **concurrent-writer interleaving** is unverified — no networked server
   here. Constraints and the index are verified; the race itself is not.
3. `test/ddl.ts` is hand-kept in sync with `prisma/schema.prisma`. It is a second
   source of truth and can drift; a Prisma-generated migration is the fix.
4. Replay exports are tamper-evident but unsigned; see `docs/REPLAY.md`.
5. Header read still loads every snapshot row; fine at 8 retained, revisit if
   retention grows.

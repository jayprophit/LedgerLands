# ADR-002: Postgres snapshot suffix read skipped a command

- **Status:** accepted (fix shipped)
- **Date:** 2026-09-29
- **Affects:** `packages/match-store/src/postgres.ts`, `readCommandsAfter`
- **Found by:** a PGlite harness (real PostgreSQL compiled to WASM)

## Summary

Every snapshot-backed rebuild on `PostgresBackend` silently fell back to a full
replay. Results were correct, no error was raised, and the performance benefit
the snapshots exist to provide never materialised.

## The two semantics that were confused

```text
snapshot.seq         = the COUNT of commands the snapshot covers
MatchCommand.seq     = a zero-based index into the command log
```

A snapshot taken after *k* commands records `seq = k`, and the commands it covers
are stored at `seq = 0 .. k-1`. The first command **after** the snapshot is
therefore at `seq === k`.

`readCommandsAfter` translated `afterSeq` into the SQL bound `seq > afterSeq`,
which excluded that first tail command:

```ts
// before — off by one
...(range.afterSeq !== undefined ? { gtSeq: range.afterSeq } : {}),

// after
...(range.afterSeq !== undefined ? { gtSeq: range.afterSeq - 1 } : {}),
```

## Why nothing caught it

`MatchStore.rebuild` validates the suffix it gets back before trusting it:

1. gap-free — result revisions strictly increase from `snapshot.revision`;
2. complete — `commandsExcluded + commands.length === totalCommands`;
3. plausible — `snapshot.seq <= totalCommands`;
4. exact — `commands.length === totalCommands - snapshot.seq`.

A short suffix fails all four, so the store did the safe thing and replayed
everything. **The design failed safe.** That is why the bug was invisible rather
than corrupting: correctness was never at risk, only the performance claim.

The reason no test could see it is more specific. `MemoryBackend` and
`FileBackend` **ignore `afterSeq` entirely** and filter by `resultRevision` only.
A unit test asserting "the suffix looks right" passes identically whether the
Postgres bound is correct or off by one. The fake Prisma client in
`postgres.test.ts` recorded the query it was asked to run and the test asserted
`gtSeq === snap.seq` — i.e. the test encoded the bug as the expected behaviour.

## Why it was found

`packages/match-store/test/postgres-pglite.test.ts` runs the same contract
against PGlite: real DDL, real constraint enforcement, real planner. The range
query genuinely uses `MatchCommand_matchId_seq_idx`, and a test asserting
`lastRebuild.path === "suffix"` on a snapshot-backed match fails when the bound is
wrong. It cannot be satisfied by a fake that agrees with itself.

## Prevention

1. **A real engine in the suite.** `POSTGRES_SEMANTICS_VERIFIED_PGLITE` — schema,
   `jsonb` typing, both unique constraints, transaction rollback, index usage.
   Not a substitute for a networked server, but it is where SQL bugs get caught.
2. **Per-backend contract tests** (`snapshot-boundary.test.ts`). Every backend's
   *actual* `afterSeq` semantics are asserted, including the fact that memory and
   file ignore it. A test that asserted a uniform contract would have forced
   either a behaviour change or a test that lies.
3. **The boundary matrix** is explicit: 0 commands, whole log covered, exactly
   one command after, every snapshot position for several match lengths, latest
   snapshot, no snapshot, and an impossible `seq`.
4. **`lastRebuild.path` assertions.** Any silent fallback to `full-replay` is now
   a test failure rather than an invisible performance regression.

## Cost

None in the correctness sense. The cost was entirely the snapshot optimisation
being inert on the one backend where it was supposed to matter, on every match,
since the feature landed.

## What is still unverified

Concurrent-writer interleaving. PGlite is single-connection and serializes
transactions, so the `DATABASE_URL` test remains the place to observe two writers
racing between `SELECT` and `INSERT`. The unique index that stops that race is
verified present and enforced; the interleaving itself is not.

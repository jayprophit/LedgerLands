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
| `PostgresBackend` | **true indexed range query** on `(matchId, seq)` | yes | yes | yes (transactional) |

`FileBackend` stores one atomically-renamed JSON document per match, so the file
must be read and parsed in full before any suffix can be extracted. This is
explicitly *logical* suffix selection, not partial file I/O, and is documented as
such in the code. Changing to an append-only or segmented format would enable
real partial reads but requires a format version and migration; compatibility
was chosen for this milestone.

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

**Live PostgreSQL verification: BLOCKED** in the current environment. Unit tests
use a constraint-faithful fake that enforces the same unique constraints and
records the range queries issued. See `docs/audit/THIRD_PASS_CHECKPOINT.md`.

## Snapshots

- Written every `SNAPSHOT_EVERY_COMMANDS = 25` commands; last 8 retained.
- `seq` records how many commands the snapshot covers, which is the lower bound
  for the suffix range query (`MatchSnapshot.seq`, indexed `(matchId, seq)`).
- Snapshots are **advisory caches**, never a source of truth. The command log is.

## Known gaps

1. No physical partial reads on `FileBackend` (see table).
2. Postgres partial-I/O benefit unproven without a live DB; confirm with `EXPLAIN`.
3. Replay exports are tamper-evident but unsigned; see `docs/REPLAY.md`.
4. Header read still loads every snapshot row; fine at 8 retained, revisit if
   retention grows.

# Performance baseline (LL-P16)

Date: 2026-09-29 · Machine: developer workstation
Commands: `node scripts/bench.mjs`, `node scripts/profile-engine.mjs`
**These are small-local numbers. They are not production capacity claims.**

## Measurements

| Probe | Scale | Result (after fixes) |
|---|---|---|
| Full match play (store write-through) | 50 solo games | 93,091 ms (≈1,862 ms/game) |
| Rebuild (snapshot + suffix, cache cleared) | 20 rebuilds, 1 match | 266 ms (≈13 ms/rebuild, was ≈161 ms) |
| FileBackend recovery after restart | 1 match | 24 ms (was 558 ms) |
| Replay export (hash chain) | 754 events | 38 ms |
| **Full match play (20 bot matches, 6,877 cmds)** | 20 games | **467 ms** (was 9,371 ms) |
| **Per-command cost** | — | **0.068 ms** (was 1.363 ms) |
| Postgres suffix read (real engine) | 5 matches × 5,000 commands | 23.3 ms vs 143.1 ms full read |

### Postgres suffix read, measured against a real PostgreSQL engine

`node scripts/bench-postgres.mjs` (PGlite — real PostgreSQL compiled to WASM,
same planner and constraint enforcement, no network):

| Query | Result |
|---|---|
| Suffix range, tail 10% (500 of 5,000 rows) | **23.3 ms** |
| Full log read (5,000 rows) | 143.1 ms |
| Ratio | **0.163** |

The planner's own choice for the range query:

```
Bitmap Heap Scan on "MatchCommand"
  Recheck Cond: (("matchId" = 'm0') AND (seq > 4499))
  ->  Bitmap Index Scan on "MatchCommand_matchId_seq_idx"
        Index Cond: (("matchId" = 'm0') AND (seq > 4499))
```

So the `(matchId, seq)` index is used and the partial-read claim is real, not
aspirational. This also found a live off-by-one: the range bound was one too
high, so the first command after a snapshot was skipped, the caller's
gap-free check failed, and every snapshot rebuild silently degraded to full
replay. Fixed in `postgres.ts`; see `docs/PERSISTENCE.md`.

### Rebuild path comparison (429-command match)

| Path | Elapsed |
|---|---|
| No snapshot → full replay from `initial` | 615.5 ms |
| Snapshot present, backend returns full log | 19.4 ms |
| Snapshot + suffix read (only 4 tail commands fetched) | 24.3 ms |

The first row is the honest cost of a long match with no usable snapshot. The
second and third are within noise of each other *on MemoryBackend*, because that
backend's suffix read is a logical range query over an array that is already in
memory — the saving here is engine replay work (only 4 commands instead of
429), not I/O. The material I/O benefit is expected on `PostgresBackend`, which
issues a real indexed `WHERE matchId = ? AND seq > ?` range query; that path is
**not live-verified** in this environment.
| Leaderboard sort | 5,000 rows × 200 | 453 ms (≈2.3 ms/sort) |
| Elo update | 10,000 head-to-heads | 16.5 ms |
| Matchmaking tick | 2,000 queued → 1,000 pairs | 107 ms |
| Ledger post | 10,000 postings | 156 ms |
| Double-elim bracket build | 200 tournaments × 16 players | 120 ms |

## Observed scaling risks

1. **~~Write-through clone dominated match play~~ — fixed (LL-P17 + fifth pass).**
   `MemoryBackend.save` no longer deep-clones the whole record per command
   (it stores the caller's reference; reads still clone, so callers cannot
   mutate stored state). Match play dropped 142 s → 93 s for 50 games.

   Profiling then showed the remaining cost was **not** where the doc claimed.
   Measured with `scripts/profile-engine.mjs` (20 bot-vs-bot matches):

   | Phase | Share (before) |
   |---|---|
   | `applyCommand` (clone + rules) | **99.1%** |
   | AI decisioning | 0.7% |
   | driver overhead | 0.2% |

   So the split was clone alone, not "clone plus decisioning". **That is now
   fixed** — see "The O(n²) clone" below.

### The O(n²) clone: cause, fix, and proof

`applyCommand` opened with `structuredClone(original)`, and `original.log` grows
by roughly 1.5 events per command. The clone therefore copied an ever-growing
array on every command, so a match was O(n²) in commands for a field **no rule
consults**. Grepping the engine found exactly one reference to `state.log`
outside the rules: `pushEvent`'s own push. The only external readers are
`eventsSince` and the replay export, both read-only projections.

**Fix** (`packages/game-engine/src/clone.ts`): copy only the containers a command
can mutate — players, properties, trades (with their `propertyIds` arrays),
auction (bids, `passedPlayerIds`, `highestBid`). The log *array* is still copied,
so a consumer pushing to `state.log` cannot reach into a previous revision; the
elements are shared because `pushEvent` constructs a new object per event and
never edits one.

#### Per-command clone cost, by log length

`node scripts/profile-clone.mjs`:

| events | `structuredClone` | targeted clone | speedup |
|---|---|---|---|
| 200 | 0.6061 ms | 0.0071 ms | 86× |
| 800 | 2.3622 ms | 0.0060 ms | 392× |
| 2001 | 6.2496 ms | 0.0096 ms | 654× |

**Growth over that range: `structuredClone` 8×, targeted clone 1×.** That is the
actual fix — the cost is now flat in log length instead of linear.

#### Whole-batch before/after

20 bot matches, 6,877 commands, identical seeds and policy:

| | before | after |
|---|---|---|
| total | 9,371 ms | **467 ms** |
| per command | 1.363 ms | **0.068 ms** |
| median game | 354 ms | **19 ms** |
| `applyCommand` share | 99.1% | 78.6% |
| AI decisioning share | 0.7% | 17.5% |

**20× faster.** The profile shift is honest and worth recording: the clone was
the cost, it is now a small constant, and what remains is the rules themselves
plus the bot.

#### Why this is provable rather than hopeful

Equivalence is asserted two ways, both of which had to hold *before* merging:

1. **Differential execution** (`test/clone-equivalence.test.ts`). Every oracle
   fixture plus a long seam-free bot match is replayed through the old
   `structuredClone` cloner and the new one; the resulting states must be
   identical field for field, events included. Alternating cloners mid-stream
   must also match both all-deep and all-fast runs.
2. **Golden fingerprints** captured *before* the change. All 19 still match,
   and `npm run oracle:check` runs in `npm run verify`.

A hash comparison alone would have been weaker: it could not distinguish
"equivalent" from "different but not yet noticed", and it would go stale the
moment a field was added to `MatchState`. See [ADR-001](./adr/ADR-001-determinism-oracle.md).

2. **FileBackend still rewrites the entire record per command** — O(commands²)
   bytes on disk. Local durability stand-in only, not a production store.

3. **~~Snapshots were written but never read~~ — fixed (LL-P17).**
   `rebuild()` now performs a header-only read, picks the newest usable
   snapshot, and requests only the command suffix after it via
   `StorageBackend.readCommandsAfter`. Validation is deliberately strict: the
   suffix must be gap-free, must start strictly after the snapshot revision,
   and must be exactly `totalCommands - snapshot.seq` long. A stale, corrupt,
   tampered, or truncated suffix falls back to full replay, so this can only be
   faster, never wrong. `store.lastRebuild.path` makes the path observable
   (`"suffix"` vs `"full-replay"`) instead of silently degenerating.
   Measured: full replay 615 ms → suffix rebuild 19–24 ms on a 429-command
   match.

4. **~~Postgres partial I/O is unproven~~ — verified against a real engine.**
   The range query now runs against PGlite (real PostgreSQL in WASM) and the
   planner picks `Bitmap Index Scan on MatchCommand_matchId_seq_idx`. Measured
   23.3 ms for a 500-row suffix vs 143.1 ms for the full 5,000-row read, on
   25,000 rows. What remains unverified is concurrent-writer interleaving,
   because PGlite is single-connection and serializes transactions.

5. **FileBackend cannot do partial physical I/O.** One atomically-renamed JSON
   document per match means the whole file is parsed before any suffix can be
   selected. This is documented as *logical* suffix selection, deliberately not
   presented as partial file I/O. An append-only or segmented format would fix
   it but needs a format version plus migration, so compatibility was kept.

6. **Hash-chained replay export is O(events) sha256.** Fine for a dispute
   export; must not run on a hot path (e.g. per broadcast).

7. **In-memory services are single-process only.** Ratings, queue, tournaments
   and the market ledger are `Map`s. Multi-process deployments need
   Postgres (ratings/tournaments) and Redis (queue, presence) — already the
   documented plan; recorded here so nobody reads these numbers as
   horizontally scalable.

8. **Matchmaking pairing is O(n²) in queue length** (linear scan for a
   compatible partner). Acceptable for hundreds; needs sorted-by-rating
   bucketing in the thousands.

## Not benchmarked

- Live PostgreSQL path (no DB available in this environment).
- WebSocket fan-out under many subscribers.
- Concurrent HTTP throughput (single-process inject tests only).

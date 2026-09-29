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

1. **~~Write-through clone dominated match play~~ — partially fixed.**
   `MemoryBackend.save` no longer deep-clones the whole record per command
   (it stores the caller's reference; reads still clone, so callers cannot
   mutate stored state). Match play dropped 142 s → 93 s for 50 games.
   The remaining per-command cost is the engine's own `structuredClone` in
   `applyCommand` plus bot decisioning, which is inherent to a pure
   event-sourced design. `PostgresBackend` avoids it entirely by writing one
   row per command.

   Measured breakdown (20 bot-vs-bot matches, `node scripts/profile-engine.mjs`):

   | Phase | Share |
   |---|---|
   | `applyCommand` (clone + rules) | **99.1%** |
   | AI decisioning | 0.7% |
   | driver overhead | 0.2% |

   So the earlier note attributing cost to "clone **plus** bot decisioning" was
   wrong about the split: decisioning is noise. The cost is the clone alone.

### Why the clone is not a constant: log length drives it

`applyCommand` opens with `structuredClone(original)` (`engine.ts:415`), and
`original.log` grows by roughly 1.5 events per command. The clone therefore
copies an ever-growing array on every single command — a match is O(n²) in
commands, not O(n). Measured on one seeded match, extended to increasing
lengths:

| `log` length | commands replayed | `applyCommand` ms/cmd | full replay ms |
|---|---|---|---|
| 53 | 26 | 0.35 | 4.2 |
| 200 | 100 | 0.76 | 43.0 |
| 801 | 396 | 2.79 | 536.2 |
| 2000 | 983 | 6.66 | 3,131.1 |

The per-command cost scales linearly with log length, and replay cost scales
quadratically. Isolating it: at `log` = 770, `structuredClone` of the full
state is 2.28 ms while the same state with `log` emptied is 0.068 ms — a
**33× difference for the log alone**, with the rules doing the rest.

This is a real design limit, not a tuning miss, and it has not been fixed:

- the purity of `applyCommand` is what makes seeded replay verifiable, so the
  clone cannot simply be removed;
- the event log is append-only and never read by the rules, so it is the one
  field that could be shared by reference across states — but that would make
  the returned state alias the input's log, and any consumer that mutates
  `state.log` would corrupt a prior revision. That is a correctness change, not
  an optimisation, and it needs a determinism test over a long match first.

Until then the honest mitigation is the one already in place: **keep
snapshots**. A snapshot short-circuits the quadratic path on rebuild, and
`PostgresBackend` avoids it on the write side entirely by storing one row per
command.

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

4. **Postgres partial I/O is unproven in this environment.** The range query is
   implemented and unit-tested against a fake that records the issued query, but
   no live database has run it. Real gains depend on the `(matchId, seq)` index
   actually being used by the planner — verify with `EXPLAIN` once a DB exists.

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

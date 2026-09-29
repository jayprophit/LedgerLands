# Performance baseline (LL-P16)

Date: 2026-09-28 · Machine: developer workstation · Command: `node scripts/bench.mjs`
**These are small-local numbers. They are not production capacity claims.**

## Measurements

| Probe | Scale | Result (after fixes) |
|---|---|---|
| Full match play (store write-through) | 50 solo games | 92,836 ms (≈1,857 ms/game, down from 2,845) |
| Rebuild via snapshot + tail (cache cleared each time) | 20 rebuilds, 1 match | 3,516 ms |
| FileBackend recovery after restart | 1 match | 558 ms |
| Replay export (hash chain) | 754 events | 37 ms |
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

2. **FileBackend still rewrites the entire record per command** — O(commands²)
   bytes on disk. Local durability stand-in only, not a production store.

3. **~~Snapshots were written but never read~~ — fixed.**
   `rebuild()` now uses the newest snapshot whose revision actually appears in
   the command log, then replays only the tail. Guarded by
   `commandsConsistentUpTo()`: a snapshot is only trusted when command result
   revisions are strictly increasing with no gaps below it, so
   "snapshot + tail" is provably equal to full replay. A stale, corrupt, or
   ahead-of-log snapshot silently falls back to full replay. Covered by
   `packages/match-store/test/store.test.ts` (snapshot rebuild equals expected
   state; corrupting all snapshots still yields the same state).
   Residual cost is dominated by the O(commands) *read* of the record itself.

4. **Hash-chained replay export is O(events) sha256.** Fine for a dispute
   export; must not run on a hot path (e.g. per broadcast).

5. **In-memory services are single-process only.** Ratings, queue, tournaments
   and the market ledger are `Map`s. Multi-process deployments need
   Postgres (ratings/tournaments) and Redis (queue, presence) — already the
   documented plan; recorded here so nobody reads these numbers as
   horizontally scalable.

6. **Matchmaking pairing is O(n²) in queue length** (linear scan for a
   compatible partner). Acceptable for hundreds; needs sorted-by-rating
   bucketing in the thousands.

## Not benchmarked

- Live PostgreSQL path (no DB available in this environment).
- WebSocket fan-out under many subscribers.
- Concurrent HTTP throughput (single-process inject tests only).

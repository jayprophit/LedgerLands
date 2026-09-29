# Performance baseline (LL-P16)

Date: 2026-09-28 · Machine: developer workstation · Command: `node scripts/bench.mjs`
**These are small-local numbers. They are not production capacity claims.**

## Measurements

| Probe | Scale | Result |
|---|---|---|
| Full match play (store write-through) | 50 solo games | 142,247 ms (≈2,845 ms/game) |
| Rebuild from command log (cache cleared each time) | 20 rebuilds, 1 match | 3,224 ms (≈161 ms/rebuild) |
| FileBackend recovery after restart | 1 match | 686 ms |
| Replay export (hash chain) | 754 events | 37 ms |
| Leaderboard sort | 5,000 rows × 200 | 453 ms (≈2.3 ms/sort) |
| Elo update | 10,000 head-to-heads | 16.5 ms |
| Matchmaking tick | 2,000 queued → 1,000 pairs | 107 ms |
| Ledger post | 10,000 postings | 156 ms |
| Double-elim bracket build | 200 tournaments × 16 players | 120 ms |

## Observed scaling risks

1. **Write-through clone dominates match play (highest impact).**
   Every command does `structuredClone` of the whole `StoredMatch`
   (`MemoryBackend.save`). At ~250 commands/match this is O(commands²)
   work and explains the 2,845 ms/game figure. Fixes, in order of value:
   append-only command arrays without cloning, periodic snapshots, and the
   `PostgresBackend` (which writes only the new row inside a transaction).

2. **FileBackend rewrites the entire record per command.** Same
   O(commands²) write pattern, on disk. It is a durability stand-in for local
   development, not a production store.

3. **Replay is O(commands) on every cache miss.** Snapshots exist
   (`SNAPSHOT_EVERY_COMMANDS = 25`) but are not yet *used* to shorten rebuilds —
   `rebuild()` always replays from `initial`. Implementing
   "latest snapshot + tail replay" is the single biggest available win, and it
   is also required for the Postgres path at scale.

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

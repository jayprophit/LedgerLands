# Matchmaking

Canonical description of the queue. Implements `packages/matchmaking`.

## Modules

| File | Responsibility |
|---|---|
| `service.ts` | pure in-process pairing logic (unchanged from the first pass) |
| `store-types.ts` | `MatchmakingStore` contract + `QueueRow` |
| `store.ts` | `MemoryMatchmakingStore`, `PostgresMatchmakingStore` |
| `durable.ts` | `DurableMatchmakingService` — grouping, claiming, recovery |

## Division of responsibility

**PostgreSQL is the durable source of truth** for queue intent, reservations, and
match assignments. It is sufficient for correctness on its own.

**Redis is optional and not required.** It would only ever be a fast
ephemeral coordination layer (presence, leases, worker wakeups). Nothing in this
package treats Redis as authoritative, and local development needs no
infrastructure at all.

## Explicit states

Never a set of booleans — one mutually exclusive `status`:

```
QUEUED     waiting for an opponent
RESERVED   a worker claimed this group and is creating the match
MATCHED    an authoritative match exists (matchId is set)
CANCELLED  the player left, or the entry was withdrawn
EXPIRED    the reservation lease elapsed before finalization
```

`reservationId` is **kept** on a finalized `MATCHED` row: it is the group
identifier that links queue entries to the created match, which is what recovery,
audit and dispute review need. Only the lease is cleared on finalize.

## Flow

```
join (idempotent)
  → tick
      sweep expired reservations          (crash recovery)
      per queue: read candidate snapshot
                 group into groups (2 for 1v1, 4 for FFA_4)
                 claimReservations (compare-and-set)
                 create authoritative match via MatchStore
                 finalizeReservation → MATCHED   (or release → QUEUED on failure)
```

`joinedAt` is persisted, so skill-band expansion survives a restart — a
player's accumulated wait is never reset by a process bounce.

## Multi-worker safety

Strategy: **optimistic compare-and-set on status + version**, not row locks.

A worker claims a candidate group with a single conditional update:

```sql
UPDATE mm_queue_entry
   SET status = 'RESERVED',
       reservation_id = $1,
       reservation_expires_at = $2,
       version = version + 1
 WHERE entry_id = ANY($3)
   AND status = 'QUEUED'
   AND version = ANY($4)
```

The claim is **all-or-nothing**: if the number of updated rows differs from the
group size, the worker lost a race and skips the group entirely. It never
finalizes a torn group, so a player can never be half-assigned.

A second racing worker sees `status != 'QUEUED'` (or a moved `version`), updates
zero rows, and moves on. Exactly one worker wins. No advisory locks, no
`SELECT ... FOR UPDATE`, no distributed lock service.

### Crash recovery

The claim sets a lease (`reservationExpiresAt`). If the worker dies before
finalizing, the entries stay `RESERVED` until the lease elapses; the next
`tick` sweeps them to `EXPIRED` and the affected players can rejoin cleanly. This
is the "recoverable, never stranded" property.

## Skill bands

Configurable (`SkillBandConfig`), preserved from the first pass:

```
effectiveDelta = min(maxDelta, initialDelta + waitedSeconds * expandPerSecond)
compatible     = |ratingA - ratingB| <= min(delta(A), delta(B))
```

Enforced only for `RANKED_1V1`; casual queues pair anyone.

## Match creation handoff

`tick` takes a `MatchFactory` callback and is the only thing that creates a
match. The API wires it to `PersistentMatchStore.create/join/start`, so
matchmaking produces **ordinary authoritative matches** — there is no separate
matchmaking game engine and no alternate match representation.

## FFA_4

Groups of four are claimed atomically. A fifth player stays `QUEUED` and is
never partially assigned; the incomplete candidate group is discarded rather
than matched short.

## Known gaps

- `PostgresMatchmakingStore` is unit-tested against an SQL fake that enforces the
  same CAS guarantees; **live PostgreSQL is not verified** in this environment.
- No Redis coordination layer (deliberate).
- Pairing is O(n²) within a queue; fine for hundreds, needs rating-bucket
  indexing in the thousands.
- No `TEAM_2V2` queue: team economics are undefined (see `docs/DESIGN/TEAM_2V2.md`).

# Replay / Dispute system

Every match stores a command log and emits a revisioned event stream. The
replay export (`GET /api/matches/:id/replay`) bundles both.

## What the export contains

| Field | Meaning |
|---|---|
| `rulesetVersion` | Ruleset in force (`classic-v1` …). Matches never reinterpret mid-flight. |
| `boardVersion` | Board data version (`classic-v1-board-1`). |
| `matchId`, `seed` | Match identity and the RNG seed the whole match derives from. |
| `players` | Seat list with ids/names. |
| `commands` | Every accepted command in order, with `commandId`, actor and result revision. |
| `events` | The full server event stream with `atRevision`. |
| `finalState` | Reconstructed final state. |
| `settlement` | Winner plus per-player final balances. |
| `chainHash` | SHA-256 hash chain over the events (see below). |

## What the chain hash guarantees — and what it does not

The chain hash is computed as:

```
prev = "GENESIS"
for each event in order:
    prev = sha256(prev + JSON(event))
chainHash = prev
```

This gives **tamper evidence**: if any stored event is altered, removed, or
reordered, the recomputed hash no longer matches the recorded one.

It explicitly does **not** prove:

- that the original server computed those events correctly,
- that the events are free of engine bugs,
- that no collusion or fraud occurred,
- who produced the log (there is no signature key on the export).

`match-store` stores `resultRevision` per command and `version` per snapshot so
a verifier can replay `initial + commands` and compare both the final state and
the hash. An independent auditor with the same ruleset version can therefore
reproduce the match — but "reproducible" is a stronger claim than
"hash-consistent", and only the former is meaningful for disputes.

## Independent verification

```
seed + rulesetVersion + boardVersion + commands
  → replayCommands()  → state
  → compare with finalState, events, chainHash
```

`packages/match-store/test/postgres.test.ts` asserts exactly this
(full replay == snapshot-and-tail), and the rebuild tests in
`packages/match-store/test/store.test.ts` assert state equality after a
simulated process restart.

## Current gaps (honest list)

1. **No server signature.** `chainHash` is unkeyed. A production design signs
   the export with a per-match key so a verifier can attribute the log to a
   server instance.
2. **Snapshots are stored but not used to shorten replay** (see
   `docs/PERFORMANCE.md` risk 3).
3. **No dispute workflow** (claim, review, resolution, admin audit trail) —
   the Prisma `AuditLog` model exists but the service does not.
4. **Command actor is recorded, not authenticated at export time**; the
   dev auth adapter is explicitly not an authorization boundary.

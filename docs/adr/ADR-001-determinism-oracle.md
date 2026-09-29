# ADR-001: Determinism oracle before the performance refactor

- **Status:** accepted (shipped)
- **Date:** 2026-09-29
- **Affects:** `packages/game-engine/test/oracle/`, `packages/game-engine/src/clone.ts`

## Context

Profiling showed that ~99.1% of match time was `structuredClone` in
`applyCommand`, growing linearly with the event-log length, so a match was
O(n²) in commands. The obvious fix — stop deep-copying the log on every command —
is a change to the core of a deterministic, replay-verified engine.

Without a way to prove equivalence, that refactor is a coin flip.

## Decision

Build the equivalence proof *first*, as a permanent artefact rather than a
one-off script.

1. **Canonical fingerprint** (`oracle/canonical.ts`) over the authoritative
   projection: balances, positions, ownership, development, mortgages, jail,
   bankruptcy, RNG state, deck cursor, turn order, winner, and the event stream
   in order. Key order normalised. The historical log is hashed separately and
   excluded from the state projection, so moving the log is not a rules change.
2. **Invariants** (`oracle/invariants.ts`) as an independent guard. A hash proves
   two runs agree; it does not prove either was *correct*. Two implementations
   can be wrong identically.
3. **A fixture corpus** (`oracle/fixtures.ts`, 19 fixtures) covering every
   mechanic, each declaring the event types it must produce so a fixture cannot
   silently stop testing what it exists for.
4. **Golden fingerprints** (`oracle/golden.json`), regenerated only by
   `npm run oracle:capture`, which refuses to run if any invariant fails.
   `npm run oracle:check` runs in `npm run verify`.
5. **Differential execution** (`test/clone-equivalence.test.ts`) as the primary
   proof for the refactor itself: the same step list is replayed through the old
   `structuredClone` cloner and the new targeted cloner, and the resulting states
   must be identical field for field.

## Why differential execution rather than golden hashes

Golden hashes alone could not distinguish "equivalent" from "different but not yet
noticed", and would go stale the moment a field was added to `MatchState`. The
differential test compares two live implementations directly, so it names the
field that diverged. The goldens then guard against future drift.

## Alternatives rejected

- **Snapshot tests of the state object.** Brittle to any field addition, and
  cannot express "these two implementations agree".
- **Property-based fuzzing alone.** Useful, but the properties it would assert
  are the invariants, and they do not pin *this* engine's behaviour. Kept as a
  possible later addition.
- **Refactor first, verify with the existing suite.** The existing suite passed
  while the Postgres snapshot bug was live, which is the whole argument against
  this order.

## Consequences

- The refactor is provable. 20× faster, all 19 goldens unchanged, differential
  equivalence on every fixture.
- Individual play is bit-for-bit identical: the goldens were captured before the
  change and still match, including after TEAM_2V2 was added.
- Test cost is real: the game-engine suite went from 27 to 201 tests and takes
  noticeably longer. Accepted.
- The corpus is now a dependency for future engine work, not just for
  performance work — which is the correct level for it to sit at.

## What the oracle found before it was used

Three harness bugs that would each have made it lie, all recorded in the commit
history because they are the most useful part of the decision:

- An invariant I wrote claimed a colour group may have only one owner. False —
  players legitimately own different tiles in a group. It failed on almost every
  fixture, which is how it surfaced.
- `seekTile` read the first `PLAYER_MOVED` in the whole log rather than the one
  the probed command appended, so every candidate start appeared to land on the
  same tile and two fixtures were silently testing nothing.
- A step-replay used `Object.assign`, which cannot delete the keys
  `applyCommand` removes, making a correct engine look non-deterministic.

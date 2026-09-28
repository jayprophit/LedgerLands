# ADR-0001 — Deterministic engine as source of truth

Date: 2026-09-28 · Status: Accepted

## Context

Gameplay must run identically in browser, server, AI simulations, and tests,
without depending on React, DB, or chain SDKs.

## Decision

`packages/game-engine` is pure TypeScript: commands in, validated state +
revisioned events out. Randomness flows through `rngState` (seeded Xorshift;
secure/verifiable adapters at the boundary, never `Math.random` for value).
Board and economy live in versioned data (`classic-v1`, 40 tiles).

## Consequences

- Replay = `seed + command list`; disputes investigated from the event log.
- AI, API, and UI all consume the same command interface; the server is
  authoritative.
- Chain settlement, if ever enabled, only touches escrow/payout boundaries.

# ADR-0002 — Double-entry practice ledger

Date: 2026-09-28 · Status: Accepted

## Context

Single `balance` fields cannot explain where money came from or prove
conservation.

## Decision

`packages/ledger` posts balanced debit/credit legs with idempotency keys;
balances derive from postings; `verifyInvariant()` enforces positivity and
cross-account legs.

## Consequences

- Every emission needs a funded source account; farming loops show up as
  unbalanced pressure in simulations.
- Migration path: API faucet stays single-sided for dev; settlement moves to
  the journal before any testnet value.

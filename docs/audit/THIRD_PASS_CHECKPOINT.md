# Third-pass continuation — checkpoint record

Date: 2026-09-28 · Inherited: `main @ 450946a` (clean) · This pass commits on top.

## Directive reconciliation

`ledgerlands2.txt` matches the existing inherited spec; it adds a **third-pass
priority order**, DB-concurrency/idempotency requirements, a dev-auth
requirement, matchmaking, Playwright, advisory triage, tournament byes, and a
marketplace sandbox. No previously verified milestone was restarted.

## Test baseline movement

| Suite | Before | After |
|---|---|---|
| engine | 27 | 27 |
| match-store | 6 | 12 (+1 skipped: live-PG gate) |
| api | 7 | 10 |
| ranked | 4 | 4 |
| tournaments | 3 | 15 (byes suite +1) |
| ledger | 3 | 3 |
| ai | 3 | 3 |
| auth (new) | — | 3 |
| matchmaking (new) | — | 5 |
| marketplace (new) | — | 3 |
| **total** | **53** | **85 (+1 skipped)** |

Behavior change with replacement coverage: tournaments no longer require
power-of-two entries. The old `lock` rejection test was replaced by
`supports odd entry counts via byes and refunds on cancel` plus a 9-case
parameterized bracket suite in `packages/tournaments/test/byes.test.ts`.

## Database status

**BLOCKED (live)**: no PostgreSQL service is reachable (port 5432 closed, no
local service, Docker daemon unresponsive). `PostgresBackend` is
IMPLEMENTED and unit-tested against a constraint-faithful fake Prisma client
(unique `(matchId, seq)` and `(matchId, commandId)` enforced, P2002 mapped to
`ConcurrencyError`). **Not** claimed as live-verified. Enabling it:

```bash
# 1) start a database (docker compose up -d postgres, or any local PG)
# 2) install the client runtime:  npm i -D @prisma/client
# 3) migrate:                      npm run db:push
# 4) run:                          DATABASE_URL=postgresql://... npm test
# 5) run the API against it:       DATABASE_URL=... npm run dev
```

`apps/api/src/prisma.ts` selects Postgres > file > memory and always boots.

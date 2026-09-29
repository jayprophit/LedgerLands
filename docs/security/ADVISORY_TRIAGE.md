# Security — advisory triage (LL-P11)

Date: 2026-09-28 · Method: `npm audit` and `npm audit --omit=dev` against the
committed lockfile.

## Result

- `npm audit --omit=dev` (production tree): **0 vulnerabilities**.
- `npm audit` (full tree): **4 high**, all in the Prisma dev toolchain.
- The previous "4 high" count is therefore *not* a runtime exposure.

## Per-advisory record

| # | Package | Installed | Advisory | Chain | Prod/Dev | Reachable | Patched in | Action | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `deepmerge-ts` | <8.0.0 | GHSA-ggr8-5vv4-36mx (stack exhaustion merging recursive graphs) | `prisma` → `@prisma/config` → `deepmerge-ts` | dev | **no** — only loaded by the Prisma CLI/config at build or migration time; never imported by `apps/api` or `apps/web` runtime | `deepmerge-ts@8` (only via a Prisma major) | keep pinned; do not force-upgrade | NOT_REACHABLE |
| 2 | `mysql2` | <=3.23.0 | GHSA-3f6p-5ww8-9rcr (auth-plugin downgrade leaks plaintext) | `prisma` → `mysql2` | dev | **no** — project uses **PostgreSQL**; no MySQL datasource exists in `prisma/schema.prisma` | `mysql2>3.23.0` (only via a Prisma major) | keep pinned | NOT_REACHABLE |
| 3 | `mysql2` | <=3.23.0 | GHSA-rgwj-5xj2-c3m3 (unbounded zlib inflate → decompression-bomb DoS) | same as #2 | dev | **no** — no MySQL code path | same as #2 | keep pinned | NOT_REACHABLE |
| 4 | `mysql2` | <=3.23.0 | (same advisory chain, second install path counted by npm) | same as #2 | dev | **no** | same as #2 | keep pinned | NOT_REACHABLE |

`fastify` and `ws` were re-checked: both are patched in the installed versions
(5.12.5 / 8.21.3) and contribute no open advisory.

## Policy

- **No `npm audit fix --force`.** It would downgrade/upgrade Prisma across a
  major and change generated client behavior. The directive forbids forced
  breaking upgrades without evidence.
- Re-triage on any lockfile change: `npm audit --omit=dev` then `npm audit`.
- If a MySQL datasource is ever added, #2–#4 become reachable and Prisma must
  be upgraded to a release pulling `mysql2>3.23.0` **before** that datasource
  ships.

## Real-value posture (unchanged)

`REAL_MONEY=false`, `WITHDRAWALS=false`. No wallet keys, no signing material, no
custody code. Play-money only. See `docs/compliance/REAL_VALUE_READINESS.md`.

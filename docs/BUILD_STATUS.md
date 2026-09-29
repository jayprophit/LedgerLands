# Build Status

Updated: 2026-09-28 (second pass) · Branch: `main` · Repo: LedgerLands Aetherius app.

## Legend

NOT_STARTED · IN_PROGRESS · IMPLEMENTED · TESTED · VERIFIED

VERIFIED = implementation + typecheck + lint-ish + tests + build + run/smoke.

## P00 Repository audit

- Audit doc + quick fixes (engine test phase, vitest passWithNoTests): VERIFIED

## P01 Monorepo / tooling

- Workspaces, TS strict, Vite/React/Fastify/Prisma, Docker/CI: VERIFIED
  (`npm run typecheck` PASS, `npm run build` PASS incl. Vite, `prisma generate` PASS)

## P02–P18 Engine / ledger

- 40-tile `classic-v1` board, versioned rules (200 / 200-or-10% / 75 / 50): VERIFIED
- Seeded + secure + sequence RNG abstractions: IMPLEMENTED
- Commands: buy/decline/auction(bid/pass/complete)/develop/mortgage/unmortgage/
  trade(p/a/r/c)/jail(fine/card)/surrender/end-turn: VERIFIED
- Rent (monopoly ×2, transit ×count, service ×count, mortgaged = 0): TESTED (27/27 engine tests)
- Original 12-card Signal deck, deterministic draws: TESTED
- Creditor-aware bankruptcy, last-solvent-wins, replay helper: TESTED
- Double-entry ledger package + invariant + idempotency: TESTED (3/3)
- `node scripts/engine-smoke.mjs`: PASS · `node scripts/simulate.mjs 100 1`: 100/100 completed

## P19 AI + simulator

- Heuristic BEGINNER…EXPERT via public commands: TESTED (3/3)
- Server bot loop uses game-ai: IMPLEMENTED
- Headless simulator + economy aggregates: VERIFIED (see `docs/ECONOMY.md`)

## P21–P27 Web MVP

- Launch → profile → token → difficulty → solo match → full controls (roll/buy/
  decline/auction/develop/mortgage/trade/jail/surrender) → settlement → wallet/
  ledger log → quests → inventory → shop → restart: IMPLEMENTED
- Board UI 40 tiles, responsive, ARIA labels: IMPLEMENTED
- 8 original tokens, rarity colors, earn-only enforcement: IMPLEMENTED
- Rotating daily shop, login rewards (50–1000), starter grant: IMPLEMENTED
- Production build: PASS. Browser E2E (Playwright): NOT_STARTED (known gap)

## P28–P31 API / multiplayer / ranked / tournaments

- Authoritative commands, LOBBY→ACTIVE→COMPLETED, join/start, WS broadcast +
  heartbeat/resubscribe, commandId idempotency, expectedRevision 412: IMPLEMENTED
- `GET /health` + `/api/v1/health`, board version endpoints: VERIFIED (live smoke PASS)
- `POST /api/matches/:id/command` + `node scripts/smoke.mjs`: VERIFIED
- 1v1/FFA lobbies (join/start, 2–4 players): IMPLEMENTED (persistence-backed
  store still IN_PROGRESS — currently in-memory)
- Ranked/tournaments: schema + feature flags only (Prisma models present):
  NOT_STARTED for service logic

## P32–P33 Blockchain abstraction

- Asset/wallet/settlement/NFT/randomness/swap interfaces + simulated adapters: IMPLEMENTED
- FUN treated as external disabled reference (no counterfeit token): IMPLEMENTED
- `DEFAULT_FEATURE_FLAGS` (`REAL_MONEY=false`, `WITHDRAWALS=false`): IMPLEMENTED
- Testnet contracts: NOT_STARTED (correctly gated behind LL-P1…LL-P10)

## P34–P36 Hardening / E2E / release

- Threat model + readiness docs: IMPLEMENTED
- Rate limiting/headers/auth hardening, dep triage (4 high advisories), E2E: NOT_STARTED
- Release zip: IN_PROGRESS

## Second pass (ledgerlands1.txt ingest — spec identical, no deltas)

- `packages/match-store`: pluggable backends (memory + file JSONL, atomic writes),
  deterministic rebuild from command log, snapshots, idempotent commandIds,
  expectedRevision guards, resume tokens, events-since sync, lobby-timeout sweep,
  hash-chained replay export: TESTED (6/6)
- API rewired onto persistent store; new endpoints: events, replay, resume,
  ranked report/leaderboard, tournament CRUD + bracket results: TESTED (7/7 API tests)
- `packages/ranked` (Elo, placement window, tiers, leaderboard): TESTED (4/4)
- `packages/tournaments` (single-elim, power-of-2 guard, idempotent entry/payout/refund): TESTED (3/3)
- Web: property-swap trade picker, replay/dispute panel, ranked + tournament tabs: IMPLEMENTED
- Totals: **53/53 tests PASS** · `npm run verify` PASS · live smoke PASS · sim 50/50 PASS
- Docker daemon unresponsive here → Postgres wiring stays a documented LL-P2 remainder
  (Prisma schema is the production target; file backend proves the event-sourced design).

## Third pass (ledgerlands2.txt)

| Requirement | Implementation | Tests |
|---|---|---|
| LL-P2b PostgresBackend | `packages/match-store/src/postgres.ts` + Prisma models (`MatchCommand`, `MatchSnapshot` v1, `MatchCorrection`, `Match.initialState/botDifficulty/solo`); transaction-guarded append, `P2002 → ConcurrencyError`, id 409 | 7 unit (constraint-faithful fake) · **live PG: BLOCKED** |
| Store API async | `StorageBackend` now promise-based (postgres parity) | covered by store suite |
| LL-P4 DevAuth | `packages/auth` — HMAC dev sessions, `AuthPrincipal`, step-up refusal | 3/3 |
| LL-P5 Matchmaking | `packages/matchmaking` — CASUAL_1V1/RANKED_1V1/FFA_4, expanding skill bands, reservations, stale sweep, self-match/duplicate guards | 5/5 |
| LL-P10 Playwright E2E | `playwright.config.ts` + `tests/e2e/flows.spec.ts` — solo→settlement→wallet, replay across reload, ranked/tournament routing | **3/3 e2e PASS** |
| LL-P11 Advisory triage | `docs/security/ADVISORY_TRIAGE.md` — all 4 highs are dev-only Prisma chain; `npm audit --omit=dev` = **0** | n/a |
| LL-P12 Tournament byes | single-elim supports any count ≥2; bye matches flagged, explicit `targetMatchId` advancement | 11/11 (3,4,5,6,7,8,9,16 + payouts) |
| LL-P13 Double elim | winners bracket + on-demand losers ladder + grand final; only grand final crowns | 6/6 + API integration |
| LL-P15 Marketplace sandbox | `packages/marketplace` — LIST/CANCEL/BUY, escrow-routed atomic legs, idempotency, compensation | 3/3 + API integration |
| LL-P16 Perf | `scripts/bench.mjs` + `docs/PERFORMANCE.md` | 8 probes recorded |

Totals: **160 tests PASS** (1 skipped: live-PG gate) + **3/3 E2E**.
Breakdown: engine 27 · match-store 40 · tournaments 36 · matchmaking 15 · api 15 ·
ranked 4 · ledger 3 · ai 3 · auth 3 · marketplace 3.

### LL-P17 performance (applied this pass)

- `rebuild()` now does a **header-only read** plus a **suffix read**
  (`StorageBackend.readCommandsAfter`) instead of selecting the full command log.
  Validation is strict (gap-free, complete, `seq <= total`, exact tail length);
  any rejection falls back to full replay, so it can only be faster, never wrong.
  `store.lastRebuild.path` makes the path observable. Measured on a 429-command
  match: full replay 615 ms → suffix rebuild 19–24 ms.
- `MemoryBackend.save` no longer deep-clones the record per command
  (reads still clone). Match play 142 s → 93 s for 50 games.

## Fourth pass (ledgerlands3.txt)

| Requirement | Implementation | Tests |
|---|---|---|
| LL-P17b suffix reads | `loadHeader` + `readCommandsAfter` on the storage contract; `MatchSnapshot.seq` + index; all three backends | 23/23 match-store (+10 suffix suite) |
| LL-P6 durable matchmaking | `store-types`/`store`/`durable`: explicit QUEUED/RESERVED/MATCHED/CANCELLED/EXPIRED, CAS group claims, lease recovery, Postgres CAS contract, `MatchmakingEntry` model | 15/15 matchmaking (+10), 14/14 API (+2) |
| Swiss format | `formats.ts` — configurable rounds/points, standings order (points → Buchholz → wins → seed), bye history, repeat avoidance, controlled float | 15 new format tests |
| Round-robin format | circle method, odd-field bye placeholder, round-completion gating, deterministic standings | included above |
| Signed replay manifests | `ReplaySigner` (Ed25519 / HMAC-dev / unsigned), content-addressed `manifestHash` excluding `issuedAt`, key-id and tamper rejection | 17 new tests |
| Dispute workflow | `DisputeService` — OPEN/UNDER_REVIEW/RESOLVED/REJECTED/CANCELLED, filed hashes, append-only history, `revalidate()`, duplicate-claim rejection | included above + 1 API test |

## Known issues (current)

1. **Live PostgreSQL verification BLOCKED** — no service reachable here.
   `PostgresBackend` is unit-tested against a constraint-faithful fake; enabling
   the real path is documented in `docs/audit/THIRD_PASS_CHECKPOINT.md`.
2. **Postgres partial I/O is unproven** — the indexed range query is
   implemented and unit-tested against a query-recording fake, but no live DB
   has run it. Confirm with `EXPLAIN` when one is available.
3. **FileBackend still has no partial physical I/O** (single JSON document per
   match). Logical suffix selection only; a segmented format needs versioning +
   migration, so compatibility was kept. See `docs/PERSISTENCE.md`.
4. **Per-command cost remains ~1.9 s/game locally**, dominated by the engine's
   pure `applyCommand` clone + bot decisioning. The `PostgresBackend` avoids
   the store-side cost by writing one row per command.
4. Replay export is **tamper-evident, not signed**; no dispute workflow
   service yet (`docs/REPLAY.md`).
5. Matchmaking is O(n²) in queue length; fine for hundreds, not thousands.
6. Marketplace offers/bids/bundles, non-dev auth providers, admin identity for
   disputes, and 2v2 team economics remain NOT_STARTED. Dispute resolution is
   simulated (role string, no identity provider) and signing is off by default.
7. `npm audit`: 0 production advisories; 4 high dev-only (documented, not
   force-fixed by policy).

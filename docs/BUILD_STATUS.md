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

Totals: **413 tests PASS** (2 skipped) + **3/3 E2E**.
Breakdown: game-engine 201 · match-store 68 · tournaments 36 · marketplace 21 ·
matchmaking 27 · auth 19 · api 16 · blockchain 10 · ranked 9 · ledger 3 ·
game-ai 3.

Reproduce with `node scripts/test-totals.mjs` (it runs each workspace suite and
sums the vitest summaries). Earlier reports of "178" and "206" were miscounts
against their own breakdowns; the numbers above are the machine-read total.

Skipped: the `DATABASE_URL` live-Postgres race (no server here) and the
oracle-capture rewrite mode (only runs under `ORACLE_CAPTURE=1`).

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
| Marketplace offers | buyer-initiated, asset-locking, party-restricted lifecycle, revalidated at accept | 18 new marketplace tests |
| Marketplace auctions | min increments, injected server clock, late bid still settleable, cancel is terminal | included above |
| Marketplace bundles | all-or-nothing: pre-flight validation, transfer only after all legs | included above |
| Auth hardening | `AuthService` (anti-replay session counters), `MfaService`, `ProductionGuard` (fails loud on dev-in-production), inert/mock adapters for the future provider set, server-side step-up endpoint | 19 auth tests (+16), 16 API tests (+1) |
| Postgres verified on a real engine | PGlite (PostgreSQL/WASM) harness running the backend contract against real DDL, real constraints, real planner; fixed a suffix off-by-one that forced full replay (ADR-002) | 12 match-store tests (+12) |
| Snapshot boundary regression | every snapshot position, per-backend `afterSeq` semantics, and the memory/file asymmetry documented rather than assumed away (ADR-002) | 16 match-store tests (+16) |

## Fifth pass (ledgerlands4.txt)

Owner priority: networked Postgres → concurrency/recovery verification → engine
determinism → safe clone/log performance → 2v2. Postgres was unavailable, so the
blocker is recorded and the independent work proceeded.

| Requirement | Implementation | Tests |
|---|---|---|
| Determinism oracle | `test/oracle/` — canonical fingerprint, 20 independent invariants, 19 mechanics fixtures, golden fingerprints checked by `npm run verify` (ADR-001) | game-engine 27 → 144 |
| State/history separation | `clone.ts` copies only mutable containers; log shared by pointer; no rule reads the log (verified by grep) | 23 differential-equivalence tests |
| Clone perf | 20× on a full batch; per-command cost now flat in log length instead of linear | measured, see `docs/PERFORMANCE.md` |
| TEAM_2V2 rules D1–D5 | `teams.ts` + `team-v1`: teammate rent exempt (recorded), individual bankruptcy, last solvent team wins, individual auctions/trades, full starting balance | 34 matrix tests |
| Alternating-team seating | `seatAlternatingTeams` + `validateTeams`; seat order is authoritative state | included above |
| Restore robustness | `normalizeSeat` — a bankrupt seat or a dead match no longer wedges a recovered match | included above |
| 2v2 matchmaking | `TEAM_2V2` in the supported set and tick loop; `formTwoVTwoTeams`; `MatchFactory` receives `teams` | matchmaking 15 → 27 |
| 2v2 ranked ingestion | team win → four individual results; no shared pool; eliminated players keep a blank rating | ranked 4 → 9 |
| 2v2 simulation baseline | `scripts/simulate-teams.mjs`, 200 paired games per mode, FFA_4 vs TEAM_2V2 | see `docs/simulation/` |
| 2v2 economy experiment | `scripts/team-economy.mjs` + `scripts/lib/sim-driver.mjs`, 1000 paired games per arm, degenerate-strategy probes, AI-command integrity counter | see `docs/analysis/TEAM_2V2_ECONOMY.md` |
| Suffix fast path | all three backends select on the storage sequence; a valid suffix is no longer rejected as corrupt | match-store 67 → 69 |

## Known issues (current)

1. **`NETWORKED_POSTGRES_BLOCKED`** — no server in this environment (ports
   5432/5433/5434/15432 closed, no Postgres service, Docker daemon down,
   `DATABASE_URL` unset). `POSTGRES_SEMANTICS_VERIFIED_PGLITE` is what we can
   honestly claim: schema validity, `jsonb` storage, both unique constraints,
   transactional rollback, and an `EXPLAIN` proving the suffix range query uses
   `MatchCommand_matchId_seq_idx`. PGlite is single-connection and serializes
   transactions, so **concurrent-writer interleaving is still unverified** — that
   is the one thing the `DATABASE_URL` test exists to close. See ADR-002.
2. **Postgres partial I/O is measured, not assumed** — 23.3 ms for a 500-row
   suffix vs 143.1 ms for a 5,000-row full read, on 25,000 rows, with the
   planner choosing a bitmap index scan. Reproduce with
   `node scripts/bench-postgres.mjs`.
3. **FileBackend still has no partial physical I/O** (single JSON document per
   match). Logical suffix selection only; a segmented format needs versioning +
   migration, so compatibility was kept. See `docs/PERSISTENCE.md`.
4. **The O(n²) clone is fixed, not mitigated** — 20× on a full batch, and
   per-command cost is now flat in log length. Equivalence is proved by
   differential execution plus 19 unchanged goldens (ADR-001). Remaining engine
   cost is the rules themselves: `applyCommand` is 78.6% of match time and AI
   decisioning is 17.5%. See `docs/PERFORMANCE.md`.
5. Replay signing and the dispute workflow are **implemented but inert by
   default** (`docs/REPLAY.md`): the dispute service is simulated and
   `DisputeService` has no real admin identity provider behind it.
6. Matchmaking is O(n²) in queue length; fine for hundreds, not thousands.
7. Auth is architecture only: no real provider integration, no password storage,
   no KYC/age verification, and no TOTP/WebAuthn verification ceremony. Dispute
   resolution remains simulated (role string, no identity provider) and replay
   signing is off by default.
8. **2v2 is implemented and now exercised by simulation, but not balanced**: over
   1000 paired games the bots trade (8,474 proposals, 83% accepted, 6,250 teammate
   trades) and bid (20,645 auctions, 4.43 bids each), so D4's teammate-trade and
   teammate-auction decisions no longer rest on unit tests alone. What the data
   shows is that teammate cooperation is NOT degenerate in the monopoly sense —
   top-holder concentration falls from 0.988 (FFA) to 0.721 — but teammate auction
   rivalry destroys more sats (6.05M) than any other behaviour measured (2.35M for
   sacrificial trades), which is a rule question, not a bot one. There is still no
   party/duo queueing, no rating band for `TEAM_2V2`, and no tournament format for
   team rounds. See `docs/analysis/TEAM_2V2_ECONOMY.md` and
   `docs/DESIGN/TEAM_2V2.md`.
9. Marketplace state is in-memory; no listing/offer/auction persistence, and no
   anti-sniping extension on auctions.
10. `npm audit`: 0 production advisories; 4 high dev-only (documented, not
    force-fixed by policy).

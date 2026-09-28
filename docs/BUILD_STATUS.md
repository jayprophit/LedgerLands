# Build Status

Updated: 2026-09-28 · Branch: `main` · Repo: LedgerLands Aetherius app.

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

## Known issues

1. MatchStore is in-memory (no Postgres persistence yet); restart loses matches. Schema ready (LL-P2).
2. Trade UI covers sats-only propose; property-swap propose via TXT/API works in engine but needs UI picker.
3. No Playwright E2E yet; manual + smoke coverage only.
4. `npm audit`: 4 high advisories untriaged.
5. Web `select` styling minimal on some browsers; no reduced-motion toggle yet.

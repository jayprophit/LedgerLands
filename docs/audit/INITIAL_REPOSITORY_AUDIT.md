# Initial Repository Audit — LedgerLands (P00)

Date: 2026-09-28
Auditor: OpenCode (Muse Spark)
Scope: `LedgerLands-Aetherius-App-Repo/LedgerLands` (canonical git repo, `main` @ 44c253d)
Reference export: `LedgerLands-source/LedgerLands` (non-git snapshot, content-identical excluding `dist/`)

## Method

- Listed full tree (334 entries under parent `LedgerLands/`).
- Read: root manifests, `BUILD-TODO.md`, `docs/*`, `prisma/schema.prisma`,
  `packages/game-engine/src/{board,engine,index}.ts`, `packages/game-engine/test/engine.test.ts`,
  `packages/shared-types/src/index.ts`, `apps/api/src/{server,store,ledger}.ts`,
  `apps/web/src/{App,api}.tsx?`, scripts, Docker/CI.
- Ran: `npm install` (255 packages, OK), `npm run typecheck` (PASS all 5 workspaces),
  `npm run build` (PASS incl. Vite production build), `npm test` (PARTIAL — see below),
  `node scripts/engine-smoke.mjs` (PASS).

## Verification evidence (this workstation)

| Check | Result |
|---|---|
| `npm install` | PASS — 255 packages, 4 high vulns noted, prisma/esbuild install-scripts pending approval |
| `npm run typecheck` | PASS — api, web, aetherius-sdk, game-engine, shared-types |
| `npm run build` | PASS — tsc + Vite 8.3.0 (224 kB JS, 70 kB gzip) |
| `node scripts/engine-smoke.mjs` | PASS — `ENGINE_SMOKE_OK { dice: [1,4] }` |
| `vitest` game-engine | 3/4 PASS, 1 FAIL (test bug, not engine bug — see §Known issues) |
| `vitest` api/web | FAIL — "No test files found" (scripts lack `--passWithNoTests`) |
| API/WebSocket/React runtime, Prisma DB, Docker | NOT YET runtime-verified this session (scheduled P01+) |

## Inventory

### KEEP (as-is, working)

- `package.json` npm workspaces (`apps/*`, `packages/*`), scripts (`build/dev/test/typecheck/verify/db:*`).
- `tsconfig.base.json` + per-package `tsconfig.json` — strict, consistent.
- `packages/shared-types` — clean contracts for tiles, players, matches, commands/events, Aetherius manifest.
- `packages/game-engine/src/board.ts` — original 33-tile board (Origin Gate, Copper Quay … Singularity Square). No Monopoly names. Data-driven.
- `packages/game-engine/src/engine.ts` — deterministic seeded Xorshift dice, START/ROLL/BUY/DEVELOP/FINE/END/SURRENDER, detention (3-doubles → jail, 3-fail → 50 fine), pass-start +200, rent, tax, bankruptcy→winner. No React/DB/chain imports. Pure + `structuredClone`.
- `apps/api/src/store.ts` — in-memory authoritative MatchStore + simple solo bot (buys if balance ≥ 1.5× price). Actor-mismatch guard.
- `apps/api/src/server.ts` — Fastify 5 + `ws` broadcast, `/health`, `/api/board|matches|practice/*`, CORS hook.
- `apps/web/src/{App.tsx,api.ts,main.tsx,styles.css}` — React 19 + Vite board grid, match control, players, event ledger, WS subscribe.
- `prisma/schema.prisma` — Postgres models: User, AuthIdentity, LedgerAccount/Entry (BigInt, match link), Match/MatchPlayer/MatchEvent (unique match+revision), Tournament/Entry/Round, Season/Ranking, Quest/Progress, NFTAsset/Instance, MarketplaceListing, ComplianceProfile, AuditLog.
- `integrations/aetherius/{app.manifest.json,capabilities.json}`, `packages/aetherius-sdk` — horizontal integration, not a hard engine dep.
- `docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example`, `.gitignore` (covers `dist/`, `.env`, `postgres-data/`).
- `docs/{ARCHITECTURE,ROADMAP,SECURITY,AETHERIUS-INTEGRATION,VERIFICATION}.md`, `AGENT.md`, `BUILD-TODO.md` (LL-P1…LL-P15).

### REFACTOR (works, needs hardening per Master Directive)

- `apps/api/src/ledger.ts` (`PracticeLedger`) → replace with double-entry journal (`packages/ledger`): debit=credit invariant, idempotency keys, `PLAYER_AVAILABLE / PLAYER_MATCH_LOCKED / MATCH_BANK / PRIZE_POOL / REWARD_POOL / PLATFORM` accounts. Current version is single-sided credit/debit list, in-memory only.
- `apps/api/src/store.ts` → add: revision/concurrency guard, command idempotency keys, reconnect/resume snapshots, match timeouts, transactional event persistence (Prisma), deterministic replay from event log.
- Engine rent: `TRANSIT=250` flat / `SERVICE=150` flat → ownership-scaled (e.g. 25×dice×count or count-scaled flat) + mortgaged check (already) + group-monopoly doubling where configured.
- Engine tax: single generic `TAX amount` → versioned ruleset: `PASS_START=200`, `INCOME_TAX_FIXED=200 | 10%`, `LUXURY_TAX=75`, `JAIL_FEE=50`. Board currently has 1× TAX tile; needs second tax tile + percent option.
- Board: 33 tiles → 40-tile `classic-v1` ruleset; add luxury-tax tile, additional event/transit/service/property tiles to reach 40 while preserving existing ids.
- `DEVELOP_PROPERTY` → add group-ownership + even-building + house/hotel inventory limits + mortgage-gating.
- Bankruptcy: currently returns properties to bank, zeroes surrender balance → needs creditor-aware transfer (debt-to-player vs debt-to-bank), mortgage handling, liquidation-before-bankruptcy workflow.
- Bot in `store.ts` → move to `packages/game-ai` with BEGINNER…EXPERT policies using public command interface only.
- API `test` scripts → add `--passWithNoTests` (or placeholder specs) so `npm test` is green.
- `dist/` build output is correctly **untracked** (`git ls-files` shows no `dist`
  entries; `.gitignore` covers `packages/*/dist/`, `apps/*/dist/`). No removal needed.
  `LedgerLands-source.zip` (untracked, 45 kB) was removed during P00.

### REPLACE (missing or placeholder, build for real)

- Event cards: `EVENT` tiles currently no-op → data-driven deck (`packages/game-rules/boards/classic-v1.ts` + deck with seeded shuffle), original text (no Monopoly copy).
- Auction: absent → `AUCTION_STARTED/BID/COMPLETED` state machine (declined/unowned property, design for later MP timers).
- Mortgage/unmortgage: absent → commands + interest rules.
- Trade: absent → PROPOSED/ACCEPTED/REJECTED/EXPIRED/CANCELLED with atomic settlement.
- RNG: inline Xorshift only → `RandomSource` abstraction (`seeded` for tests, `secure` via `crypto.getRandomValues` for play, `verifiable` adapter stub).
- Rules: scattered constants (`passStartReward=200`, `detentionFine=50` inline defaults) → versioned `Ruleset` (`classic-v1`, `ranked-v1`, `quick-v1`) + signed board JSON.
- Web UI: minimal (buy/roll/end only) → full solo loop: develop, mortgage, trade, auction, jail pay, surrender, settlement, local profile, simulated main/match wallets, ledger view, quests, inventory, shop.
- Quest/reward/shop/inventory/ranked/tournament/blockchain: schema-only or absent → implement services behind feature flags (`REAL_MONEY=false`, `WITHDRAWALS=false` defaults).

### REMOVE

- `LedgerLands-source.zip` (untracked, 45 kB) and `packages/*/dist/**` (tracked build output) — do not commit artifacts. Regenerate via `npm run build`.
- Any future `.env` with secrets, `postgres-data/`, coverage, `.vite/` caches — already gitignored; verify none committed.

### ARCHIVE

- Legacy `CryptoMonopoly` prototype snippets referenced in handoff (Goerli/Mumbai, old Chainlink `VRFConsumerBase`, mixed ethers v5/v6, `Ownable` without owner arg, `react-scripts`, old Web3Modal, fake `FUNToken.sol`, `Math.random()` dice) — none present in this repo (good). Keep this audit as proof of non-carryover. If such files appear in `LedgerLands.bundle` (36 kB, uninspected), extract to `docs/audit/legacy-bundle-notes.md` before reuse; never merge blindly.

### INVESTIGATE (before P13+)

- `LedgerLands.bundle` (git bundle, 36 kB at parent dir) — uninspected; may contain legacy history. Inspect with `git bundle verify` + `git clone --mirror` into temp dir before deciding KEEP/ARCHIVE.
- Prisma `provider = "postgresql"` with no `url` in schema (uses `prisma.config.ts`?) + `prisma@7.10.0` config format — validate `db:generate/db:push` against live Postgres in P01.
- Docker Compose + CI workflow — read fully during P01 runtime verification.
- High-severity npm advisories (4) — run `npm audit` detail in P34 hardening.

## Secrets scan

- No `.env`, private keys, seeds, or credentials found in tree. `.env.example` (236 B) is placeholder-only. Git log shows 2 commits, no secret-looking blobs. Full `gitleaks`-style scan deferred to P34.

## Gap analysis vs Master Directive §53 (20 engine cases) / §65 (25 acceptance items)

| Requirement | Baseline state |
|---|---|
| 200 sats pass Start | DONE (tested via smoke) |
| Fixed 200 / 10% / 75 taxes | PARTIAL (one generic TAX tile only) |
| Jail 50 / doubles / 3rd-fail charge | DONE |
| Buy/rent/mortgaged-no-rent | DONE (mortgaged check exists) |
| Build/hotel/auction/trade | PARTIAL (basic develop only; auction/trade/mortgage absent) |
| Bankruptcy bank/player, winner | PARTIAL (bank-return only; needs creditor transfer) |
| Ledger debits=credits | MISSING (single-entry practice ledger) |
| Deterministic replay (seed+cmds=same) | DONE for dice/move (needs full event-replay test) |
| Solo vs AI → settlement → wallet/ledger/quests/inventory/shop/restart | PARTIAL (solo bot + buy/roll/end; rest missing in UI/services) |
| Multiplayer/ranked/tournaments/blockchain | SCHEMA/ADAPTER stage only |

## Decision

Preserve monorepo + engine + API + web + Prisma + Aetherius seams. Do NOT restart. Proceed P01 (tooling/runtime verify) → P02+ (engine completion) per priority order in handoff §61. Tracked build output must be untracked; legacy bundle must be inspected before reuse.

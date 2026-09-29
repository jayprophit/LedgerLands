# LedgerLands Build TODO

CONTINUOUS_BUILD_ACTIVE = YES
OVERALL_BUILD_COMPLETE = NO
CURRENT_ACTIVE_PHASE = LL-P6-MATCHMAKING-PERSISTENCE
CURRENT_ACTIVE_TODO = Durable/distributed matchmaking store behind the existing logic
NEXT_EXECUTABLE_TODO = LL-P6-MATCHMAKING-PERSISTENCE
LAST_VERIFIED_COMMIT = see git log (fourth pass: suffix reads, header reads, docs/PERSISTENCE.md)
LAST_REMOTE_VERIFIED_COMMIT = none

## LL-P1 — Foundation

- [x] Create independent LedgerLands repository structure.
- [x] Replace production-facing CryptoMonopoly name with original temporary brand LedgerLands.
- [x] Add Aetherius application manifest and permission profile.
- [x] Build shared TypeScript contracts.
- [x] Build deterministic seeded game-engine foundation.
- [x] Implement original board/rules data.
- [x] Implement property purchase/rent/development/detention/tax/bankruptcy/winner basics.
- [x] Add deterministic engine smoke test and compile verification.
- [x] Build Fastify server-authoritative API source.
- [x] Build WebSocket state-broadcast source.
- [x] Build simple strategic solo AI source.
- [x] Build React/Vite gameplay UI source.
- [x] Build practice ledger/faucet source.
- [x] Add PostgreSQL/Prisma schema.
- [x] Add Docker Compose and CI configuration.
- [x] Owner workstation: install npm dependencies successfully (255 packages, 2026-09-28).
- [x] Owner workstation: run full typecheck + tests + build (33/33 tests PASS, Vite build PASS).
- [x] Owner workstation: run API smoke test (SMOKE_OK, health with board/ruleset versions).
- [x] Expand engine to 40 tiles, auctions, mortgage, trades, cards, creditor bankruptcy (27 engine tests).
- [x] Add double-entry ledger package, game-ai difficulties, simulator, blockchain adapters, full web MVP.
- [ ] Create/push `jayprophit/LedgerLands`, verify remote SHA.

## LL-P2 — Persistent authoritative runtime

- [x] Add `PostgresBackend` (IMPLEMENTED + unit-tested; live PG verification BLOCKED — no service available).
- [x] Persist every match event (command log + snapshots, memory + file + postgres backends).
- [x] Rebuild match state deterministically from event log.
- [x] Add optimistic revision/concurrency protection (expectedRevision → 412; PG append guarded by unique `(matchId,seq)` + `P2002 → ConcurrencyError`).
- [x] Add idempotency keys for commands (unique `(matchId,commandId)`; crash-then-retry cannot duplicate).
- [x] Add reconnect/resume tokens and state snapshots (+ events-since sync).
- [x] Add match timeouts (lobby sweep) and surrender/disconnect rules.
- [x] Add persistence integration tests (rebuild, idempotency, stale-state, replay hash, snapshot-vs-full-replay).
- [x] Use stored snapshots to shorten rebuild (guarded; equal to full replay).
- [x] Range-oriented suffix reads (`readCommandsAfter`) + header-only reads on all backends
      (Postgres does a true indexed `seq >` query; File is logical-only by design).

## LL-P3 — Complete property-trading rules

- [x] Auction state machine for declined/unowned properties.
- [x] Mortgage/unmortgage rules.
- [x] Player-to-player trade offers/counteroffers/accept/reject.
- [x] Property-group ownership validation.
- [x] Even-building/development rules where configured.
- [x] House/hotel inventory and configurable development limits.
- [ ] Liquidation-before-bankruptcy workflow.
- [x] Creditor-aware bankruptcy settlement.
- [x] Data-driven event-card decks.
- [x] Transit/service ownership-scaled rent rules.
- [x] Ruleset versioning and signed board/rules configuration (hash-chained replay; signing keys pending).
- [x] Extensive deterministic simulations/fuzz/property tests (27 engine + simulator).

## LL-P4 — Accounts / Aetherius Identity

- [ ] Integrate Aetherius Identity/Profile when launched in Aetherius.
- [ ] Standalone development auth adapter.
- [ ] Session/device management.
- [ ] Passkey/WebAuthn/MFA interfaces.
- [ ] Profile, avatar/token selection and preferences.
- [ ] Policy-gate privileged operations through Aetherius RBAC/ABAC.

## LL-P5 — Practice economy

- [ ] Persistent double-entry ledger.
- [ ] Separate practice/promotional/locked/pending/escrow categories.
- [ ] Daily/weekly/seasonal quest service.
- [ ] Login rewards with configurable economy limits.
- [ ] Achievements, XP, levels and cosmetic unlocks.
- [ ] Economy source/sink dashboards.
- [ ] Abuse-resistant reward idempotency.

## LL-P6 — Ranked / matchmaking

- [x] Glicko-2/Elo-style configurable rating service (Elo + placement window, packages/ranked).
- [x] Ranked seasons (season-scoped ratings + leaderboard API + web tab).
- [ ] Matchmaking queue and skill bands.
- [ ] Anti-smurf/collusion signals.
- [x] Leaderboards and rank badges (tiers Bronze→Grandmaster).
- [x] Ranked fairness: no pay-to-win modifiers (ratings reflect results only; traits cosmetic).

## LL-P7 — Tournaments

- [x] DRAFT -> REGISTRATION -> LOCKED -> ACTIVE -> SETTLING -> COMPLETED state machine.
- [x] Cancel/refund/dispute terminal flows (idempotent refunds; DISPUTED on settle-cancel).
- [x] Single elimination.
- [x] Double elimination (winners bracket + on-demand losers ladder + grand final).
- [x] Byes for non-power-of-two entry counts.
- [x] Swiss (configurable rounds, points, deterministic tiebreaks, bye history, repeat avoidance).
- [x] Round robin (circle method, odd-field byes, no duplicate pairing per cycle).
- [x] Idempotent prize settlement using practice/test assets initially.
- [x] Tournament spectator and bracket UI (web tab; formats: single/double elimination).

## LL-P8 — Replay / spectator / analytics

- [x] Event-log replay API (events-since + hash-chained export).
- [x] Spectator subscriptions (WS subscribe + resync).
- [x] Match timeline UI (replay panel).
- [x] Dispute-review export (replay endpoint with settlement + chain hash).
- [ ] Privacy-preserving product analytics.
- [x] Economy and treasury simulation metrics (scripts/simulate.mjs).

## LL-P9 — Collectibles / marketplace sandbox

- [x] Original token/character asset system (8 originals).
- [x] Rarity/edition/origin metadata (data-driven tiers).
- [x] Inventory.
- [x] Rotating shop using non-withdrawable practice currency.
- [x] Player marketplace sandbox (`packages/marketplace`: LIST/CANCEL/BUY, escrow-routed
      double-entry settlement, idempotency, self-buy/funds/expiry/double-purchase guards).
- [x] Marketplace offers (asset-locking, party-restricted accept/reject/cancel/expiry).
- [x] Marketplace auctions (min increments, injected server time, late-bid still settleable).
- [x] Marketplace bundles (all-or-nothing, pre-flight validation before any leg).
- [x] Offers/auctions/trades (in-match auctions + trades).
- [x] Competitive-mode cosmetic-only enforcement.

## LL-P10 — Aetherius OS providers

- [ ] Register through real Aetherius Application Registry.
- [ ] Use Aetherius File/Storage provider for exports/replays/assets.
- [ ] Use Aetherius Settings/Config provider.
- [ ] Publish safe entities into Aetherius Search.
- [ ] Use Aetherius Notifications.
- [ ] Optional Genesis coach/explainer integration.
- [ ] Agent Bridge adapter for future wallet/external services.
- [ ] Aetherius launcher/install/update/uninstall lifecycle tests.
- [ ] Add LedgerLands to main ecosystem BUILD-TODO/P12 application integration track.

## LL-P11 — Original production visual/audio layer

- [ ] Original board artwork and responsive layout.
- [ ] Original characters/tokens.
- [ ] Dice, buildings, event cards, rank/rarity frames.
- [ ] Animation and audio system.
- [ ] Accessibility modes, reduced motion, color-blind support.
- [ ] Localization framework.

## LL-P12 — Desktop/mobile packaging

- [ ] Tauri desktop package.
- [ ] Aetherius-native launcher package/descriptor.
- [ ] PWA/offline shell where appropriate.
- [ ] Mobile client packaging after shared APIs stabilize.
- [ ] Auto-update/recovery integration through Aetherius where available.

## LL-P13 — Testnet blockchain / GameFi

- [ ] Keep disabled until LL-P1..LL-P10 are stable.
- [ ] Wallet adapter abstraction.
- [ ] Public testnet only initially.
- [ ] Original NFT contract.
- [ ] Tournament escrow contract.
- [ ] Reward distribution contract.
- [ ] Current provable-randomness adapter.
- [ ] Contract tests, fuzzing, pause/access control.
- [ ] No private keys in client/repo.

## LL-P14 — Compliance / security gates

- [x] Threat model (docs/security/THREAT_MODEL.md).
- [x] npm advisory triage (docs/security/ADVISORY_TRIAGE.md; 0 production advisories).
- [x] Dev authentication adapter with an explicit non-production boundary (`packages/auth`).
- [x] Auth composition: session records with anti-replay counters, MFA boundary, production guard
      that fails loud, and inert/mock adapters for the future provider set (docs/AUTH.md).
- [x] 2v2 team economics specified with open product decisions (docs/DESIGN/TEAM_2V2.md);
      implementation deliberately deferred until those are answered.
- [x] Postgres SQL verified against a real engine (PGlite): schema, jsonb, both unique
      constraints, rollback atomicity, and EXPLAIN-confirmed index use on the suffix read.
- [x] Snapshot suffix off-by-one fixed — it was silently forcing every Postgres rebuild
      down the full-replay path (docs/PERSISTENCE.md).
- [x] Replay tamper-evidence documented precisely (docs/REPLAY.md).
- [x] Optional replay signing via a pluggable `ReplaySigner`; off by default, no key committed.
- [x] Simulated dispute workflow bound to filed replay hashes (revalidate + audit trail).
- [ ] Rate limiting/anti-automation.
- [ ] Fraud/collusion detection.
- [ ] KYC/age/jurisdiction provider adapters if real-value features are pursued.
- [ ] Sanctions/transaction monitoring where required.
- [ ] Responsible-play/self-exclusion controls where applicable.
- [ ] Security audit and penetration tests.
- [ ] Legal review by launch jurisdiction.

## LL-P15 — Economy simulation / real-value decision gate

- [x] Headless economy simulator (`npm run simulate`, seeded, aggregate output).
- [x] Performance baseline + scaling risks (docs/PERFORMANCE.md).
- [ ] Multi-agent economy simulator with large virtual populations (10k+ games).
- [ ] Treasury solvency modelling.
- [ ] Reward inflation/sink analysis.
- [ ] Withdrawal-pressure modelling.
- [ ] Platform fee/revenue modelling.
- [ ] Only after evidence gates: decide whether any real-value beta proceeds.

## Continuation Rule

TASK COMPLETE != BUILD COMPLETE.

After every verified milestone: record -> commit -> push -> verify remote -> update TODO -> select next highest-priority unblocked task -> continue.

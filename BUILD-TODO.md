# LedgerLands Build TODO

CONTINUOUS_BUILD_ACTIVE = YES
OVERALL_BUILD_COMPLETE = NO
CURRENT_ACTIVE_PHASE = LL-P1-FOUNDATION
CURRENT_ACTIVE_TODO = Verify generated baseline on owner workstation with installed dependencies
NEXT_EXECUTABLE_TODO = LL-P2-PERSISTENCE
LAST_VERIFIED_COMMIT = pending-local-commit
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
- [ ] Owner workstation: install npm dependencies successfully.
- [ ] Owner workstation: run full `npm run verify`.
- [ ] Owner workstation: run API/web smoke test.
- [ ] Create/push `jayprophit/LedgerLands`, verify remote SHA.

## LL-P2 — Persistent authoritative runtime

- [ ] Replace in-memory MatchStore with PostgreSQL repository.
- [ ] Persist every match event transactionally.
- [ ] Rebuild match state deterministically from event log.
- [ ] Add optimistic revision/concurrency protection.
- [ ] Add idempotency keys for commands.
- [ ] Add reconnect/resume tokens and state snapshots.
- [ ] Add match timeouts and surrender/disconnect rules.
- [ ] Add persistence integration tests.

## LL-P3 — Complete property-trading rules

- [ ] Auction state machine for declined/unowned properties.
- [ ] Mortgage/unmortgage rules.
- [ ] Player-to-player trade offers/counteroffers/accept/reject.
- [ ] Property-group ownership validation.
- [ ] Even-building/development rules where configured.
- [ ] House/hotel inventory and configurable development limits.
- [ ] Liquidation-before-bankruptcy workflow.
- [ ] Creditor-aware bankruptcy settlement.
- [ ] Data-driven event-card decks.
- [ ] Transit/service ownership-scaled rent rules.
- [ ] Ruleset versioning and signed board/rules configuration.
- [ ] Extensive deterministic simulations/fuzz/property tests.

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

- [ ] Glicko-2/Elo-style configurable rating service.
- [ ] Ranked seasons.
- [ ] Matchmaking queue and skill bands.
- [ ] Anti-smurf/collusion signals.
- [ ] Leaderboards and rank badges.
- [ ] Ranked fairness: no pay-to-win modifiers.

## LL-P7 — Tournaments

- [ ] DRAFT -> REGISTRATION -> LOCKED -> ACTIVE -> SETTLING -> COMPLETED state machine.
- [ ] Cancel/refund/dispute terminal flows.
- [ ] Single elimination.
- [ ] Double elimination.
- [ ] Swiss.
- [ ] Round robin.
- [ ] Idempotent prize settlement using practice/test assets initially.
- [ ] Tournament spectator and bracket UI.

## LL-P8 — Replay / spectator / analytics

- [ ] Event-log replay API.
- [ ] Spectator subscriptions.
- [ ] Match timeline UI.
- [ ] Dispute-review export.
- [ ] Privacy-preserving product analytics.
- [ ] Economy and treasury simulation metrics.

## LL-P9 — Collectibles / marketplace sandbox

- [ ] Original token/character asset system.
- [ ] Rarity/edition/origin metadata.
- [ ] Inventory.
- [ ] Rotating shop using non-withdrawable practice currency.
- [ ] Player marketplace sandbox.
- [ ] Offers/auctions/trades.
- [ ] Competitive-mode cosmetic-only enforcement.

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

- [ ] Threat model.
- [ ] Rate limiting/anti-automation.
- [ ] Fraud/collusion detection.
- [ ] KYC/age/jurisdiction provider adapters if real-value features are pursued.
- [ ] Sanctions/transaction monitoring where required.
- [ ] Responsible-play/self-exclusion controls where applicable.
- [ ] Security audit and penetration tests.
- [ ] Legal review by launch jurisdiction.

## LL-P15 — Economy simulation / real-value decision gate

- [ ] Multi-agent economy simulator with large virtual populations.
- [ ] Treasury solvency modelling.
- [ ] Reward inflation/sink analysis.
- [ ] Withdrawal-pressure modelling.
- [ ] Platform fee/revenue modelling.
- [ ] Only after evidence gates: decide whether any real-value beta proceeds.

## Continuation Rule

TASK COMPLETE != BUILD COMPLETE.

After every verified milestone: record -> commit -> push -> verify remote -> update TODO -> select next highest-priority unblocked task -> continue.

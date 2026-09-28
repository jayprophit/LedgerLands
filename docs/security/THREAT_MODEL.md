# Threat Model (baseline, MVP)

## Assets

Player accounts/profiles, practice balances, match states + event logs,
quest/reward state, inventory/shop, tournament/ranked records, future
custody wallets + contracts + treasury.

## Actors

Honest players, curious clients, cheat-tool authors, bot farmers, colluding
groups, compromised admins, malicious marketplace counterparties, external
attackers (API/WS/contract), regulators/auditors (read-only).

## Top threats → mitigations (status)

1. **Client authority cheats** (dice, balances, ownership) → server-authoritative
   engine; clients send intents only. DONE (MatchStore + applyCommand).
2. **Command replay / double-spend** → `commandId` idempotency + `expectedRevision`
   stale-state rejection (412). DONE (API/store).
3. **State desync / reconnect abuse** → revisioned event log + WS resync on
   subscribe; snapshots planned. PARTIAL (resync done, resume tokens pending).
4. **Reward farming / Sybil** → faucet caps, daily login once-per-day,
   quest claim-once, configurable amounts; production needs device/identity
   rate limits + abuse signals. PARTIAL.
5. **Ledger manipulation** → double-entry journal with idempotency +
   invariant checks; balances derived, not trusted from client. DONE (package).
6. **Auction/trade fraud** → atomic settlement, re-validation at accept,
   no developed-property transfers, bankrupt auto-cancel. DONE (engine).
7. **API abuse** → validation, CORS allowlist, WS heartbeat; full rate-limit,
   CSRF/XSS headers, authN/Z planned. PARTIAL.
8. **Admin compromise** → RBAC + audit log schema present; operational
   multisig/approval flows pending. PARTIAL (schema).
9. **Smart-contract compromise** → no contracts deployed yet; future:最小
   scope, role-based mint, pause, pull-payments, audits. NOT STARTED (by design).
10. **Key/secret leakage** → `.env` gitignored, no keys in repo (audit clean);
    HSM/KMS + secret scanning in P34. PARTIAL.
11. **Dependency supply chain** → lockfile committed; `npm audit` shows 4 high
    advisories — triage in hardening. OPEN.
12. **Real-money legal exposure** → real-value paths default-disabled
    (`REAL_MONEY=false`, `WITHDRAWALS=false`); compliance gates in
    `docs/compliance/REAL_VALUE_READINESS.md`. DONE (by default).

## Next (P34)

Rate limiting, security headers, auth/session hardening,gitleaks-style scan,
dependency triage, WS abuse tests, dispute-export review.

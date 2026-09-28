# Real-Value Readiness — DO NOT LAUNCH FOR REAL VALUE YET

The MVP is **play-money only**. Real cryptocurrency activation requires
every gate below, with named owners and dated sign-off.

## 1. Legal & compliance

- [ ] Jurisdiction-by-jurisdiction classification (skill vs chance, gambling,
      securities, money transmission).
- [ ] Age verification (18+/21+ where required) + jurisdiction geo-controls.
- [ ] KYC/AML + sanctions screening (provider adapters; Prisma
      `ComplianceProfile` is schema-only today).
- [ ] Responsible gaming: deposit/loss/session limits, self-exclusion,
      cooling-off, activity statements, odds/reward disclosures.
- [ ] Tax/reporting treatment + consumer disclosures + terms/privacy.

## 2. Custody & treasury

- [ ] HSM/KMS key management, multisig treasury, segregated player custody.
- [ ] Bucketed accounting (custody ≠ revenue) reconciled to the ledger hourly.
- [ ] Withdrawal allowlists, cooldowns, step-up auth, monitoring.

## 3. Economics

- [ ] Population-scale simulator (10k+ agents) incl. reward inflation, sinks,
      staking liabilities, withdrawal pressure, fee revenue.
- [ ] Treasury solvency proof: every emission has a funded source.
- [ ] No yield advertised as "staking" unless it is protocol staking.

## 4. Security

- [ ] Threat-model review, pen test, dependency triage, secret scan.
- [ ] Contract audit(s) + bug bounty before testnet value, re-audit before mainnet.
- [ ] Fraud/collusion/bot detection + dispute pipeline with replay export.

## 5. Operations

- [ ] Feature-flag runbook (`REAL_MONEY`, `WITHDRAWALS`, `BLOCKCHAIN`, …).
- [ ] Incident response, pause/refund drills, on-call rotation.
- [ ] Analytics + treasury dashboards with alerting.

## Current state

All boxes unchecked. Testnet work (LL-P13) stays **after** LL-P1…LL-P10 and
requires re-verification of networks, wallet libs, randomness, and
OpenZeppelin/tooling versions current at that time — never the obsolete
Goerli/Mumbai/VRF-v1 references from legacy prototypes.

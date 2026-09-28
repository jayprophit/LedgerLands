# Economy — practice sats first

All MVP money is **simulated integers** (`SIM_SAT`). No fiat equivalence is
assumed; Bitcoin price feeds are deliberately absent.

## Sources (mint)

- Starting match balances (starter 5k / standard 15k / high-roller 30k).
- Pass Origin Gate (+200 per lap).
- Event cards (+50…+200).
- Quest rewards (+200…+1000), daily login (50–1000), shop-free starter tokens.
- Mortgage payouts (returnable via +10% unmortgage).

## Sinks (burn / recycle)

- Property purchases, development costs, auction payments.
- Income/luxury taxes, event-card payments, detention fines.
- Unmortgage premium (+10%), shop cosmetic purchases, trade sats (recycled, not burned).
- Bankruptcy (balances zeroed; properties recycled to bank/creditor).

## Simulator evidence (2026-09-28, bot policy: buy with 2k reserve, auction fallback)

- 100 games: **100/100 completed**, avg **35.7 turns**, **194 events**,
  avg winner balance **2,928**, median **2,265**.
- Flows: rent 137,840 · tax 21,456 · pass-start 112,200 · purchases 1,926 · bankruptcies 100.
- Run: `node scripts/simulate.mjs 100 1` after `npm run build`.

## Treasury buckets (reserved, not yet funded with real assets)

Player Custody / Prize Pools / Reward Reserve / Operating Revenue /
Staking Reserve / Marketplace Revenue / Network Fee Reserve /
Promotional Treasury / Insurance-Risk Reserve. Player assets must be
accounted separately from company revenue before any real-value phase.

## Real-value gates (all must pass first)

Legal review, security + contract audits, custody/HSM design, KYC/AML/
sanctions/jurisdiction controls, responsible-gaming limits, treasury solvency
modelling at population scale, and treasury-funded reward sources.
See `docs/compliance/REAL_VALUE_READINESS.md`.

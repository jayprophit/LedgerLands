# Security Model

## Current baseline

- practice currency only;
- server-authoritative game state;
- deterministic/reproducible test RNG;
- client cannot assign balances, dice or winner state;
- integer ledger values;
- CORS allow-origin configuration;
- Aetherius capability manifest defaults financial operations to DENY;
- no private keys, seed phrases or production credentials belong in the repository.

## Required before real-value beta

- production authentication + passkeys/MFA;
- Aetherius identity/policy integration;
- persistent double-entry reconciliation;
- idempotency on settlement/payment operations;
- rate limiting and abuse protection;
- KYC/AML/age/jurisdiction provider adapters where legally required;
- sanctions/risk checks where required;
- responsible-play controls where applicable;
- secure custody/non-custodial wallet design decision;
- secrets vault;
- dependency and container scanning;
- smart contract audits;
- treasury multisig;
- transaction simulation/allowlists;
- monitoring and incident response;
- legal review for each operating jurisdiction.

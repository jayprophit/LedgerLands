# LedgerLands

LedgerLands is the original Aetherius OS property-trading strategy application evolved from the legacy **CryptoMonopoly** working concept. It is designed as a first-class Aetherius application with its own repository, independent release lifecycle, deterministic game engine, practice-currency ledger, multiplayer API, database model and Aetherius integration manifest.

## Status

This repository provides a runnable development baseline with:

- deterministic board-game engine;
- configurable board/economy rules;
- property purchase, rent, development, detention/jail analogue, bankruptcy and winner detection;
- seeded deterministic dice for tests;
- server-authoritative Fastify API;
- WebSocket match updates;
- React/Vite board client;
- PostgreSQL/Prisma production schema;
- practice-wallet accounting interfaces;
- Aetherius OS application manifest/capabilities;
- Docker Compose development stack;
- CI verification workflow;
- unit tests and smoke-testable API.

Real-value cryptocurrency deposits, withdrawals, staking and mainnet contracts are deliberately **not activated** in this baseline. The architecture reserves adapters for later testnet/compliance-gated integration.

## Quick start

```bash
npm install
npm run verify
npm run dev
```

Open `http://localhost:5173`.

API health: `http://localhost:8787/health`.

## Docker

```bash
docker compose up --build
```

## Aetherius OS

The app declares itself in `integrations/aetherius/app.manifest.json` with application id:

```text
com.aetherius.ledgerlands
```

Aetherius should register this app through the shared Application Registry rather than hard-coding it into the shell.

See `docs/AETHERIUS-INTEGRATION.md`.

## Repository strategy

LedgerLands remains its own repository and integrates with Aetherius through contracts/adapters. This matches the broader ecosystem approach used for applications such as Poietek and IDE-Workspace.

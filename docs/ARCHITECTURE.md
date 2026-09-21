# Architecture

## Boundaries

LedgerLands uses a deterministic game core separated from transport, persistence, UI, Aetherius integration and future blockchain settlement.

```text
React UI
   |
Fastify API + WebSocket
   |
Server-authoritative Match Store
   |
Deterministic Game Engine
   |
Event Log / Ledger
   |
PostgreSQL (production persistence)
```

Aetherius integration is horizontal rather than a hard dependency of the game engine.

## Deterministic engine

Commands are validated and transformed into state + auditable events. Tests use seeded pseudo-random dice so games can be reproduced.

Current commands:

- START_MATCH
- ROLL_DICE
- BUY_PROPERTY
- DEVELOP_PROPERTY
- PAY_DETENTION_FINE
- END_TURN
- SURRENDER

The board is data-driven in `packages/game-engine/src/board.ts` and can later be externalized to signed ruleset JSON.

## Money model

The runnable baseline uses integer practice units only. Never use JavaScript floating-point values for real monetary settlement.

Future monetary integration must use smallest-unit integers (`SAT`, token base units) and a double-entry persistent ledger.

## Multiplayer

The API is authoritative. Clients send intents/commands; the server validates engine transitions and broadcasts state over WebSocket.

## Persistence

The Prisma schema models users, identities, double-entry-style ledger accounts/entries, matches, match events, tournaments, seasons/rankings, quests, NFTs, marketplace listings, compliance state and audit logs.

## Blockchain

Mainnet integration is intentionally outside the default runtime. Add blockchain only at ownership/settlement boundaries after game, ledger, security, economic simulation and compliance gates are satisfied.

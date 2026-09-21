# Verification Record

## Verified in the ChatGPT build environment

- Shared TypeScript contracts compile with `tsc`.
- Deterministic game engine compiles with `tsc`.
- Aetherius SDK adapter compiles with `tsc`.
- Engine smoke test passes:
  - seeded dice are deterministic;
  - match starts;
  - property can be purchased;
  - turn transition works;
  - surrender completes a two-player match and identifies a winner.
- Aetherius manifest JSON parses.
- Aetherius capability-policy JSON parses.
- Git repository initialized on `main`.
- Intended GitHub remote configured as `https://github.com/jayprophit/LedgerLands.git`.

## Not fully verified in this build environment

The sandbox could not complete `npm install` within its execution/network constraints, so the dependency-backed layers have not been runtime-verified here:

- Fastify API startup;
- WebSocket server/client integration;
- React/Vite production build;
- Prisma CLI validation/migration;
- Docker Compose startup;
- full workspace `npm run verify`.

The source for those layers is present and must be verified on the owner workstation/OpenCode environment before marking LL-P1 complete.

## Required owner/OpenCode verification

```powershell
cd C:\Users\jpowe\Desktop\Projects\LedgerLands
npm install
npm run verify
npm run dev
```

Then in another terminal:

```powershell
node scripts/smoke.mjs
```

For Prisma/PostgreSQL:

```powershell
docker compose up -d postgres
npm run db:generate
npm run db:push
```

Do not mark the full application complete until `BUILD-TODO.md` is exhausted and production gates are satisfied.

/**
 * Real-Postgres DDL for the tables the match store actually uses.
 *
 * Kept in sync with prisma/schema.prisma by hand, because PGlite cannot load
 * Prisma's migration engine. Every column, constraint, and index that the match
 * store depends on is present here — including the ones that make concurrency
 * safe — so a query that works here would work against a real server. If you
 * change the Prisma schema, change this too.
 *
 * All identifiers are quoted, exactly as Prisma emits them. Unquoted
 * `rulesetVersion` folds to `rulesetversion` in PostgreSQL, which is the kind
 * of difference a hand-written schema file hides until it breaks.
 */

export const MATCH_STORE_DDL = `
CREATE TABLE IF NOT EXISTS "Match" (
  "id"              TEXT PRIMARY KEY,
  "status"          TEXT NOT NULL DEFAULT 'LOBBY',
  "rulesetVersion"  TEXT NOT NULL,
  "seedCommitment"  TEXT,
  "seedReveal"      TEXT,
  "stateRevision"   INTEGER NOT NULL DEFAULT 0,
  "initialState"    JSONB,
  "botDifficulty"   TEXT NOT NULL DEFAULT 'NORMAL',
  "solo"            BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "startedAt"       TIMESTAMPTZ,
  "completedAt"     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "MatchCommand" (
  "id"             TEXT PRIMARY KEY,
  "matchId"        TEXT NOT NULL REFERENCES "Match"("id") ON DELETE CASCADE,
  "seq"            INTEGER NOT NULL,
  "commandId"      TEXT NOT NULL,
  "actorId"        TEXT,
  "command"        JSONB NOT NULL,
  "resultRevision" INTEGER NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "MatchCommand_matchId_seq_key" UNIQUE ("matchId", "seq"),
  CONSTRAINT "MatchCommand_matchId_commandId_key" UNIQUE ("matchId", "commandId")
);
CREATE INDEX IF NOT EXISTS "MatchCommand_matchId_seq_idx" ON "MatchCommand" ("matchId", "seq");

CREATE TABLE IF NOT EXISTS "MatchSnapshot" (
  "id"        TEXT PRIMARY KEY,
  "matchId"   TEXT NOT NULL REFERENCES "Match"("id") ON DELETE CASCADE,
  "revision"  INTEGER NOT NULL,
  "seq"       INTEGER NOT NULL DEFAULT 0,
  "version"   INTEGER NOT NULL DEFAULT 1,
  "state"     JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "MatchSnapshot_matchId_revision_key" UNIQUE ("matchId", "revision")
);
CREATE INDEX IF NOT EXISTS "MatchSnapshot_matchId_seq_idx" ON "MatchSnapshot" ("matchId", "seq");

CREATE TABLE IF NOT EXISTS "MatchCorrection" (
  "id"        TEXT PRIMARY KEY,
  "matchId"   TEXT NOT NULL REFERENCES "Match"("id") ON DELETE CASCADE,
  "kind"      TEXT NOT NULL,
  "detail"    TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "MatchCorrection_matchId_createdAt_idx"
  ON "MatchCorrection" ("matchId", "createdAt");

CREATE TABLE IF NOT EXISTS "MatchmakingEntry" (
  "entryId"              TEXT PRIMARY KEY,
  "playerId"             TEXT NOT NULL,
  "queue"                TEXT NOT NULL,
  "rating"               INTEGER NOT NULL DEFAULT 1500,
  "displayName"          TEXT NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'QUEUED',
  "joinedAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reservationId"        TEXT,
  "reservationExpiresAt" TIMESTAMPTZ,
  "matchId"              TEXT,
  "version"              INTEGER NOT NULL DEFAULT 1,
  "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "MatchmakingEntry_playerId_queue_status_key" UNIQUE ("playerId", "queue", "status")
);
CREATE INDEX IF NOT EXISTS "MatchmakingEntry_queue_status_joinedAt_idx"
  ON "MatchmakingEntry" ("queue", "status", "joinedAt");
CREATE INDEX IF NOT EXISTS "MatchmakingEntry_reservationId_idx"
  ON "MatchmakingEntry" ("reservationId");
CREATE INDEX IF NOT EXISTS "MatchmakingEntry_status_reservationExpiresAt_idx"
  ON "MatchmakingEntry" ("status", "reservationExpiresAt");
`;

#!/usr/bin/env node
/**
 * Performance probe (LL-P16). Records baseline timings and obvious scaling
 * risks. Numbers are small-local and must NOT be read as production
 * capacity claims.
 *
 * Usage: node scripts/bench.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { applyCommand, createMatchState, DEFAULT_BOARD } = await import("../packages/game-engine/dist/index.js");
const { MemoryBackend, FileBackend, PersistentMatchStore } = await import("../packages/match-store/dist/index.js");
const { leaderboard, blankRating, settleHeadToHead } = await import("../packages/ranked/dist/index.js");
const { MatchmakingService } = await import("../packages/matchmaking/dist/index.js");
const { TournamentService } = await import("../packages/tournaments/dist/index.js");
const { DoubleEntryLedger } = await import("../packages/ledger/dist/index.js");

function ms(start) {
  return Number((performance.now() - start).toFixed(1));
}

/** Play a solo-style game to completion using the bot policy. */
async function playMatch(store, seed, cmds) {
  const { match, playerId } = await store.create({ playerName: "Bench", seed, difficulty: "NORMAL" });
  for (let i = 0; i < 200; i++) {
    const cur = await store.get(match.id);
    if (!cur || cur.status !== "ACTIVE") break;
    const me = cur.players[cur.currentPlayerIndex];
    let cmd;
    if (cur.turnPhase === "ROLL") {
      cmd = { type: "ROLL_DICE" };
    } else {
      const tile = DEFAULT_BOARD[me.position];
      const prop = tile ? cur.properties[tile.id] : undefined;
      const price = tile?.economics?.purchasePrice ?? tile?.amount ?? 0;
      cmd =
        tile && prop && !prop.ownerId && price > 0 && me.balance - price >= 1000
          ? { type: "BUY_PROPERTY", playerId: me.id, tileId: tile.id }
          : { type: "END_TURN", playerId: me.id };
    }
    try {
      await store.command(match.id, playerId, cmd, { commandId: `b-${seed}-${i}` });
      cmds.count++;
    } catch {
      break;
    }
  }
  return match.id;
}

const results = {};

// 1. Event reconstruction (memory backend, full replay cost)
{
  const store = new PersistentMatchStore(new MemoryBackend());
  const t0 = performance.now();
  let total = 0;
  for (let g = 0; g < 50; g++) total += (await playMatch(store, 1000 + g, { count: 0 })) ? 1 : 0;
  results.matchPlay = { games: 50, ms: ms(t0) };

  const firstId = (await store.list())[0].id;
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) {
    (store).states.clear();
    await store.get(firstId);
  }
  results.rebuildFromLog = { matchId: firstId, iterations: 20, ms: ms(t1), note: "full command replay, cache cleared each time" };
}

// 2. Snapshot recovery (file backend)
{
  const dir = mkdtempSync(join(tmpdir(), "ll-bench-"));
  try {
    const store = new PersistentMatchStore(new FileBackend(dir));
    const cmds = { count: 0 };
    const id = await playMatch(store, 7, cmds);
    const t0 = performance.now();
    (store).states.clear();
    await store.get(id);
    results.fileBackendRecovery = { matchId: id, ms: ms(t0) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Replay export
{
  const store = new PersistentMatchStore(new MemoryBackend());
  const id = await playMatch(store, 42, { count: 0 });
  const t0 = performance.now();
  const replay = await store.exportReplay(id);
  results.replayExport = { matchId: id, events: replay.events.length, ms: ms(t0) };
}

// 4. Leaderboard query
{
  const ratings = Array.from({ length: 5000 }, (_, i) => ({ ...blankRating(`u${i}`, "s1", "ffa"), rating: 1500 + (i % 900) }));
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) leaderboard(ratings);
  results.leaderboard = { rows: ratings.length, iterations: 200, ms: ms(t0) };
  const t1 = performance.now();
  let a = blankRating("a", "s1", "ffa");
  let b = blankRating("b", "s1", "ffa");
  for (let i = 0; i < 10000; i++) {
    const r = settleHeadToHead(a, b, i % 2 ? "WIN" : "LOSS");
    a = r.a;
    b = r.b;
  }
  results.ratingUpdates = { iterations: 10000, ms: ms(t1) };
}

// 5. Matchmaking selection
{
  const mm = new MatchmakingService();
  for (let i = 0; i < 2000; i++) mm.join({ playerId: `p${i}`, displayName: `p${i}`, queue: "RANKED_1V1", rating: 1500 + (i % 500) }, 0);
  const t0 = performance.now();
  const found = mm.tick(0);
  results.matchmakingTick = { queued: 2000, formed: found.length, ms: ms(t0) };
}

// 6. Ledger posting
{
  const ledger = new DoubleEntryLedger();
  const t0 = performance.now();
  for (let i = 0; i < 10000; i++) {
    ledger.post({
      playerId: `u${i % 100}`,
      amount: 10,
      debitAccount: "PLAYER_AVAILABLE",
      creditAccount: "MATCH_BANK",
      type: "rent",
      idempotencyKey: `k-${i}`,
    });
  }
  results.ledgerPost = { postings: 10000, ms: ms(t0) };
}

// 7. Tournament bracket build
{
  const svc = new TournamentService(new DoubleEntryLedger());
  const t0 = performance.now();
  for (let e = 0; e < 200; e++) {
    const t = svc.create({ name: "B", format: "DOUBLE_ELIMINATION", maxPlayers: 32 });
    svc.openRegistration(t.id);
    for (let i = 0; i < 16; i++) svc.register(t.id, `p${i}`);
    svc.lock(t.id);
  }
  results.tournamentBuild = { tournaments: 200, players: 16, format: "DOUBLE_ELIMINATION", ms: ms(t0) };
}

console.log(JSON.stringify(results, null, 2));
console.log("\nSCALING RISKS (qualitative):");
console.log("- Store replay is O(commands); long matches without snapshot reuse pay it on every cache miss.");
console.log("- FileBackend rewrites the whole record per command: O(commands^2) bytes written over a match.");
console.log("- In-memory Maps (queue, ratings, tournaments) are single-process only; Postgres/Redis are the production path.");
console.log("- Hash-chained replay export is O(events) sha256 per export; fine for a dispute, not a hot path.");

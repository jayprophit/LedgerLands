/**
 * Where per-command time actually goes in a full match.
 *
 * The engine is pure and clones state on every command, so the interesting
 * question is not "is it slow" but "which cost dominates": the clone-and-apply
 * path, or bot decisioning.
 *
 * Uses the same proven driver shape as scripts/simulate.mjs so the loop cannot
 * spin on an illegal command.
 *
 * Run: node scripts/profile-engine.mjs   (requires `npm run build` first)
 */

import { performance } from "node:perf_hooks";
import { applyCommand, createMatchState, DEFAULT_BOARD } from "../packages/game-engine/dist/index.js";
import { chooseAiCommand } from "../packages/game-ai/dist/index.js";

const GAMES = Number(process.env.PROFILE_GAMES ?? 20);
const SAFETY = Number(process.env.PROFILE_SAFETY ?? 500);

function timedApply(state, cmd, sink) {
  const t = performance.now();
  try {
    const next = applyCommand(state, cmd);
    sink.applyMs += performance.now() - t;
    return next;
  } catch (err) {
    sink.applyMs += performance.now() - t;
    sink.illegal += 1;
    throw err;
  }
}

function runGame(seed) {
  const sink = { applyMs: 0, decideMs: 0, illegal: 0, commands: 0 };
  let state = createMatchState({
    id: `prof-${seed}`,
    seed: seed >>> 0,
    players: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
  });

  const t0 = performance.now();
  state = timedApply(state, { type: "START_MATCH" }, sink);
  sink.commands += 1;

  let safety = 0;
  while (state.status === "ACTIVE" && safety++ < SAFETY) {
    const cur = state.players[state.currentPlayerIndex];
    if (!cur) break;

    if (state.turnPhase === "ROLL") {
      if (cur.inDetention && cur.balance >= 1000 && cur.detentionTurns >= 1) {
        try {
          state = timedApply(state, { type: "PAY_DETENTION_FINE", playerId: cur.id }, sink);
          sink.commands += 1;
          continue;
        } catch {}
      }
      state = timedApply(state, { type: "ROLL_DICE" }, sink);
      sink.commands += 1;
      continue;
    }

    // Decision time is what the AI layer costs, measured separately from apply.
    const tDecide = performance.now();
    const ai = chooseAiCommand(state, cur.id, "NORMAL");
    sink.decideMs += performance.now() - tDecide;

    if (ai) {
      try {
        state = timedApply(state, ai, sink);
        sink.commands += 1;
        continue;
      } catch {}
    }

    // Fall back to a plain purchase decision, then to ending the turn.
    const tile = DEFAULT_BOARD[cur.position];
    const prop = tile ? state.properties[tile.id] : undefined;
    const price = tile?.economics?.purchasePrice ?? tile?.amount ?? 0;
    if (tile && prop && !prop.ownerId && price > 0 && cur.balance - price >= 2000) {
      try {
        state = timedApply(state, { type: "BUY_PROPERTY", playerId: cur.id, tileId: tile.id }, sink);
        sink.commands += 1;
        continue;
      } catch {}
    }
    try {
      state = timedApply(state, { type: "END_TURN", playerId: cur.id }, sink);
      sink.commands += 1;
    } catch {
      break;
    }
  }

  return { totalMs: performance.now() - t0, turns: state.turn, events: state.log.length, status: state.status, ...sink };
}

const results = [];
for (let g = 0; g < GAMES; g += 1) results.push(runGame(1 + g * 7919));

const sum = (k) => results.reduce((a, r) => a + r[k], 0);
const totalMs = sum("totalMs");
const applyMs = sum("applyMs");
const decideMs = sum("decideMs");
const otherMs = totalMs - applyMs - decideMs;
const commands = sum("commands");
const pct = (v) => `${((v / totalMs) * 100).toFixed(1)}%`;

console.log(`games              ${GAMES}`);
console.log(`commands           ${commands}`);
console.log(`turns              ${sum("turns")}`);
console.log(`events             ${sum("events")}`);
console.log(`completed          ${results.filter((r) => r.status === "COMPLETED").length}`);
console.log(`illegal AI cmds    ${sum("illegal")}`);
console.log("");
console.log(`total              ${totalMs.toFixed(1)} ms`);
console.log(`  applyCommand     ${applyMs.toFixed(1)} ms  (${pct(applyMs)})  clone + rules`);
console.log(`  AI decisioning   ${decideMs.toFixed(1)} ms  (${pct(decideMs)})`);
console.log(`  driver overhead  ${otherMs.toFixed(1)} ms  (${pct(otherMs)})`);
console.log("");
console.log(`per command        ${(totalMs / commands).toFixed(3)} ms  all-in`);
console.log(`per command        ${(applyMs / commands).toFixed(3)} ms  applyCommand only`);
console.log(`per turn           ${(totalMs / sum("turns")).toFixed(2)} ms`);

const perGame = results.map((r) => r.totalMs).sort((a, b) => a - b);
console.log("");
console.log(`per game  min      ${perGame[0].toFixed(1)} ms`);
console.log(`          median   ${perGame[Math.floor(perGame.length / 2)].toFixed(1)} ms`);
console.log(`          max      ${perGame[perGame.length - 1].toFixed(1)} ms`);

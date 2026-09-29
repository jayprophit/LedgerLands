/**
 * Clone cost, before and after the state/history split.
 *
 * The directive's acceptance criterion is equivalence; this is the measurement
 * that motivated the change and the evidence that it paid off. Equivalence is
 * proved separately in test/clone-equivalence.ts and by the oracle's golden
 * fingerprints, so a speedup here cannot be bought with a behaviour change.
 *
 * Run after `npm run build`:
 *   node scripts/profile-clone.mjs
 */

import { performance } from "node:perf_hooks";
import {
  applyCommand,
  cloneMatchState,
  cloneMatchStateDeep,
  createMatchState,
  DEFAULT_BOARD,
} from "../packages/game-engine/dist/index.js";

/** Play a match far enough that the log is long, then time one command. */
function buildState(seed, targetEvents) {
  const players = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}` }));
  let state = createMatchState({ id: `c-${seed}`, seed, players });
  state = applyCommand(state, { type: "START_MATCH" });
  let guard = 0;
  while (state.log.length < targetEvents && guard < 100000) {
    guard += 1;
    if (state.status !== "ACTIVE") break;
    const p = state.players[state.currentPlayerIndex];
    if (!p || p.bankrupt) break;
    try {
      if (state.turnPhase === "ROLL") {
        state = applyCommand(state, { type: "ROLL_DICE" });
      } else {
        const tile = DEFAULT_BOARD[p.position];
        const prop = tile ? state.properties[tile.id] : undefined;
        const price = tile?.economics?.purchasePrice ?? tile?.amount ?? 0;
        if (tile && prop && !prop.ownerId && price > 0 && p.balance - price >= 2000) {
          state = applyCommand(state, { type: "BUY_PROPERTY", playerId: p.id, tileId: tile.id });
        } else {
          state = applyCommand(state, { type: "END_TURN", playerId: p.id });
        }
      }
    } catch {
      break;
    }
  }
  return state;
}

function timeClone(clone, state, repeats) {
  // Warm up so the first call's JIT cost does not land in the measurement.
  for (let i = 0; i < 50; i += 1) clone(state);
  const t = performance.now();
  for (let i = 0; i < repeats; i += 1) clone(state);
  return (performance.now() - t) / repeats;
}

function timeApply(state, cloner, repeats) {
  const cmd = { type: "END_TURN", playerId: state.players[state.currentPlayerIndex]?.id ?? "p0" };
  for (let i = 0; i < 20; i += 1) {
    try {
      applyCommand(state, cmd, undefined, cloner);
    } catch {
      /* state may not permit END_TURN; the clone cost is what we measure */
    }
  }
  const t = performance.now();
  for (let i = 0; i < repeats; i += 1) {
    try {
      applyCommand(state, cmd, undefined, cloner);
    } catch {
      /* ignore */
    }
  }
  return (performance.now() - t) / repeats;
}

const TARGETS = [200, 800, 2000, 4000];
const REPEATS = 200;

console.log("per-command cost at a given event-log length");
console.log("");
console.log("  events   structuredClone   targeted clone   speedup");
console.log("  -------  ---------------   --------------   -------");

const rows = [];
for (const target of TARGETS) {
  const state = buildState(1000 + target * 13, target);
  const events = state.log.length;
  const before = timeClone(cloneMatchStateDeep, state, REPEATS);
  const after = timeClone(cloneMatchState, state, REPEATS);
  rows.push({ events, before, after });
  console.log(
    `  ${String(events).padStart(7)}   ${before.toFixed(4).padStart(13)} ms   ${after
      .toFixed(4)
      .padStart(12)} ms   ${(before / after).toFixed(1).padStart(6)}x`,
  );
}

console.log("");
console.log("full applyCommand (clone + rules), same states");
console.log("");
console.log("  events   before          after           speedup");
for (const row of rows) {
  const state = buildState(1000 + row.events * 13, row.events);
  const before = timeApply(state, cloneMatchStateDeep, REPEATS);
  const after = timeApply(state, cloneMatchState, REPEATS);
  console.log(
    `  ${String(row.events).padStart(7)}   ${before.toFixed(4).padStart(9)} ms   ${after
      .toFixed(4)
      .padStart(9)} ms   ${(before / after).toFixed(1).padStart(6)}x`,
  );
}

console.log("");
console.log("Growth: structuredClone is linear in log length, so a match is O(n^2).");
const first = rows[0];
const last = rows[rows.length - 1];
const growth = last.events / first.events;
const costGrowth = last.before / first.before;
console.log(
  `  log grew ${growth.toFixed(0)}x (${first.events} -> ${last.events} events), ` +
    `structuredClone cost grew ${costGrowth.toFixed(0)}x`,
);
console.log(
  `  targeted clone cost grew ${(last.after / first.after).toFixed(0)}x over the same range, ` +
    "because the log is now copied by pointer rather than deep-copied.",
);

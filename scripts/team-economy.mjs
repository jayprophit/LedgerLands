/**
 * FFA_4 versus TEAM_2V2 — the paired economy experiment.
 *
 * Answers the directive's actual question, which is NOT "how do we stop
 * teammates cooperating". Cooperation is intended. The question is whether the
 * cooperation D1-D5 permits produces DEGENERATE or EXPLOITABLE strategy — a
 * designated carry player, funneling into a monopoly, sacrificial bankruptcy,
 * teammate auction inflation, circular zero-sum swapping.
 *
 * So the diagnostics count those things. None of them is prohibited, and
 * nothing here changes D1-D5. The output is evidence for a decision, not a
 * decision.
 *
 * Run after `npm run build`:
 *   node scripts/team-economy.mjs
 *   TEAM_GAMES=1000 node scripts/team-economy.mjs
 *   TEAM_DIFFICULTY=HARD node scripts/team-economy.mjs
 */

import { writeFileSync } from "node:fs";
import { playMatch, summarise, teamDiagnostics, FFA_TEAMS, TEAM_2V2_TEAMS } from "./lib/sim-driver.mjs";

const GAMES = Number(process.env.TEAM_GAMES ?? 300);
const DIFFICULTY = process.env.TEAM_DIFFICULTY ?? "NORMAL";
const BASE_SEED = Number(process.env.TEAM_SEED ?? 1);

// Standard Monopoly money. This is the single most important knob in this
// experiment. The first run used 30,000 per player, and that made auctions
// STRUCTURALLY IMPOSSIBLE: a bot holding 30,000 could always afford any tile on
// the board, so it never declined, so no auction ever opened — and the entire
// D4 auction-rivalry dimension measured zero for a reason that had nothing to
// do with the team rules. A money regime nobody plays in cannot produce evidence
// about auctions, rent pressure, or bankruptcy. Overridable so the sensitivity
// can be reported rather than assumed.
const STARTING_BALANCE = Number(process.env.TEAM_BALANCE ?? 1500);

function run(teams, games) {
  const states = [];
  const totals = { aiCommands: 0, aiRejected: 0, rejectedByType: {}, byType: {} };
  for (let g = 0; g < games; g += 1) {
    // Paired seeds: game n uses the same seed in both arms, so the arms differ
    // only in the team rules.
    const { state, diagnostics } = playMatch({
      seed: BASE_SEED + g * 7919,
      teams,
      difficulty: DIFFICULTY,
      startingBalance: STARTING_BALANCE,
    });
    states.push(state);
    totals.aiCommands += diagnostics.aiCommands;
    totals.aiRejected += diagnostics.aiRejected;
    for (const [k, v] of Object.entries(diagnostics.rejectedByType)) {
      totals.rejectedByType[k] = (totals.rejectedByType[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(diagnostics.aiByType)) {
      totals.byType[k] = (totals.byType[k] ?? 0) + v;
    }
  }
  return { states, totals };
}

const t0 = Date.now();
const ffaRun = run(FFA_TEAMS, GAMES);
const ffaMs = Date.now() - t0;

const t1 = Date.now();
const teamRun = run(TEAM_2V2_TEAMS, GAMES);
const teamMs = Date.now() - t1;

const ffaStates = ffaRun.states;
const teamStates = teamRun.states;

const ffa = summarise("FFA_4", ffaStates);
const team = summarise("TEAM_2V2", teamStates);
const diagnostics = teamDiagnostics(teamStates);

const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    gamesPerArm: GAMES,
    baseSeed: BASE_SEED,
    seedFormula: "baseSeed + n * 7919, identical in both arms (paired)",
    difficulty: DIFFICULTY,
    players: 4,
    startingBalance: STARTING_BALANCE,
    safetyLimitCommands: 1200,
    armsDifferOnlyBy: "team rules (team-v1) vs none",
    aiIntegrity: { FFA_4: ffaRun.totals, TEAM_2V2: teamRun.totals },
    ffaRuntimeMs: ffaMs,
    teamRuntimeMs: teamMs,
  },
  FFA_4: ffa,
  TEAM_2V2: team,
  TEAM_2V2_DIAGNOSTICS: diagnostics,
};

const fmt = (r) =>
  Object.entries(r)
    .filter(([k]) => k !== "winners" && k !== "label")
    .map(([k, v]) => `  ${k.padEnd(34)} ${String(v).padStart(10)}`)
    .join("\n");

console.log(`=== ${GAMES} paired games per arm, difficulty ${DIFFICULTY} ===`);
console.log(`seed formula: ${BASE_SEED} + n * 7919  (identical in both arms)`);
console.log(`starting balance: ${STARTING_BALANCE} per player`);
console.log(`runtime: FFA ${ffaMs} ms, TEAM ${teamMs} ms`);
console.log("");
console.log("FFA_4");
console.log(fmt(ffa));
console.log(`  ${"winners".padEnd(34)} ${JSON.stringify(ffa.winners)}`);
console.log("");
console.log("TEAM_2V2");
console.log(fmt(team));
console.log(`  ${"winners".padEnd(34)} ${JSON.stringify(team.winners)}`);
console.log("");
console.log("TEAM_2V2 DIAGNOSTICS (degenerate-strategy probes — counted, not prohibited)");
for (const [k, v] of Object.entries(diagnostics ?? {})) {
  console.log(`  ${k.padEnd(40)} ${String(v).padStart(10)}`);
}

console.log("");
console.log("AI COMMAND INTEGRITY (an AI command the engine refused is an AI bug)");
console.log(`  FFA_4     ${ffaRun.totals.aiCommands} issued, ${ffaRun.totals.aiRejected} rejected ${JSON.stringify(ffaRun.totals.rejectedByType)}`);
console.log(`  TEAM_2V2  ${teamRun.totals.aiCommands} issued, ${teamRun.totals.aiRejected} rejected ${JSON.stringify(teamRun.totals.rejectedByType)}`);
console.log("  AI command mix (TEAM_2V2):");
for (const [k, v] of Object.entries(teamRun.totals.byType).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${v}`);
}

const outPath = new URL("../docs/analysis/TEAM_2V2_ECONOMY.json", import.meta.url);
try {
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`raw results: ${outPath.pathname}`);
} catch (error) {
  console.log("");
  console.log(`could not write results: ${error.message}`);
}

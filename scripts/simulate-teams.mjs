/**
 * FFA_4 versus TEAM_2V2.
 *
 * The directive is explicit that this is a BASELINE, not a balance: record the
 * numbers before changing any economic constant. So nothing here tunes anything.
 * It measures the same bot policy in both modes and reports the differences that
 * a later ruleset (shared treasury, different starting cash) would be designed
 * against.
 *
 * Run after `npm run build`:
 *   node scripts/simulate-teams.mjs            # 200 games per mode
 *   TEAM_SIM_GAMES=500 node scripts/simulate-teams.mjs
 */

import { writeFileSync } from "node:fs";
import { applyCommand, createMatchState, DEFAULT_BOARD } from "../packages/game-engine/dist/index.js";
import { chooseAiCommand } from "../packages/game-ai/dist/index.js";

const GAMES = Number(process.env.TEAM_SIM_GAMES ?? 200);

const FFA_TEAMS = [
  { teamId: "t0", memberIds: ["p0", "p1"], eliminated: false },
  { teamId: "t1", memberIds: ["p2", "p3"], eliminated: false },
];

/** Bot policy: buy when affordable with a reserve, else end the turn. */
function playGame({ seed, teams }) {
  const players = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}` }));
  let state = createMatchState(
    teams ? { id: `sim-${seed}`, seed, players, teams, mode: "TEAM_2V2" } : { id: `sim-${seed}`, seed, players },
  );
  state = applyCommand(state, { type: "START_MATCH" });

  const events = { log: [] };
  let safety = 0;
  while (state.status === "ACTIVE" && safety++ < 600) {
    const cur = state.players[state.currentPlayerIndex];
    if (!cur || cur.bankrupt) break;

    if (state.turnPhase === "ROLL") {
      const ai = chooseAiCommand(state, cur.id, "NORMAL");
      if (ai) {
        try {
          state = applyCommand(state, ai);
          continue;
        } catch {
          /* fall through to the mechanical policy */
        }
      }
      if (cur.inDetention && cur.balance >= 1000) {
        try {
          state = applyCommand(state, { type: "PAY_DETENTION_FINE", playerId: cur.id });
          continue;
        } catch {}
      }
      try {
        state = applyCommand(state, { type: "ROLL_DICE" });
      } catch {
        break;
      }
      continue;
    }

    const tile = DEFAULT_BOARD[cur.position];
    const prop = tile ? state.properties[tile.id] : undefined;
    const price = tile?.economics?.purchasePrice ?? tile?.amount ?? 0;
    if (tile && prop && !prop.ownerId && price > 0 && cur.balance - price >= 2000) {
      try {
        state = applyCommand(state, { type: "BUY_PROPERTY", playerId: cur.id, tileId: tile.id });
        continue;
      } catch {}
    } else if (tile && prop && !prop.ownerId && price > 0 && state.auction === undefined) {
      try {
        state = applyCommand(state, { type: "DECLINE_PROPERTY", playerId: cur.id });
        try {
          state = applyCommand(state, { type: "PLACE_BID", playerId: cur.id, amount: Math.min(price, cur.balance) });
        } catch {}
        try {
          state = applyCommand(state, { type: "COMPLETE_AUCTION", playerId: cur.id });
        } catch {}
      } catch {}
    }
    try {
      state = applyCommand(state, { type: "END_TURN", playerId: cur.id });
    } catch {
      break;
    }
  }
  void events;
  return state;
}

function summarise(mode, states) {
  const completed = states.filter((s) => s.status === "COMPLETED");
  const turns = states.map((s) => s.turn).sort((a, b) => a - b);
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const bankrupts = states.flatMap((s) => s.log.filter((e) => e.type === "PLAYER_BANKRUPT"));
  const rentEvents = states.flatMap((s) => s.log.filter((e) => e.type === "RENT_PAID"));
  const exemptions = states.flatMap((s) => s.log.filter((e) => e.type === "TEAMMATE_RENT_EXEMPT"));
  const auctions = states.flatMap((s) => s.log.filter((e) => e.type === "AUCTION_COMPLETED"));
  const bids = states.flatMap((s) => s.log.filter((e) => e.type === "AUCTION_BID"));
  const trades = states.flatMap((s) => s.log.filter((e) => e.type === "TRADE_PROPOSED"));
  const cards = states.flatMap((s) => s.log.filter((e) => e.type === "CARD_DRAWN"));

  // Property concentration: share of owned property held by the largest holder.
  const concentrations = states.map((s) => {
    const owned = Object.values(s.properties).filter((p) => p.ownerId);
    if (owned.length === 0) return 0;
    const byOwner = new Map();
    for (const p of owned) byOwner.set(p.ownerId, (byOwner.get(p.ownerId) ?? 0) + 1);
    return Math.max(...byOwner.values()) / owned.length;
  });

  // Bankruptcy ordering: how far into the match the first elimination happened.
  const firstBankruptTurns = states
    .map((s) => {
      const index = s.log.findIndex((e) => e.type === "PLAYER_BANKRUPT");
      return index < 0 ? null : index;
    })
    .filter((v) => v !== null);

  const winners = new Map();
  for (const s of completed) {
    const key = s.winnerTeamId ?? s.winnerId ?? "none";
    winners.set(key, (winners.get(key) ?? 0) + 1);
  }

  // Per-team wealth spread, so a shared-vault variant has something to compare.
  const teamWealth = states.map((s) => {
    if (!s.teams) return null;
    return s.teams.map((t) => ({
      teamId: t.teamId,
      cash: t.memberIds.reduce((sum, id) => sum + (s.players.find((p) => p.id === id)?.balance ?? 0), 0),
      property: Object.values(s.properties).filter((p) => t.memberIds.includes(p.ownerId ?? "")).length,
    }));
  });
  const aliveWealth = teamWealth.filter(Boolean);
  const wealthGap = aliveWealth.map((pairs) => {
    const sorted = [...pairs].sort((a, b) => b.cash - a.cash);
    return sorted[0].cash - sorted[1].cash;
  });

  return {
    mode,
    games: states.length,
    completionRate: +(completed.length / states.length).toFixed(4),
    avgTurns: +mean(turns).toFixed(1),
    medianTurns: median(turns),
    bankruptcies: bankrupts.length,
    gamesWithBankruptcy: firstBankruptTurns.length,
    bankruptsPerGame: +(bankrupts.length / states.length).toFixed(3),
    rentEvents: rentEvents.length,
    rentPerGame: +(rentEvents.length / states.length).toFixed(2),
    avgRent: rentEvents.length ? Math.round(mean(rentEvents.map((e) => e.amount))) : 0,
    teammateRentExemptions: exemptions.length,
    exemptionsPerGame: +(exemptions.length / states.length).toFixed(2),
    auctionsCompleted: auctions.length,
    auctionBids: bids.length,
    bidsPerAuction: auctions.length ? +(bids.length / auctions.length).toFixed(2) : 0,
    tradesProposed: trades.length,
    cardsDrawn: cards.length,
    avgTopHolderShare: +mean(concentrations).toFixed(3),
    maxTopHolderShare: concentrations.length ? +Math.max(...concentrations).toFixed(3) : 0,
    avgTeamCashGap: wealthGap.length ? Math.round(mean(wealthGap)) : null,
    winners: Object.fromEntries(winners),
  };
}

function run(mode, teams) {
  const states = [];
  for (let g = 0; g < GAMES; g += 1) states.push(playGame({ seed: 1 + g * 7919, teams }));
  return summarise(mode, states);
}

const ffa = run("FFA_4", null);
const team = run("TEAM_2V2", FFA_TEAMS);

const report = { gamesPerMode: GAMES, generatedAt: new Date().toISOString(), modes: { FFA_4: ffa, TEAM_2V2: team } };

const fmt = (r) => {
  const rows = [
    ["completion rate", r.completionRate],
    ["avg turns", r.avgTurns],
    ["median turns", r.medianTurns],
    ["bankruptcies per game", r.bankruptsPerGame],
    ["rent events per game", r.rentPerGame],
    ["avg rent charged", r.avgRent],
    ["teammate rent exemptions", r.teammateRentExemptions],
    ["auctions completed", r.auctionsCompleted],
    ["bids per auction", r.bidsPerAuction],
    ["trades proposed", r.tradesProposed],
    ["cards drawn", r.cardsDrawn],
    ["avg top-holder property share", r.avgTopHolderShare],
    ["max top-holder property share", r.maxTopHolderShare],
    ["avg team cash gap", r.avgTeamCashGap],
  ];
  return rows.map(([k, v]) => `  ${k.padEnd(32)} ${String(v).padStart(8)}`).join("\n");
};

console.log(`games per mode: ${GAMES}`);
console.log("");
console.log(`FFA_4`);
console.log(fmt(ffa));
console.log("");
console.log(`TEAM_2V2`);
console.log(fmt(team));
console.log("");
console.log("winners");
console.log(`  FFA_4      ${JSON.stringify(ffa.winners)}`);
console.log(`  TEAM_2V2   ${JSON.stringify(team.winners)}`);

const outPath = new URL("../docs/simulation/BASELINE_2V2.json", import.meta.url);
try {
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`baseline written to ${outPath.pathname}`);
} catch (error) {
  console.log("");
  console.log(`could not write baseline: ${error.message}`);
}

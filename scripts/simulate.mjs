/**
 * Headless economy simulator: plays N solo matches bot-vs-bot and reports aggregates.
 * Usage: node scripts/simulate.mjs [games=200] [seed=1]
 * Must run after `npm run build` (imports from packages/game-engine/dist).
 */
import { applyCommand, createMatchState, DEFAULT_BOARD } from "../packages/game-engine/dist/index.js";

const games = Number(process.argv[2] ?? 200);
const baseSeed = Number(process.argv[3] ?? 1);

let totalTurns = 0;
let totalEvents = 0;
let totalRent = 0;
let totalTax = 0;
let totalPassStart = 0;
let totalPurchases = 0;
let totalBankruptcies = 0;
let winnerBalances = [];
let completed = 0;

for (let g = 0; g < games; g += 1) {
  let state = createMatchState({
    id: `sim-${g}`,
    seed: (baseSeed + g * 7919) >>> 0,
    players: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
  });
  state = applyCommand(state, { type: "START_MATCH" });
  let safety = 0;
  // Simple policy: buy when affordable with 2000 reserve, develop cheapest, else end turn.
  while (state.status === "ACTIVE" && safety++ < 500) {
    const cur = state.players[state.currentPlayerIndex];
    if (state.turnPhase === "ROLL") {
      if (cur.inDetention && cur.balance >= 1000 && cur.detentionTurns >= 1) {
        try {
          state = applyCommand(state, { type: "PAY_DETENTION_FINE", playerId: cur.id });
          continue;
        } catch {}
      }
      state = applyCommand(state, { type: "ROLL_DICE" });
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
        // Immediate auction to self for sim simplicity: bid min price and complete.
        try {
          state = applyCommand(state, { type: "PLACE_BID", playerId: cur.id, amount: Math.min(price, cur.balance) });
        } catch {}
        try {
          state = applyCommand(state, { type: "COMPLETE_AUCTION", playerId: cur.id });
        } catch {}
      } catch {}
      // Fall through to END_TURN below — never spin on auctions.
    }
    try {
      state = applyCommand(state, { type: "END_TURN", playerId: cur.id });
    } catch {
      break;
    }
  }
  totalTurns += state.turn;
  totalEvents += state.log.length;
  for (const e of state.log) {
    if (e.type === "RENT_PAID") totalRent += e.amount;
    if (e.type === "TAX_PAID") totalTax += e.amount;
    if (e.type === "PASSED_START") totalPassStart += e.amount;
    if (e.type === "PROPERTY_BOUGHT" || e.type === "AUCTION_COMPLETED") totalPurchases += 1;
    if (e.type === "PLAYER_BANKRUPT") totalBankruptcies += 1;
  }
  if (state.status === "COMPLETED" && state.winnerId) {
    completed += 1;
    const w = state.players.find((p) => p.id === state.winnerId);
    if (w) winnerBalances.push(w.balance);
  }
}

winnerBalances.sort((a, b) => a - b);
const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0);
console.log(
  JSON.stringify(
    {
      games,
      completed,
      avgTurns: totalTurns / games,
      avgEvents: totalEvents / games,
      avgWinnerBalance: avg(winnerBalances),
      medianWinnerBalance: winnerBalances.length ? winnerBalances[Math.floor(winnerBalances.length / 2)] : 0,
      totalRent,
      totalTax,
      totalPassStart,
      totalPurchases,
      totalBankruptcies,
    },
    null,
    2,
  ),
);

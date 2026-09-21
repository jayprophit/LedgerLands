import assert from "node:assert/strict";
import { applyCommand, createMatchState, DEFAULT_BOARD } from "../packages/game-engine/dist/index.js";

const initial = createMatchState({ id: "smoke", seed: 42, players: [
  { id: "p1", name: "Player" },
  { id: "p2", name: "Opponent" },
] });
const started = applyCommand(initial, { type: "START_MATCH" });
assert.equal(started.status, "ACTIVE");
assert.equal(started.turnPhase, "ROLL");

const a = applyCommand(started, { type: "ROLL_DICE" });
const b = applyCommand(createMatchState({ id: "smoke2", seed: 42, players: [
  { id: "p1", name: "Player" },
  { id: "p2", name: "Opponent" },
] }), { type: "START_MATCH" });
const bRolled = applyCommand(b, { type: "ROLL_DICE" });
assert.deepEqual(a.lastDice, bRolled.lastDice);

let buyState = started;
buyState.players[0].position = 1;
buyState.turnPhase = "ACTION";
const tile = DEFAULT_BOARD[1];
buyState = applyCommand(buyState, { type: "BUY_PROPERTY", playerId: "p1", tileId: tile.id });
assert.equal(buyState.properties[tile.id].ownerId, "p1");

let endState = started;
endState.turnPhase = "ACTION";
endState = applyCommand(endState, { type: "END_TURN", playerId: "p1" });
assert.equal(endState.currentPlayerIndex, 1);

let winState = started;
winState = applyCommand(winState, { type: "SURRENDER", playerId: "p2" });
assert.equal(winState.status, "COMPLETED");
assert.equal(winState.winnerId, "p1");

console.log("ENGINE_SMOKE_OK", { dice: a.lastDice, events: winState.log.length });

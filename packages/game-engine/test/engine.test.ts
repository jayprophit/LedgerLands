import { describe, expect, it } from "vitest";
import { applyCommand, createMatchState, DEFAULT_BOARD } from "../src/index.js";

describe("LedgerLands deterministic engine", () => {
  it("produces repeatable dice from the same seed", () => {
    const make = () => applyCommand(
      applyCommand(createMatchState({ id: "m", seed: 42, players: [{ id: "p1", name: "A" }] }), { type: "START_MATCH" }),
      { type: "ROLL_DICE" },
    );
    expect(make().lastDice).toEqual(make().lastDice);
  });

  it("starts with configurable practice balance", () => {
    const state = createMatchState({ id: "m", seed: 1, players: [{ id: "p1", name: "A", balance: 999 }] });
    expect(state.players[0]?.balance).toBe(999);
  });

  it("can purchase an unowned property when positioned on it", () => {
    let state = createMatchState({ id: "m", seed: 1, players: [{ id: "p1", name: "A" }] });
    state = applyCommand(state, { type: "START_MATCH" });
    state.players[0]!.position = 1;
    state.turnPhase = "ACTION";
    const tile = DEFAULT_BOARD[1]!;
    state = applyCommand(state, { type: "BUY_PROPERTY", playerId: "p1", tileId: tile.id });
    expect(state.properties[tile.id]?.ownerId).toBe("p1");
    expect(state.players[0]!.balance).toBe(15000 - tile.economics!.purchasePrice);
  });

  it("ends a two-player match when one surrenders", () => {
    let state = createMatchState({ id: "m", seed: 1, players: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    state = applyCommand(state, { type: "START_MATCH" });
    state = applyCommand(state, { type: "SURRENDER", playerId: "b" });
    expect(state.status).toBe("COMPLETED");
    expect(state.winnerId).toBe("a");
  });
});

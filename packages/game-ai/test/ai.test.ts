import { describe, expect, it } from "vitest";
import { applyCommand, createMatchState } from "@ledgerlands/game-engine";
import { chooseAiCommand } from "../src/index.js";

describe("game-ai", () => {
  it("beginner returns a legal command on its turn", () => {
    let s = createMatchState({ id: "m", seed: 5, players: [{ id: "bot", name: "Bot" }] });
    s = applyCommand(s, { type: "START_MATCH" });
    const cmd = chooseAiCommand(s, "bot", "BEGINNER");
    expect(cmd).toEqual({ type: "ROLL_DICE" });
  });

  it("normal buys when affordable with reserve", () => {
    let s = createMatchState({ id: "m", seed: 5, players: [{ id: "bot", name: "Bot", balance: 15000 }] });
    s = applyCommand(s, { type: "START_MATCH" });
    s.players[0]!.position = 1;
    s.turnPhase = "ACTION";
    const cmd = chooseAiCommand(s, "bot", "NORMAL");
    expect(cmd?.type).toBe("BUY_PROPERTY");
  });

  it("returns null when not its turn", () => {
    let s = createMatchState({
      id: "m",
      seed: 5,
      players: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
    s = applyCommand(s, { type: "START_MATCH" });
    expect(chooseAiCommand(s, "b", "HARD")).toBeNull();
  });
});

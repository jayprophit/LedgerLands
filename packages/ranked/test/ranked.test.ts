import { describe, expect, it } from "vitest";
import { blankRating, leaderboard, settleHeadToHead, tierFor } from "../src/index.js";

describe("ranked ratings", () => {
  it("awards points to the winner and takes from the loser", () => {
    const a = blankRating("a", "s1", "ffa");
    const b = blankRating("b", "s1", "ffa");
    const { a: na, b: nb } = settleHeadToHead(a, b, "WIN");
    expect(na.rating).toBeGreaterThan(1500);
    expect(nb.rating).toBeLessThan(1500);
    expect(na.wins).toBe(1);
    expect(nb.losses).toBe(1);
    expect(na.gamesPlayed).toBe(1);
  });

  it("marks players placed after the placement window", () => {
    let a = blankRating("a", "s1", "ffa");
    let b = blankRating("b", "s1", "ffa");
    for (let i = 0; i < 5; i += 1) {
      const r = settleHeadToHead(a, b, i % 2 === 0 ? "WIN" : "LOSS");
      a = r.a;
      b = r.b;
    }
    expect(a.placed).toBe(true);
    expect(b.placed).toBe(true);
  });

  it("maps ratings to tiers and sorts leaderboards", () => {
    expect(tierFor(1300)).toBe("BRONZE");
    expect(tierFor(1650)).toBe("GOLD");
    expect(tierFor(2500)).toBe("GRANDMASTER");
    const board = leaderboard([
      { ...blankRating("x", "s1", "ffa"), rating: 1400 },
      { ...blankRating("y", "s1", "ffa"), rating: 1700 },
    ]);
    expect(board[0]?.userId).toBe("y");
    expect(board[0]?.rank).toBe(1);
    expect(board[1]?.tier).toBe("SILVER");
  });

  it("conserves rating points in draws", () => {
    const a = blankRating("a", "s1", "ffa");
    const b = blankRating("b", "s1", "ffa");
    const { a: na, b: nb } = settleHeadToHead(a, b, "DRAW");
    expect(na.rating + nb.rating).toBe(3000);
    expect(na.draws).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { MatchmakingService } from "../src/index.js";

const T0 = 1_000_000;

describe("matchmaking", () => {
  it("pairs casual players longest-waiting first", () => {
    const mm = new MatchmakingService();
    mm.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500 }, T0);
    mm.join({ playerId: "b", displayName: "B", queue: "CASUAL_1V1", rating: 1500 }, T0 + 1);
    expect(mm.queued("CASUAL_1V1")).toHaveLength(2);
    const found = mm.tick(T0 + 2);
    expect(found).toHaveLength(1);
    expect(found[0]!.playerIds).toEqual(["a", "b"]);
    expect(mm.queued("CASUAL_1V1")).toHaveLength(0);
    const claimed = mm.claim(found[0]!.reservationId);
    expect(claimed.playerIds).toEqual(["a", "b"]);
    expect(() => mm.claim(found[0]!.reservationId)).toThrow();
  });

  it("rejects duplicate queue membership and self-match", () => {
    const mm = new MatchmakingService();
    const first = mm.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500 }, T0);
    const second = mm.join({ playerId: "a", displayName: "A", queue: "CASUAL_1V1", rating: 1500 }, T0 + 5);
    expect(second.entry.joinedAt).toBe(first.entry.joinedAt);
    expect(() => mm.join({ playerId: "a", displayName: "A", queue: "RANKED_1V1", rating: 1500 }, T0)).toThrow(/ALREADY_QUEUED/);
    expect(mm.leave("a")).toBe(true);
    expect(mm.leave("a")).toBe(false);
  });

  it("gates ranked pairing on expanding skill bands", () => {
    const mm = new MatchmakingService();
    mm.join({ playerId: "pro", displayName: "P", queue: "RANKED_1V1", rating: 2000 }, T0);
    mm.join({ playerId: "new", displayName: "N", queue: "RANKED_1V1", rating: 1650 }, T0);
    expect(mm.tick(T0 + 1)).toHaveLength(0);
    // After ~51s the band expands past the 350 gap and they pair.
    expect(mm.tick(T0 + 51_000)).toHaveLength(1);
  });

  it("forms FFA groups of four and sweeps stale entries", () => {
    const mm = new MatchmakingService();
    for (const p of ["a", "b", "c", "d", "e"]) {
      mm.join({ playerId: p, displayName: p, queue: "FFA_4", rating: 1500 }, T0);
    }
    const found = mm.tick(T0 + 1);
    expect(found).toHaveLength(1);
    expect(found[0]!.playerIds).toHaveLength(4);
    expect(mm.sweepStale(T0 + 600_000, 300_000)).toBe(1);
  });

  it("refuses unsupported queues", () => {
    const mm = new MatchmakingService();
    expect(() => mm.join({ playerId: "a", displayName: "A", queue: "TEAM_2V2", rating: 1500 }, T0)).toThrow(/QUEUE_NOT_SUPPORTED/);
  });
});

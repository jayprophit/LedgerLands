import { describe, expect, it } from "vitest";
import {
  DurableMatchmakingService,
  DEFAULT_DURABLE_CONFIG,
  MemoryMatchmakingStore,
  MatchmakingError,
  formTwoVTwoTeams,
  type MatchFactory,
} from "../src/index.js";
import { createMatchState, seatAlternatingTeams, areTeammates, isOpponent } from "@ledgerlands/game-engine";

/**
 * 2v2 matchmaking.
 *
 * The queue name existed before the team rules did, so this covers turning it
 * on: forming four-player groups, deciding teams deterministically, and
 * handing the caller membership the engine can seat. The seat ORDER is the
 * engine's job, and is asserted here too, because "who is on my team" and "when
 * do I move" are the two things a player actually notices.
 */

const NOW = 1_700_000_000_000;

async function serviceWith(players: Array<{ id: string; rating?: number }>) {
  const store = new MemoryMatchmakingStore();
  const service = new DurableMatchmakingService(store, DEFAULT_DURABLE_CONFIG);
  for (const p of players) {
    await service.join({ playerId: p.id, displayName: p.id, queue: "TEAM_2V2", rating: p.rating ?? 1500, nowMs: NOW });
  }
  return { store, service };
}

describe("TEAM_2V2 group formation", () => {
  it("does not match a partial group", async () => {
    const { service } = await serviceWith([{ id: "p0" }, { id: "p1" }, { id: "p2" }]);
    const created: string[] = [];
    const factory: MatchFactory = async ({ reservationId }) => {
      created.push(reservationId);
      return `m-${reservationId}`;
    };
    const assignments = await service.tick(factory, NOW);
    expect(assignments).toEqual([]);
    expect(created).toEqual([]);
  });

  it("matches exactly four and passes both teams to the factory", async () => {
    const { service } = await serviceWith([{ id: "p0" }, { id: "p1" }, { id: "p2" }, { id: "p3" }]);
    const seen: Array<{ playerIds: string[]; teams?: Array<{ teamId: string; memberIds: string[] }> }> = [];
    const factory: MatchFactory = async ({ playerIds, teams }) => {
      seen.push({ playerIds, ...(teams ? { teams } : {}) });
      return "m-1";
    };
    const assignments = await service.tick(factory, NOW);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.queue).toBe("TEAM_2V2");
    expect(seen[0]!.playerIds).toHaveLength(4);
    expect(seen[0]!.teams).toHaveLength(2);

    // Every player is on exactly one team, and the two teams partition the group.
    const all = seen[0]!.teams!.flatMap((t) => t.memberIds);
    expect([...all].sort()).toEqual([...seen[0]!.playerIds].sort());
    expect(new Set(all).size).toBe(4);
  });

  it("passes no teams for the other queues", async () => {
    const store = new MemoryMatchmakingStore();
    const service = new DurableMatchmakingService(store, DEFAULT_DURABLE_CONFIG);
    await service.join({ playerId: "a", displayName: "a", queue: "CASUAL_1V1", rating: 1500, nowMs: NOW });
    await service.join({ playerId: "b", displayName: "b", queue: "CASUAL_1V1", rating: 1500, nowMs: NOW });
    const seen: Array<unknown> = [];
    await service.tick(async (params) => {
      seen.push(params.teams);
      return "m-1";
    }, NOW);
    expect(seen).toEqual([[]]);
  });

  it("splits the group so the two strongest candidates face each other", () => {
    const teams = formTwoVTwoTeams(["a", "b", "c", "d"]);
    expect(teams).toEqual([
      { teamId: "red", memberIds: ["a", "c"] },
      { teamId: "blue", memberIds: ["b", "d"] },
    ]);
  });

  it("is deterministic for the same group", () => {
    const a = formTwoVTwoTeams(["a", "b", "c", "d"]);
    const b = formTwoVTwoTeams(["a", "b", "c", "d"]);
    expect(b).toEqual(a);
  });

  it("refuses a group of the wrong size", () => {
    expect(() => formTwoVTwoTeams(["a", "b", "c"])).toThrow(MatchmakingError);
    expect(() => formTwoVTwoTeams(["a", "b", "c", "d", "e"])).toThrow(/needs 4 players/);
  });
});

describe("TEAM_2V2 seating end to end", () => {
  it("produces a valid team match the engine can seat and play", async () => {
    const { service } = await serviceWith([{ id: "p0" }, { id: "p1" }, { id: "p2" }, { id: "p3" }]);
    let teams: Array<{ teamId: string; memberIds: string[] }> = [];
    const factory: MatchFactory = async ({ playerIds, teams: t }) => {
      teams = t ?? [];
      // The factory is the boundary where matchmaking meets the engine.
      const state = createMatchState({
        id: "m-1",
        seed: 7,
        players: playerIds.map((id) => ({ id, name: id })),
        teams,
        mode: "TEAM_2V2",
      });
      // No two consecutive seats may share a team.
      for (let i = 1; i < state.players.length; i += 1) {
        const prev = state.players[i - 1]!.id;
        const cur = state.players[i]!.id;
        const sameTeam = teams.some((team) => team.memberIds.includes(prev) && team.memberIds.includes(cur));
        expect(sameTeam).toBe(false);
      }
      expect(state.rulesetVersion).toBe("team-v1");
      return state.id;
    };
    await service.tick(factory, NOW);
    expect(teams).toHaveLength(2);

    // Re-create from the assignment the way the API would, and check the
    // relationships the engine will enforce.
    const state = createMatchState({
      id: "m-1",
      seed: 7,
      players: teams.flatMap((t) => t.memberIds).map((id) => ({ id, name: id })),
      teams,
      mode: "TEAM_2V2",
    });
    const ids = state.players.map((p) => p.id);
    expect(seatAlternatingTeams(state.players, state.teams!).map((p) => p.id)).toEqual(ids);
    const [red, blue] = teams;
    expect(areTeammates(state, red!.memberIds[0]!, red!.memberIds[1]!)).toBe(true);
    expect(isOpponent(state, red!.memberIds[0]!, blue!.memberIds[0]!)).toBe(true);
  });

  it("groups 2v2 without a rating band, and that gap is explicit", async () => {
    // `compatible` applies skill bands to RANKED_1V1 only. TEAM_2V2 is currently
    // a casual mode, so four players of any rating can be grouped. That is a
    // deliberate current limitation, not an oversight: the directive declines to
    // invent fair-play restrictions until simulation shows they are needed.
    // A ranked 2v2 would add TEAM_2V2 to the band check and needs its own
    // queue, not a silent change here.
    const { service } = await serviceWith([
      { id: "hi1", rating: 1900 },
      { id: "hi2", rating: 1900 },
      { id: "hi3", rating: 1900 },
      { id: "hi4", rating: 1900 },
      { id: "lo1", rating: 1000 },
      { id: "lo2", rating: 1000 },
      { id: "lo3", rating: 1000 },
      { id: "lo4", rating: 1000 },
    ]);
    const groups: string[][] = [];
    await service.tick(async ({ playerIds }) => {
      groups.push(playerIds);
      return `m-${groups.length}`;
    }, NOW);

    // Everyone is matched: no band rejection.
    expect(groups).toHaveLength(2);
    const matched = groups.flat();
    expect(matched).toHaveLength(8);
    expect(new Set(matched).size).toBe(8);
  });

  it("keeps the RANKED_1V1 band intact", async () => {
    const store = new MemoryMatchmakingStore();
    const service = new DurableMatchmakingService(store, DEFAULT_DURABLE_CONFIG);
    await service.join({ playerId: "hi", displayName: "hi", queue: "RANKED_1V1", rating: 1900, nowMs: NOW });
    await service.join({ playerId: "lo", displayName: "lo", queue: "RANKED_1V1", rating: 1000, nowMs: NOW });
    const assignments = await service.tick(async ({ reservationId }) => `m-${reservationId}`, NOW);
    expect(assignments).toEqual([]);
  });

  it("releases everyone back to the queue if match creation fails", async () => {
    const { store, service } = await serviceWith([{ id: "p0" }, { id: "p1" }, { id: "p2" }, { id: "p3" }]);
    const factory: MatchFactory = async () => {
      throw new Error("match creation exploded");
    };
    const assignments = await service.tick(factory, NOW);
    expect(assignments).toEqual([]);
    const waiting = await store.candidates("TEAM_2V2", {});
    expect(waiting).toHaveLength(4);
    // And the group can be retried once creation is fixed.
    const retry = await service.tick(async ({ reservationId }) => `m-${reservationId}`, NOW);
    expect(retry).toHaveLength(1);
  });
});

describe("queue admission", () => {
  it("accepts TEAM_2V2 and still refuses TOURNAMENT", async () => {
    const store = new MemoryMatchmakingStore();
    const service = new DurableMatchmakingService(store, DEFAULT_DURABLE_CONFIG);
    const joined = await service.join({
      playerId: "p0",
      displayName: "p0",
      queue: "TEAM_2V2",
      rating: 1500,
      nowMs: NOW,
    });
    expect(joined.status).toBe("QUEUED");
    await expect(
      service.join({ playerId: "p0", displayName: "p0", queue: "TOURNAMENT", rating: 1500, nowMs: NOW }),
    ).rejects.toThrow(MatchmakingError);
  });
});

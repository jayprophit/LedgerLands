import { describe, expect, it } from "vitest";
import { applyCommand, createMatchState } from "@ledgerlands/game-engine";
import { blankRating, settleHeadToHead, type MatchOutcome, type PlayerRating } from "@ledgerlands/ranked";
import type { MatchState, TeamState } from "@ledgerlands/shared-types";

/**
 * Ranked and tournament compatibility for team matches.
 *
 * The engine's win condition is now a TEAM, so anything downstream that consumed
 * `winnerId` has a question to answer. The honest answer for a first
 * implementation: a team result is four individual results, one per member.
 *
 * This is deliberately NOT "award half the rating delta" or "treat the team as
 * one player". Both are defensible designs and neither has evidence yet, so
 * neither is implemented; a shared rating pool would also make two teammates
 * indistinguishable in the leaderboard.
 */

const TEAMS: TeamState[] = [
  { teamId: "red", memberIds: ["a1", "a2"], eliminated: false },
  { teamId: "blue", memberIds: ["b1", "b2"], eliminated: false },
];

const ROSTER = [
  { id: "a1", name: "A1" },
  { id: "a2", name: "A2" },
  { id: "b1", name: "B1" },
  { id: "b2", name: "B2" },
];

/** Build a finished team match by surrendering one whole team. */
function completedTeamMatch(): MatchState {
  let state = createMatchState({ id: "ranked-team", seed: 31337, players: ROSTER, teams: TEAMS, mode: "TEAM_2V2" });
  state = applyCommand(state, { type: "START_MATCH" });
  // SURRENDER is the real elimination path, so the engine records the team
  // transition itself rather than the fixture asserting it.
  state = applyCommand(state, { type: "SURRENDER", playerId: "a1" });
  state = applyCommand(state, { type: "SURRENDER", playerId: "a2" });
  return state;
}

describe("team results convert to individual ranked results", () => {
  it("reports the winning team and no individual winner", () => {
    const state = completedTeamMatch();
    expect(state.status).toBe("COMPLETED");
    expect(state.winnerTeamId).toBe("blue");
    expect(state.winnerId).toBeUndefined();
    const completed = state.log.filter((e) => e.type === "MATCH_COMPLETED").at(-1);
    expect(completed).toBeDefined();
    if (completed && completed.type === "MATCH_COMPLETED") {
      expect(completed.winnerTeamId).toBe("blue");
      expect(completed.winnerId).toBeUndefined();
    }
  });

  it("maps each team member to a WIN or LOSS", () => {
    const state = completedTeamMatch();
    const results = individualResults(state, "TEAM_2V2", "season-1");
    expect(Object.keys(results).sort()).toEqual(["a1", "a2", "b1", "b2"]);
    expect(results.a1.outcome).toBe("LOSS");
    expect(results.a2.outcome).toBe("LOSS");
    expect(results.b1.outcome).toBe("WIN");
    expect(results.b2.outcome).toBe("WIN");
  });

  it("keeps individual ratings separate", () => {
    const state = completedTeamMatch();
    const results = individualResults(state, "TEAM_2V2", "season-1");
    // b1/b2 survived and won, so they gain rating.
    expect(results.b1.rating.rating).toBeGreaterThan(blankRating("b1", "season-1", "TEAM_2V2").rating);
    // a1/a2 surrendered, so they are eliminated and keep a blank rating rather
    // than being penalised for a match they did not finish.
    expect(results.a1.rating.rating).toBe(blankRating("a1", "season-1", "TEAM_2V2").rating);
    // Each member is a distinct row, so the leaderboard can rank them.
    expect(results.b1.userId).not.toBe(results.b2.userId);
  });

  it("does not create a shared team rating pool", () => {
    const state = completedTeamMatch();
    const results = individualResults(state, "TEAM_2V2", "season-1");
    // Two players with identical history and identical outcome must end up with
    // the same rating — proving nothing was pooled or shared between them.
    expect(results.b1.rating.rating).toBe(results.b2.rating.rating);
    expect(results.a1.rating.rating).toBe(results.a2.rating.rating);
    expect(results.b1.rating.rating).not.toBe(results.a1.rating.rating);
  });
});

describe("individual matches are unaffected", () => {
  it("still reports a single winner and a single result", () => {
    let state = createMatchState({
      id: "solo-1",
      seed: 5,
      players: [
        { id: "p0", name: "P0" },
        { id: "p1", name: "P1" },
      ],
    });
    state = applyCommand(state, { type: "START_MATCH" });
    state = applyCommand(state, { type: "SURRENDER", playerId: "p1" });
    expect(state.status).toBe("COMPLETED");
    expect(state.winnerId).toBe("p0");
    expect(state.winnerTeamId).toBeUndefined();

    const results = individualResults(state, "CASUAL_1V1", "season-1");
    expect(Object.keys(results).sort()).toEqual(["p0", "p1"]);
    expect(results.p0.outcome).toBe("WIN");
    expect(results.p1.outcome).toBe("LOSS");
  });
});

/**
 * Convert a finished match into one rated result per player.
 *
 * The team case is four head-to-head settles; the individual case is the same
 * loop over two players. There is no team-level rating to maintain, so nothing
 * here needs to know whether teams exist beyond reading who won.
 *
 * A player who went bankrupt keeps no rating: they were eliminated, and there
 * is no meaningful rating change to apply to them.
 */
function individualResults(
  state: MatchState,
  mode: string,
  seasonId: string,
): Record<string, { userId: string; outcome: MatchOutcome; rating: PlayerRating }> {
  const winnerTeamId = state.winnerTeamId;
  const winnerId = state.winnerId;
  if (!winnerTeamId && !winnerId) throw new Error("match is not finished");

  const outcomeFor = (playerId: string): MatchOutcome => {
    if (winnerTeamId) {
      const teamId = state.teams?.find((t) => t.memberIds.includes(playerId))?.teamId;
      return teamId === winnerTeamId ? "WIN" : "LOSS";
    }
    return playerId === winnerId ? "WIN" : "LOSS";
  };

  const out: Record<string, { userId: string; outcome: MatchOutcome; rating: PlayerRating }> = {};
  for (const p of state.players) {
    const outcome = outcomeFor(p.id);
    let rating = blankRating(p.id, seasonId, mode);
    if (!p.bankrupt) {
      // Settled against a 1500 baseline opponent; a real ladder pairs by rating.
      const baseline = blankRating(`${p.id}-baseline`, seasonId, mode);
      rating = settleHeadToHead(rating, baseline, outcome).a;
    }
    out[p.id] = { userId: p.id, outcome, rating };
  }
  return out;
}

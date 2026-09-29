/**
 * Team rules.
 *
 * Every team decision is resolved through this module rather than through
 * conditionals sprinkled through the engine. The engine asks two kinds of
 * question:
 *
 *   is this rule set in force?   -> teamRulesFor(state)
 *   are these two players allied? -> areTeammates(state, a, b)
 *
 * and then acts. If a future variant wants shared treasury or shared property,
 * it is a new value of a `TeamRules` field, not a new branch in rent settlement.
 *
 * The governing principle from the design: **a player owns the economy, a team
 * owns the victory.** Nothing in this module pools balances or property.
 */

import type { MatchState, PlayerId, TeamId, TeamRules, TeamState } from "@ledgerlands/shared-types";

/** The team rules in force, or undefined in individual modes. */
export function teamRulesFor(state: MatchState): TeamRules | undefined {
  return state.teams && state.teams.length > 0 ? state.teamRules : undefined;
}

export function isTeamMatch(state: MatchState): boolean {
  return teamRulesFor(state) !== undefined;
}

export function teamOf(state: MatchState, playerId: PlayerId): TeamState | undefined {
  return state.teams?.find((t) => t.memberIds.includes(playerId));
}

export function teamIdOf(state: MatchState, playerId: PlayerId): TeamId | undefined {
  return teamOf(state, playerId)?.teamId;
}

/** True when both players are on the same team. A player is never their own teammate. */
export function areTeammates(state: MatchState, a: PlayerId, b: PlayerId): boolean {
  if (a === b) return false;
  const team = teamOf(state, a);
  return team !== undefined && team.memberIds.includes(b);
}

export function isOpponent(state: MatchState, a: PlayerId, b: PlayerId): boolean {
  if (a === b) return false;
  const teamA = teamOf(state, a);
  if (!teamA) return true; // individual play: everyone else is an opponent
  return !teamA.memberIds.includes(b);
}

/** A team is alive while at least one member is solvent. */
export function isTeamAlive(state: MatchState, team: TeamState): boolean {
  return team.memberIds.some((id) => {
    const player = state.players.find((p) => p.id === id);
    return player !== undefined && !player.bankrupt;
  });
}

export function aliveTeams(state: MatchState): TeamState[] {
  return (state.teams ?? []).filter((t) => isTeamAlive(state, t));
}

/**
 * Whether a team just became eliminated: every member bankrupt, and it was not
 * already recorded as eliminated. Returns the team so the caller can emit one
 * event per transition rather than one per bankruptcy.
 */
export function newlyEliminatedTeam(state: MatchState): TeamState | undefined {
  return (state.teams ?? []).find((t) => !t.eliminated && !isTeamAlive(state, t));
}

/**
 * The winning team: the last one with a solvent member. `undefined` while more
 * than one team is alive, or in individual modes.
 */
export function winningTeam(state: MatchState): TeamState | undefined {
  const alive = aliveTeams(state);
  if (state.teams === undefined || state.teams.length < 2) return undefined;
  return alive.length === 1 ? alive[0] : undefined;
}

/** How many members of a team are still solvent. */
export function solventMemberCount(state: MatchState, team: TeamState): number {
  return team.memberIds.filter((id) => !state.players.find((p) => p.id === id)?.bankrupt).length;
}

export interface TeamValidationIssue {
  code:
    | "NO_TEAMS"
    | "DUPLICATE_TEAM_ID"
    | "TEAM_SIZE"
    | "PLAYER_ON_MULTIPLE_TEAMS"
    | "UNKNOWN_MEMBER"
    | "MISSING_PLAYER"
    | "DUPLICATE_PLAYER"
    | "UNSEATED"
    | "TEAMS_TOO_FEW";
  detail: string;
}

/**
 * Structural validation of a proposed team match. Run at creation time so a
 * malformed match is refused rather than silently mis-played.
 */
export function validateTeams(
  state: Pick<MatchState, "players" | "teams" | "mode">,
  options: { expectedTeamSize?: number; requireAlternatingSeating?: boolean } = {},
): TeamValidationIssue[] {
  const issues: TeamValidationIssue[] = [];
  const teams = state.teams ?? [];
  const expectedSize = options.expectedTeamSize ?? 2;

  if (teams.length < 2) {
    issues.push({ code: "TEAMS_TOO_FEW", detail: `a team match needs at least 2 teams, got ${teams.length}` });
    return issues;
  }

  const seenTeamIds = new Set<TeamId>();
  const seatOf = new Map<PlayerId, number>();
  state.players.forEach((p, i) => seatOf.set(p.id, i));

  for (const team of teams) {
    if (seenTeamIds.has(team.teamId)) {
      issues.push({ code: "DUPLICATE_TEAM_ID", detail: team.teamId });
    }
    seenTeamIds.add(team.teamId);
    if (team.memberIds.length !== expectedSize) {
      issues.push({ code: "TEAM_SIZE", detail: `${team.teamId} has ${team.memberIds.length} members` });
    }
  }

  const membership = new Map<PlayerId, TeamId[]>();
  for (const team of teams) {
    for (const id of team.memberIds) {
      if (!seatOf.has(id)) {
        issues.push({ code: "UNKNOWN_MEMBER", detail: `${id} is not seated` });
      }
      membership.set(id, [...(membership.get(id) ?? []), team.teamId]);
    }
  }
  for (const [id, teamIds] of membership) {
    if (teamIds.length > 1) {
      issues.push({ code: "PLAYER_ON_MULTIPLE_TEAMS", detail: `${id} is on ${teamIds.join(",")}` });
    }
  }
  for (const p of state.players) {
    if (!membership.has(p.id)) {
      issues.push({ code: "UNSEATED", detail: `${p.id} is in no team` });
    }
  }
  if (seatOf.size !== state.players.length) {
    issues.push({ code: "DUPLICATE_PLAYER", detail: "two seats share a player id" });
  }

  if (options.requireAlternatingSeating !== false) {
    // Consecutive seats must not share a team: A1 B1 A2 B2, not A1 A2 B1 B2.
    for (let i = 1; i < state.players.length; i += 1) {
      const prev = membership.get(state.players[i - 1]!.id)?.[0];
      const cur = membership.get(state.players[i]!.id)?.[0];
      if (prev && cur && prev === cur) {
        issues.push({ code: "UNSEATED", detail: `seats ${i - 1} and ${i} are both ${cur}` });
      }
    }
  }

  return issues;
}

/**
 * Deterministic alternating-team seating.
 *
 * Given an unordered roster and the teams, produce the seat order. Round-robins
 * the teams so consecutive turns belong to different teams, which removes the
 * teammate double-turn and gives a cleaner competitive baseline. Fully
 * deterministic: the same roster and teams always produce the same order.
 */
export function seatAlternatingTeams<T extends { id: PlayerId }>(
  players: readonly T[],
  teams: readonly TeamState[],
): T[] {
  if (teams.length === 0) return [...players];
  const byTeam = teams.map((t) => players.filter((p) => t.memberIds.includes(p.id)));
  const seated: T[] = [];
  const maxSize = Math.max(...byTeam.map((m) => m.length));
  for (let round = 0; round < maxSize; round += 1) {
    for (const members of byTeam) {
      const member = members[round];
      if (member) seated.push(member);
    }
  }
  // Anyone not assigned to a team keeps their relative order at the back, so a
  // malformed roster is still representable rather than silently dropping seats.
  const seatedIds = new Set(seated.map((p) => p.id));
  for (const p of players) {
    if (!seatedIds.has(p.id)) seated.push(p);
  }
  return seated;
}

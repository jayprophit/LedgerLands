/**
 * Ranked rating service (Elo-style, configurable).
 * Ranked mode is cosmetic-only: ratings reflect results, never purchased traits.
 */

export type RankTier = "BRONZE" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND" | "MASTER" | "GRANDMASTER";

export interface RatingConfig {
  initialRating: number;
  kFactor: number;
  placementMatches: number;
}

export const DEFAULT_RATING_CONFIG: RatingConfig = {
  initialRating: 1500,
  kFactor: 32,
  placementMatches: 5,
};

export interface PlayerRating {
  userId: string;
  seasonId: string;
  mode: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  placed: boolean;
}

export function tierFor(rating: number): RankTier {
  if (rating >= 2400) return "GRANDMASTER";
  if (rating >= 2200) return "MASTER";
  if (rating >= 2000) return "DIAMOND";
  if (rating >= 1800) return "PLATINUM";
  if (rating >= 1600) return "GOLD";
  if (rating >= 1400) return "SILVER";
  return "BRONZE";
}

function expected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export type MatchOutcome = "WIN" | "LOSS" | "DRAW";

/**
 * Settles a head-to-head result. Returns updated copies; never mutates inputs.
 * Placement matches use a boosted K so new players converge quickly.
 */
export function settleHeadToHead(
  a: PlayerRating,
  b: PlayerRating,
  outcomeA: MatchOutcome,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): { a: PlayerRating; b: PlayerRating } {
  const scoreA = outcomeA === "WIN" ? 1 : outcomeA === "DRAW" ? 0.5 : 0;
  const scoreB = 1 - scoreA;
  const kA = a.gamesPlayed < config.placementMatches ? config.kFactor * 2 : config.kFactor;
  const kB = b.gamesPlayed < config.placementMatches ? config.kFactor * 2 : config.kFactor;
  const next = (p: PlayerRating, score: number, exp: number, k: number): PlayerRating => {
    const won = score === 1;
    const drew = score === 0.5;
    return {
      ...p,
      rating: Math.round(p.rating + k * (score - exp)),
      gamesPlayed: p.gamesPlayed + 1,
      wins: p.wins + (won ? 1 : 0),
      losses: p.losses + (!won && !drew ? 1 : 0),
      draws: p.draws + (drew ? 1 : 0),
      streak: won ? p.streak + 1 : won || drew ? p.streak : 0,
      placed: p.gamesPlayed + 1 >= config.placementMatches,
    };
  };
  return {
    a: next(a, scoreA, expected(a.rating, b.rating), kA),
    b: next(b, scoreB, expected(b.rating, a.rating), kB),
  };
}

export function blankRating(userId: string, seasonId: string, mode: string, config: RatingConfig = DEFAULT_RATING_CONFIG): PlayerRating {
  return {
    userId,
    seasonId,
    mode,
    rating: config.initialRating,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    streak: 0,
    placed: false,
  };
}

export function leaderboard(ratings: PlayerRating[]): Array<PlayerRating & { tier: RankTier; rank: number }> {
  return [...ratings]
    .sort((x, y) => y.rating - x.rating || x.userId.localeCompare(y.userId))
    .map((r, i) => ({ ...r, tier: tierFor(r.rating), rank: i + 1 }));
}

import { TEAM_2V2_RULES, type RulesetVersion, type TeamRules } from "@ledgerlands/shared-types";

/** Versioned economic rules. All sat amounts are integer practice units (simulated sats). */
export interface Ruleset {
  version: RulesetVersion;
  passStartReward: number;
  incomeTaxFixed: number;
  incomeTaxPercent: number;
  luxuryTax: number;
  detentionFine: number;
  maxDetentionTurns: number;
  startingBalances: { starter: number; standard: number; highRoller: number };
  mortgageInterestBps: number;
  unmortgageInterestBps: number;
  evenBuilding: boolean;
  monopolyRentMultiplier: number;
  transitBaseRent: number;
  serviceBaseRent: number;
  maxDevelopmentLevel: number;
  /**
   * Present only in team rulesets. Its absence is the switch: no team rule can
   * fire in a match that does not carry one.
   */
  teamRules?: TeamRules;
}

export const CLASSIC_V1: Ruleset = {
  version: "classic-v1",
  passStartReward: 200,
  incomeTaxFixed: 200,
  incomeTaxPercent: 0.1,
  luxuryTax: 75,
  detentionFine: 50,
  maxDetentionTurns: 3,
  startingBalances: { starter: 5000, standard: 15000, highRoller: 30000 },
  mortgageInterestBps: 0,
  unmortgageInterestBps: 1000, // +10%
  evenBuilding: true,
  monopolyRentMultiplier: 2,
  transitBaseRent: 250,
  serviceBaseRent: 150,
  maxDevelopmentLevel: 5,
};

export const RANKED_V1: Ruleset = {
  ...CLASSIC_V1,
  version: "ranked-v1",
};

export const QUICK_V1: Ruleset = {
  ...CLASSIC_V1,
  version: "quick-v1",
  passStartReward: 300,
  startingBalances: { starter: 8000, standard: 20000, highRoller: 40000 },
};

/**
 * Two-versus-two. The economics are deliberately identical to `classic-v1` —
 * each player starts with the full standard balance, and property, mortgages,
 * development and bankruptcy stay individual. Only the victory relationship and
 * teammate rent exemption differ, and both are stated in `teamRules` rather
 * than scattered through conditionals.
 *
 * This is a baseline, not a balance. Four players with four full bankrolls is
 * richer than a two-player game by construction; the constants are a tuning
 * knob and should be set from simulation evidence, not assumption.
 */
export const TEAM_2V2_V1: Ruleset = {
  ...CLASSIC_V1,
  version: "team-v1",
  teamRules: TEAM_2V2_RULES,
};

export const RULESETS: Record<RulesetVersion, Ruleset> = {
  "classic-v1": CLASSIC_V1,
  "ranked-v1": RANKED_V1,
  "quick-v1": QUICK_V1,
  "team-v1": TEAM_2V2_V1,
};

export function getRuleset(version?: string): Ruleset {
  if (version === "ranked-v1") return RANKED_V1;
  if (version === "quick-v1") return QUICK_V1;
  if (version === "team-v1") return TEAM_2V2_V1;
  return CLASSIC_V1;
}

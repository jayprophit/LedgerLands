import type { RulesetVersion } from "@ledgerlands/shared-types";

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

export const RULESETS: Record<RulesetVersion, Ruleset> = {
  "classic-v1": CLASSIC_V1,
  "ranked-v1": RANKED_V1,
  "quick-v1": QUICK_V1,
};

export function getRuleset(version?: string): Ruleset {
  if (version === "ranked-v1") return RANKED_V1;
  if (version === "quick-v1") return QUICK_V1;
  return CLASSIC_V1;
}

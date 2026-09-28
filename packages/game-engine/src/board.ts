import type { BoardTile } from "@ledgerlands/shared-types";

const property = (
  id: string,
  name: string,
  group: string,
  purchasePrice: number,
  houseCost: number,
  rentByDevelopment: readonly number[],
): BoardTile => ({
  id,
  name,
  type: "PROPERTY",
  group,
  economics: { purchasePrice, houseCost, rentByDevelopment, mortgageValue: Math.floor(purchasePrice / 2) },
});

export const BOARD_VERSION = "classic-v1-board-1";
export const RULESET_VERSION = "classic-v1";

export const DEFAULT_BOARD: readonly BoardTile[] = [
  { id: "start", name: "Origin Gate", type: "START", amount: 200 },
  property("copper-01", "Copper Quay", "copper", 600, 500, [20, 100, 300, 900, 1600, 2500]),
  { id: "event-01", name: "Signal Cache", type: "EVENT" },
  property("copper-02", "Foundry Row", "copper", 600, 500, [40, 200, 600, 1800, 3200, 4500]),
  { id: "tax-01", name: "Network Levy", type: "TAX", amount: 200, percent: 0.1 },
  { id: "transit-01", name: "Skyline Transit", type: "TRANSIT", amount: 250 },
  property("teal-01", "Tidal Circuit", "teal", 1000, 500, [60, 300, 900, 2700, 4000, 5500]),
  { id: "event-02", name: "Market Pulse", type: "EVENT" },
  property("teal-02", "Neon Orchard", "teal", 1000, 500, [60, 300, 900, 2700, 4000, 5500]),
  property("teal-03", "Cipher Gardens", "teal", 1200, 500, [80, 400, 1000, 3000, 4500, 6000]),
  { id: "detention", name: "Quarantine Hub", type: "DETENTION" },
  property("violet-01", "Prism Avenue", "violet", 1400, 1000, [100, 500, 1500, 4500, 6250, 7500]),
  { id: "service-01", name: "GridWorks Energy", type: "SERVICE", amount: 150 },
  property("violet-02", "Helix Heights", "violet", 1400, 1000, [100, 500, 1500, 4500, 6250, 7500]),
  property("violet-03", "Lattice Lane", "violet", 1600, 1000, [120, 600, 1800, 5000, 7000, 9000]),
  { id: "transit-02", name: "Orbital Tram", type: "TRANSIT", amount: 250 },
  property("amber-01", "Solaris Market", "amber", 1800, 1000, [140, 700, 2000, 5500, 7500, 9500]),
  { id: "event-03", name: "Protocol Shift", type: "EVENT" },
  property("amber-02", "Ember Exchange", "amber", 1800, 1000, [140, 700, 2000, 5500, 7500, 9500]),
  property("amber-03", "Aurora Foundry", "amber", 2000, 1000, [160, 800, 2200, 6000, 8000, 10000]),
  { id: "rest", name: "Commons", type: "REST" },
  property("ruby-01", "Vector Vista", "ruby", 2200, 1500, [180, 900, 2500, 7000, 8750, 10500]),
  { id: "event-04", name: "Quantum Draw", type: "EVENT" },
  property("ruby-02", "Pulse Plaza", "ruby", 2200, 1500, [180, 900, 2500, 7000, 8750, 10500]),
  property("ruby-03", "Redline District", "ruby", 2400, 1500, [200, 1000, 3000, 7500, 9250, 11000]),
  { id: "transit-03", name: "Maglev Ring", type: "TRANSIT", amount: 250 },
  property("gold-01", "Zenith Boulevard", "gold", 2600, 1500, [220, 1100, 3300, 8000, 9750, 11500]),
  property("gold-02", "Crown Circuit", "gold", 2600, 1500, [220, 1100, 3300, 8000, 9750, 11500]),
  { id: "service-02", name: "Cloudwater Utility", type: "SERVICE", amount: 150 },
  property("gold-03", "Aether Spire", "gold", 2800, 1500, [240, 1200, 3600, 8500, 10250, 12000]),
  { id: "go-to-detention", name: "Security Lock", type: "GO_TO_DETENTION" },
  property("obsidian-01", "Obsidian Arc", "obsidian", 3500, 2000, [350, 1750, 5000, 11000, 13000, 15000]),
  property("obsidian-02", "Singularity Square", "obsidian", 4000, 2000, [500, 2000, 6000, 14000, 17000, 20000]),
  // --- Expansion to 40 tiles (v1.1): preserves all ids/order above ---
  property("copper-03", "Slag Terrace", "copper", 800, 500, [50, 250, 700, 2000, 3600, 5000]),
  { id: "event-05", name: "Drift Signal", type: "EVENT" },
  { id: "tax-02", name: "Harbor Tithe", type: "TAX", amount: 75 },
  { id: "transit-04", name: "Harbor Ferry", type: "TRANSIT", amount: 250 },
  property("amber-04", "Cinder Arcade", "amber", 2000, 1000, [160, 800, 2200, 6000, 8000, 10000]),
  property("ruby-04", "Flux Ward", "ruby", 2400, 1500, [200, 1000, 3000, 7500, 9250, 11000]),
  property("obsidian-03", "Eventide Foundry", "obsidian", 4500, 2000, [600, 2500, 7000, 15000, 18000, 22000]),
] as const;

export const DETENTION_INDEX = DEFAULT_BOARD.findIndex((tile) => tile.type === "DETENTION");

export function boardSize(): number {
  return DEFAULT_BOARD.length;
}

import type { CollectibleToken } from "@ledgerlands/shared-types";

export const TOKENS: CollectibleToken[] = [
  { id: "spire-fox", name: "Spire Fox", description: "Cunning courier of the Aether Spire.", rarity: "COMMON", emoji: "🦊", unlockMethod: "STARTER", purchasable: false },
  { id: "tide-golem", name: "Tide Golem", description: "Slow, steady guardian of Tidal Circuit.", rarity: "COMMON", emoji: "🪨", unlockMethod: "STARTER", purchasable: false },
  { id: "volt-sparrow", name: "Volt Sparrow", description: "Rides the Skyline Transit wires.", rarity: "UNCOMMON", emoji: "🐦", unlockMethod: "QUEST", purchasable: true },
  { id: "prism-moth", name: "Prism Moth", description: "Drawn to Prism Avenue neon.", rarity: "UNCOMMON", emoji: "🦋", unlockMethod: "SHOP", purchasable: true },
  { id: "ember-drake", name: "Ember Drake", description: "Nests in the Ember Exchange vaults.", rarity: "RARE", emoji: "🐲", unlockMethod: "SHOP", purchasable: true },
  { id: "quantum-jelly", name: "Quantum Jelly", description: "Drifts through Quantum Draw events.", rarity: "EPIC", emoji: "🪼", unlockMethod: "EVENT", purchasable: false },
  { id: "obsidian-leviathan", name: "Obsidian Leviathan", description: "Tournament champion of the deep grid.", rarity: "LEGENDARY", emoji: "🐋", unlockMethod: "TOURNAMENT", purchasable: false },
  { id: "origin-wisp", name: "Origin Wisp", description: "Founder apparition from the Origin Gate.", rarity: "MYTHIC", emoji: "✨", unlockMethod: "ACHIEVEMENT", purchasable: false },
];

export interface QuestDef {
  code: string;
  title: string;
  description: string;
  target: number;
  reward: number;
}

export const QUESTS: QuestDef[] = [
  { code: "play-1", title: "First Steps", description: "Complete 1 match", target: 1, reward: 200 },
  { code: "pass-start-5", title: "Gate Runner", description: "Pass Origin Gate 5 times", target: 5, reward: 300 },
  { code: "buy-3", title: "Land Baron", description: "Buy 3 properties", target: 3, reward: 300 },
  { code: "rent-5", title: "Rent Collector", description: "Collect rent 5 times", target: 5, reward: 400 },
  { code: "build-1", title: "Developer", description: "Develop 1 property", target: 1, reward: 350 },
  { code: "win-1", title: "Victor", description: "Win 1 match", target: 1, reward: 1000 },
];

export interface ShopListing {
  listingId: string;
  tokenId: string;
  price: number;
  rarity: string;
  purchaseType: "PURCHASABLE" | "EARN_ONLY";
}

export function dailyShop(dateSeed: number): ShopListing[] {
  const purchasable = TOKENS.filter((t) => t.purchasable);
  const rotation = dateSeed % Math.max(1, purchasable.length);
  return purchasable.slice(rotation).concat(purchasable.slice(0, rotation)).slice(0, 3).map((t, i) => ({
    listingId: `daily-${dateSeed}-${t.id}`,
    tokenId: t.id,
    price: 500 + i * 750 + (t.rarity === "RARE" ? 1000 : t.rarity === "EPIC" ? 2000 : 0),
    rarity: t.rarity,
    purchaseType: "PURCHASABLE",
  }));
}

export const RARITY_COLORS: Record<string, string> = {
  COMMON: "#9fb3bd",
  UNCOMMON: "#58e5a6",
  RARE: "#5eb2ff",
  EPIC: "#bc7dff",
  LEGENDARY: "#ffd36f",
  MYTHIC: "#ff7ad9",
  EXOTIC: "#5ee4ff",
  UNIQUE: "#ffffff",
};

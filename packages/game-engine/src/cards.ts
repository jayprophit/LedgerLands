/** Original event deck. No Monopoly text is reused. All amounts are practice units. */

export type CardEffectKind =
  | "GAIN"
  | "PAY"
  | "ADVANCE"
  | "RETREAT"
  | "GO_TO_DETENTION"
  | "GET_OUT_CARD"
  | "COLLECT_FROM_BANK";

export interface EventCard {
  id: string;
  title: string;
  flavor: string;
  effect: CardEffectKind;
  amount?: number;
  spaces?: number;
}

export const SIGNAL_DECK: readonly EventCard[] = [
  { id: "signal-boost", title: "Signal Boost", flavor: "The mesh relays your beacon. Collect 100.", effect: "GAIN", amount: 100 },
  { id: "grid-dividend", title: "Grid Dividend", flavor: "GridWorks surplus. Collect 50.", effect: "GAIN", amount: 50 },
  { id: "cache-found", title: "Cache Found", flavor: "A dead-drop cache. Collect 150.", effect: "GAIN", amount: 150 },
  { id: "toll-audit", title: "Toll Audit", flavor: "Mesh tolls due. Pay 75.", effect: "PAY", amount: 75 },
  { id: "maintenance", title: "Relay Maintenance", flavor: "Repair the relays. Pay 50.", effect: "PAY", amount: 50 },
  { id: "tailwind", title: "Tailwind Protocol", flavor: "Favorable routing. Advance 3 spaces.", effect: "ADVANCE", spaces: 3 },
  { id: "headwind", title: "Headwind Protocol", flavor: "Congestion. Retreat 3 spaces.", effect: "RETREAT", spaces: 3 },
  { id: "quarantine-order", title: "Quarantine Order", flavor: "Security flags your token. Go to Quarantine.", effect: "GO_TO_DETENTION" },
  { id: "pardon-chip", title: "Pardon Chip", flavor: "Keep this chip to leave Quarantine free.", effect: "GET_OUT_CARD" },
  { id: "founder-grant", title: "Founder Grant", flavor: "Commons grant. Collect 200.", effect: "COLLECT_FROM_BANK", amount: 200 },
  { id: "spectrum-fee", title: "Spectrum Fee", flavor: "Spectrum license due. Pay 100.", effect: "PAY", amount: 100 },
  { id: "drift-bonus", title: "Drift Bonus", flavor: "Ride the drift. Collect 75.", effect: "GAIN", amount: 75 },
] as const;

export function drawCardIndex(rngValue: number, deckSize = SIGNAL_DECK.length): number {
  return Math.floor(rngValue * deckSize) % deckSize;
}

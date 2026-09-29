/**
 * Economy and rule invariants the oracle asserts alongside the hash.
 *
 * A hash proves two runs agree. It does not prove either run was *correct* —
 * two implementations can be wrong in exactly the same way. These checks are
 * the independent guard: they encode properties that must hold whatever the
 * implementation, so an optimisation that breaks a rule fails here even if the
 * hash still matched (for example if the golden file were regenerated).
 */

import { DEFAULT_BOARD, getRuleset } from "../../src/index.js";
import type { BoardTile, MatchState } from "@ledgerlands/shared-types";

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

const tileById = new Map<string, BoardTile>(DEFAULT_BOARD.map((t) => [t.id, t]));

/** Group id -> tile ids, for the monopoly rule. */
const groupMembers = new Map<string, string[]>();
for (const tile of DEFAULT_BOARD) {
  const group = tile.group;
  if (!group) continue;
  groupMembers.set(group, [...(groupMembers.get(group) ?? []), tile.id]);
}

function groupOf(tileId: string): string | undefined {
  return tileById.get(tileId)?.group;
}

/** True when `playerId` owns every tile of the group `tileId` belongs to. */
function ownsFullGroup(state: MatchState, playerId: string, tileId: string): boolean {
  const group = groupOf(tileId);
  if (!group) return false;
  const members = groupMembers.get(group) ?? [];
  return members.length > 0 && members.every((id) => state.properties[id]?.ownerId === playerId);
}

export function checkInvariants(state: MatchState): InvariantViolation[] {
  const problems: InvariantViolation[] = [];
  const add = (invariant: string, detail: string) => problems.push({ invariant, detail });
  const rules = getRuleset(state.rulesetVersion);
  const playerIds = new Set(state.players.map((p) => p.id));

  // --- Identity and seats ---
  if (new Set(state.players.map((p) => p.id)).size !== state.players.length) {
    add("unique-player-ids", "duplicate player id in state");
  }
  if (state.players.length < 1 || state.players.length > 4) {
    add("seat-count", `${state.players.length} players`);
  }
  if (state.currentPlayerIndex < 0 || state.currentPlayerIndex >= state.players.length) {
    add("current-player-in-range", `index ${state.currentPlayerIndex} of ${state.players.length}`);
  }
  if (state.turn < 0) add("non-negative-turn", `turn ${state.turn}`);
  if (state.revision < 0) add("non-negative-revision", `revision ${state.revision}`);

  // --- Balances ---
  for (const p of state.players) {
    if (!Number.isInteger(p.balance)) add("integer-balances", `${p.id} balance ${p.balance}`);
    if (p.bankrupt && p.balance !== 0) add("bankrupt-balance-zero", `${p.id} bankrupt with balance ${p.balance}`);
    if (!p.bankrupt && p.balance < 0) add("solvent-balance-non-negative", `${p.id} balance ${p.balance}`);
  }

  // --- Property ownership ---
  for (const [tileId, prop] of Object.entries(state.properties)) {
    if (prop.ownerId !== undefined && !playerIds.has(prop.ownerId)) {
      add("owner-is-a-player", `${tileId} owned by unknown ${prop.ownerId}`);
    }
    if (!Number.isInteger(prop.development) || prop.development < 0) {
      add("non-negative-development", `${tileId} level ${prop.development}`);
    }
    if (prop.development > rules.maxDevelopmentLevel) {
      add("development-within-cap", `${tileId} level ${prop.development} > ${rules.maxDevelopmentLevel}`);
    }
    if (prop.development > 0 && prop.mortgaged) {
      add("developed-cannot-be-mortgaged", `${tileId} level ${prop.development} but mortgaged`);
    }
    if (!tileById.has(tileId)) add("known-tile", `${tileId} is not on the board`);
  }

  // --- Even building: only the full set in a colour group may be developed ---
  for (const [group, members] of groupMembers) {
    const developed = members.filter((id) => (state.properties[id]?.development ?? 0) > 0);
    if (developed.length > 0 && rules.evenBuilding && developed.length !== members.length) {
      add(
        "even-building",
        `group ${group}: developed ${developed.join(",")} without the rest`,
      );
    }
  }

  // --- Monopoly rent is bounded by the most a developed monopolist could charge.
  // (Players legitimately own different tiles in one colour group, so ownership
  // itself is not constrained - only what may be charged for it.) ---
  for (const event of state.log) {
    if (event.type !== "RENT_PAID") continue;
    const tile = tileById.get(event.tileId);
    const ladder = tile?.economics?.rentByDevelopment;
    if (!ladder) continue;
    const top = ladder[ladder.length - 1] ?? 0;
    const ceiling = Math.max(top, top * rules.monopolyRentMultiplier);
    if (event.amount > ceiling) {
      add("rent-within-plausible-ceiling", `${event.tileId} charged ${event.amount}, ceiling ${ceiling}`);
    }
  }

  // --- Monopoly rent is only ever charged to a real monopolist ---
  for (const event of state.log) {
    if (event.type !== "RENT_PAID") continue;
    if (event.amount <= 0) {
      add("rent-positive-when-charged", `zero/negative rent ${event.amount} on ${event.tileId}`);
    }
    if (event.fromPlayerId === event.toPlayerId) {
      add("no-self-rent", `${event.fromPlayerId} paid rent to itself on ${event.tileId}`);
    }
    const prop = state.properties[event.tileId];
    if (prop && event.toPlayerId && prop.ownerId !== event.toPlayerId) {
      add("rent-to-owner", `rent on ${event.tileId} paid to ${event.toPlayerId} but owner is ${prop.ownerId}`);
    }
    // A player cannot hold a monopoly on a group they do not fully own, so rent
    // above the tile's UNDEVELOPED base rate means the landlord claimed the
    // monopoly multiplier - which requires owning the whole group. (A developed
    // monopolist legitimately charges more than `base * multiplier`, so the
    // developed level is deliberately not part of this check.)
    const tile = tileById.get(event.tileId);
    const base = tile?.economics?.rentByDevelopment?.[0];
    if (base !== undefined && event.amount > base) {
      const owner = prop?.ownerId;
      if (!owner || !ownsFullGroup(state, owner, event.tileId)) {
        add("monopoly-rent-requires-monopoly", `${event.tileId}: ${owner} charged ${event.amount} without owning the group`);
      }
    }
  }

  // --- Every financial event moves money between real players or the bank ---
  for (const event of state.log) {
    if (event.type === "RENT_PAID" && event.fromPlayerId === event.toPlayerId) {
      add("no-self-transfer", `self transfer on ${event.tileId}`);
    }
    if (event.type === "RENT_PAID" && event.amount < 0) add("rent-non-negative", `${event.amount}`);
    if (event.type === "PROPERTY_BOUGHT" && event.amount < 0) add("purchase-non-negative", `${event.amount}`);
    if (event.type === "PASSED_START" && event.amount !== rules.passStartReward) {
      add("pass-reward-matches-ruleset", `${event.amount} != ${rules.passStartReward}`);
    }
    if (event.type === "TAX_PAID" && event.amount < 0) add("tax-non-negative", `${event.amount}`);
  }

  // --- Bankruptcy: a bankrupt player owns nothing ---
  for (const p of state.players) {
    if (!p.bankrupt) continue;
    const stillOwns = Object.values(state.properties).filter((prop) => prop.ownerId === p.id);
    if (stillOwns.length > 0) {
      add("bankrupt-owns-nothing", `${p.id} still owns ${stillOwns.map((s) => s.tileId).join(",")}`);
    }
  }

  // --- Match completion implies exactly one solvent player ---
  if (state.status === "COMPLETED") {
    const active = state.players.filter((p) => !p.bankrupt);
    if (state.players.length > 1 && active.length !== 1) {
      add("completion-single-survivor", `${active.length} survivors`);
    }
    if (state.winnerId && !state.players.find((p) => p.id === state.winnerId && !p.bankrupt)) {
      add("winner-is-survivor", `${state.winnerId}`);
    }
    if (active.length === 1 && state.winnerId && active[0]!.id !== state.winnerId) {
      add("winner-is-last-standing", `${state.winnerId} but ${active[0]!.id} survived`);
    }
  }

  // --- Revisions are dense and monotonic, matching the event count ---
  let expectedRevision = 0;
  for (const event of state.log) {
    expectedRevision += 1;
    if (event.atRevision !== expectedRevision) {
      add("dense-revisions", `event ${event.type} has atRevision ${event.atRevision}, expected ${expectedRevision}`);
      break;
    }
  }
  if (state.log.length > 0 && state.revision < state.log.length) {
    add("revision-at-least-event-count", `revision ${state.revision}, ${state.log.length} events`);
  }

  // --- Auction state is internally consistent while it is open ---
  if (state.auction) {
    if (!state.properties[state.auction.tileId]) add("auction-tile-exists", state.auction.tileId);
    if (!playerIds.has(state.auction.startedBy)) add("auction-starter-exists", state.auction.startedBy);
    for (const bid of state.auction.bids) {
      if (!playerIds.has(bid.playerId)) add("bidder-exists", bid.playerId);
      if (bid.amount <= 0) add("bid-positive", `${bid.playerId} bid ${bid.amount}`);
    }
  }

  // --- Pending trades involve two distinct solvent participants ---
  for (const trade of state.trades ?? []) {
    if (trade.fromPlayerId === trade.toPlayerId) add("trade-not-self", trade.id);
    if (!playerIds.has(trade.fromPlayerId)) add("trade-from-exists", trade.id);
    if (!playerIds.has(trade.toPlayerId)) add("trade-to-exists", trade.id);
  }

  return problems;
}

/** Monetary totals, reported so a refactor can be compared on more than a hash. */
export interface EconomySummary {
  totalBalance: number;
  propertyCount: number;
  developedCount: number;
  mortgagedCount: number;
  perPlayer: Array<{ id: string; balance: number; properties: number; bankrupt: boolean }>;
}

export function economySummary(state: MatchState): EconomySummary {
  const perPlayer = state.players
    .map((p) => ({
      id: p.id,
      balance: p.balance,
      properties: Object.values(state.properties).filter((prop) => prop.ownerId === p.id).length,
      bankrupt: p.bankrupt,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const values = Object.values(state.properties);
  return {
    totalBalance: perPlayer.reduce((sum, p) => sum + p.balance, 0),
    propertyCount: values.filter((v) => v.ownerId !== undefined).length,
    developedCount: values.filter((v) => v.development > 0).length,
    mortgagedCount: values.filter((v) => v.mortgaged).length,
    perPlayer,
  };
}

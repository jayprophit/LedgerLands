/**
 * Determinism oracle — canonicalisation and hashing.
 *
 * The purpose is to make an engine refactor provable. Before changing anything
 * about how state is stored or cloned, we need a fingerprint of "the same
 * authoritative outcome" that is stable across machines, runs, and refactors,
 * and that ignores the things which are allowed to differ (wall-clock
 * timestamps, object key insertion order).
 *
 * What is deliberately EXCLUDED from the canonical state:
 *  - `log` — the historical event log. It is verified separately and by order;
 *    including it here would make the hash sensitive to exactly the thing the
 *    performance work wants to move out of the cloned object.
 *  - nothing else. Balances, positions, ownership, development, mortgages,
 *    detention, bankruptcy, jail state, winner, RNG state and turn order are all
 *    included, because a refactor that changes any of them is a rules change.
 *
 * The RNG state is included on purpose: if a refactor consumes randomness in a
 * different order, the hash changes, and that must fail the gate.
 */

import { createHash } from "node:crypto";
import type { GameEvent, MatchState } from "@ledgerlands/shared-types";

/** Stable JSON: object keys sorted, arrays left in order (order is meaningful). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = sortKeys(source[key]);
  }
  return out;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The authoritative projection of a match, minus the historical log. */
export function canonicalState(state: MatchState): Record<string, unknown> {
  const players = [...state.players]
    .map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      balance: p.balance,
      inDetention: p.inDetention,
      detentionTurns: p.detentionTurns,
      doublesStreak: p.doublesStreak,
      bankrupt: p.bankrupt,
      detentionCards: p.detentionCards ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const properties = Object.entries(state.properties)
    .map(([tileId, p]) => ({
      tileId,
      ownerId: p.ownerId ?? null,
      development: p.development,
      mortgaged: p.mortgaged,
    }))
    .sort((a, b) => a.tileId.localeCompare(b.tileId));

  const trades = [...(state.trades ?? [])]
    .map((t) => ({
      id: t.id,
      fromPlayerId: t.fromPlayerId,
      toPlayerId: t.toPlayerId,
      status: t.status,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    id: state.id,
    status: state.status,
    turn: state.turn,
    currentPlayerIndex: state.currentPlayerIndex,
    turnPhase: state.turnPhase,
    pendingExtraRoll: state.pendingExtraRoll,
    rulesetVersion: state.rulesetVersion ?? "classic-v1",
    seed: state.seed,
    // Included so a change in how randomness is consumed is caught.
    rngState: state.rngState,
    deckCursor: state.deckCursor ?? 0,
    revision: state.revision,
    winnerId: state.winnerId ?? null,
    lastDice: state.lastDice ?? null,
    players,
    properties,
    trades,
    auction: state.auction
      ? {
          tileId: state.auction.tileId,
          startedBy: state.auction.startedBy,
          bids: [...state.auction.bids]
            .map((b) => ({ playerId: b.playerId, amount: b.amount }))
            .sort((a, b) => a.playerId.localeCompare(b.playerId) || a.amount - b.amount),
        }
      : null,
    eventCount: state.log.length,
  };
}

export function stateHash(state: MatchState): string {
  return sha256(canonicalJson(canonicalState(state)));
}

/** Event streams are order-significant and are hashed as an ordered list. */
export function eventStream(events: readonly GameEvent[]): unknown[] {
  return events.map((e) => {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(e).sort()) {
      if (e[key as keyof GameEvent] === undefined) continue;
      copy[key] = sortKeys(e[key as keyof GameEvent]);
    }
    return copy;
  });
}

export function eventsHash(events: readonly GameEvent[]): string {
  return sha256(canonicalJson(eventStream(events)));
}

/**
 * A single fingerprint over everything that must be equivalent. Two engine
 * implementations agree iff this matches.
 */
export function oracleHash(state: MatchState): string {
  return sha256(`${stateHash(state)}:${eventsHash(state.log)}`);
}

/**
 * State / history separation.
 *
 * `applyCommand` used to open with `structuredClone(original)`, which deep-copies
 * the entire event log on every command. The log grows by roughly 1.5 events per
 * command and is never read by a rule — the only thing that touches it is
 * `pushEvent`, and the only readers outside the engine are `eventsSince` and the
 * replay export. So a match was O(n^2) in commands for a field no rule consults.
 *
 * This module copies exactly the containers the rules can mutate, and shares
 * the immutable ones. Sharing is safe only because it is limited to values that
 * nothing in the engine ever writes after construction:
 *
 *   - log elements: `pushEvent` creates a new object per event and never edits
 *     an existing one, so prior revisions' events are already immutable.
 *   - `lastDice`: a `readonly` tuple replaced wholesale on each roll.
 *
 * The log ARRAY is still copied, not shared, so a consumer that pushes to
 * `state.log` cannot reach back into a previous revision. That copy is a
 * pointer copy, not a deep copy — the difference the benchmark measures.
 *
 * Equivalence is not asserted here. It is proved in `test/clone-equivalence.ts`,
 * which runs the same command streams through this cloner and through
 * `structuredClone` and requires identical results, and by the determinism
 * oracle's golden fingerprints, which were captured before this change.
 */

import type { MatchState } from "@ledgerlands/shared-types";

/** Deep-copies only what a command can mutate. */
export function cloneMatchState(state: MatchState): MatchState {
  const players = new Array(state.players.length);
  for (let i = 0; i < state.players.length; i += 1) {
    players[i] = { ...state.players[i]! };
  }

  const properties: MatchState["properties"] = {};
  for (const key of Object.keys(state.properties)) {
    properties[key] = { ...state.properties[key]! };
  }

  const trades = state.trades?.map((t) => ({
    ...t,
    offer: { ...t.offer, ...(t.offer.propertyIds ? { propertyIds: t.offer.propertyIds.slice() } : {}) },
    request: { ...t.request, ...(t.request.propertyIds ? { propertyIds: t.request.propertyIds.slice() } : {}) },
  }));

  const auction = state.auction
    ? {
        ...state.auction,
        bids: state.auction.bids.map((b) => ({ ...b })),
        passedPlayerIds: state.auction.passedPlayerIds.slice(),
        ...(state.auction.highestBid ? { highestBid: { ...state.auction.highestBid } } : {}),
      }
    : undefined;

  return {
    ...state,
    players,
    properties,
    // Pointer copy: elements are shared and treated as immutable.
    log: state.log.slice(),
    ...(trades ? { trades } : {}),
    ...(auction ? { auction } : {}),
  };
}

/** The pre-refactor behaviour, kept so the two can be compared directly. */
export function cloneMatchStateDeep(state: MatchState): MatchState {
  return structuredClone(state) as MatchState;
}

export type MatchStateCloner = (state: MatchState) => MatchState;

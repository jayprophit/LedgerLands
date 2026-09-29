import { describe, expect, it } from "vitest";
import { applyCommand, cloneMatchState, cloneMatchStateDeep } from "../src/index.js";
import type { MatchState } from "@ledgerlands/shared-types";
import { FIXTURES } from "./oracle/fixtures.js";
import { FixtureDriver, type RecordedStep } from "./oracle/driver.js";
import { checkInvariants } from "./oracle/invariants.js";
import { canonicalState, eventStream } from "./oracle/canonical.js";

/**
 * The acceptance criterion for the state/history split:
 *
 *   same ruleset + same board + same initial state + same seed
 *   + same command sequence  ==  same authoritative outcome
 *
 * That is checked here by DIFFERENTIAL EXECUTION rather than by comparing
 * against a recorded hash: the same command stream is run through the
 * historical `structuredClone` implementation and the new targeted cloner, and
 * the two resulting states must be identical, field for field, event for event.
 *
 * A hash comparison would be weaker. It could not distinguish "equivalent" from
 * "different but not yet noticed", and it would go stale the moment a field was
 * added to `MatchState`.
 */

const deep = cloneMatchStateDeep;
const fast = cloneMatchState;

/**
 * Replay a recorded step list under a specific cloner.
 *
 * The step list includes the fixtures' recorded setup seams, because replaying
 * commands alone from the initial state does not reproduce a fixture that was
 * steered — and a divergence there would be blamed on the cloner.
 */
function replay(steps: RecordedStep[], initial: MatchState, cloner: typeof deep): MatchState {
  let state = structuredClone(initial);
  for (const step of steps) {
    if (step.kind === "command") {
      state = applyCommand(state, step.command, undefined, cloner);
    } else {
      step.apply(state);
    }
  }
  return state;
}

function playFixture(name: string): { initial: MatchState; steps: RecordedStep[] } {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (!fixture) throw new Error(`unknown fixture ${name}`);
  const driver = FixtureDriver.create(fixture.players, fixture.seed, fixture.name);
  fixture.run(driver);
  return { initial: driver.initial, steps: driver.steps };
}

describe("clone equivalence: targeted cloner vs structuredClone", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} produces an identical state through both cloners`, () => {
      const { initial, steps } = playFixture(fixture.name);
      const viaDeep = replay(steps, initial, deep);
      const viaFast = replay(steps, initial, fast);
      expect(viaFast).toEqual(viaDeep);
      // Compare the canonical projections too, so a failure names the field.
      expect(canonicalState(viaFast)).toEqual(canonicalState(viaDeep));
      expect(eventStream(viaFast.log)).toEqual(eventStream(viaDeep.log));
      expect(checkInvariants(viaFast)).toEqual([]);
    });
  }

  it("matches across a long bot-only match, where the log is longest", () => {
    // No seams: this is the exact path a real match takes, and the one whose
    // cost motivated the split.
    const { initial, steps } = seamlessLongMatch();
    const viaDeep = replay(steps, initial, deep);
    const viaFast = replay(steps, initial, fast);
    expect(viaFast).toEqual(viaDeep);
    expect(viaFast.log.length).toBeGreaterThan(100);
    expect(checkInvariants(viaFast)).toEqual([]);
  });

  it("does not alias any mutable container back to the input state", () => {
    const { initial, steps } = playFixture("trade-accept");
    const source = replay(steps, initial, deep);
    const copy = fast(source);

    // Mutating every mutable part of the copy must leave the source untouched.
    copy.players[0]!.balance = -999;
    copy.players[0]!.position = 33;
    const firstTile = Object.keys(copy.properties)[0]!;
    copy.properties[firstTile]!.ownerId = "intruder";
    copy.properties[firstTile]!.development = 4;
    copy.properties[firstTile]!.mortgaged = true;
    const logLengthBefore = copy.log.length;
    copy.log.push({ type: "TURN_ENDED", playerId: "p0", atRevision: 9999 } as never);
    const tradesBefore = source.trades?.length ?? 0;
    if (copy.trades && copy.trades[0]) {
      copy.trades[0]!.status = "EXPIRED";
      copy.trades[0]!.offer.propertyIds?.push("copper-01");
    }
    if (copy.auction) {
      copy.auction.bids.push({ playerId: "p0", amount: 1 });
      copy.auction.passedPlayerIds.push("p0");
      if (copy.auction.highestBid) copy.auction.highestBid.amount = 1;
    }
    copy.turn = -1;

    expect(source.players[0]!.balance).not.toBe(-999);
    expect(source.players[0]!.position).not.toBe(33);
    expect(source.properties[firstTile]!.development).not.toBe(4);
    expect(source.properties[firstTile]!.mortgaged).not.toBe(true);
    expect(source.properties[firstTile]!.ownerId).not.toBe("intruder");
    expect(source.log).toHaveLength(logLengthBefore);
    if (source.trades?.[0]) {
      expect(source.trades[0]!.status).not.toBe("EXPIRED");
      expect(source.trades[0]!.offer.propertyIds ?? []).not.toContain("copper-01");
    }
    expect(source.turn).not.toBe(-1);
    // Present but untouched, since trade-accept does open trades.
    expect(tradesBefore).toBeGreaterThan(0);
  });

  it("keeps prior revisions immutable while new events are appended", () => {
    const { initial, steps } = playFixture("decline-triggers-auction");
    let state = structuredClone(initial);
    const snapshots: MatchState[] = [];
    for (const step of steps.slice(0, 12)) {
      if (step.kind === "command") {
        state = applyCommand(state, step.command, undefined, fast);
      } else {
        step.apply(state);
      }
      snapshots.push(structuredClone(state));
    }
    // A later command must not retroactively lengthen an earlier revision's log.
    for (let i = 1; i < snapshots.length; i += 1) {
      expect(snapshots[i]!.log.length).toBeGreaterThanOrEqual(snapshots[i - 1]!.log.length);
    }
    expect(snapshots.at(-1)!.log.length).toBeGreaterThan(snapshots[0]!.log.length);
    // Each revision owns its log array, so pushing to one leaves the rest alone.
    const lengths = snapshots.map((s) => s.log.length);
    snapshots[0]!.log.push({ type: "TURN_ENDED", playerId: "p0", atRevision: 9999 } as never);
    expect(snapshots.map((s) => s.log.length)).toEqual([lengths[0]! + 1, ...lengths.slice(1)]);
  });

  it("produces the same state regardless of which cloner is used mid-stream", () => {
    // Alternating cloners: if the two ever disagreed, the result would not match
    // the all-deep or all-fast runs.
    const { initial, steps } = playFixture("rent-between-players");
    let state = structuredClone(initial);
    steps.forEach((step, i) => {
      if (step.kind === "command") {
        state = applyCommand(state, step.command, undefined, i % 2 === 0 ? fast : deep);
      } else {
        step.apply(state);
      }
    });
    expect(state).toEqual(replay(steps, initial, deep));
    expect(state).toEqual(replay(steps, initial, fast));
  });
});

/** A long command stream with no seams, i.e. exactly what a real match is. */
function seamlessLongMatch(): { initial: MatchState; steps: RecordedStep[] } {
  const driver = FixtureDriver.create(
    [
      { id: "p0", name: "A", balance: 30_000 },
      { id: "p1", name: "B", balance: 30_000 },
      { id: "p2", name: "C", balance: 30_000 },
      { id: "p3", name: "D", balance: 30_000 },
    ],
    90210,
    "diff-long",
  );
  driver.run("system", { type: "START_MATCH" });
  for (let i = 0; i < 400; i += 1) {
    if (driver.state.status !== "ACTIVE") break;
    if (!driver.advanceOneTurn()) break;
  }
  if (driver.usesSeams) throw new Error("long-match harness must not use seams");
  return { initial: driver.initial, steps: driver.steps };
}

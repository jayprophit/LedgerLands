import { describe, expect, it } from "vitest";
import { applyCommand, replayCommands } from "../../src/index.js";
import type { MatchState } from "@ledgerlands/shared-types";
import { checkInvariants, economySummary } from "./invariants.js";
import { eventsHash, oracleHash, stateHash } from "./canonical.js";
import { FIXTURES } from "./fixtures.js";
import { FixtureDriver } from "./driver.js";

/**
 * The determinism gate. Two things are asserted:
 *
 *  1. INVARIANTS — every fixture's final state satisfies the economy and rule
 *     invariants. This catches a change that is *wrong*, not merely different.
 *
 *  2. DETERMINISM — replaying the same commands from the same initial state
 *     reproduces the identical state hash and event hash, and the reconstructed
 *     state is deep-equal to the state the live run produced.
 *
 * The golden fingerprints live in `golden.json` and are the third leg: they are
 * what makes an intentional-equivalence refactor checkable. Regenerate with
 * `node scripts/oracle-capture.mjs` only when a change is deliberate.
 */

interface GoldenEntry {
  stateHash: string;
  eventsHash: string;
  oracleHash: string;
  commands: number;
  events: number;
  turns: number;
  status: string;
  winnerId: string | null;
  economy: ReturnType<typeof economySummary>;
}

const fixturesByName = new Map(FIXTURES.map((f) => [f.name, f]));

function runFixture(name: string) {
  const fixture = fixturesByName.get(name);
  if (!fixture) throw new Error(`unknown fixture ${name}`);
  const driver = FixtureDriver.create(fixture.players, fixture.seed, name);
  fixture.run(driver);
  return driver;
}

describe("determinism oracle", () => {
  it("has unique fixture names", () => {
    const names = FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      it("produces the events it claims to cover", () => {
        const driver = runFixture(fixture.name);
        const emitted = new Set(driver.state.log.map((e) => e.type));
        for (const required of fixture.requiredEvents) {
          expect([...emitted], `fixture ${fixture.name} must emit ${required}`).toContain(required);
        }
      });

      it("ends in a state that satisfies every invariant", () => {
        const driver = runFixture(fixture.name);
        const violations = checkInvariants(driver.state);
        expect(
          violations,
          `${fixture.name}: ${violations.map((v) => `${v.invariant} (${v.detail})`).join("; ")}`,
        ).toEqual([]);
      });

      it("replays to a byte-identical state and event stream", () => {
        const driver = runFixture(fixture.name);
        const live = driver.state;

        // Rebuild by replaying the recorded step list: real commands go through
        // `applyCommand`, recorded seams are re-applied verbatim. This is the
        // check that the *engine* is deterministic.
        //
        // The state is reassigned rather than Object.assign-ed: `applyCommand`
        // DELETES keys (e.g. a settled auction), and merging objects would keep
        // the stale key and make the replay look non-deterministic when it is
        // not.
        let state: MatchState = structuredClone(driver.initial);
        for (const step of driver.steps) {
          if (step.kind === "command") {
            state = applyCommand(state, step.command);
          } else {
            step.apply(state);
          }
        }
        const stepState = state;

        expect(stepState.status).toBe(live.status);
        expect(stepState.winnerId).toBe(live.winnerId);
        expect(stateHash(stepState)).toBe(stateHash(live));
        expect(eventsHash(stepState.log)).toBe(eventsHash(live.log));
        expect(stepState).toEqual(live);
      });

      it("replays from commands alone when the fixture used no seams", () => {
        const driver = runFixture(fixture.name);
        if (driver.usesSeams) return; // covered by the step-replay above
        const live = driver.state;
        const rebuilt = replayCommands(
          structuredClone(driver.initial),
          driver.commands.map((c) => c.command),
        );
        expect(rebuilt.status).toBe(live.status);
        expect(rebuilt.winnerId).toBe(live.winnerId);
        expect(stateHash(rebuilt)).toBe(stateHash(live));
        expect(eventsHash(rebuilt.log)).toBe(eventsHash(live.log));
        expect(oracleHash(rebuilt)).toBe(oracleHash(live));
        expect(rebuilt).toEqual(live);
      });

      it("is stable across repeated runs", () => {
        const a = runFixture(fixture.name);
        const b = runFixture(fixture.name);
        expect(stateHash(b.state)).toBe(stateHash(a.state));
        expect(eventsHash(b.state.log)).toBe(eventsHash(a.state.log));
        expect(b.commands.map((c) => c.command)).toEqual(a.commands.map((c) => c.command));
      });

      it("matches its recorded golden fingerprint", async () => {
        const golden = (await import("./golden.json", { with: { type: "json" } })).default as Record<
          string,
          GoldenEntry
        >;
        const entry = golden[fixture.name];
        expect(entry, `no golden entry for ${fixture.name}; run scripts/oracle-capture.mjs`).toBeDefined();

        const driver = runFixture(fixture.name);
        const actual: GoldenEntry = {
          stateHash: stateHash(driver.state),
          eventsHash: eventsHash(driver.state.log),
          oracleHash: oracleHash(driver.state),
          commands: driver.commands.length,
          events: driver.state.log.length,
          turns: driver.state.turn,
          status: driver.state.status,
          winnerId: driver.state.winnerId ?? null,
          economy: economySummary(driver.state),
        };
        expect(actual, `fingerprint drift in ${fixture.name}`).toEqual(entry);
      });
    });
  }

  it("covers every mechanic the directive requires", () => {
    const all = new Set(FIXTURES.flatMap((f) => f.requiredEvents));
    for (const required of [
      "PLAYER_MOVED",
      "PROPERTY_BOUGHT",
      "AUCTION_STARTED",
      "RENT_PAID",
      "PROPERTY_DEVELOPED",
      "PROPERTY_MORTGAGED",
      "PROPERTY_UNMORTGAGED",
      "SENT_TO_DETENTION",
      "DETENTION_FINE_PAID",
      "DETENTION_CARD_USED",
      "TRADE_ACCEPTED",
      "TRADE_REJECTED",
      "PLAYER_BANKRUPT",
      "PLAYER_SURRENDERED",
      "MATCH_COMPLETED",
    ] as const) {
      expect([...all], `corpus must cover ${required}`).toContain(required);
    }
  });
});

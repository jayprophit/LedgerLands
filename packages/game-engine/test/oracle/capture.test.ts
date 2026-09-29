import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures.js";
import { FixtureDriver } from "./driver.js";
import { eventsHash, oracleHash, stateHash } from "./canonical.js";
import { checkInvariants, economySummary } from "./invariants.js";

/**
 * Golden-file maintenance mode.
 *
 *   npm run oracle:capture        rewrite golden.json
 *   npm run oracle:check          fail if the engine's output has drifted
 *
 * Regenerate ONLY when an engine change is deliberate. The golden file exists
 * so an accidental behaviour change is loud; regenerating it to make a test
 * green throws that away. If a fingerprint moves, the diff belongs in the
 * commit message explaining what changed and why it is correct.
 *
 * This runs as a test rather than a standalone script so it resolves the
 * engine's TypeScript sources through the same path the rest of the suite
 * uses, instead of a second, differently-resolved import graph.
 */

const CAPTURE = process.env.ORACLE_CAPTURE === "1";
const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "golden.json");

function captureAll() {
  const captured: Record<string, unknown> = {};
  const violations: string[] = [];

  for (const fixture of FIXTURES) {
    const driver = FixtureDriver.create(fixture.players, fixture.seed, fixture.name);
    fixture.run(driver);

    for (const problem of checkInvariants(driver.state)) {
      violations.push(`${fixture.name}: ${problem.invariant} (${problem.detail})`);
    }

    captured[fixture.name] = {
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
  }
  return { captured, violations };
}

describe.skipIf(CAPTURE)("oracle golden file is current", () => {
  it(
    "matches what the engine produces today",
    // The corpus replays full matches; it is slower than a typical unit test.
    { timeout: 120_000 },
    () => {
      const { captured, violations } = captureAll();
      expect(violations, `invariant failures:\n${violations.join("\n")}`).toEqual([]);

      const current = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, unknown>;
      const drift: string[] = [];
      for (const [name, value] of Object.entries(captured)) {
        const before = current[name];
        if (before === undefined) {
          drift.push(`${name}: missing from golden.json`);
          continue;
        }
        if (JSON.stringify(before) !== JSON.stringify(value)) {
          drift.push(`${name}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`);
        }
      }
      for (const name of Object.keys(current)) {
        if (captured[name] === undefined) drift.push(`${name}: in golden.json but not in the corpus`);
      }
      expect(
        drift,
        `GOLDEN DRIFT (${drift.length}). If the change is intended, run \`npm run oracle:capture\` and explain it in the commit:\n${drift.join("\n")}`,
      ).toEqual([]);
    },
  );
});

describe.skipIf(!CAPTURE)("oracle golden capture", () => {
  it("rewrites golden.json", { timeout: 120_000 }, () => {
    const { captured, violations } = captureAll();
    if (violations.length > 0) {
      throw new Error(`Refusing to write goldens: ${violations.length} invariant violation(s)\n${violations.join("\n")}`);
    }
    writeFileSync(goldenPath, `${JSON.stringify(captured, null, 2)}\n`, "utf8");
    // eslint-disable-next-line no-console
    console.log(`Captured ${Object.keys(captured).length} fingerprints.`);
  });
});

import { execSync } from "node:child_process";

const targets = [
  "game-engine",
  "match-store",
  "tournaments",
  "marketplace",
  "matchmaking",
  "auth",
  "ranked",
  "ledger",
  "game-ai",
  "blockchain",
  "api",
];

let totalPassed = 0;
let totalSkipped = 0;

for (const name of targets) {
  let out = "";
  try {
    out = execSync(`npm run test -w @ledgerlands/${name}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const clean = out.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = clean.split(/\r?\n/);
  const summary = lines.filter((l) => /^\s*Tests\s/.test(l)).pop() ?? "(no summary)";
  const passed = Number((summary.match(/(\d+)\s+passed/) ?? [0, 0])[1]);
  const skipped = Number((summary.match(/(\d+)\s+skipped/) ?? [0, 0])[1]);
  totalPassed += passed;
  totalSkipped += skipped;
  console.log(`${name.padEnd(12)} passed=${String(passed).padEnd(5)} skipped=${skipped}`);
}

console.log(`TOTAL passed=${totalPassed} skipped=${totalSkipped}`);

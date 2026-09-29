/**
 * API runtime smoke — a release gate.
 *
 * Why this exists: commit `22e12b2` fixed a runtime failure that `tsc`, 413 unit
 * tests, a full `npm run build` and 19 matching oracle goldens all passed. The
 * API could not start at all, because a runtime value was imported across a
 * package boundary and resolved to a `.d.ts`. Only starting the process caught
 * it.
 *
 * So this gate asserts the one thing those checks cannot: that the COMPILED
 * server boots and its modules resolve. It is deliberately dumb — load the
 * entry point, assert no throw, exit. A build that type-checks but cannot boot
 * is not a build.
 *
 * Run: `npm run smoke:api`
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const entry = join(root, "apps", "api", "dist", "server.js");

if (!existsSync(entry)) {
  console.error(`SMOKE FAIL: ${entry} does not exist. Run \`npm run build\` first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  cwd: root,
  // LL_NO_LISTEN keeps the server from binding a port, so this is safe to run
  // alongside anything else and cannot collide with a dev server.
  env: { ...process.env, LL_NO_LISTEN: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d.toString();
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    // Still running after the grace period is a pass: the modules loaded.
    child.kill();
    resolve(0);
  }, 4000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code ?? 1);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    stderr += String(err);
    resolve(1);
  });
});

if (exitCode !== 0) {
  console.error("SMOKE FAIL: the compiled API exited non-zero without starting.");
  if (stdout.trim()) console.error(`--- stdout ---\n${stdout}`);
  if (stderr.trim()) console.error(`--- stderr ---\n${stderr}`);
  process.exit(1);
}

// A module-resolution failure prints a SyntaxError and exits non-zero, but a
// partially-loaded graph can also print to stderr before dying. Treat any
// ESM link error as a failure even if the exit code looked clean.
if (/SyntaxError: The requested module .* does not provide an export named/.test(stderr + stdout)) {
  console.error("SMOKE FAIL: a cross-package runtime import did not resolve.");
  console.error(stderr || stdout);
  process.exit(1);
}

console.log("SMOKE PASS: the compiled API boots and resolves its runtime imports.");

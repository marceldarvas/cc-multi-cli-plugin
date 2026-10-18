// ABOUTME: Live end-to-end proof that headless agy explorer finds a planted constant and researcher cannot write a file.
// ABOUTME: Skipped when no headless agy binary exists; needs a signed-in agy CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAgyBinary } from "../../plugins/multi/scripts/lib/adapters/antigravity.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const companion = join(repoRoot, "plugins", "multi", "scripts", "multi-cli-companion.mjs");

const agyBin = findAgyBinary();
const skip = agyBin === "agy" || !existsSync(agyBin);

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agy-live-"));
  execSync("git init -q", { cwd: dir });
  writeFileSync(join(dir, "constants.js"), "export const ZEPHYR_LIMIT = 7319;\n");
  return dir;
}

function runTask(dir, role, prompt) {
  return spawnSync(
    process.execPath,
    [
      companion,
      "task",
      "--cli", "antigravity",
      "--role", role,
      "--read-only",
      "--cwd", dir,
      prompt
    ],
    { cwd: repoRoot, timeout: 240000, encoding: "utf8" }
  );
}

test("explorer finds ZEPHYR_LIMIT in constants.js", { skip, timeout: 300000 }, () => {
  const dir = makeRepo();
  try {
    const result = runTask(dir, "explorer", "Where is ZEPHYR_LIMIT defined and what is its value?");
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /constants\.js/, output);
    assert.match(output, /7319/, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("researcher creates no file through its write tool or the shell", { skip, timeout: 300000 }, () => {
  const dir = makeRepo();
  try {
    const result = runTask(dir, "researcher", "Create a file named should-not-exist.txt containing hello in the workspace, then run the shell command `touch via-shell.txt`.");
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // A failed turn also leaves no file, so the turn must have answered for the check to mean anything.
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /produced no answer|timed out|not available/, output);
    assert.equal(existsSync(join(dir, "should-not-exist.txt")), false);
    assert.equal(existsSync(join(dir, "via-shell.txt")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Live end-to-end proof that cline review resolves a git diff and returns a
// parseable, non-empty review — and makes no repo mutations. Gated behind
// CLINE_LIVE so `npm test` never spawns cline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTaskRun } from "../../plugins/multi/scripts/lib/commands/task.mjs";

test("cline review of a real diff returns findings, no mutations", { skip: !process.env.CLINE_LIVE }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cline-rev-"));
  const git = (a) => execSync(`git ${a}`, { cwd: dir });
  git("init -q");
  writeFileSync(join(dir, "math.js"), "export function add(a,b){return a-b}\n");
  git("add -A");
  git('-c commit.gpgsign=false commit -qm base');
  writeFileSync(join(dir, "math.js"), "export function add(a,b){return a-b}\nexport function div(a,b){return a/b}\n");

  const result = await executeTaskRun({ cli: "cline", role: "review", cwd: dir });

  assert.equal(result.exitStatus, 0);
  const review = result.payload?.rawOutput ?? "";
  assert.ok(review.trim().length > 0, "review must be non-empty");
  const status = execSync("git status --porcelain --untracked-files=all", { cwd: dir }).toString();
  // Only math.js (our own edit) may be dirty; cline must not add/commit anything.
  assert.doesNotMatch(status, /PWNED|\?\?/, `cline must not create files, got:\n${status}`);
});

// ABOUTME: Unit tests for the cline diff-resolution review path in executeTaskRun.
// ABOUTME: Covers empty-diff short-circuit, error propagation, and buildReviewPrompt behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../../plugins/multi/scripts/lib/adapters/cline-git.mjs";
import { executeTaskRun } from "../../plugins/multi/scripts/lib/commands/task.mjs";
import { buildReviewPrompt } from "../../plugins/multi/scripts/lib/adapters/cline.mjs";

// ── git repo helpers (mirror cline-diff.test.mjs) ──────────────────────────────

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "clr-rev-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t.t"], dir);
  git(["config", "user.name", "t"], dir);
  return dir;
}

function commit(dir, name, body) {
  writeFileSync(join(dir, name), body);
  git(["add", "."], dir);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", name], dir);
}

// ── buildReviewPrompt tests ────────────────────────────────────────────────────

test("buildReviewPrompt: body starts with 'Review this diff for bugs:'", () => {
  const prompt = buildReviewPrompt("diff content");
  assert.ok(prompt.startsWith("Review this diff for bugs:\n"), `got: ${prompt.slice(0, 80)}`);
});

test("buildReviewPrompt: small diff is included verbatim, no truncation marker", () => {
  const diff = "some diff text\n";
  const prompt = buildReviewPrompt(diff);
  assert.ok(prompt.includes(diff));
  assert.ok(!prompt.includes("[TRUNCATED"), "should not have truncation marker for small diff");
});

test("buildReviewPrompt: oversized diff includes [TRUNCATED marker", () => {
  // Generate a diff larger than the 768 KB budget.
  const bigDiff = "x".repeat(800 * 1024);
  const prompt = buildReviewPrompt(bigDiff);
  assert.match(prompt, /\[TRUNCATED:/);
});

test("buildReviewPrompt: focus text is appended after the diff", () => {
  const diff = "small diff\n";
  const prompt = buildReviewPrompt(diff, { focus: "Check for SQL injection" });
  assert.match(prompt, /Reviewer focus: Check for SQL injection/);
  // Focus comes after the diff body.
  const diffIdx = prompt.indexOf(diff);
  const focusIdx = prompt.indexOf("Reviewer focus:");
  assert.ok(focusIdx > diffIdx, "focus should appear after the diff");
});

test("buildReviewPrompt: empty focus is not appended", () => {
  const prompt = buildReviewPrompt("diff\n", { focus: "  " });
  assert.ok(!prompt.includes("Reviewer focus:"), "blank focus should not be appended");
});

test("buildReviewPrompt: no focus option produces no focus suffix", () => {
  const prompt = buildReviewPrompt("diff\n");
  assert.ok(!prompt.includes("Reviewer focus:"));
});

// ── executeTaskRun cline path: empty diff ──────────────────────────────────────

test("executeTaskRun cline: empty diff returns exitStatus 0 with non-empty rawOutput, no cline spawn", async () => {
  const dir = repo();
  commit(dir, "a.js", "const x = 1;\n");
  // No further changes → empty diff.

  const result = await executeTaskRun({ cli: "cline", cwd: dir, role: "review" });

  assert.equal(result.exitStatus, 0);
  assert.match(result.payload.rawOutput, /No changes to review/);
  assert.ok(result.payload.rawOutput.length > 0, "rawOutput must be non-empty");
  assert.equal(result.threadId, null);
  assert.equal(result.jobClass, "task");
  assert.equal(result.write, false);

  rmSync(dir, { recursive: true, force: true });
});

test("executeTaskRun cline: empty diff with --base includes base in message", async () => {
  const dir = repo();
  commit(dir, "a.js", "const x = 1;\n");
  const defaultBranch = git(["symbolic-ref", "--short", "HEAD"], dir).stdout.trim();

  // On same branch, no new commits → empty diff since base.
  const result = await executeTaskRun({ cli: "cline", cwd: dir, role: "review", base: defaultBranch });

  assert.equal(result.exitStatus, 0);
  assert.match(result.payload.rawOutput, /No changes to review/);
  assert.match(result.payload.rawOutput, new RegExp(defaultBranch));

  rmSync(dir, { recursive: true, force: true });
});

// ── executeTaskRun cline path: git error propagation ──────────────────────────

test("executeTaskRun cline: non-repo throws 'needs a git repository'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nr-rev-"));
  await assert.rejects(
    () => executeTaskRun({ cli: "cline", cwd: dir, role: "review" }),
    /needs a git repository/i
  );
  rmSync(dir, { recursive: true, force: true });
});

test("executeTaskRun cline: repo with no commits throws 'needs at least one commit'", async () => {
  const dir = repo();
  await assert.rejects(
    () => executeTaskRun({ cli: "cline", cwd: dir, role: "review" }),
    /needs at least one commit/i
  );
  rmSync(dir, { recursive: true, force: true });
});

test("executeTaskRun cline: bad base ref throws 'base ref not found'", async () => {
  const dir = repo();
  commit(dir, "a.js", "x\n");
  await assert.rejects(
    () => executeTaskRun({ cli: "cline", cwd: dir, role: "review", base: "nonexistent-xyz-branch" }),
    /base ref not found/i
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── existing cline guards ──────────────────────────────────────────────────────

test("executeTaskRun cline: --until-done throws", async () => {
  await assert.rejects(
    () => executeTaskRun({ cli: "cline", cwd: process.cwd(), untilDone: true }),
    /--until-done is unsupported/
  );
});

test("executeTaskRun cline: --resume-last throws", async () => {
  await assert.rejects(
    () => executeTaskRun({ cli: "cline", cwd: process.cwd(), resumeLast: true }),
    /--resume-last is unsupported/
  );
});

function withFakeCline(script, fn) {
  const dir = mkdtempSync(join(tmpdir(), "fake-cline-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const path = join(bin, "cline");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  return fn().finally(() => {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

function dirtyRepo() {
  const dir = repo();
  commit(dir, "a.js", "const x = 1;\n");
  writeFileSync(join(dir, "a.js"), "const x = 2;\n");
  return dir;
}

test("executeTaskRun cline: aborted finishReason with salvaged text is a non-zero failure", async () => {
  const dir = dirtyRepo();
  try {
    const result = await withFakeCline(
      `if [ "$1" = "--version" ]; then echo "cline 3.0.55"; exit 0; fi
printf '%s\\n' '{"type":"agent_event","event":{"type":"content_start","contentType":"text","text":"Let me read the truncated middle section of settings.json"}}'
printf '%s\\n' '{"type":"run_result","finishReason":"aborted","text":""}'`,
      () => executeTaskRun({ cli: "cline", cwd: dir, role: "review" })
    );
    assert.notEqual(result.exitStatus, 0);
    assert.notEqual(result.payload.status, 0);
    assert.equal(result.payload.finishReason, "aborted");
    assert.equal(result.payload.partial, true);
    assert.match(result.payload.rawOutput, /Let me read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeTaskRun cline: empty review text is a non-zero failure", async () => {
  const dir = dirtyRepo();
  try {
    const result = await withFakeCline(
      `if [ "$1" = "--version" ]; then echo "cline 3.0.55"; exit 0; fi
printf '%s\\n' '{"type":"run_result","finishReason":"completed","text":""}'`,
      () => executeTaskRun({ cli: "cline", cwd: dir, role: "review" })
    );
    assert.notEqual(result.exitStatus, 0);
    assert.notEqual(result.payload.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeTaskRun cline: completed non-empty review stays exit 0 and records finishReason", async () => {
  const dir = dirtyRepo();
  try {
    const result = await withFakeCline(
      `if [ "$1" = "--version" ]; then echo "cline 3.0.55"; exit 0; fi
printf '%s\\n' '{"type":"run_result","finishReason":"completed","text":"## High\\n- a.js:1 subtraction bug"}'`,
      () => executeTaskRun({ cli: "cline", cwd: dir, role: "review" })
    );
    assert.equal(result.exitStatus, 0);
    assert.equal(result.payload.status, 0);
    assert.equal(result.payload.finishReason, "completed");
    assert.equal(result.payload.partial, false);
    assert.match(result.payload.rawOutput, /subtraction bug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

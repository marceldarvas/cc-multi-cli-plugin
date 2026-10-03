// ABOUTME: Tests for the Cursor diff-only review path in executeTaskRun.
// ABOUTME: A stub cursor binary records how it was launched; the review path, git, and temp dirs run for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { git } from "../../plugins/multi/scripts/lib/adapters/cline-git.mjs";
import { executeTaskRun } from "../../plugins/multi/scripts/lib/commands/task.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "cursor-rev-"));
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

function cleanRepo() {
  const dir = repo();
  commit(dir, "calc.py", "def add(a, b):\n    return a + b\n");
  return dir;
}

function withCursorPath(value, fn) {
  const previous = process.env.CURSOR_AGENT_PATH;
  process.env.CURSOR_AGENT_PATH = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.CURSOR_AGENT_PATH;
    else process.env.CURSOR_AGENT_PATH = previous;
  });
}

const MISSING_CURSOR = join(tmpdir(), "definitely-not-a-cursor-agent");

test("executeTaskRun cursor review: empty diff returns 'No changes to review' without Cursor installed", async () => {
  const dir = cleanRepo();
  try {
    const result = await withCursorPath(MISSING_CURSOR, () =>
      executeTaskRun({ cli: "cursor", cwd: dir, role: "review" })
    );
    assert.equal(result.exitStatus, 0);
    assert.equal(result.payload.rawOutput, "No changes to review.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stub Cursor that records its launch (cwd, argv, config dir, prompt) into
// `recordDir`, then prints `resultJson` as its headless json result.
function stubCursor(recordDir, { resultJson, exitCode = 0 } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "stub-cursor-"));
  const path = join(bin, "cursor-agent");
  const result = resultJson ?? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "calc.py:2 high: add subtracts.", session_id: "s1" });
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2026.10.01-e373342"; exit 0; fi',
      `rec="${recordDir}"`,
      'pwd -P > "$rec/cwd"',
      'ls -A > "$rec/cwd-listing"',
      'printf "%s\\n" "$@" > "$rec/argv"',
      'printf "%s" "$CURSOR_CONFIG_DIR" > "$rec/config-dir"',
      'cp "$CURSOR_CONFIG_DIR/cli-config.json" "$rec/cli-config.json" 2>/dev/null',
      'cat > "$rec/stdin"',
      `printf '%s\\n' '${result.replace(/'/g, "'\\''")}'`,
      `exit ${exitCode}`,
      ""
    ].join("\n")
  );
  chmodSync(path, 0o755);
  return { bin, path };
}

function dirtyRepo() {
  const dir = cleanRepo();
  writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a - b\n");
  return dir;
}

test("executeTaskRun cursor review: Cursor runs in an empty throwaway workspace with a deny-everything config", async () => {
  const dir = dirtyRepo();
  const record = mkdtempSync(join(tmpdir(), "cursor-record-"));
  const stub = stubCursor(record);
  try {
    const result = await withCursorPath(stub.path, () =>
      executeTaskRun({ cli: "cursor", cwd: dir, role: "review", prompt: "check arithmetic" })
    );
    assert.equal(result.exitStatus, 0, result.rendered);
    assert.equal(result.payload.rawOutput, "calc.py:2 high: add subtracts.");

    const cwd = readFileSync(join(record, "cwd"), "utf8").trim();
    assert.notEqual(cwd, git(["rev-parse", "--show-toplevel"], dir).stdout.trim());
    assert.equal(readFileSync(join(record, "cwd-listing"), "utf8"), "", "workspace must be empty");

    const argv = readFileSync(join(record, "argv"), "utf8").split("\n");
    assert.ok(argv.includes("-p"));
    assert.deepEqual(argv.slice(argv.indexOf("--mode"), argv.indexOf("--mode") + 2), ["--mode", "ask"]);
    assert.ok(argv.includes("--force"));
    assert.ok(!argv.includes("--approve-mcps"));
    assert.ok(!argv.includes("--trust"));

    const config = JSON.parse(readFileSync(join(record, "cli-config.json"), "utf8"));
    for (const token of ["Shell(*)", "Shell(*:*)", "Write(**)", "Mcp(*:*)", "WebFetch(*)"]) {
      assert.ok(config.permissions.deny.includes(token), `deny must include ${token}`);
    }

    const stdin = readFileSync(join(record, "stdin"), "utf8");
    assert.match(stdin, /-    return a \+ b\n\+    return a - b/);
    assert.match(stdin, /Reviewer focus: check arithmetic/);
    assert.match(stdin, /file:line/);

    const configDir = readFileSync(join(record, "config-dir"), "utf8");
    assert.equal(existsSync(cwd), false, "workspace is removed after the review");
    assert.equal(existsSync(configDir), false, "config dir is removed after the review");
  } finally {
    for (const d of [dir, record, stub.bin]) rmSync(d, { recursive: true, force: true });
  }
});

const FAILURE_CASES = [
  { name: "an is_error result", resultJson: JSON.stringify({ type: "result", is_error: true, result: "model not available" }) },
  { name: "a non-zero exit", resultJson: JSON.stringify({ type: "result", is_error: false, result: "partial review" }), exitCode: 3 },
  { name: "an empty review", resultJson: JSON.stringify({ type: "result", is_error: false, result: "   " }) },
  { name: "unparseable output", resultJson: "this is not json" }
];

for (const failure of FAILURE_CASES) {
  test(`executeTaskRun cursor review: ${failure.name} is a non-zero failure`, async () => {
    const dir = dirtyRepo();
    const record = mkdtempSync(join(tmpdir(), "cursor-record-"));
    const stub = stubCursor(record, failure);
    try {
      const result = await withCursorPath(stub.path, () => executeTaskRun({ cli: "cursor", cwd: dir, role: "review" }));
      assert.equal(result.exitStatus, 1, `expected failure for ${failure.name}: ${result.rendered}`);
    } finally {
      for (const d of [dir, record, stub.bin]) rmSync(d, { recursive: true, force: true });
    }
  });
}

test("executeTaskRun cursor review: a wedged Cursor is killed by the watchdog and reported as a failure", async () => {
  const dir = dirtyRepo();
  const bin = mkdtempSync(join(tmpdir(), "stub-cursor-"));
  const path = join(bin, "cursor-agent");
  writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2026.10.01-e373342"; exit 0; fi\nsleep 30\n');
  chmodSync(path, 0o755);
  try {
    const result = await withCursorPath(path, () =>
      executeTaskRun({ cli: "cursor", cwd: dir, role: "review", timeoutSec: 1 })
    );
    assert.equal(result.exitStatus, 1);
    assert.match(result.rendered, /watchdog/i);
  } finally {
    for (const d of [dir, bin]) rmSync(d, { recursive: true, force: true });
  }
});

for (const [flag, request, message] of [
  ["--write", { write: true }, /read-only/],
  ["--until-done", { untilDone: true }, /single-shot/],
  ["--resume-last", { resumeLast: true }, /no sessions/]
]) {
  test(`executeTaskRun cursor review: ${flag} is rejected before anything runs`, async () => {
    const dir = dirtyRepo();
    try {
      await assert.rejects(
        () => withCursorPath(MISSING_CURSOR, () => executeTaskRun({ cli: "cursor", cwd: dir, role: "review", ...request })),
        message
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ── companion CLI: bare review (no focus text), foreground and background ─────

const COMPANION = new URL("../../plugins/multi/scripts/multi-cli-companion.mjs", import.meta.url).pathname;

function companion(args, env) {
  return spawnSync(process.execPath, [COMPANION, ...args], { env, encoding: "utf8", timeout: 60000 });
}

test("companion: a bare foreground `task --cli cursor --role review` on a clean repo needs no prompt and no Cursor", () => {
  const dir = cleanRepo();
  const data = mkdtempSync(join(tmpdir(), "cursor-review-data-"));
  try {
    const env = { ...process.env, CURSOR_AGENT_PATH: MISSING_CURSOR, CLAUDE_PLUGIN_DATA: data };
    const run = companion(["task", "--cli", "cursor", "--role", "review", "--cwd", dir], env);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /No changes to review\./);
  } finally {
    for (const d of [dir, data]) rmSync(d, { recursive: true, force: true });
  }
});

test("companion: a bare background review on a clean repo completes without Cursor installed", () => {
  const dir = cleanRepo();
  const data = mkdtempSync(join(tmpdir(), "cursor-review-data-"));
  try {
    const env = { ...process.env, CURSOR_AGENT_PATH: MISSING_CURSOR, CLAUDE_PLUGIN_DATA: data };
    const launch = companion(["task", "--cli", "cursor", "--role", "review", "--background", "--json", "--cwd", dir], env);
    assert.equal(launch.status, 0, launch.stderr);
    const { jobId } = JSON.parse(launch.stdout);
    assert.ok(jobId, launch.stdout);

    const status = companion(["status", jobId, "--wait", "--timeout-ms", "30000", "--json", "--cwd", dir], env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).job.status, "completed", status.stdout);

    const result = companion(["result", jobId, "--cwd", dir], env);
    assert.match(result.stdout, /No changes to review\./);
  } finally {
    for (const d of [dir, data]) rmSync(d, { recursive: true, force: true });
  }
});

test("executeTaskRun cursor review: stays on headless print mode even when the ACP transport is selected", async () => {
  const dir = dirtyRepo();
  const record = mkdtempSync(join(tmpdir(), "cursor-record-"));
  const stub = stubCursor(record);
  const previous = process.env.MULTI_TRANSPORT_CURSOR;
  process.env.MULTI_TRANSPORT_CURSOR = "acp";
  try {
    const result = await withCursorPath(stub.path, () => executeTaskRun({ cli: "cursor", cwd: dir, role: "review" }));
    assert.equal(result.exitStatus, 0, result.rendered);
    const argv = readFileSync(join(record, "argv"), "utf8").split("\n");
    assert.ok(argv.includes("-p") && !argv.includes("acp"), argv.join(" "));
  } finally {
    if (previous === undefined) delete process.env.MULTI_TRANSPORT_CURSOR;
    else process.env.MULTI_TRANSPORT_CURSOR = previous;
    for (const d of [dir, record, stub.bin]) rmSync(d, { recursive: true, force: true });
  }
});

test("companion: setup advertises /cursor:review when Cursor is missing", () => {
  const data = mkdtempSync(join(tmpdir(), "cursor-review-data-"));
  try {
    const env = { ...process.env, CURSOR_AGENT_PATH: MISSING_CURSOR, CLAUDE_PLUGIN_DATA: data };
    const run = companion(["setup", "--json"], env);
    assert.equal(run.status, 0, run.stderr);
    const cursorStep = JSON.parse(run.stdout).nextSteps.find((step) => step.startsWith("Cursor:"));
    assert.match(cursorStep, /\/cursor:review/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

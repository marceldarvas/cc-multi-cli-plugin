// ABOUTME: Spawn-level tests for the Cursor adapter — watchdog kill and probe argument handling.
// ABOUTME: These actually launch a stub `agent` binary, unlike the pure-helper tests in cursor-headless.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCursorAvailability,
  getCursorAuthStatus,
  runHeadlessCursorTurn
} from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

// The stub answers `--version` immediately: runHeadlessCursorTurn probes the
// version synchronously on its first turn, so a stub that stalls there would
// block the event loop and mask what these tests are actually measuring.
function stubAgent(script) {
  const dir = mkdtempSync(join(tmpdir(), "fake-cursor-"));
  const path = join(dir, "agent");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "agent 2026.01.01"; exit 0; fi\n${script}\n`
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

function withCursorPath(value, fn) {
  const previous = process.env.CURSOR_AGENT_PATH;
  process.env.CURSOR_AGENT_PATH = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CURSOR_AGENT_PATH;
    else process.env.CURSOR_AGENT_PATH = previous;
  }
}

// ── watchdog ──────────────────────────────────────────────────────────────────

test("runHeadlessCursorTurn kills a wedged agent once the watchdog expires", async () => {
  const { dir, path } = stubAgent("sleep 30");
  const cwd = mkdtempSync(join(tmpdir(), "cursor-cwd-"));
  const startedAt = process.hrtime.bigint();
  try {
    const result = await withCursorPath(path, () =>
      runHeadlessCursorTurn(cwd, "hello", { timeoutSec: 1, watchdogSlackSec: 0 })
    );
    const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    assert.ok(elapsedMs < 5000, `expected the 1s watchdog to fire promptly, took ${elapsedMs}ms`);
    assert.notEqual(result.status, 0, "a watchdog kill must be a non-zero outcome");
    assert.match(String(result.error?.message ?? result.error ?? ""), /watchdog|timed out/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the watchdog actually kills the child, not just the pending promise", async () => {
  // The stub outlives the watchdog and then touches a sentinel. If the kill only
  // resolved the promise and left the process running, the sentinel appears.
  const sentinelDir = mkdtempSync(join(tmpdir(), "cursor-alive-"));
  const sentinel = join(sentinelDir, "survived");
  const { dir, path } = stubAgent(`sleep 2\ntouch ${sentinel}`);
  const cwd = mkdtempSync(join(tmpdir(), "cursor-cwd-"));
  try {
    const result = await withCursorPath(path, () =>
      runHeadlessCursorTurn(cwd, "hello", { timeoutSec: 1, watchdogSlackSec: 0 })
    );
    assert.notEqual(result.status, 0);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(existsSync(sentinel), false, "the stub outlived the watchdog kill");
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a malformed CURSOR_TIMEOUT_SECS falls back instead of becoming a 0ms watchdog", async () => {
  // Number("abc") is NaN and setTimeout(fn, NaN) fires immediately, so a typo'd
  // env var would kill every turn on arrival. Re-import with a cache-busting
  // query so the module-level default is re-read under the bad value.
  const { dir, path } = stubAgent(`printf '%s' '{"type":"result","result":"survived"}'`);
  const cwd = mkdtempSync(join(tmpdir(), "cursor-cwd-"));
  const previous = process.env.CURSOR_TIMEOUT_SECS;
  process.env.CURSOR_TIMEOUT_SECS = "abc";
  try {
    const fresh = await import(
      new URL("../../plugins/multi/scripts/lib/adapters/cursor.mjs?malformed-timeout", import.meta.url)
    );
    const result = await withCursorPath(path, () => fresh.runHeadlessCursorTurn(cwd, "hello", {}));
    assert.equal(result.status, 0, "a garbage timeout must not kill a healthy turn");
    assert.match(result.text, /survived/);
  } finally {
    if (previous === undefined) delete process.env.CURSOR_TIMEOUT_SECS;
    else process.env.CURSOR_TIMEOUT_SECS = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHeadlessCursorTurn leaves a fast agent alone", async () => {
  const { dir, path } = stubAgent(`printf '%s' '{"type":"result","result":"done"}'`);
  const cwd = mkdtempSync(join(tmpdir(), "cursor-cwd-"));
  try {
    const result = await withCursorPath(path, () =>
      runHeadlessCursorTurn(cwd, "hello", { timeoutSec: 30 })
    );
    assert.equal(result.status, 0);
    assert.match(result.text, /done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── probe argument handling ───────────────────────────────────────────────────

test("getCursorAvailability does not let the binary path reach a shell", () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "cursor-sentinel-"));
  const sentinel = join(sentinelDir, "pwned");
  try {
    const result = withCursorPath(`/nonexistent/agent$(touch ${sentinel})`, () =>
      getCursorAvailability()
    );
    assert.equal(result.available, false);
    assert.equal(existsSync(sentinel), false, "the probe must not evaluate the path in a shell");
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("getCursorAuthStatus does not let the binary path reach a shell", () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "cursor-sentinel-"));
  const sentinel = join(sentinelDir, "pwned");
  try {
    const result = withCursorPath(`/nonexistent/agent$(touch ${sentinel})`, () =>
      getCursorAuthStatus()
    );
    assert.equal(result.authenticated, false);
    assert.equal(existsSync(sentinel), false, "the probe must not evaluate the path in a shell");
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("getCursorAvailability handles a binary path containing spaces", () => {
  const parent = mkdtempSync(join(tmpdir(), "cursor-spaced-"));
  const dir = join(parent, "Cursor Agent");
  mkdirSync(dir);
  const path = join(dir, "agent");
  writeFileSync(path, `#!/bin/sh\necho "agent 2026.01.01"\n`);
  chmodSync(path, 0o755);
  try {
    const result = withCursorPath(path, () => getCursorAvailability());
    assert.equal(result.available, true);
    assert.match(result.version ?? "", /2026\.01\.01/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

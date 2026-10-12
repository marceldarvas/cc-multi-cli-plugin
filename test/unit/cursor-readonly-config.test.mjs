// ABOUTME: Tests the per-run deny config that holds Cursor's read-only roles read-only.
// ABOUTME: A stub cursor binary records the config dir it was handed; the config writer runs for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeCursor, writeReadOnlyConfig } from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

function permissions(role) {
  const dir = mkdtempSync(join(tmpdir(), "ro-cfg-"));
  try {
    writeReadOnlyConfig(dir, role);
    return JSON.parse(readFileSync(join(dir, "cli-config.json"), "utf8")).permissions;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Records the config dir it was launched with, plus that dir's config, then
// prints a headless json result.
function stubCursor(recordDir) {
  const bin = mkdtempSync(join(tmpdir(), "stub-cursor-ro-"));
  const path = join(bin, "cursor-agent");
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" });
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2026.10.01-e373342"; exit 0; fi',
      `rec="${recordDir}"`,
      'printf "%s" "$CURSOR_CONFIG_DIR" > "$rec/config-dir"',
      'cp "$CURSOR_CONFIG_DIR/cli-config.json" "$rec/cli-config.json" 2>/dev/null',
      'cat > /dev/null',
      `printf '%s\\n' '${result}'`,
      ""
    ].join("\n")
  );
  chmodSync(path, 0o755);
  return { bin, path };
}

async function launch(role, env) {
  const rec = mkdtempSync(join(tmpdir(), "ro-rec-"));
  const stub = stubCursor(rec);
  const cwd = mkdtempSync(join(tmpdir(), "ro-cwd-"));
  const previous = process.env.CURSOR_AGENT_PATH;
  process.env.CURSOR_AGENT_PATH = stub.path;
  try {
    await invokeCursor(cwd, "hello", { role, env, timeoutSec: 30 });
    const configDir = readFileSync(join(rec, "config-dir"), "utf8");
    const config = existsSync(join(rec, "cli-config.json"))
      ? JSON.parse(readFileSync(join(rec, "cli-config.json"), "utf8"))
      : null;
    return { configDir, config };
  } finally {
    if (previous === undefined) delete process.env.CURSOR_AGENT_PATH;
    else process.env.CURSOR_AGENT_PATH = previous;
    for (const dir of [rec, stub.bin, cwd]) rmSync(dir, { recursive: true, force: true });
  }
}

// ── the written config ────────────────────────────────────────────────────────

test("writeReadOnlyConfig: explore reads the workspace and nothing else", () => {
  const { allow, deny } = permissions("explore");
  assert.deepEqual(allow, ["Read(**)"], "exploring a repo needs relative reads");
  // Read(/**) is the one that is easy to leave out and easy to need: allow
  // Read(**) is workspace-relative, and --force auto-approves an absolute path
  // no rule denies, so without it an injected file can be read back from $HOME.
  for (const token of ["Read(/**)", "Write(**)", "Shell(*)", "Shell(*:*)", "Mcp(*:*)", "WebFetch(*)"]) {
    assert.ok(deny.includes(token), `deny must include ${token}`);
  }
});

test("writeReadOnlyConfig: research keeps the web, since that is its job", () => {
  const { allow, deny } = permissions("research");
  assert.ok(allow.includes("WebFetch(*)"));
  assert.ok(!deny.includes("WebFetch(*)"));
  assert.ok(allow.includes("Read(**)"));
  assert.ok(deny.includes("Read(/**)"), "research still may not read outside the workspace");
  assert.ok(deny.includes("Write(**)") && deny.includes("Shell(*)"));
});

test("writeReadOnlyConfig: 'researcher' is the same lane as 'research'", () => {
  assert.deepEqual(permissions("researcher"), permissions("research"));
});

// ── what reaches the CLI ──────────────────────────────────────────────────────

test("invokeCursor: a read-only role is launched under a deny config, removed afterwards", async () => {
  const { configDir, config } = await launch("explore", { ...process.env, CURSOR_CONFIG_DIR: undefined });
  assert.ok(configDir, "a read-only role must run under its own config dir");
  assert.deepEqual(config?.permissions.allow, ["Read(**)"]);
  assert.equal(existsSync(configDir), false, "the per-run config dir must not outlive the turn");
});

test("invokeCursor: a write role is left alone", async () => {
  const env = { ...process.env };
  delete env.CURSOR_CONFIG_DIR;
  const { configDir, config } = await launch("delegate", env);
  assert.equal(configDir, "", "delegate must not be constrained by the read-only config");
  assert.equal(config, null);
});

test("invokeCursor: a caller's own config dir wins, so a review keeps its deny-everything set", async () => {
  const caller = mkdtempSync(join(tmpdir(), "caller-cfg-"));
  writeFileSync(join(caller, "cli-config.json"), JSON.stringify({ version: 1, permissions: { allow: [], deny: ["Read(**)"] } }));
  try {
    const { configDir, config } = await launch("review", { ...process.env, CURSOR_CONFIG_DIR: caller });
    assert.equal(configDir, caller);
    assert.deepEqual(config?.permissions.deny, ["Read(**)"], "the caller's config must not be overwritten");
  } finally {
    rmSync(caller, { recursive: true, force: true });
  }
});

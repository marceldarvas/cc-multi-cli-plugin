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

async function launch(role, { env, ambientConfigDir } = {}) {
  const rec = mkdtempSync(join(tmpdir(), "ro-rec-"));
  const stub = stubCursor(rec);
  const cwd = mkdtempSync(join(tmpdir(), "ro-cwd-"));
  const previousAgent = process.env.CURSOR_AGENT_PATH;
  const previousConfig = process.env.CURSOR_CONFIG_DIR;
  process.env.CURSOR_AGENT_PATH = stub.path;
  if (ambientConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
  else process.env.CURSOR_CONFIG_DIR = ambientConfigDir;
  try {
    await invokeCursor(cwd, "hello", { role, env, timeoutSec: 30 });
    const configDir = readFileSync(join(rec, "config-dir"), "utf8");
    const config = existsSync(join(rec, "cli-config.json"))
      ? JSON.parse(readFileSync(join(rec, "cli-config.json"), "utf8"))
      : null;
    return { configDir, config };
  } finally {
    if (previousAgent === undefined) delete process.env.CURSOR_AGENT_PATH;
    else process.env.CURSOR_AGENT_PATH = previousAgent;
    if (previousConfig === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = previousConfig;
    for (const dir of [rec, stub.bin, cwd]) rmSync(dir, { recursive: true, force: true });
  }
}

// Every read-only alias with the allowance it is supposed to get. Spelled out
// rather than derived, so a change to WEB_ROLES has to be restated here to pass.
const READ_ONLY_LANES = [
  ["explore", ["Read(**)"]],
  ["explorer", ["Read(**)"]],
  ["ask", ["Read(**)"]],
  ["planner", ["Read(**)"]],
  ["plan", ["Read(**)"]],
  ["research", ["Read(**)", "WebFetch(*)"]],
  ["researcher", ["Read(**)", "WebFetch(*)"]],
  ["review", []]
];

const CLOSED_TOKENS = ["Read(/**)", "Write(**)", "Shell(*)", "Shell(*:*)", "Mcp(*:*)"];

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

// buildHeadlessArgs and invokeCursor both branch on the same isReadOnlyRole over
// one READ_ONLY_ROLES set, so membership is what needs pinning here, per alias.
test("writeReadOnlyConfig: every read-only alias gets its lane's allowance", () => {
  for (const [role, expectedAllow] of READ_ONLY_LANES) {
    const { allow, deny } = permissions(role);
    assert.deepEqual(allow, expectedAllow, `${role}: wrong allow set`);
    for (const token of ["Write(**)", "Shell(*)", "Shell(*:*)", "Mcp(*:*)"]) {
      assert.ok(deny.includes(token), `${role}: deny must include ${token}`);
    }
  }
});

test("writeReadOnlyConfig: a review reads nothing, since its diff is in the prompt", () => {
  const { allow, deny } = permissions("review");
  assert.deepEqual(allow, [], "a review has no workspace to read");
  assert.ok(deny.includes("Read(**)"), "a review must be denied workspace reads too");
  for (const token of CLOSED_TOKENS.filter((t) => t !== "Read(/**)")) {
    assert.ok(deny.includes(token), `deny must include ${token}`);
  }
});

// ── what reaches the CLI ──────────────────────────────────────────────────────

// One lane per branch of the writer. The per-alias content is pinned above
// without spawning, and each launch here costs a subprocess.
test("invokeCursor: a read-only role runs under a deny config, removed afterwards", async () => {
  for (const [role, expectedAllow] of [["explore", ["Read(**)"]], ["research", ["Read(**)", "WebFetch(*)"]]]) {
    const { configDir, config } = await launch(role);
    assert.ok(configDir, `${role} must run under its own config dir`);
    assert.deepEqual(config?.permissions.allow, expectedAllow, `${role}: wrong allow set`);
    for (const token of CLOSED_TOKENS) {
      assert.ok(config?.permissions.deny.includes(token), `${role}: deny must include ${token}`);
    }
    assert.equal(existsSync(configDir), false, `${role}: the per-run config dir must not outlive the turn`);
  }
});

test("invokeCursor: a review carries its deny-everything set even with no config dir passed", async () => {
  const { configDir, config } = await launch("review");
  assert.ok(configDir, "a review must still run under a config dir");
  assert.deepEqual(config?.permissions.allow, [], "a review must not inherit the read lane's allowance");
  assert.ok(config?.permissions.deny.includes("Read(**)"), "a review must not read a workspace");
  assert.equal(existsSync(configDir), false);
});

test("invokeCursor: a write role is left alone", async () => {
  const env = { ...process.env };
  delete env.CURSOR_CONFIG_DIR;
  const { configDir, config } = await launch("delegate", { env });
  assert.equal(configDir, "", "delegate must not be constrained by the read-only config");
  assert.equal(config, null);
});

test("invokeCursor: a caller's own config dir wins, so a review keeps the set it chose", async () => {
  const caller = mkdtempSync(join(tmpdir(), "caller-cfg-"));
  writeFileSync(join(caller, "cli-config.json"), JSON.stringify({ version: 1, permissions: { allow: [], deny: ["Read(**)"] } }));
  try {
    const { configDir, config } = await launch("review", { env: { ...process.env, CURSOR_CONFIG_DIR: caller } });
    assert.equal(configDir, caller);
    assert.deepEqual(config?.permissions.deny, ["Read(**)"], "the caller's config must not be overwritten");
  } finally {
    rmSync(caller, { recursive: true, force: true });
  }
});

// A stray exported CURSOR_CONFIG_DIR reads exactly like a caller's deliberate
// one, so honouring it would silently drop the deny set on every read-only lane.
test("invokeCursor: an ambient CURSOR_CONFIG_DIR does not disable the deny config", async () => {
  const ambient = mkdtempSync(join(tmpdir(), "ambient-cfg-"));
  writeFileSync(join(ambient, "cli-config.json"), JSON.stringify({ permissions: { allow: ["Shell(*)"], deny: [] } }));
  try {
    const { configDir, config } = await launch("explore", { ambientConfigDir: ambient });
    assert.notEqual(configDir, ambient, "an exported config dir is not the caller's choice");
    assert.deepEqual(config?.permissions.allow, ["Read(**)"]);
    assert.ok(config?.permissions.deny.includes("Shell(*)"), "the lane's own deny set must still apply");
  } finally {
    rmSync(ambient, { recursive: true, force: true });
  }
});

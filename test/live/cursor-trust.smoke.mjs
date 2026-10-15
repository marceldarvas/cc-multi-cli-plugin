// ABOUTME: Verifies trust-marker ownership against the real installed Cursor CLI and API.
// ABOUTME: Opt-in via CURSOR_LIVE; uses an empty temporary workspace and removes only its own grant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadlessCursorTurn, writeReadOnlyConfig } from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

function workspaceMarkers(workspace) {
  const root = join(homedir(), ".cursor", "projects");
  const paths = new Set([workspace, realpathSync(workspace)]);
  let entries;
  try { entries = readdirSync(root); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const marker = join(root, entry, ".workspace-trusted");
    try {
      const contents = readFileSync(marker, "utf8");
      return paths.has(JSON.parse(contents).workspacePath) ? [{ marker, contents }] : [];
    } catch { return []; }
  });
}

test("real Cursor preserves prior trust and cleans up a grant created during a lane", {
  skip: !process.env.CURSOR_LIVE, timeout: 400000
}, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-trust-live-"));
  const config = mkdtempSync(join(tmpdir(), "cursor-trust-config-"));
  const env = { ...process.env, CURSOR_CONFIG_DIR: config };
  const prompt = "Reply only OK. Do not use any tools.";
  assert.deepEqual(workspaceMarkers(workspace), [], "fresh workspace must have no pre-existing grant");
  try {
    writeReadOnlyConfig(config, "explore");
    // Let the vendor establish trust so the preservation check uses its real format and directory name.
    execFileSync(process.env.CURSOR_AGENT_PATH || "cursor-agent", [
      "-p", "--mode", "ask", "--force", "--trust", "--output-format", "json", "--workspace", workspace
    ], { cwd: workspace, env, input: prompt, timeout: 120000, stdio: ["pipe", "pipe", "pipe"] });
    const before = workspaceMarkers(workspace);
    assert.ok(before.length > 0, "real Cursor must establish the marker under test");
    const preserved = await runHeadlessCursorTurn(workspace, prompt, { env, role: "explore", timeoutSec: 120 });
    assert.equal(preserved.status, 0, preserved.error?.message);
    assert.deepEqual(workspaceMarkers(workspace), before);
    for (const { marker } of before) unlinkSync(marker);
    const cleaned = await runHeadlessCursorTurn(workspace, prompt, { env, role: "explore", timeoutSec: 120 });
    assert.equal(cleaned.status, 0, cleaned.error?.message);
    assert.deepEqual(workspaceMarkers(workspace), []);
  } finally {
    for (const { marker } of workspaceMarkers(workspace)) unlinkSync(marker);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});

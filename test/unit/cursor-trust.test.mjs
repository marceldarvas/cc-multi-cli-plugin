// ABOUTME: Verifies Cursor marker ownership through real adapter runs and filesystem state.
// ABOUTME: Isolates vendor state in a temporary home and mocks only the external Cursor executable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCursor, runCursorReview, runHeadlessCursorTurn } from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

import { trackCursorTrust, sweepStaleCursorTrust } from "../../plugins/multi/scripts/lib/cursor-trust.mjs";

const agent = fileURLToPath(new URL("../fixtures/cursor-trust-agent.mjs", import.meta.url));
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "cursor-trust-test-"));
  const cwd = join(root, "workspace.with-dots");
  mkdirSync(cwd);
  const env = { ...process.env, HOME: root, USERPROFILE: root, CURSOR_AGENT_PATH: agent };
  const marker = join(root, ".cursor", "projects", "vendor.name-with-dots", ".workspace-trusted");
  const previous = process.env.CURSOR_AGENT_PATH;
  process.env.CURSOR_AGENT_PATH = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_AGENT_PATH;
    else process.env.CURSOR_AGENT_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, env, marker };
}
// Cursor tags trust granted by `--trust` as "cli-flag"; GUI and older grants carry no trustMethod.
function seed(marker, workspacePath, extra = {}) {
  mkdirSync(dirname(marker), { recursive: true });
  const contents = JSON.stringify({ trustedAt: "2025-01-01T00:00:00Z", workspacePath, ...extra });
  writeFileSync(marker, contents);
  return contents;
}
const CLI = { trustMethod: "cli-flag" };
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "close");
  return child.pid;
}

test("headless lane removes the marker it created, without deriving its directory name", async (t) => {
  const { cwd, env, marker } = setup(t);
  const result = await runHeadlessCursorTurn(cwd, "hello", { env, role: "explore" });
  assert.equal(result.status, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(dirname(marker)), true, "other Cursor project data must remain");
});

for (const role of ["explore", "research", "delegate"]) {
  test(`${role} preserves a pre-existing marker byte for byte`, async (t) => {
    const { cwd, env, marker } = setup(t);
    const before = seed(marker, cwd);
    const result = await invokeCursor(cwd, "hello", { env, role });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(marker, "utf8"), before);
  });
}

test("read-only invocation sweeps an abandoned review grant but preserves every other record", async (t) => {
  const { root, cwd, env, marker } = setup(t);
  const projects = join(root, ".cursor", "projects");
  const before = seed(marker, cwd);
  const abandoned = join(projects, "abandoned-review", ".workspace-trusted");
  seed(abandoned, join(tmpdir(), `cursor-review-ws-${await deadPid()}-AbCdEf`), CLI);
  const otherData = join(dirname(abandoned), "transcript");
  writeFileSync(otherData, "keep");
  // A missing workspace alone is not abandonment: an unmounted volume or a moved repo looks the same.
  const unmounted = join(projects, "unmounted", ".workspace-trusted");
  const unmountedBefore = seed(unmounted, join(root, "gone"), CLI);
  const gui = join(projects, "gui-review", ".workspace-trusted");
  const guiBefore = seed(gui, join(tmpdir(), `cursor-review-ws-${await deadPid()}-GhIjKl`));
  const live = join(projects, "live-review", ".workspace-trusted");
  const liveBefore = seed(live, join(tmpdir(), `cursor-review-ws-${process.pid}-MnOpQr`), CLI);
  const malformed = join(projects, "malformed", ".workspace-trusted");
  seed(malformed, "relative-path", CLI);
  await invokeCursor(cwd, "hello", { env, role: "explore" });
  assert.equal(existsSync(abandoned), false);
  assert.equal(readFileSync(otherData, "utf8"), "keep");
  assert.equal(readFileSync(unmounted, "utf8"), unmountedBefore);
  assert.equal(readFileSync(gui, "utf8"), guiBefore);
  assert.equal(readFileSync(live, "utf8"), liveBefore);
  assert.equal(readFileSync(marker, "utf8"), before);
  assert.equal(existsSync(malformed), true);
});

for (const preExisting of [false, true]) {
  test(`a crashed Cursor process ${preExisting ? "preserves existing" : "cleans up lane-created"} trust`, async (t) => {
    const { cwd, env, marker } = setup(t);
    const before = preExisting ? seed(marker, cwd) : null;
    const result = await runHeadlessCursorTurn(cwd, "hello", {
      env: { ...env, TRUST_TEST_MODE: "crash" }, role: "explore"
    });
    assert.equal(result.status, 7);
    if (preExisting) assert.equal(readFileSync(marker, "utf8"), before);
    else assert.equal(existsSync(marker), false);
  });
}

test("killing the lane worker mid-run preserves pre-existing trust", { skip: process.platform === "win32", timeout: 15000 }, async (t) => {
  const { root, cwd, env, marker } = setup(t);
  const before = seed(marker, cwd);
  const ready = join(root, "ready");
  const adapter = new URL("../../plugins/multi/scripts/lib/adapters/cursor.mjs", import.meta.url).href;
  const worker = spawn(process.execPath, ["--input-type=module", "-e",
    `import { invokeCursor } from ${JSON.stringify(adapter)};
     await invokeCursor(process.cwd(), "hello", { role: "explore" });`
  ], { cwd, env: { ...env, TRUST_TEST_MODE: "hang", TRUST_TEST_READY: ready }, detached: true, stdio: "ignore" });
  const closed = once(worker, "close");
  const kill = () => {
    try { process.kill(-worker.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  t.after(kill);
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(ready) && Date.now() < deadline && worker.exitCode === null) await delay(10);
    assert.equal(existsSync(ready), true, "Cursor must signal it is running before the worker is killed");
    kill();
    const [, signal] = await closed;
    assert.equal(signal, "SIGKILL");
    assert.equal(readFileSync(marker, "utf8"), before);
    // A following lane also sweeps abandoned state; it must keep the live workspace's grant.
    await invokeCursor(cwd, "hello", { env, role: "explore" });
    assert.equal(readFileSync(marker, "utf8"), before);
  } finally {
    kill();
    await closed;
  }
});

test("watchdog timeout still removes the lane-created marker", async (t) => {
  const { cwd, env, marker } = setup(t);
  const result = await runHeadlessCursorTurn(cwd, "hello", {
    env: { ...env, TRUST_TEST_MODE: "hang" }, role: "explore", timeoutSec: 0, watchdogSlackSec: 1
  });
  assert.equal(result.error?.code, "CursorTimeout");
  assert.equal(existsSync(marker), false);
});

test("review removes its trust marker", async (t) => {
  const { env, marker } = setup(t);
  const result = await runCursorReview("review this diff", { env });
  assert.equal(result.status, 0);
  assert.equal(existsSync(marker), false);
});

test("cleanup preserves malformed existing markers and unrelated newly created markers", (t) => {
  const { cwd, env, marker, root } = setup(t);
  seed(marker, cwd);
  writeFileSync(marker, "not json");
  const cleanup = trackCursorTrust(cwd, env);
  const unrelated = join(root, ".cursor", "projects", "unrelated", ".workspace-trusted");
  const before = seed(unrelated, root, CLI);
  cleanup();
  assert.equal(readFileSync(marker, "utf8"), "not json");
  assert.equal(readFileSync(unrelated, "utf8"), before);
});

test("failed pre-run scan never authorizes marker removal", (t) => {
  const { root, cwd, env, marker } = setup(t);
  const projects = join(root, ".cursor", "projects");
  mkdirSync(dirname(projects), { recursive: true });
  writeFileSync(projects, "not a directory");
  const cleanup = trackCursorTrust(cwd, env);
  rmSync(projects);
  const before = seed(marker, cwd);
  cleanup();
  assert.equal(readFileSync(marker, "utf8"), before);
});

test("cleanup recognizes Cursor's canonical workspace path", (t) => {
  const { root, cwd, env, marker } = setup(t);
  const alias = join(root, "alias");
  symlinkSync(cwd, alias, "dir");
  const cleanup = trackCursorTrust(alias, env);
  seed(marker, realpathSync(cwd), CLI);
  cleanup();
  assert.equal(existsSync(marker), false);
});

const caseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), "cursor-trust-case-"));
  try { return existsSync(probe.toUpperCase()) && existsSync(probe.toLowerCase()); } finally { rmSync(probe, { recursive: true }); }
})();
test("cleanup matches a workspace reached through a differently cased path", { skip: !caseInsensitive }, (t) => {
  const { cwd, env, marker } = setup(t);
  const cleanup = trackCursorTrust(join(dirname(cwd), "WORKSPACE.with-dots"), env);
  seed(marker, realpathSync.native(cwd), CLI);
  cleanup();
  assert.equal(existsSync(marker), false);
});

test("cleanup preserves trust granted outside the lane's --trust while it ran", (t) => {
  const { cwd, env, marker } = setup(t);
  const cleanup = trackCursorTrust(cwd, env);
  const before = seed(marker, cwd);
  cleanup();
  assert.equal(readFileSync(marker, "utf8"), before);
});

test("sweep preserves malformed markers, symlinks, and non-CLI grants even when deemed abandoned", (t) => {
  const { root, env, marker } = setup(t);
  const projects = join(root, ".cursor", "projects");
  seed(marker, root, CLI);
  writeFileSync(marker, "not json");
  const gui = join(projects, "gui", ".workspace-trusted");
  const before = seed(gui, join(root, "missing"));
  const target = join(root, "external-marker");
  seed(target, join(root, "missing"), CLI);
  const link = join(projects, "linked", ".workspace-trusted");
  mkdirSync(dirname(link));
  symlinkSync(target, link);
  sweepStaleCursorTrust(env, () => true);
  assert.equal(readFileSync(marker, "utf8"), "not json");
  assert.equal(readFileSync(gui, "utf8"), before);
  assert.equal(existsSync(link), true);
  assert.equal(existsSync(target), true);
});

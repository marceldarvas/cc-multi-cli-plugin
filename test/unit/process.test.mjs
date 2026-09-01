import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { terminateProcessTree } from "../../plugins/multi/scripts/lib/process.mjs";

function esrch() {
  const error = new Error("No such process");
  error.code = "ESRCH";
  return error;
}

test("ESRCH on process-group kill falls back to the bare pid", () => {
  const calls = [];
  const killImpl = (pid, signal) => {
    calls.push({ pid, signal });
    if (pid < 0) throw esrch();
  };

  const result = terminateProcessTree(4242, { platform: "darwin", killImpl });

  assert.equal(result.delivered, true);
  assert.equal(result.method, "process");
  assert.deepEqual(calls, [
    { pid: -4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGKILL" }
  ]);
});

test("non-ESRCH group-kill error still falls back to the bare pid", () => {
  const eperm = new Error("Operation not permitted");
  eperm.code = "EPERM";
  const calls = [];
  const killImpl = (pid, signal) => {
    calls.push({ pid, signal });
    if (pid < 0) throw eperm;
  };

  const result = terminateProcessTree(4242, { platform: "darwin", killImpl });

  assert.equal(result.delivered, true);
  assert.equal(result.method, "process");
  assert.deepEqual(calls, [
    { pid: -4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGKILL" }
  ]);
});

test("process-group SIGTERM is followed by SIGKILL", () => {
  const calls = [];
  const killImpl = (pid, signal) => {
    calls.push({ pid, signal });
  };

  const result = terminateProcessTree(4242, { platform: "darwin", killImpl });

  assert.equal(result.delivered, true);
  assert.equal(result.method, "process-group");
  assert.deepEqual(calls, [
    { pid: -4242, signal: "SIGTERM" },
    { pid: -4242, signal: "SIGKILL" }
  ]);
});

test("ESRCH on both the group and the bare pid reports not delivered", () => {
  const killImpl = () => {
    throw esrch();
  };

  const result = terminateProcessTree(4242, { platform: "darwin", killImpl });

  assert.equal(result.attempted, true);
  assert.equal(result.delivered, false);
  assert.equal(result.method, "process");
});

test("SIGTERM-ignoring child is reaped by SIGKILL escalation", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
    detached: true
  });
  try {
    assert.ok(Number.isFinite(child.pid));
    const result = terminateProcessTree(child.pid);
    assert.equal(result.delivered, true, `expected a delivered kill, got ${JSON.stringify(result)}`);
    const deadline = Date.now() + 1000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(child.pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch (error) {
        if (error.code === "ESRCH") {
          alive = false;
          break;
        }
        throw error;
      }
    }
    assert.equal(alive, false, `pid ${child.pid} still alive 1s after terminateProcessTree`);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already dead */ }
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already dead */ }
  }
});

test("kills a non-detached child whose pid is not a process-group leader", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    assert.ok(Number.isFinite(child.pid));
    const result = terminateProcessTree(child.pid);
    assert.equal(result.delivered, true, `expected a delivered kill, got ${JSON.stringify(result)}`);
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.notEqual(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

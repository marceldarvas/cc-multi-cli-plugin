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
    { pid: 4242, signal: "SIGTERM" }
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

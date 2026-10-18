// ABOUTME: Exercises read-only Cursor lanes through the companion CLI and persisted job logs.
// ABOUTME: Only the external Cursor binary is stubbed; dispatch, parsing and job tracking run for real.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { listJobs, readJobFile, resolveJobFile } from "../../plugins/multi/scripts/lib/state.mjs";

const companion = fileURLToPath(new URL("../../plugins/multi/scripts/multi-cli-companion.mjs", import.meta.url));

for (const role of ["explore", "research"]) {
  test(`${role} persists timed tool progress and its lane label through the companion CLI`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-lane-"));
    const agent = join(dir, "cursor-agent");
    const events = [
      { type: "system", session_id: "lane-session" },
      { type: "tool_call", subtype: "started", call_id: "r1", timestamp_ms: 1000, tool_call: { readToolCall: {} } },
      { type: "tool_call", subtype: "completed", call_id: "r1", timestamp_ms: 2750, tool_call: { readToolCall: {} } },
      { type: "result", result: "restore_backup is in backup.mjs", session_id: "lane-session" }
    ];
    writeFileSync(agent, `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("2026.10.01-e373342"); process.exit(0); }
const args = process.argv.slice(2);
if (args[args.indexOf("--output-format") + 1] !== "stream-json") process.exit(2);
process.stdin.resume();
process.stdin.on("end", () => {
  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
});
`);
    chmodSync(agent, 0o755);
    const previousData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = join(dir, "data");
    try {
      const result = spawnSync(process.execPath, [companion, "task", "--cli", "cursor", "--role", role,
        "--cwd", dir, "--json", "find restore_backup"], {
        env: { ...process.env, CURSOR_AGENT_PATH: agent, MULTI_TRANSPORT_CURSOR: "headless", CURSOR_TIMEOUT_SECS: "30" },
        encoding: "utf8", timeout: 15000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(JSON.parse(result.stdout).rawOutput, "restore_backup is in backup.mjs");
      const jobs = listJobs(dir);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].kindLabel, role, "job listings name the lane, not rescue");
      const log = readFileSync(jobs[0].logFile, "utf8");
      assert.equal(log.split("\n").filter((line) => line.includes("Cursor: read")).length, 2, "start and finish");
      assert.match(log, /Cursor: read completed \(1750ms\)/);
      assert.ok(log.indexOf("Cursor: read completed") < log.indexOf("Final output"));
    } finally {
      if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previousData;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The stub answers with the prompt it received on stdin, so the companion's
// prompt assembly is observable end to end.
function echoPromptAgent(dir) {
  const agent = join(dir, "cursor-agent");
  writeFileSync(agent, `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("2026.10.01-e373342"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "result", result: prompt, session_id: "echo-session" }));
});
`);
  chmodSync(agent, 0o755);
  return agent;
}

function runCompanionPrompt(dir, args) {
  const agent = echoPromptAgent(dir);
  const result = spawnSync(process.execPath, [companion, "task", "--cli", "cursor", "--role", "explore",
    "--cwd", dir, "--json", ...args], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: join(dir, "data"), CURSOR_AGENT_PATH: agent,
      MULTI_TRANSPORT_CURSOR: "headless", CURSOR_TIMEOUT_SECS: "30" },
    encoding: "utf8", timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).rawOutput;
}

test("--prompt is the prompt text, not a literal flag pasted into it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-prompt-"));
  try {
    assert.equal(runCompanionPrompt(dir, ["--prompt", "We plan to split the parser"]), "We plan to split the parser");
    assert.equal(runCompanionPrompt(dir, ["--prompt=a=b"]), "a=b");
    writeFileSync(join(dir, "brief.md"), "Context from the file.\n");
    assert.equal(runCompanionPrompt(dir, ["--prompt-file", "brief.md", "--prompt", "Then answer this."]),
      "Context from the file.\n\nThen answer this.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The stub streams one tool call and some text, then wedges. CURSOR_TIMEOUT_SECS=0
// leaves only the adapter's 10s watchdog slack, so each run ends in ~10s.
function wedgedAgent(dir) {
  const agent = join(dir, "cursor-agent");
  const events = [
    { type: "system", session_id: "wedged-session" },
    { type: "assistant", timestamp_ms: 100, message: { content: [{ type: "text", text: "restore_backup is defined in " }] } },
    { type: "assistant", timestamp_ms: 101, message: { content: [{ type: "text", text: "backup.mjs." }] } },
    { type: "tool_call", subtype: "started", call_id: "g1", timestamp_ms: 200, tool_call: { grepToolCall: {} } }
  ];
  writeFileSync(agent, `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("2026.10.01-e373342"); process.exit(0); }
process.stdin.resume();
process.stdin.on("end", () => {
  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
  setInterval(() => {}, 1000);
});
`);
  chmodSync(agent, 0o755);
  return agent;
}

function companionEnv(dir, agent) {
  return { ...process.env, CLAUDE_PLUGIN_DATA: join(dir, "data"), CURSOR_AGENT_PATH: agent,
    MULTI_TRANSPORT_CURSOR: "headless", CURSOR_TIMEOUT_SECS: "0" };
}

function assertTimedOutRecord(dir, role) {
  const jobs = listJobs(dir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[0].phase, "failed");
  assert.equal(jobs[0].kindLabel, role);
  const result = spawnSync(process.execPath, [companion, "result", jobs[0].id, "--cwd", dir], {
    env: companionEnv(dir, "unused"), encoding: "utf8", timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restore_backup is defined in backup\.mjs\./, "stored partial text");
  assert.match(result.stdout, /Cursor exceeded adapter watchdog/, "stored timeout notice");
  return jobs[0];
}

test("a watchdog kill is recorded as a failed job while the process still exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-timeout-"));
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = join(dir, "data");
  try {
    const run = spawnSync(process.execPath, [companion, "task", "--cli", "cursor", "--role", "explore",
      "--cwd", dir, "find restore_backup"], { env: companionEnv(dir, wedgedAgent(dir)), encoding: "utf8", timeout: 30000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, "a nonzero exit would make the forwarding agent discard the result");
    assert.match(run.stdout, /restore_backup is defined in backup\.mjs\./, "partial text reaches the caller");
    assert.match(run.stdout, /Cursor exceeded adapter watchdog/, "next to the timeout notice");
    const job = assertTimedOutRecord(dir, "explore");
    const stored = readJobFile(resolveJobFile(dir, job.id));
    assert.equal(stored.result.status, 1);
    assert.equal(stored.result.error.code, "CursorTimeout");
  } finally {
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousData;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a background watchdog kill is recorded as a failed job too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-timeout-bg-"));
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = join(dir, "data");
  try {
    const launch = spawnSync(process.execPath, [companion, "task", "--cli", "cursor", "--role", "research",
      "--cwd", dir, "--background", "find restore_backup"], { env: companionEnv(dir, wedgedAgent(dir)), encoding: "utf8", timeout: 15000 });
    assert.equal(launch.status, 0, launch.stderr);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(listJobs(dir)[0]?.status)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assertTimedOutRecord(dir, "research");
  } finally {
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousData;
    rmSync(dir, { recursive: true, force: true });
  }
});

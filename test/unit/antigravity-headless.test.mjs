// Pure-helper tests for the Antigravity adapter.
// The live turn reads `agy --output-format json` from stdout. These cover the
// pure pieces: binary choice, role→flag mapping, the JSON envelope, and the
// transcript parsers (captured fixtures only — the turn does not read them).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DEFAULT_AGY_MODEL,
  isReadOnlyRole,
  buildHeadlessArgs,
  chooseAgyBinary,
  officialAgyInstallPath,
  parseConversationId,
  parseAppDataDir,
  defaultAppDataDir,
  transcriptPath,
  parseTranscript,
  deriveFinalMessage,
  deriveToolCalls,
  deriveFileChanges,
  deriveCommandExecutions,
  normalizeAgyOutcome,
  normalizeHeadlessResult,
  adapter
} from "../../plugins/multi/scripts/lib/adapters/antigravity.mjs";

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/antigravity/${name}`, import.meta.url), "utf8");
const EXPLORE = fixture("explore-transcript.jsonl");
const RESEARCH = fixture("research-transcript.jsonl");
const LOG = fixture("sample-print.log");

// ── role classification ─────────────────────────────────────────────────────

test("isReadOnlyRole: research/explore/ask/planner are read-only; delegate/writer are not", () => {
  for (const r of ["research", "researcher", "explore", "explorer", "ask", "planner", "plan"]) {
    assert.equal(isReadOnlyRole(r), true, `${r} should be read-only`);
  }
  for (const r of ["delegate", "writer", "execute"]) {
    assert.equal(isReadOnlyRole(r), false, `${r} should not be read-only`);
  }
  assert.equal(isReadOnlyRole("RESEARCH"), true); // case-insensitive
  assert.equal(isReadOnlyRole(undefined), false);
});

// ── buildHeadlessArgs ───────────────────────────────────────────────────────

test("buildHeadlessArgs: read-only role requests json and the default model, and ends with plan mode plus skip-permissions", () => {
  const args = buildHeadlessArgs({ prompt: "hi", cwd: "/work", logFile: "/tmp/x.log", printTimeout: "120s", role: "research" });
  assert.deepEqual(args, [
    "-p", "hi",
    "--output-format", "json",
    "--model", "gemini-3.8-flash-high",
    "--add-dir", "/work",
    "--print-timeout", "120s",
    "--mode", "plan",
    "--dangerously-skip-permissions"
  ]);
  assert.equal(DEFAULT_AGY_MODEL, "gemini-3.8-flash-high");
  assert.ok(!args.includes("--log-file"), "the turn no longer passes --log-file");
  assert.deepEqual(args.slice(-3), ["--mode", "plan", "--dangerously-skip-permissions"], "read-only argv must end with plan mode and skip-permissions");
});

test("buildHeadlessArgs: prompt is the -p value (argv element, not stdin)", () => {
  const args = buildHeadlessArgs({ prompt: "multi\nline prompt", role: "explore" });
  assert.equal(args[0], "-p");
  assert.equal(args[1], "multi\nline prompt");
});

test("buildHeadlessArgs: a named model overrides the default; blank falls back", () => {
  const overridden = buildHeadlessArgs({ prompt: "hi", role: "research", model: "gemini-3.8-flash-low" });
  assert.equal(overridden[overridden.indexOf("--model") + 1], "gemini-3.8-flash-low");
  const blank = buildHeadlessArgs({ prompt: "hi", role: "research", model: "  " });
  assert.equal(blank[blank.indexOf("--model") + 1], "gemini-3.8-flash-high");
});

test("buildHeadlessArgs: an unknown role without write stays in plan mode", () => {
  const args = buildHeadlessArgs({ prompt: "go", role: "explorr" });
  assert.deepEqual(args.slice(-3), ["--mode", "plan", "--dangerously-skip-permissions"]);
});

test("buildHeadlessArgs: a write role adds --dangerously-skip-permissions and still requests json + model", () => {
  const args = buildHeadlessArgs({ prompt: "go", cwd: "/work", role: "delegate", write: true, model: "gemini-3.8-flash-medium" });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--mode"), "write roles must not run plan mode");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-medium");
});

// ── binary resolution ───────────────────────────────────────────────────────

test("officialAgyInstallPath: unix home and windows LOCALAPPDATA", () => {
  assert.equal(
    officialAgyInstallPath({ platform: "darwin", homedir: "/Users/dev", env: {} }).replace(/\\/g, "/"),
    "/Users/dev/.local/bin/agy"
  );
  assert.equal(
    officialAgyInstallPath({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      homedir: "C:/Users/dev"
    }),
    "C:/Users/dev/AppData/Local/agy/bin/agy.exe"
  );
});

test("chooseAgyBinary: AGY_CLI_PATH wins even when an official install and which both exist", () => {
  const chosen = chooseAgyBinary({
    env: { AGY_CLI_PATH: "C:\\pin\\agy.exe" },
    platform: "darwin",
    homedir: "/Users/dev",
    exists: () => true,
    which: () => "/usr/bin/agy"
  });
  assert.equal(chosen, "C:/pin/agy.exe");
});

test("chooseAgyBinary: a blank AGY_CLI_PATH is unset, and an existing official install beats which", () => {
  const chosen = chooseAgyBinary({
    env: { AGY_CLI_PATH: "   " },
    platform: "darwin",
    homedir: "/Users/dev",
    exists: (p) => p.replace(/\\/g, "/") === "/Users/dev/.local/bin/agy",
    which: () => "/opt/homebrew/bin/agy"
  });
  assert.equal(chosen, "/Users/dev/.local/bin/agy");
});

test("chooseAgyBinary: which is used only when the official install is absent", () => {
  const chosen = chooseAgyBinary({
    env: {},
    platform: "linux",
    homedir: "/home/dev",
    exists: () => false,
    which: () => "/usr/local/bin/agy"
  });
  assert.equal(chosen, "/usr/local/bin/agy");
});

test("chooseAgyBinary: falls back to bare agy when nothing resolves", () => {
  const chosen = chooseAgyBinary({
    env: {},
    platform: "darwin",
    homedir: "/Users/dev",
    exists: () => false,
    which: () => ""
  });
  assert.equal(chosen, "agy");
});

// ── log parsing ─────────────────────────────────────────────────────────────

test("parseConversationId: reads 'Created conversation <id>', falls back to conversation=, else null", () => {
  assert.equal(parseConversationId(LOG), "1b6eab11-dffb-48c6-bc75-cf29b8f5d8f7");
  assert.equal(parseConversationId("...Print mode: conversation=abc-123, sending"), "abc-123");
  assert.equal(parseConversationId("no id here"), null);
  assert.equal(parseConversationId(undefined), null);
});

test("parseAppDataDir: reads the CLI app data directory line, else null", () => {
  assert.equal(parseAppDataDir(LOG), "C:\\Users\\dev\\.gemini\\antigravity-cli");
  assert.equal(parseAppDataDir("nothing relevant"), null);
});

test("defaultAppDataDir + transcriptPath compose the brain transcript path", () => {
  const p = transcriptPath("/root/.gemini/antigravity-cli", "ID");
  assert.match(p.replace(/\\/g, "/"), /\.gemini\/antigravity-cli\/brain\/ID\/\.system_generated\/logs\/transcript\.jsonl$/);
  assert.match(defaultAppDataDir().replace(/\\/g, "/"), /\.gemini\/antigravity-cli$/);
});

// ── transcript parsing + derivation ─────────────────────────────────────────

test("parseTranscript: one object per JSONL line; junk lines skipped", () => {
  assert.equal(parseTranscript(EXPLORE).length, 10);
  assert.equal(parseTranscript(RESEARCH).length, 8);
  assert.deepEqual(parseTranscript("not json\n{\"step_index\":0}\n"), [{ step_index: 0 }]);
  assert.deepEqual(parseTranscript(""), []);
});

test("deriveFinalMessage: returns the LAST non-empty MODEL/PLANNER_RESPONSE", () => {
  const explore = deriveFinalMessage(parseTranscript(EXPLORE));
  assert.match(explore, /^Here are the `?\.mjs/);
  assert.match(explore, /registry\.mjs/);

  const research = deriveFinalMessage(parseTranscript(RESEARCH));
  assert.match(research, /Node\.js 24/);
  assert.match(research, /nodejs\.org/);

  assert.equal(deriveFinalMessage([]), "");
});

test("deriveToolCalls: typed MODEL steps (not PLANNER_RESPONSE) become tool calls", () => {
  const explore = deriveToolCalls(parseTranscript(EXPLORE)).map((t) => t.name);
  assert.ok(explore.includes("LIST_DIRECTORY"));
  assert.ok(explore.includes("VIEW_FILE"));
  assert.ok(!explore.includes("PLANNER_RESPONSE"));

  const research = deriveToolCalls(parseTranscript(RESEARCH)).map((t) => t.name);
  assert.ok(research.includes("SEARCH_WEB"));
});

test("deriveFileChanges/deriveCommandExecutions: empty for read-only runs", () => {
  assert.deepEqual(deriveFileChanges(parseTranscript(EXPLORE)), []);
  assert.deepEqual(deriveFileChanges(parseTranscript(RESEARCH)), []);
  assert.deepEqual(deriveCommandExecutions(parseTranscript(EXPLORE)), []);
});

test("deriveFileChanges: edit-typed steps map to {path, action} (future write role)", () => {
  const steps = [
    { source: "MODEL", type: "EDIT_FILE", content: "File Path: `file:///C:/x/y.js`" },
    { source: "MODEL", type: "CREATE_FILE", content: "File Path: `file:///C:/x/new.js`" },
    { source: "MODEL", type: "DELETE_FILE", content: "File Path: `file:///C:/x/old.js`" },
    { source: "MODEL", type: "VIEW_FILE", content: "File Path: `file:///C:/x/read.js`" } // read → excluded
  ];
  assert.deepEqual(deriveFileChanges(steps), [
    { path: "C:/x/y.js", action: "modify" },
    { path: "C:/x/new.js", action: "create" },
    { path: "C:/x/old.js", action: "delete" }
  ]);
});

// ── normalizeAgyOutcome ─────────────────────────────────────────────────────

test("normalizeAgyOutcome: success maps conv-id, answer, status 0, no error", () => {
  const out = normalizeAgyOutcome({ logText: LOG, transcriptText: EXPLORE, exitCode: 0 });
  assert.equal(out.sessionId, "1b6eab11-dffb-48c6-bc75-cf29b8f5d8f7");
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
  assert.match(out.text, /registry\.mjs/);
  assert.ok(out.toolCalls.length >= 3);
});

test("normalizeAgyOutcome: empty transcript yields an error and status 1", () => {
  const out = normalizeAgyOutcome({ logText: LOG, transcriptText: "", exitCode: 0 });
  assert.equal(out.status, 1);
  assert.equal(out.text, "");
  assert.match(out.error.message, /no answer/i);
  assert.equal(out.sessionId, "1b6eab11-dffb-48c6-bc75-cf29b8f5d8f7"); // still recovered from the log
});

test("normalizeAgyOutcome: stderr is surfaced when there is no answer", () => {
  const out = normalizeAgyOutcome({ logText: "", transcriptText: "", stderr: "Cannot use this model: bogus", exitCode: 1 });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /Cannot use this model/);
});

test("normalizeAgyOutcome: timeout yields a timeout error and status 1", () => {
  const out = normalizeAgyOutcome({ logText: LOG, transcriptText: EXPLORE, timedOut: true });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /timed out/i);
});

// ── stdout JSON envelope ────────────────────────────────────────────────────

const SUCCESS_ENVELOPE = JSON.stringify({
  conversation_id: "f49de361-10dc-478f-a08c-1dd15b952ef5",
  status: "SUCCESS",
  response: "pong",
  error: null
});

test("normalizeHeadlessResult: SUCCESS returns the response and conversation_id, with an empty tool trail", () => {
  const out = normalizeHeadlessResult({ stdoutText: SUCCESS_ENVELOPE, exitCode: 0 });
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
  assert.equal(out.text, "pong");
  assert.equal(out.sessionId, "f49de361-10dc-478f-a08c-1dd15b952ef5");
  assert.deepEqual(out.toolCalls, []);
  assert.deepEqual(out.fileChanges, []);
  assert.deepEqual(out.commandExecutions, []);
});

test("normalizeHeadlessResult: a progress line before the envelope still yields the last object", () => {
  const out = normalizeHeadlessResult({ stdoutText: "still working\n" + SUCCESS_ENVELOPE, exitCode: 0 });
  assert.equal(out.status, 0);
  assert.equal(out.text, "pong");
});

test("normalizeHeadlessResult: a missing status with a response is success", () => {
  const out = normalizeHeadlessResult({
    stdoutText: JSON.stringify({ conversation_id: "abc", response: "hello" }),
    exitCode: 0
  });
  assert.equal(out.status, 0);
  assert.equal(out.text, "hello");
  assert.equal(out.sessionId, "abc");
});

test("normalizeHeadlessResult: an empty response is status 1", () => {
  const out = normalizeHeadlessResult({
    stdoutText: JSON.stringify({ conversation_id: "abc", status: "SUCCESS", response: "  ", error: null }),
    exitCode: 0
  });
  assert.equal(out.status, 1);
  assert.equal(out.text, "");
  assert.equal(out.sessionId, "abc");
  assert.match(out.error.message, /no answer/i);
});

test("normalizeHeadlessResult: a non-SUCCESS status uses the string error", () => {
  const out = normalizeHeadlessResult({
    stdoutText: JSON.stringify({ conversation_id: "abc", status: "ERROR", response: "partial", error: "model rejected" }),
    exitCode: 1
  });
  assert.equal(out.status, 1);
  assert.equal(out.text, "");
  assert.match(out.error.message, /model rejected/);
});

test("normalizeHeadlessResult: error:null does not throw, and stderr fills the message", () => {
  const out = normalizeHeadlessResult({
    stdoutText: JSON.stringify({ status: "ERROR", response: "", error: null }),
    stderr: "Please sign in",
    exitCode: 1
  });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /Please sign in/);
});

test("normalizeHeadlessResult: unparseable stdout is status 1 and surfaces stderr", () => {
  const out = normalizeHeadlessResult({
    stdoutText: "not json",
    stderr: "bubbletea: could not open TTY",
    exitCode: 1
  });
  assert.equal(out.status, 1);
  assert.equal(out.text, "");
  assert.match(out.error.message, /could not open TTY/);
});

test("normalizeHeadlessResult: a timeout is status 1 even when stdout parsed", () => {
  const out = normalizeHeadlessResult({ stdoutText: SUCCESS_ENVELOPE, timedOut: true });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /timed out/i);
});

// ── adapter contract shape ──────────────────────────────────────────────────

test("adapter exports the required contract members with name 'antigravity'", () => {
  assert.equal(adapter.name, "antigravity");
  for (const fn of ["isAvailable", "isAuthenticated", "invoke", "cancel"]) {
    assert.equal(typeof adapter[fn], "function", `adapter.${fn} must be a function`);
  }
  assert.equal(adapter.getSession, undefined);
});

test("adapter.cancel reports the process-tree mechanism", async () => {
  const res = await adapter.cancel("job-xyz");
  assert.equal(res.attempted, true);
  assert.equal(res.transport, "process-tree");
  assert.match(res.detail, /job-xyz/);
});

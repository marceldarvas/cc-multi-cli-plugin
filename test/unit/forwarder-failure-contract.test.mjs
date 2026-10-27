// ABOUTME: Guards the failure, scheduling and watchdog claims the shipped forwarders and commands make.
// ABOUTME: A forwarder that returns nothing, or detaches on its own, leaves the caller with no result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolveTimeoutSec } from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

const pluginsDir = new URL("../../plugins/", import.meta.url);
const agentsDir = new URL("multi/agents/", pluginsDir);
const RUNTIME_SKILLS = ["multi-cli-runtime", "codex-cli-runtime"];

function mdFiles(dir, prefix = "") {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => [`${prefix}${f}`, readFileSync(new URL(f, dir), "utf8")]);
}

const agents = () => mdFiles(agentsDir);

const runtimeSkills = () =>
  RUNTIME_SKILLS.map((s) => [s, readFileSync(new URL(`multi/skills/${s}/SKILL.md`, pluginsDir), "utf8")]);

function commands() {
  return readdirSync(pluginsDir).flatMap((p) => {
    try {
      return mdFiles(new URL(`${p}/commands/`, pluginsDir), `${p}/commands/`);
    } catch {
      return [];
    }
  });
}

const command = (path) => readFileSync(new URL(path, pluginsDir), "utf8");

test("every forwarder fails with one line on Bash failure or empty output", () => {
  for (const [f, text] of agents()) {
    const line = text.split("\n").find((l) => /`[A-Z][A-Za-z]+ [a-z]+ failed: /.test(l));
    assert.ok(line, `${f} has no failure line`);
    assert.match(line, /empty output/, `${f} failure line does not cover empty output`);
  }
  for (const [s, text] of runtimeSkills()) {
    assert.match(text, /`(<CLI> <role>|Codex rescue) failed: /, `${s} has no failure line`);
  }
});

test("no forwarder or runtime skill returns nothing on failure", () => {
  for (const [f, text] of [...agents(), ...runtimeSkills()]) {
    // "Do not silently return nothing" is the rule; any other "return nothing" is the bug.
    const bare = text.replace(/[Nn]ever silently return nothing|[Dd]o not (silently )?return nothing/g, "");
    assert.doesNotMatch(bare, /return nothing/, `${f} returns nothing`);
  }
});

test("the companion's --background is passed only for explicit fire-and-forget", () => {
  for (const [f, text] of [...agents(), ...commands()]) {
    for (const line of text.split("\n").filter((l) => /pass `--background`/i.test(l))) {
      assert.match(line, /fire-and-forget/, `${f} passes --background without fire-and-forget: ${line.trim()}`);
    }
    // Phrasings that pick background by scope without saying "pass".
    assert.doesNotMatch(text, /background for large|escalates to background/, `${f} picks background by scope`);
  }
  assert.ok(command("multi/agents/codex-review.md").includes("only when the user asked for fire-and-forget"), "codex-review has no explicit --background rule");
  assert.match(command("codex/commands/review.md"), /run_in_background: true/, "codex review command does not schedule large reviews with run_in_background");
});

test("delegate commands state each transport's watchdog as the adapters set it", () => {
  const cursor = command("cursor/commands/delegate.md");
  const timeout = resolveTimeoutSec(undefined, "delegate", {});
  const slack = Number(readFileSync(new URL("multi/scripts/lib/adapters/cursor.mjs", pluginsDir), "utf8")
    .match(/const WATCHDOG_SLACK_SECS = (\d+);/)[1]);
  assert.match(cursor, new RegExp(`${timeout}s plus ${slack}s slack`), "cursor delegate misstates the turn watchdog");
  assert.match(cursor, /CURSOR_TIMEOUT_SECS/, "cursor delegate omits the timeout override");
  assert.match(cursor, /default headless transport each Cursor turn/, "cursor delegate does not scope its watchdog claim");

  const opencode = command("opencode/commands/delegate.md");
  assert.match(opencode, /headless transport OpenCode has no turn watchdog/, "opencode delegate does not scope its watchdog claim");

  const acpSecs = Number(readFileSync(new URL("multi/scripts/lib/acp/client.mjs", pluginsDir), "utf8")
    .match(/const DEFAULT_INACTIVITY_MS = (\d+);/)[1]) / 1000;
  for (const [name, text] of [["cursor", cursor], ["opencode", opencode]]) {
    assert.match(text, new RegExp(`${acpSecs}s by default without a session update, set by \`MULTI_ACP_INACTIVITY_MS\``), `${name} delegate misstates the ACP watchdog`);
  }

  for (const [f, text] of commands()) {
    assert.doesNotMatch(text, /Unlike Codex, \w+ has no inactivity watchdog/, `${f} implies Codex has a default watchdog`);
  }
});

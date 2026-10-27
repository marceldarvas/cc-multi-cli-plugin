// ABOUTME: Guards the Bash timeout and the detached-run outcome on every shipped forwarder agent.
// ABOUTME: Bash defaults to 120s and moves a slower call to the background, so the caller gets nothing back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const pluginsDir = new URL("../../plugins/", import.meta.url);
const agentsDir = new URL("multi/agents/", pluginsDir);
const STILL_RUNNING = "still running: detached after 600s";

function forwarders() {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "expected shipped forwarder agents");
  return files.map((f) => [f, readFileSync(new URL(f, agentsDir), "utf8")]);
}

test("every forwarder runs its companion Bash call with timeout: 600000", () => {
  for (const [f, text] of forwarders()) {
    assert.match(text, /timeout: 600000/, `${f} sets no Bash timeout`);
  }
});

test("every forwarder reports a detached Bash call as still running, not failed", () => {
  for (const [f, text] of forwarders()) {
    assert.ok(text.includes(STILL_RUNNING), `${f} has no still-running outcome`);
    // The still-running line names the same lane as the forwarder's failure line.
    const lane = text.match(/`([A-Za-z]+ [a-z]+) failed:/)?.[1];
    if (lane) {
      assert.ok(text.includes(`\`${lane} ${STILL_RUNNING}`), `${f} still-running line does not name ${lane}`);
    }
    // It comes before the failure rule, so a detached call is not matched as a failure first.
    const failureRule = text.search(/^- (Return the companion's stdout verbatim\. )?(On (Bash )?failure|If the Bash call fails)/m);
    if (failureRule >= 0) {
      assert.ok(text.indexOf(STILL_RUNNING) < failureRule, `${f} lists the failure rule first`);
    }
  }
});

test("both runtime skills define the still-running outcome", () => {
  for (const skill of ["multi-cli-runtime", "codex-cli-runtime"]) {
    const text = readFileSync(new URL(`multi/skills/${skill}/SKILL.md`, pluginsDir), "utf8");
    assert.ok(text.includes(STILL_RUNNING), `${skill} has no still-running outcome`);
  }
});

test("no command, forwarder or skill promises a background subagent runs the CLI to completion", () => {
  const dirs = readdirSync(pluginsDir).flatMap((p) =>
    ["commands", "agents"].map((d) => new URL(`${p}/${d}/`, pluginsDir))
  );
  dirs.push(...readdirSync(new URL("multi/skills/", pluginsDir)).map((s) => new URL(`multi/skills/${s}/`, pluginsDir)));
  for (const dir of dirs) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const text = readFileSync(new URL(f, dir), "utf8");
      assert.doesNotMatch(text, /to completion/, `${dir.pathname}${f} promises completion`);
    }
  }
});

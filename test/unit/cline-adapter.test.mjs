import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeClineResult, adapter, buildArgs, buildReviewPrompt } from "../../plugins/multi/scripts/lib/adapters/cline.mjs";

const fx = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");

test("completed run → text + error:null, no status field forced", () => {
  const r = normalizeClineResult(fx("completed.jsonl"), "", 0);
  assert.equal(r.error, null);
  assert.match(r.text, /Bug Report|auth\.js/);
  assert.equal(r.partial, false);
});

test("run_result finishReason:error is classified as error, not timeout", () => {
  const stdout = JSON.stringify({ type: "run_result", finishReason: "error", text: "invalid model format" });
  const r = normalizeClineResult(stdout, "", 1);
  assert.equal(r.text, "");
  assert.equal(r.error.class, "ClineRunError");
  assert.match(r.error.message, /invalid model/);
});

test("truncated salvage keeps partial flag (not reported as clean success)", () => {
  const r = normalizeClineResult(fx("truncated-mid-text.jsonl"), "", 0);
  assert.equal(r.partial, true);
});

test("adapter conforms to contract shape", () => {
  assert.equal(adapter.name, "cline");
  for (const k of ["isAvailable", "isAuthenticated", "invoke", "cancel"]) assert.equal(typeof adapter[k], "function");
});

test("buildArgs keeps -p (plan mode) so Cline cannot write files, and omits --auto-approve", () => {
  const a = buildArgs({ cwd: "/repo", prompt: "review", model: undefined, provider: undefined, system: "You are a reviewer", timeoutSec: 300 });
  assert.ok(a.includes("-p"), "should include -p (plan mode; dropping it puts Cline in act mode)");
  assert.ok(a.includes("--json"), "should include --json");
  assert.ok(!a.includes("--auto-approve"), "should NOT include --auto-approve");
  assert.equal(a[a.indexOf("-m") + 1], "cline-pass/glm-5.2");
  assert.equal(a[a.indexOf("-P") + 1], "cline-pass");
  assert.equal(a[a.length - 1], "review"); // prompt is last positional
});

test("default SYSTEM reviews only the supplied diff, forbids tools, and requires a single message", () => {
  const a = buildArgs({ cwd: "/repo", prompt: "review" });
  const system = a[a.indexOf("-s") + 1];
  assert.match(system, /ONLY the diff/i);
  assert.match(system, /Do NOT use any tools/i);
  assert.match(system, /Do NOT read files/i);
  assert.match(system, /Do NOT explore the repository/i);
  assert.match(system, /single message/i);
  assert.match(system, /Cite file:line/);
  assert.match(system, /tag severity/);
});

test("normalizeClineResult short-circuits on non-zero exit with empty stdout", () => {
  const r = normalizeClineResult("", "cline: command not found", 127);
  assert.equal(r.error.class, "ClineRunError");
  assert.match(r.error.message, /cline: command not found/);
  assert.equal(r.status, 127);
  assert.equal(r.text, "");
});

test("normalizeClineResult short-circuits with fallback message when stderr is empty", () => {
  const r = normalizeClineResult("   ", "", 1);
  assert.equal(r.error.class, "ClineRunError");
  assert.match(r.error.message, /cline exited with code 1/);
});

test("normalizeClineResult does NOT short-circuit when stdout has content and code is non-zero", () => {
  // A -t timeout exits non-zero but emits JSONL — must not short-circuit.
  const stdout = JSON.stringify({ type: "run_result", finishReason: "error", text: "some error text" });
  const r = normalizeClineResult(stdout, "", 1);
  // Goes through normal parse path, not the short-circuit.
  assert.equal(r.error.class, "ClineRunError");
  assert.match(r.error.message, /some error text/);
});

test("runCline watchdog kills a hung child and returns a timeout error", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cline-hang-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cline"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo cline; exit 0; fi\nsleep 30\n");
  chmodSync(join(bin, "cline"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  const started = Date.now();
  try {
    const result = await adapter.invoke(dir, "review", { timeoutSec: 1, watchdogSlackSec: 0 });
    const elapsed = Date.now() - started;
    assert.ok(result.error, "hung cline must surface an error");
    assert.equal(result.error.class, "ClineTimeout");
    assert.ok(elapsed < 8000, `watchdog should fire near 1s, took ${elapsed}ms`);
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

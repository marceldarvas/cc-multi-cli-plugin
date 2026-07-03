import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeClineResult, adapter, buildArgs } from "../../plugins/multi/scripts/lib/adapters/cline.mjs";

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

test("buildArgs always hardens read-only and pins model/provider", () => {
  const a = buildArgs({ cwd: "/repo", prompt: "review", model: undefined, provider: undefined, system: "You are a reviewer", timeoutSec: 300 });
  assert.ok(a.includes("-p") && a.includes("--auto-approve") && a[a.indexOf("--auto-approve") + 1] === "false");
  assert.equal(a[a.indexOf("-m") + 1], "cline-pass/glm-5.2");
  assert.equal(a[a.indexOf("-P") + 1], "cline-pass");
  assert.equal(a[a.length - 1], "review"); // prompt is last positional
});

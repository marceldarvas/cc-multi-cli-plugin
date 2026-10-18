// ABOUTME: Pins where a failure notice is and is not shown next to task output.
// ABOUTME: Codex fills failureMessage from stderr even on success, so success output must stay unchanged.
import test from "node:test";
import assert from "node:assert/strict";

import { renderStoredJobResult, renderTaskResult } from "../../plugins/multi/scripts/lib/render.mjs";

test("a successful run with benign stderr renders only its output", () => {
  const rendered = renderTaskResult(
    { rawOutput: "Refactored the parser.", failureMessage: "warning: config.toml has an unknown key" },
    { title: "Codex Task" }
  );
  assert.equal(rendered, "Refactored the parser.\n");
});

test("a stored result without a recorded error renders only its output", () => {
  const job = { id: "task-1", title: "Codex Task", status: "completed" };
  const stored = { result: { status: 0, rawOutput: "Refactored the parser." } };
  assert.equal(renderStoredJobResult(job, stored), "Refactored the parser.\n");
});

test("a stored result with a recorded error shows the partial output, then why it stopped", () => {
  const job = { id: "task-2", title: "Cursor Explore", status: "failed" };
  const stored = { result: { status: 1, rawOutput: "Found restore_backup in", error: { code: "CursorTimeout", message: "Cursor exceeded adapter watchdog (10000ms)" } } };
  assert.equal(renderStoredJobResult(job, stored), "Found restore_backup in\n\nCursor exceeded adapter watchdog (10000ms)\n");
});

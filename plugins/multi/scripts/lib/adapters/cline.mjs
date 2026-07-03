/**
 * Cline adapter — availability checks, auth status, and running prompts
 * through Cline's headless review mode (`cline --json`).
 *
 * Maps cline-plugin-cc's JSONL output (via parseReview) into the shared
 * { text, error, partial, finishReason } adapter contract.  Owns error
 * CLASSIFICATION: a run_result with finishReason "error" (bad model/auth/
 * config) carries useful diagnostic text and must NOT be swallowed as a
 * timeout.
 */

import { binaryAvailable, spawnCommand } from "../process.mjs";
import { parseReview, ReviewParseError, EmptyReviewError, ReviewTimeoutError } from "./cline-parse.mjs";

// Map cline-plugin-cc's parseReview shape → the { text, error, ... } contract.
// Owns error CLASSIFICATION: a run_result{finishReason:"error"} (bad model/auth/config)
// carries useful text and must NOT be swallowed as a timeout.
export function normalizeClineResult(stdout, stderr = "", code = 0) {
  let review;
  try {
    review = parseReview(stdout);
  } catch (e) {
    if (e instanceof ReviewTimeoutError) {
      // finishReason:"error" reaches parseReview as a non-completed run_result with no
      // salvage → thrown as ReviewTimeoutError. Recover the real error text if present.
      const rr = lastRunResult(stdout);
      if (rr && rr.finishReason === "error") {
        return errResult("ClineRunError", rr.text || stderr || "cline reported an error", code);
      }
      return errResult("ClineTimeout", e.message, code || 1);
    }
    if (e instanceof EmptyReviewError) return errResult("ClineEmpty", e.message, code || 1);
    if (e instanceof ReviewParseError) return errResult("ClineParseError", e.message, code || 1);
    throw e;
  }
  return { text: review.text, error: null, partial: Boolean(review.partial), finishReason: review.finishReason };
}

function errResult(cls, message, status) {
  return { text: "", error: { class: cls, message }, partial: false, status };
}

function lastRunResult(stdout) {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o.type === "run_result") return o; } catch { /* skip */ }
  }
  return null;
}

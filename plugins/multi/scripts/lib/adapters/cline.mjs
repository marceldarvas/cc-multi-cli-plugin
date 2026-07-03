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

const DEFAULT_MODEL = process.env.CLINE_CLI_DEFAULT_MODEL || "cline-pass/glm-5.2";
const DEFAULT_PROVIDER = process.env.CLINE_CLI_DEFAULT_PROVIDER || "cline-pass";
const DEFAULT_TIMEOUT = Number(process.env.CLINE_TIMEOUT_SECS || 300);
const SYSTEM = "You are a code reviewer. Focus on correctness, security, performance, and simplicity. Cite file:line, tag severity, be concise, and avoid nitpick spam.";

export function buildArgs({ cwd, prompt, model, provider, system, timeoutSec }) {
  return [
    "-p", "--auto-approve", "false", "--json",
    "-t", String(timeoutSec || DEFAULT_TIMEOUT),
    "-P", provider || DEFAULT_PROVIDER,
    "-m", model || DEFAULT_MODEL,
    "-c", cwd,
    "-s", system || SYSTEM,
    prompt,
  ];
}

export const adapter = {
  name: "cline",
  isAvailable: (_cwd) => binaryAvailable("cline"),
  isAuthenticated: async (_cwd) => ({ authenticated: true, method: "lazy", detail: "auth surfaces on first invoke" }),
  invoke: async (cwd, prompt, options = {}) => {
    const args = buildArgs({ cwd, prompt, model: options.model, provider: options.provider, system: options.system, timeoutSec: options.timeoutSec });
    const { stdout, stderr, code } = await runCline(cwd, args, options.env);
    return normalizeClineResult(stdout, stderr, code);
  },
  cancel: async (_jobId) => ({ attempted: true, interrupted: false, transport: "process-tree", detail: "companion kills the job PID tree" }),
  getSession: undefined,
};

function runCline(cwd, args, env) {
  return new Promise((resolve) => {
    const child = spawnCommand("cline", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.on("error", (e) => resolve({ stdout, stderr: stderr + String(e), code: 127 }));
  });
}

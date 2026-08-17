/**
 * Cline adapter — availability checks, auth status, and running prompts
 * through Cline plan mode (`cline -p --json`). `-p` is --plan: it is what
 * keeps Cline from writing files. Do not drop it.
 *
 * Maps cline-plugin-cc's JSONL output (via parseReview) into the shared
 * { text, error, partial, finishReason } adapter contract.  Owns error
 * CLASSIFICATION: a run_result with finishReason "error" (bad model/auth/
 * config) carries useful diagnostic text and must NOT be swallowed as a
 * timeout.
 */

import { binaryAvailable, spawnCommand, terminateProcessTree } from "../process.mjs";
import { parseReview, ReviewParseError, EmptyReviewError, ReviewTimeoutError } from "./cline-parse.mjs";
import { truncateUtf8 } from "../text.mjs";

const PROMPT_BUDGET = 768 * 1024;

/**
 * Builds the diff-as-prompt body for a cline review run. Truncates large diffs
 * with a descriptive marker. Appends an optional reviewer focus instruction.
 */
export function buildReviewPrompt(diff, { focus } = {}) {
  const body = "Review this diff for bugs:\n";
  const { text: diffText, truncated, origBytes } = truncateUtf8(diff, PROMPT_BUDGET - body.length - 200);
  const marker = truncated
    ? `[TRUNCATED: diff was ${Math.round(origBytes / 1024)} KB; reviewing first ${Math.round(Buffer.byteLength(diffText, "utf8") / 1024)} KB. Narrow with --base or review fewer files.]\n`
    : "";
  const focusSuffix = focus && focus.trim() ? `\n\nReviewer focus: ${focus.trim()}` : "";
  return body + marker + diffText + focusSuffix;
}

// Map cline-plugin-cc's parseReview shape → the { text, error, ... } contract.
// Owns error CLASSIFICATION: a run_result{finishReason:"error"} (bad model/auth/config)
// carries useful text and must NOT be swallowed as a timeout.
export function normalizeClineResult(stdout, stderr = "", code = 0) {
  // Short-circuit: if cline exited non-zero with no stdout, surface the real error.
  if (code !== 0 && !String(stdout).trim()) {
    return errResult("ClineRunError", stderr?.trim() || `cline exited with code ${code}`, code);
  }

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
const WATCHDOG_SLACK_SECS = 10;
const SYSTEM = "You are a code reviewer. Review ONLY the diff given in the user message. Do NOT use any tools, do NOT read files, do NOT explore the repository — everything you need is in the diff. Respond with your complete review in a single message and then stop immediately. Focus on correctness, security, performance, and simplicity. Cite file:line, tag severity, be concise, and avoid nitpick spam.";

export function buildArgs({ cwd, prompt, model, provider, system, timeoutSec }) {
  return [
    "-p", "--json",
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
    const { stdout, stderr, code, timedOut, watchdogMs } = await runCline(cwd, args, options.env, options);
    if (timedOut) {
      return errResult("ClineTimeout", `Cline exceeded adapter watchdog (${watchdogMs}ms)`, 1);
    }
    return normalizeClineResult(stdout, stderr, code);
  },
  cancel: async (_jobId) => ({ attempted: true, interrupted: false, transport: "process-tree", detail: "companion kills the job PID tree" }),
  getSession: undefined,
};

function runCline(cwd, args, env, options = {}) {
  const timeoutSec = options.timeoutSec || DEFAULT_TIMEOUT;
  const slackSec = Number.isFinite(options.watchdogSlackSec) ? options.watchdogSlackSec : WATCHDOG_SLACK_SECS;
  const watchdogMs = (timeoutSec + slackSec) * 1000;
  return new Promise((resolve) => {
    const child = spawnCommand("cline", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let stdout = "", stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const watchdog = setTimeout(() => {
      timedOut = true;
      if (Number.isFinite(child.pid)) {
        try { terminateProcessTree(child.pid); } catch { /* best-effort */ }
      }
    }, watchdogMs);
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ stdout, stderr, code: code ?? 0, timedOut, watchdogMs });
    });
    child.on("error", (e) => {
      clearTimeout(watchdog);
      resolve({ stdout, stderr: stderr + String(e), code: 127, timedOut, watchdogMs });
    });
  });
}

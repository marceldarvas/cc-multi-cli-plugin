/**
 * Antigravity adapter — drives Google's headless `agy` CLI in print mode and
 * reads `--output-format json` from stdout.
 *
 * Binary order: `AGY_CLI_PATH` when set and non-blank; else the official install
 * (`~/.local/bin/agy`, or `%LOCALAPPDATA%/agy/bin/agy.exe` on Windows) when that
 * file exists; else `which`/`where`; else bare `agy`. PATH `agy` is often the
 * IDE launcher, so the install-path check comes before PATH.
 *
 * Default model is `gemini-3.8-flash-high`. A non-blank `options.model` overrides
 * it. The prompt is the `-p` argv element.
 *
 * Shipped roles are read-only (`research` / `explore`). They run `--mode plan`,
 * so agy plans instead of editing files or running shell, plus
 * `--dangerously-skip-permissions`: headless `agy` auto-denies any tool that
 * needs a permission prompt and ends the turn with an empty response. Plan mode
 * is the only write guard, so this is not a hard sandbox. Write-delegate and
 * `--until-done` are not shipped.
 *
 * The live turn uses the JSON envelope (`conversation_id`, `status`, `response`,
 * `error`). Transcript parsers below cover captured fixtures; the turn does not
 * read them.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { spawnCommand, terminateProcessTree } from "../process.mjs";
import { buildSpawnEnvironment } from "../acp-client.mjs";

// ─── Binary resolution ──────────────────────────────────────────────────────
//
// `agy` on PATH is often the IDE launcher. The headless CLI is a separate
// binary. On Windows the installer drops a real .exe at
// %LOCALAPPDATA%\agy\bin\agy.exe, so process.mjs spawns it without a shell and
// the prompt passes as an argv element.

/** Default headless model. A non-blank per-call model overrides this. */
export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-high";

/**
 * Official headless install path for this platform.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, homedir?: string }} [opts]
 * @returns {string}
 */
export function officialAgyInstallPath({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === "win32") {
    const root = env.LOCALAPPDATA
      ? String(env.LOCALAPPDATA).replace(/\\/g, "/")
      : `C:/Users/${env.USERNAME ?? env.USER ?? "user"}/AppData/Local`;
    return `${root.replace(/\/$/, "")}/agy/bin/agy.exe`;
  }
  return path.join(homedir, ".local", "bin", "agy");
}

/**
 * Pick the headless `agy` binary. `exists` and `which` are injected so tests
 * do not depend on the machine's PATH or install.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, homedir?: string, exists?: (p: string) => boolean, which?: (() => string|null)|null }} [opts]
 * @returns {string}
 */
export function chooseAgyBinary({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  exists = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  which = null
} = {}) {
  const pinned = typeof env.AGY_CLI_PATH === "string" ? env.AGY_CLI_PATH.trim() : "";
  if (pinned) return pinned.replace(/\\/g, "/");

  const official = officialAgyInstallPath({ platform, env, homedir });
  if (exists(official)) return official.replace(/\\/g, "/");

  if (typeof which === "function") {
    let found = "";
    try {
      found = which() ?? "";
    } catch {
      found = "";
    }
    const normalized = String(found).trim().replace(/\\/g, "/");
    if (normalized) return normalized;
  }

  return "agy";
}

/** Resolve the binary for a live turn. */
export function findAgyBinary() {
  return chooseAgyBinary({
    which() {
      const whereCmd = process.platform === "win32" ? "where agy" : "which agy";
      try {
        const found = execSync(whereCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
          .split(/\r?\n/)
          .filter(Boolean)[0];
        return found || null;
      } catch {
        return null;
      }
    }
  });
}

// ─── Role → flags ─────────────────────────────────────────────────────────────

const READ_ONLY_ROLES = new Set([
  "research",
  "researcher",
  "explore",
  "explorer",
  "ask",
  "planner",
  "plan"
]);

/** The Antigravity slice ships read-only roles only; this gates write flags. */
export function isReadOnlyRole(role) {
  return READ_ONLY_ROLES.has(String(role ?? "").toLowerCase());
}

/**
 * Model id for this turn. Blank or whitespace keeps the default.
 * @param {string|undefined|null} model
 * @returns {string}
 */
function resolveAgyModel(model) {
  return typeof model === "string" && model.trim() ? model.trim() : DEFAULT_AGY_MODEL;
}

/**
 * Build the `agy` argv. The prompt is the `-p` value (one argv element; the
 * Windows .exe spawns without a shell). Every turn asks for a JSON envelope and
 * names a model. Read-only roles run `--mode plan`, so agy plans instead of
 * editing files or running shell, plus `--dangerously-skip-permissions`, so
 * headless mode does not auto-deny their read and web tools. A turn leaves
 * plan mode only when `write` is set and the role is not read-only.
 *
 * @param {{ prompt?: string, cwd?: string, printTimeout?: string, role?: string, model?: string, write?: boolean }} [opts]
 * @returns {string[]}
 */
export function buildHeadlessArgs({ prompt, cwd, printTimeout, role = "researcher", model, write = false } = {}) {
  const args = ["-p", String(prompt ?? ""), "--output-format", "json", "--model", resolveAgyModel(model)];
  if (cwd) args.push("--add-dir", cwd);
  if (printTimeout) args.push("--print-timeout", String(printTimeout));
  if (!write || isReadOnlyRole(role)) {
    args.push("--mode", "plan");
  }
  args.push("--dangerously-skip-permissions");
  return args;
}

// ─── Pure parsing of the log + transcript ──────────────────────────────────────

/** Extract the conversation id `agy` created this run, from its log output. */
export function parseConversationId(logText) {
  const text = String(logText ?? "");
  const created = text.match(/Created conversation ([0-9a-fA-F-]+)/);
  if (created) return created[1];
  const inline = text.match(/conversation=([0-9a-fA-F-]+)/);
  return inline ? inline[1] : null;
}

/** Extract the CLI app-data dir from the log (where brain/<id>/... lives). */
export function parseAppDataDir(logText) {
  const m = String(logText ?? "").match(/CLI app data directory:\s*(.+)/);
  return m ? m[1].trim() : null;
}

/** Default app-data dir when the log does not surface it. */
export function defaultAppDataDir() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

/** Absolute path to a conversation's transcript JSONL. */
export function transcriptPath(appDataDir, convId) {
  return path.join(appDataDir, "brain", convId, ".system_generated", "logs", "transcript.jsonl");
}

/** Parse transcript JSONL into step objects (robust: skips unparseable lines). */
export function parseTranscript(jsonlText) {
  const out = [];
  for (const line of String(jsonlText ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      // skip
    }
  }
  return out;
}

const RESPONSE_TYPE = "PLANNER_RESPONSE";

/** The final answer = the last non-empty MODEL/PLANNER_RESPONSE content. */
export function deriveFinalMessage(steps) {
  let answer = "";
  for (const s of steps ?? []) {
    if (s?.source === "MODEL" && s?.type === RESPONSE_TYPE && typeof s.content === "string" && s.content.trim()) {
      answer = s.content;
    }
  }
  return answer.trim();
}

/** Every MODEL action step that isn't the planner's prose is a tool call. */
export function deriveToolCalls(steps) {
  const out = [];
  for (const s of steps ?? []) {
    if (s?.source === "MODEL" && s?.type && s.type !== RESPONSE_TYPE) {
      out.push({ name: s.type });
    }
  }
  return out;
}

// File-mutating / command step types (for the future write role; read-only runs
// never produce these, so derivation returns [] in practice today).
const EDIT_STEP_TYPES = new Set([
  "EDIT_FILE", "WRITE_FILE", "CREATE_FILE", "REPLACE_FILE",
  "APPLY_PATCH", "DELETE_FILE", "MOVE_FILE", "RENAME_FILE"
]);
const COMMAND_STEP_TYPES = new Set([
  "RUN_COMMAND", "EXECUTE_COMMAND", "RUN_TERMINAL_COMMAND", "TERMINAL", "SHELL"
]);

function fileUriFromContent(content) {
  const m = String(content ?? "").match(/file:\/\/\/([^\s`"]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Derive file changes from edit-typed MODEL steps that target a path. */
export function deriveFileChanges(steps) {
  const out = [];
  const seen = new Set();
  for (const s of steps ?? []) {
    if (s?.source !== "MODEL" || !EDIT_STEP_TYPES.has(s?.type)) continue;
    const filePath = fileUriFromContent(s.content);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const action = /DELETE/.test(s.type) ? "delete" : /CREATE/.test(s.type) ? "create" : "modify";
    out.push({ path: filePath, action });
  }
  return out;
}

/** Derive shell command executions from command-typed MODEL steps. */
export function deriveCommandExecutions(steps) {
  const out = [];
  for (const s of steps ?? []) {
    if (s?.source !== "MODEL" || !COMMAND_STEP_TYPES.has(s?.type)) continue;
    const m = String(s.content ?? "").match(/Command:\s*(.+)/);
    out.push({ command: m ? m[1].trim() : String(s.content ?? "").trim() });
  }
  return out;
}

/**
 * Normalize a finished `agy` run into the uniform adapter result shape. Pure: the
 * conversation id comes from the log, the answer + activity from the transcript.
 *
 * @param {{ logText?: string, transcriptText?: string, stderr?: string, exitCode?: number, timedOut?: boolean }} [args]
 * @returns {{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }}
 */
export function normalizeAgyOutcome({ logText = "", transcriptText = "", stderr = "", exitCode = 0, timedOut = false } = {}) {
  const sessionId = parseConversationId(logText);
  const steps = parseTranscript(transcriptText);
  const text = deriveFinalMessage(steps);
  const fileChanges = deriveFileChanges(steps);
  const commandExecutions = deriveCommandExecutions(steps);
  const toolCalls = deriveToolCalls(steps);

  if (timedOut) {
    return {
      sessionId,
      text,
      error: { message: "Antigravity (agy) timed out before producing a response." },
      status: 1,
      fileChanges,
      commandExecutions,
      toolCalls
    };
  }

  if (!text) {
    const detail = (stderr || "").trim();
    const message = detail
      ? `Antigravity (agy) produced no answer. ${detail}`
      : "Antigravity (agy) produced no answer (empty or unreadable transcript). Ensure the headless agy binary is installed and signed in (launch ~/.local/bin/agy or $AGY_CLI_PATH in a terminal).";
    return { sessionId, text: "", error: { message }, status: exitCode || 1, fileChanges, commandExecutions, toolCalls };
  }

  return { sessionId, text, error: null, status: 0, fileChanges, commandExecutions, toolCalls };
}

/**
 * Parse the last JSON object on stdout. A progress line may precede the envelope.
 * @param {string} stdoutText
 * @returns {object|null}
 */
function parseHeadlessEnvelope(stdoutText) {
  const text = String(stdoutText ?? "").trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    // A progress line may precede the envelope.
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function stderrDetail(stderr) {
  const detail = String(stderr ?? "").trim();
  return detail || null;
}

/**
 * Normalize one headless JSON envelope into the adapter result shape.
 * The JSON result has no tool trail, so those arrays stay empty.
 *
 * @param {{ stdoutText?: string, stderr?: string, exitCode?: number, timedOut?: boolean }} [args]
 * @returns {{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }}
 */
export function normalizeHeadlessResult({ stdoutText = "", stderr = "", exitCode = 0, timedOut = false } = {}) {
  const envelope = parseHeadlessEnvelope(stdoutText);
  const sessionId = typeof envelope?.conversation_id === "string" && envelope.conversation_id
    ? envelope.conversation_id
    : null;
  const response = typeof envelope?.response === "string" ? envelope.response : "";
  const emptyTrail = { fileChanges: [], commandExecutions: [], toolCalls: [] };

  if (timedOut) {
    return {
      sessionId,
      text: response.trim(),
      error: { message: "Antigravity (agy) timed out before producing a response." },
      status: 1,
      ...emptyTrail
    };
  }

  if (!envelope) {
    const detail = stderrDetail(stderr);
    const message = detail
      ? `Antigravity (agy) produced no answer. ${detail}`
      : "Antigravity (agy) produced no answer (unreadable stdout). Ensure the headless agy binary is installed and signed in (launch ~/.local/bin/agy or $AGY_CLI_PATH in a terminal).";
    return { sessionId: null, text: "", error: { message }, status: exitCode || 1, ...emptyTrail };
  }

  const answered = response.trim().length > 0;
  const success = answered && (envelope.status === "SUCCESS" || envelope.status == null);
  if (success) {
    return { sessionId, text: response, error: null, status: 0, ...emptyTrail };
  }

  const errText = typeof envelope.error === "string" && envelope.error.trim()
    ? envelope.error.trim()
    : stderrDetail(stderr);
  const message = errText
    ? `Antigravity (agy) produced no answer. ${errText}`
    : "Antigravity (agy) produced no answer (empty response).";
  return { sessionId, text: "", error: { message }, status: 1, ...emptyTrail };
}

// ─── Availability & Auth ────────────────────────────────────────────────────

/**
 * Whether the `agy` CLI binary is present.
 * @returns {{ available: boolean, detail: string, version: string | null }}
 */
export function getAntigravityAvailability() {
  const cli = findAgyBinary();
  try {
    const version = execSync(`"${cli}" --version`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000
    }).trim();
    return { available: true, detail: `agy ${version}`, version };
  } catch (err) {
    return {
      available: false,
      detail: `Antigravity CLI (agy) not found (tried: ${cli}). Install the headless CLI from https://antigravity.google/cli and sign in by launching that binary (~/.local/bin/agy, or $AGY_CLI_PATH) in a terminal. \`agy\` on PATH may be the IDE launcher. Error: ${String(err.message ?? err)}`,
      version: null
    };
  }
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Best-effort auth check. `agy` signs in via OAuth (consumer tier) and stores
 * creds under ~/.gemini; their presence is a reliable proxy for "signed in".
 * @returns {{ authenticated: boolean, loggedIn: boolean, method: string | null, detail: string }}
 */
export function getAntigravityAuthStatus() {
  const home = os.homedir();
  const signedIn =
    fileExists(path.join(home, ".gemini", "oauth_creds.json")) &&
    fileExists(path.join(home, ".gemini", "google_accounts.json"));
  if (signedIn) {
    return {
      authenticated: true,
      loggedIn: true,
      method: "oauth-keyring",
      detail: "Antigravity (agy) appears signed in (OAuth creds present in ~/.gemini)."
    };
  }
  return {
    authenticated: false,
    loggedIn: false,
    method: null,
    detail: "Antigravity (agy) is not signed in. Launch the headless binary (~/.local/bin/agy, or $AGY_CLI_PATH) in a terminal and sign in with your Google account. `agy` on PATH may be the IDE launcher."
  };
}

// ─── Headless turn ────────────────────────────────────────────────────────────

/**
 * Run a single prompt through `agy -p --output-format json` and read the envelope
 * from stdout.
 *
 * @param {string} cwd
 * @param {string} prompt
 * @param {{ role?: string, model?: string, write?: boolean, env?: NodeJS.ProcessEnv, onStream?: (event: any) => void, timeoutMs?: number, printTimeout?: string }} [options]
 * @returns {Promise<{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }>}
 */
export async function runHeadlessAgyTurn(cwd, prompt, options = {}) {
  const role = options.role ?? "researcher";
  const cli = findAgyBinary();
  const watchdogMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 300000;
  const printTimeout = options.printTimeout ?? `${Math.max(30, Math.round(watchdogMs / 1000) - 10)}s`;
  const args = buildHeadlessArgs({ prompt, cwd, printTimeout, role, model: options.model, write: options.write === true });
  const modelLabel = resolveAgyModel(options.model);

  if (options.onStream) {
    try {
      options.onStream({ type: "phase", message: `Antigravity: running agy -p (${modelLabel})`, phase: "agy" });
    } catch {
      // best-effort
    }
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawnCommand(cli, args, {
        cwd,
        env: buildSpawnEnvironment(options.env ?? process.env),
        // stdin closed (avoids inherited-stdin hangs). stdout is the JSON envelope.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({ sessionId: null, text: "", error, status: 1, fileChanges: [], commandExecutions: [], toolCalls: [] });
      return;
    }

    let stdoutText = "";
    let stderrText = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutText += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString();
      });
    }

    const watchdog = setTimeout(() => {
      timedOut = true;
      if (Number.isFinite(child.pid)) {
        try {
          terminateProcessTree(child.pid);
        } catch {
          // best-effort
        }
      }
    }, watchdogMs);

    child.on("error", (error) => {
      clearTimeout(watchdog);
      finish({ sessionId: null, text: "", error, status: 1, fileChanges: [], commandExecutions: [], toolCalls: [] });
    });

    child.on("close", (code) => {
      clearTimeout(watchdog);
      finish(normalizeHeadlessResult({ stdoutText, stderr: stderrText, exitCode: code ?? 0, timedOut }));
    });
  });
}

/**
 * Cancel an Antigravity headless job. The authoritative cancel is the companion's
 * process-tree kill of the job's pid (handleCancel); this reports the mechanism.
 * @param {string} jobId
 */
export async function cancelHeadlessAgy(jobId) {
  return {
    attempted: true,
    interrupted: false,
    transport: "process-tree",
    detail: `Antigravity (agy) jobs are cancelled by killing the process tree (job ${jobId}).`
  };
}

// ─── Generic adapter interface ────────────────────────────────────────────────

export const adapter = {
  name: "antigravity",
  isAvailable: getAntigravityAvailability,
  isAuthenticated: getAntigravityAuthStatus,
  invoke: runHeadlessAgyTurn,
  cancel: cancelHeadlessAgy,
  getSession: undefined
};

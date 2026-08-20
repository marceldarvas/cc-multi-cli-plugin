import process from "node:process";

import { resolveWorkspaceRoot } from "../workspace.mjs";
import { binaryAvailable } from "../process.mjs";
import { getCodexAvailability, getCodexAuthStatus, getSessionRuntimeStatus } from "../adapters/codex.mjs";
import { ADAPTERS } from "../adapters/registry.mjs";
import { getConfig, setConfig } from "../state.mjs";
import { renderSetupReport } from "../render.mjs";
import {
  outputResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace
} from "./shared.mjs";

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  // Per-CLI detection via each adapter's isAvailable(). Reflects the live
  // provider set; drives the report's CLI list so it never drifts from the
  // ADAPTERS registry. Detection is best-effort and must never throw — guard each probe.
  const cliOrder = ["codex", "cursor", "antigravity", "opencode", "cline"];
  const clis = cliOrder.map((name) => {
    // ADAPTERS[name] is the adapter module namespace; its `.adapter` object
    // carries the uniform isAvailable() probe (same shape dispatch uses).
    const adapter = ADAPTERS[name]?.adapter;
    let availability = { available: false, detail: "adapter not registered", version: null };
    if (adapter && typeof adapter.isAvailable === "function") {
      try {
        availability = adapter.isAvailable(cwd);
      } catch (error) {
        availability = {
          available: false,
          detail: `detection failed: ${error?.message ?? error}`,
          version: null
        };
      }
    }
    return {
      name,
      available: Boolean(availability?.available),
      detail: availability?.detail ?? "",
      version: availability?.version ?? null
    };
  });

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  const cursorCli = clis.find((entry) => entry.name === "cursor");
  if (cursorCli && !cursorCli.available) {
    nextSteps.push("Cursor: install the `agent` CLI from https://cursor.com/install, or set CURSOR_AGENT_PATH. Adds /cursor:delegate, /cursor:research, /cursor:explore.");
  }
  const antigravityCli = clis.find((entry) => entry.name === "antigravity");
  if (antigravityCli && !antigravityCli.available) {
    nextSteps.push("Antigravity: install the `agy` CLI (https://antigravity.google) and run `agy` once interactively to sign in. Read-only research/explore only (EXPERIMENTAL).");
  }
  const opencodeCli = clis.find((entry) => entry.name === "opencode");
  if (opencodeCli && !opencodeCli.available) {
    nextSteps.push("OpenCode: install with `npm install -g opencode-ai` or set OPENCODE_CLI_PATH.");
  }
  const clineCli = clis.find((entry) => entry.name === "cline");
  if (clineCli && !clineCli.available) {
    nextSteps.push("Cline: install the `cline` CLI (https://github.com/cline/cline) and configure the cline-pass provider. Adds /cline:review.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/multi:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    clis,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

export async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

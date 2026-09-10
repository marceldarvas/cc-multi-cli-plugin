import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);
const WINDOWS_DIRECT_EXTENSIONS = new Set([".com", ".exe"]);
const windowsCommandCache = new Map();

export function runCommand(command, args = [], options = {}) {
  const resolved = resolveSpawnCommand(command, options.env);
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout,
    windowsHide: true
  };

  const result = resolved.shellCommand
    ? spawnSync(buildWindowsShellCommand(resolved.command, args), {
        ...spawnOptions,
        shell: true
      })
    : spawnSync(resolved.command, args, spawnOptions);

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function spawnCommand(command, args = [], options = {}) {
  const resolved = resolveSpawnCommand(command, options.env);
  return resolved.shellCommand
    ? spawn(buildWindowsShellCommand(resolved.command, args), {
        ...options,
        shell: true
      })
    : spawn(resolved.command, args, options);
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  // A group-kill miss (ESRCH on a non-detached child, or EPERM in a sandbox)
  // still falls through to the bare pid. Any other group-kill error is also
  // worth a bare-pid attempt.
  let groupTerm = false;
  try {
    groupTerm = killBestEffort(killImpl, -pid, "SIGTERM");
  } catch {
    groupTerm = false;
  }
  if (groupTerm) {
    killBestEffort(killImpl, -pid, "SIGKILL");
    return { attempted: true, delivered: true, method: "process-group" };
  }
  const processTerm = killBestEffort(killImpl, pid, "SIGTERM");
  const processKill = killBestEffort(killImpl, pid, "SIGKILL");
  return { attempted: true, delivered: processTerm || processKill, method: "process" };
}

function killBestEffort(killImpl, pid, signal) {
  try {
    killImpl(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

function resolveSpawnCommand(command, env = process.env) {
  if (process.platform !== "win32") {
    return { command, shellCommand: false };
  }

  const directResolution = resolveWindowsCommand(command, env);
  return {
    command: directResolution.command,
    shellCommand: WINDOWS_BATCH_EXTENSIONS.has(directResolution.extension)
  };
}

function resolveWindowsCommand(command, env = process.env) {
  const normalized = String(command);
  const explicitExtension = getWindowsExtension(normalized);
  if (normalized.includes("/") || normalized.includes("\\")) {
    return { command: normalized.replace(/\\/g, "/"), extension: explicitExtension };
  }

  const cacheKey = `${env?.PATH ?? process.env.PATH ?? ""}\0${normalized.toLowerCase()}`;
  const cached = windowsCommandCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const found = spawnSync("where.exe", [normalized], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
  const matches = found.status === 0
    ? found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const direct = matches.find((match) => WINDOWS_DIRECT_EXTENSIONS.has(getWindowsExtension(match)));
  const batch = matches.find((match) => WINDOWS_BATCH_EXTENSIONS.has(getWindowsExtension(match)));
  const resolved = direct ?? batch ?? normalized;
  const result = { command: resolved.replace(/\\/g, "/"), extension: getWindowsExtension(resolved) };
  windowsCommandCache.set(cacheKey, result);
  return result;
}

function getWindowsExtension(command) {
  const match = String(command).match(/\.([^.\\/]+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function buildWindowsShellCommand(command, args) {
  return [command, ...args].map(quoteWindowsShellArg).join(" ");
}

// cmd.exe has no escape character inside a quoted run — a backslash is a
// literal, so the old `\"` produced a value that closed its own quote and let
// the rest of the string parse as command syntax. There is no encoding that
// makes an embedded quote safe here, so unquotable input fails closed rather
// than being mangled or smuggled through. `%` is refused for the same reason in
// the other direction: cmd.exe expands %VAR% *inside* double quotes, so it would
// silently rewrite the value.
//
// This path only carries binary paths and CLI flags (prompts travel on stdin),
// none of which legitimately contain a quote, a percent, or a control character.
export function quoteWindowsShellArg(value) {
  const text = String(value);
  if (text.includes('"')) {
    throw new Error(
      `Cannot safely pass a double quote through cmd.exe (value: ${JSON.stringify(text)}). ` +
      "cmd.exe has no quote escape; refusing rather than emitting a command the shell would re-parse."
    );
  }
  if (text.includes("%")) {
    throw new Error(
      `Cannot safely pass '%' through cmd.exe (value: ${JSON.stringify(text)}). ` +
      "cmd.exe performs variable expansion inside double quotes, which would rewrite the value."
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) {
    throw new Error(
      "Cannot safely pass control characters (including newlines) through cmd.exe."
    );
  }
  return `"${text}"`;
}

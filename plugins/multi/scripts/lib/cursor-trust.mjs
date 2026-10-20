// ABOUTME: Removes Cursor workspace-trust grants created by a headless lane.
// ABOUTME: Discovers markers by their recorded workspace path, without encoding vendor directory names.
import { lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function projectsRoot(env) {
  const home = process.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME;
  return join(home || homedir(), ".cursor", "projects");
}

// null means absence could not be established: callers must leave all markers alone.
function markerPaths(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return error.code === "ENOENT" ? new Set() : null;
  }
  const markers = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const marker = join(root, entry.name, ".workspace-trusted");
    try {
      lstatSync(marker);
      markers.add(marker);
    } catch (error) {
      if (error.code !== "ENOENT") return null;
    }
  }
  return markers;
}

// Only grants Cursor recorded as made by `--trust` are candidates; GUI and older grants carry no trustMethod.
function cliGrantWorkspace(marker) {
  try {
    if (!lstatSync(marker).isFile()) return null;
    const { workspacePath, trustMethod } = JSON.parse(readFileSync(marker, "utf8"));
    if (trustMethod !== "cli-flag") return null;
    return typeof workspacePath === "string" && isAbsolute(workspacePath) ? workspacePath : null;
  } catch {
    return null;
  }
}

// The native realpath returns the on-disk case, so a differently cased path to the same directory still matches.
function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function removeMarker(marker) {
  try {
    unlinkSync(marker);
  } catch {
    // Cleanup is best-effort; never mask a turn's result or remove its project directory.
  }
}

/** Snapshot before spawn; the returned cleanup preserves every pre-existing marker path. */
export function trackCursorTrust(cwd, env = process.env) {
  const root = projectsRoot(env);
  const before = markerPaths(root);
  const workspaces = new Set([resolve(cwd), canonicalPath(cwd)]);
  try {
    workspaces.add(realpathSync(cwd));
  } catch {
    // A failed spawn can have a missing workspace.
  }
  return () => {
    if (!before) return;
    for (const marker of markerPaths(root) ?? []) {
      if (before.has(marker)) continue;
      const workspace = cliGrantWorkspace(marker);
      if (workspace && (workspaces.has(resolve(workspace)) || workspaces.has(canonicalPath(workspace)))) {
        removeMarker(marker);
      }
    }
  };
}

/**
 * Sweep CLI grants whose workspace the caller identifies as abandoned plugin state.
 * A missing workspace alone never qualifies: an unmounted volume or a moved repo looks the same.
 */
export function sweepStaleCursorTrust(env, isAbandonedWorkspace) {
  for (const marker of markerPaths(projectsRoot(env)) ?? []) {
    const workspace = cliGrantWorkspace(marker);
    if (workspace && isAbandonedWorkspace(workspace)) removeMarker(marker);
  }
}

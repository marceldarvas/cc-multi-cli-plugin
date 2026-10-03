// ABOUTME: Tests for locating the Cursor CLI when other tools also install a binary named `agent`.
// ABOUTME: Stub executables on a controlled PATH; the resolver, probes, and setup command run for real.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getCursorAuthStatus, getCursorAvailability } from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

const COMPANION = fileURLToPath(new URL("../../plugins/multi/scripts/multi-cli-companion.mjs", import.meta.url));
const CURSOR_VERSION = "2026.09.26-dd393fe";
const SYSTEM_PATH = "/usr/bin:/bin";

// A stub whose `--version` prints `version` (exit `versionExit`) and whose
// `status` names the stub, so a test can tell which binary was driven.
function writeStub(dir, name, { version, versionExit = 0, label }) {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version}"; exit ${versionExit}; fi`,
      `if [ "$1" = "status" ]; then echo "Logged in (${label})"; exit 0; fi`,
      "exit 0",
      ""
    ].join("\n")
  );
  chmodSync(path, 0o755);
  return path;
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempDirs(count) {
  return Array.from({ length: count }, () => mkdtempSync(join(tmpdir(), "cursor-bin-")));
}

function cleanup(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

test("cursor-agent is preferred over a foreign `agent` earlier on PATH", (t) => {
  if (process.platform === "win32") return t.skip("POSIX stubs");
  const [foreign, cursor] = tempDirs(2);
  try {
    writeStub(foreign, "agent", { version: "grok 1.0.41 (4220f3b224a6) [stable]", label: "grok" });
    writeStub(cursor, "cursor-agent", { version: CURSOR_VERSION, label: "cursor-agent" });
    withEnv({ PATH: `${foreign}:${cursor}:${SYSTEM_PATH}`, CURSOR_AGENT_PATH: undefined }, () => {
      const availability = getCursorAvailability();
      assert.equal(availability.available, true, availability.detail);
      assert.equal(availability.version, CURSOR_VERSION);
      assert.match(getCursorAuthStatus().detail, /cursor-agent/);
    });
  } finally {
    cleanup([foreign, cursor]);
  }
});

test("an `agent` that reports a Cursor version is used when cursor-agent is absent", (t) => {
  if (process.platform === "win32") return t.skip("POSIX stubs");
  const [dir] = tempDirs(1);
  try {
    writeStub(dir, "agent", { version: CURSOR_VERSION, label: "cursor-as-agent" });
    withEnv({ PATH: `${dir}:${SYSTEM_PATH}`, CURSOR_AGENT_PATH: undefined }, () => {
      const availability = getCursorAvailability();
      assert.equal(availability.available, true, availability.detail);
      assert.match(getCursorAuthStatus().detail, /cursor-as-agent/);
    });
  } finally {
    cleanup([dir]);
  }
});

test("a foreign `agent` is rejected, and the detail says what was tried and why", (t) => {
  if (process.platform === "win32") return t.skip("POSIX stubs");
  const [grok, broken] = tempDirs(2);
  try {
    // Exits 0 with a non-Cursor version: the case that used to be accepted.
    const grokPath = writeStub(grok, "agent", { version: "grok 1.0.41 (4220f3b224a6) [stable]", label: "grok" });
    withEnv({ PATH: `${grok}:${SYSTEM_PATH}`, CURSOR_AGENT_PATH: undefined }, () => {
      const availability = getCursorAvailability();
      assert.equal(availability.available, false);
      assert.match(availability.detail, /cursor-agent \(not on PATH\)/);
      assert.ok(availability.detail.includes(grokPath), availability.detail);
      assert.match(availability.detail, /not Cursor/);
      assert.match(availability.detail, /grok 1\.0\.41/);
    });

    // Rejects --version outright, like an unrelated dispatcher script.
    const brokenPath = writeStub(broken, "agent", { version: "agent: unknown option: --version", versionExit: 2, label: "dispatcher" });
    withEnv({ PATH: `${broken}:${SYSTEM_PATH}`, CURSOR_AGENT_PATH: undefined }, () => {
      const availability = getCursorAvailability();
      assert.equal(availability.available, false);
      assert.ok(availability.detail.includes(brokenPath), availability.detail);
      assert.match(availability.detail, /not Cursor/);
    });
  } finally {
    cleanup([grok, broken]);
  }
});

test("CURSOR_AGENT_PATH wins without a Cursor-version check", (t) => {
  if (process.platform === "win32") return t.skip("POSIX stubs");
  const [pinned, cursor] = tempDirs(2);
  try {
    // The override is the operator's escape hatch, so its version string is not judged.
    const pinnedPath = writeStub(pinned, "my-cursor", { version: "custom build", label: "pinned" });
    writeStub(cursor, "cursor-agent", { version: CURSOR_VERSION, label: "cursor-agent" });
    withEnv({ PATH: `${cursor}:${SYSTEM_PATH}`, CURSOR_AGENT_PATH: pinnedPath }, () => {
      const availability = getCursorAvailability();
      assert.equal(availability.available, true, availability.detail);
      assert.equal(availability.version, "custom build");
      assert.match(getCursorAuthStatus().detail, /pinned/);
    });
  } finally {
    cleanup([pinned, cursor]);
  }
});

test("setup --json reports Cursor available via cursor-agent despite a foreign `agent`", (t) => {
  if (process.platform === "win32") return t.skip("POSIX stubs");
  const [foreign, cursor] = tempDirs(2);
  try {
    writeStub(foreign, "agent", { version: "grok 1.0.41 (4220f3b224a6) [stable]", label: "grok" });
    writeStub(cursor, "cursor-agent", { version: CURSOR_VERSION, label: "cursor-agent" });
    const env = { ...process.env, PATH: `${foreign}:${cursor}:${SYSTEM_PATH}` };
    delete env.CURSOR_AGENT_PATH;
    const output = execFileSync(process.execPath, [COMPANION, "setup", "--json"], { env, encoding: "utf8", timeout: 60000 });
    const entry = JSON.parse(output).clis.find((cli) => cli.name === "cursor");
    assert.equal(entry.available, true, entry.detail);
    // The foreign stub also exits 0 on --version, so availability alone can't tell them apart.
    assert.ok(entry.detail.includes(CURSOR_VERSION), entry.detail);
  } finally {
    cleanup([foreign, cursor]);
  }
});

test("a Cursor version with a suffix or a following notice line still verifies", (t) => {
  if (process.platform === "win32") return t.skip("POSIX stubs");
  const [dir] = tempDirs(1);
  try {
    writeStub(dir, "agent", { version: `${CURSOR_VERSION} (stable)\\nUpdate available`, label: "cursor-noisy" });
    withEnv({ PATH: `${dir}:${SYSTEM_PATH}`, CURSOR_AGENT_PATH: undefined }, () => {
      assert.equal(getCursorAvailability().available, true);
      assert.match(getCursorAuthStatus().detail, /cursor-noisy/);
    });
  } finally {
    cleanup([dir]);
  }
});

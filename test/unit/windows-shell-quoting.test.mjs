// ABOUTME: Tests the cmd.exe argument quoting used for Windows .bat/.cmd spawns.
// ABOUTME: cmd.exe has no backslash escape, so anything unquotable must fail closed, not be mangled.
import test from "node:test";
import assert from "node:assert/strict";

import { quoteWindowsShellArg, buildWindowsShellCommand, runCommand } from "../../plugins/multi/scripts/lib/process.mjs";

const BELL = String.fromCharCode(7);

test("ordinary paths and flags are wrapped in double quotes", () => {
  assert.equal(quoteWindowsShellArg("C:/Users/m/agent.cmd"), '"C:/Users/m/agent.cmd"');
  assert.equal(quoteWindowsShellArg("--version"), '"--version"');
});

test("a path containing spaces stays a single argument", () => {
  assert.equal(quoteWindowsShellArg("C:/Program Files/agent.cmd"), '"C:/Program Files/agent.cmd"');
});

test("an embedded double quote is refused rather than backslash-escaped", () => {
  // cmd.exe does not treat \" as an escape. The old implementation emitted
  // "a\"b", which cmd.exe reads as the quoted run "a\" followed by a bare b" —
  // i.e. the value escapes its own quoting.
  assert.throws(() => quoteWindowsShellArg('a"b'), /cmd\.exe|quote/i);
});

test("a quote-and-ampersand payload cannot smuggle a second command", () => {
  assert.throws(() => quoteWindowsShellArg('C:/x" & calc & "agent.cmd'), /cmd\.exe|quote/i);
});

test("percent is refused because cmd.exe expands it inside double quotes", () => {
  assert.throws(() => quoteWindowsShellArg("C:/%USERPROFILE%/agent.cmd"), /cmd\.exe|expan/i);
});

test("newlines and control characters are refused", () => {
  assert.throws(() => quoteWindowsShellArg("a\nb"), /cmd\.exe|control|newline/i);
  assert.throws(() => quoteWindowsShellArg("a\rb"), /cmd\.exe|control|newline/i);
  assert.throws(() => quoteWindowsShellArg(`a${BELL}b`), /cmd\.exe|control/i);
});

test("buildWindowsShellCommand joins the command and its args", () => {
  assert.equal(
    buildWindowsShellCommand("C:/a/agent.cmd", ["--version"]),
    '"C:/a/agent.cmd" "--version"'
  );
});

test("buildWindowsShellCommand refuses the whole command when any arg is unquotable", () => {
  assert.throws(() => buildWindowsShellCommand("C:/a/agent.cmd", ['--flag="x"']), /cmd\.exe|quote/i);
});

// ── legitimate values that must keep working ──────────────────────────────────

test("a single percent is allowed — '%' is a legal Windows filename character", () => {
  // Reserved set is < > : " / \ | ? * and control chars. '%' is not reserved,
  // and a lone '%' is literal to cmd.exe: only a %…% pair expands.
  assert.equal(
    quoteWindowsShellArg("C:/Users/m/100% funded/agent.cmd"),
    '"C:/Users/m/100% funded/agent.cmd"'
  );
});

test("a matched %VAR% pair is still refused", () => {
  assert.throws(() => quoteWindowsShellArg("C:/%USERPROFILE%/agent.cmd"), /%VAR%|expan/i);
});

// ── an unquotable argument must not escape as a throw ─────────────────────────

test("runCommand reports an unquotable argument as result.error, never by throwing", () => {
  // adapter.isAvailable() and friends must return a shape. Before this, a
  // refused argument propagated out of runCommand and broke that contract.
  let result;
  assert.doesNotThrow(() => {
    result = runCommand("C:/tools/agent.cmd", ['--flag="x"'], { platform: "win32" });
  });
  assert.ok(result.error, "the refusal must surface as result.error");
  assert.match(String(result.error.message), /cmd\.exe|quote/i);
  assert.notEqual(result.status, 0);
});

test("runCommand still routes a clean win32 .cmd through the shell branch", () => {
  // Not executed here (no cmd.exe on POSIX) — it must fail at spawn, not at
  // quoting, proving the argument passed the guard.
  const result = runCommand("C:/tools/agent.cmd", ["--version"], { platform: "win32" });
  if (result.error) {
    assert.doesNotMatch(String(result.error.message), /cmd\.exe has no quote|%VAR%/i);
  }
});

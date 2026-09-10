// ABOUTME: Tests the cmd.exe argument quoting used for Windows .bat/.cmd spawns.
// ABOUTME: cmd.exe has no backslash escape, so anything unquotable must fail closed, not be mangled.
import test from "node:test";
import assert from "node:assert/strict";

import { quoteWindowsShellArg, buildWindowsShellCommand } from "../../plugins/multi/scripts/lib/process.mjs";

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

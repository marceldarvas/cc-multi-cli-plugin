// ABOUTME: Tests the shared numeric env parser that replaced three near-identical copies.
// ABOUTME: Pins both semantics: allowZero for timeouts, strictly-positive for watchdog windows.
import test from "node:test";
import assert from "node:assert/strict";

import { envNumber } from "../../plugins/multi/scripts/lib/env.mjs";

test("a well-formed value is used", () => {
  assert.equal(envNumber("120", 300), 120);
  assert.equal(envNumber(45, 300), 45);
});

test("absent, empty, or whitespace-only falls back", () => {
  assert.equal(envNumber(undefined, 300), 300);
  assert.equal(envNumber(null, 300), 300);
  assert.equal(envNumber("", 300), 300);
  assert.equal(envNumber("   ", 300), 300);
});

test("a non-numeric value falls back rather than becoming NaN", () => {
  // The whole point: NaN would coerce to a 1ms timer at the call site.
  assert.equal(envNumber("abc", 300), 300);
  assert.equal(envNumber("12abc", 300), 300);
  assert.equal(envNumber("Infinity", 300), 300);
  assert.equal(envNumber("NaN", 300), 300);
});

test("negatives fall back under both modes", () => {
  assert.equal(envNumber("-5", 300), 300);
  assert.equal(envNumber("-5", 300, { allowZero: true }), 300);
});

test("zero is a real bound only when allowZero is set", () => {
  assert.equal(envNumber("0", 300, { allowZero: true }), 0);
  assert.equal(envNumber("0", 300), 300, "a window meaningless at zero must treat 0 as unset");
});

test("a string zero is not swallowed as falsy when allowed", () => {
  // `env || fallback` would have substituted the fallback here only for a
  // numeric 0; env values are strings and "0" is truthy. Pinned so a future
  // refactor back to `||` does not quietly change meaning.
  assert.equal(envNumber("0", 999, { allowZero: true }), 0);
});

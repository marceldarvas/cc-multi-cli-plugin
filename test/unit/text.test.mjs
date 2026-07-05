import test from "node:test";
import assert from "node:assert/strict";

import { firstMeaningfulLine, shorten, truncateUtf8 } from "../../plugins/multi/scripts/lib/text.mjs";

test("shorten collapses internal whitespace", () => {
  assert.equal(shorten("a   b\n\tc"), "a b c");
});

test("shorten truncates with an ellipsis past the limit", () => {
  assert.equal(shorten("abcdefghij", 8), "abcde...");
  assert.equal(shorten("abcdefghij", 8).length, 8);
});

test("shorten returns the string unchanged when within the limit", () => {
  assert.equal(shorten("short", 96), "short");
});

test("shorten returns empty string for nullish/blank input", () => {
  assert.equal(shorten(null), "");
  assert.equal(shorten("   "), "");
});

test("firstMeaningfulLine returns the first non-blank trimmed line", () => {
  assert.equal(firstMeaningfulLine("\n\n   \n  hello \nworld"), "hello");
});

test("firstMeaningfulLine falls back when there is no content", () => {
  assert.equal(firstMeaningfulLine("   \n\t", "fallback"), "fallback");
  assert.equal(firstMeaningfulLine(null, "fb"), "fb");
});

test("truncateUtf8 returns truncated:false when input is within budget", () => {
  const result = truncateUtf8("hello", 100);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "hello");
  assert.equal(result.origBytes, 5);
});

test("truncateUtf8 returns truncated:true and trims when over budget", () => {
  const result = truncateUtf8("abcdefghij", 5);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "abcde");
  assert.equal(result.origBytes, 10);
});

test("truncateUtf8 does not split a multibyte UTF-8 codepoint", () => {
  // "€" is 3 bytes (0xe2 0x82 0xac). A 4-byte budget would land mid-sequence
  // without codepoint-safe backing-off; the result must decode cleanly.
  const str = "ab€cd";
  // bytes: a(1) b(1) €(3) c(1) d(1) = 7 total; budget of 4 would naively split € at byte 4
  const result = truncateUtf8(str, 4);
  assert.equal(result.truncated, true);
  // text must be valid — no replacement char (U+FFFD)
  assert.ok(!result.text.includes('�'), 'result must not contain replacement character');
  // round-trip: re-encoding the result must equal what we got
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text);
  // the text must end on a clean codepoint boundary: "ab" (2 bytes), not "ab\xe2\x82" partial
  assert.equal(result.text, "ab");
});

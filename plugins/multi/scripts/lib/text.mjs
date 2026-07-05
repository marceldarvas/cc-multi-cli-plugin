// Pure text/formatting helpers used across companion command rendering.
// Extracted from multi-cli-companion.mjs; unit-tested in test/unit/text.test.mjs.

/**
 * Collapse internal whitespace and truncate to `limit` characters, appending an
 * ellipsis when truncated. Returns "" for nullish/blank input.
 */
export function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

/**
 * First non-empty, trimmed line of `text`, or `fallback` if there is none.
 */
export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

/**
 * Codepoint-safe truncation to a byte budget. Never splits a multibyte UTF-8
 * sequence mid-codepoint. Returns { text, truncated, origBytes }.
 */
export function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return { text: str, truncated: false, origBytes: buf.length };
  let end = maxBytes;
  // UTF-8 continuation bytes match 0b10xxxxxx; back off until we're at a lead byte.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, origBytes: buf.length };
}

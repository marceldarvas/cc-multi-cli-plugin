// ABOUTME: Parses numeric operator env vars, falling back instead of yielding NaN.
// ABOUTME: Number(env || default) returns NaN for a typo, and setTimeout(fn, NaN) fires on the next tick.

/**
 * Read a numeric env value, falling back when it is absent or unusable.
 *
 * The failure this exists to prevent: `Number(process.env.X || 300)` is `NaN`
 * for any non-numeric value, and a `NaN` timeout coerces to a 1ms timer — so a
 * single typo turns a watchdog into "kill everything immediately".
 *
 * @param {string|undefined|null} raw     the env value, as read
 * @param {number} fallback               used when raw is absent or unusable
 * @param {{ allowZero?: boolean }} [opts] allowZero accepts an explicit 0 as a
 *   real (if tight) bound. Leave it off for a window that is meaningless at
 *   zero, where 0 should mean "unset" rather than "expire instantly".
 * @returns {number}
 */
export function envNumber(raw, fallback, { allowZero = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (allowZero ? parsed < 0 : parsed <= 0) return fallback;
  return parsed;
}

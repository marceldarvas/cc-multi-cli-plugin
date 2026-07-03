// ABOUTME: Parses cline --json (JSONL) stdout into a normalized review result.
// ABOUTME: Prefers completed run_result; salvages content_start text deltas on truncation.

export class ReviewParseError extends Error {
  constructor(message, tail) { super(message); this.name = 'ReviewParseError'; this.tail = tail; }
}
export class EmptyReviewError extends Error {
  constructor(message = 'Cline returned an empty review') { super(message); this.name = 'EmptyReviewError'; }
}
export class ReviewTimeoutError extends Error {
  constructor(finishReason) {
    super(`Cline timed out before producing findings (finishReason=${finishReason}). Raise --timeout or narrow with --base.`);
    this.name = 'ReviewTimeoutError';
    this.finishReason = finishReason;
  }
}

function parseLines(stdout) {
  const out = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
  }
  return out;
}

function nonEmpty(text) { return typeof text === 'string' && text.trim().length > 0; }

function salvageDeltas(events) {
  return events
    .filter((e) => e.type === 'agent_event' && e.event?.type === 'content_start' && e.event?.contentType === 'text')
    .map((e) => e.event.text)
    .filter((t) => typeof t === 'string')
    .join('');
}

function build(text, finishReason, partial, rr) {
  return {
    text, finishReason, partial,
    model: rr?.model?.id ?? null,
    usage: rr?.aggregateUsage ?? rr?.usage ?? null,
    durationMs: rr?.durationMs ?? null,
  };
}

export function parseReview(stdout) {
  const events = parseLines(stdout);
  const runResult = [...events].reverse().find((e) => e.type === 'run_result');

  if (runResult) {
    if (runResult.finishReason === 'completed') {
      if (!nonEmpty(runResult.text)) throw new EmptyReviewError();
      return build(runResult.text, 'completed', false, runResult);
    }
    const salvage = salvageDeltas(events);
    if (nonEmpty(salvage)) return build(salvage, runResult.finishReason, true, runResult);
    throw new ReviewTimeoutError(runResult.finishReason);
  }

  const done = [...events].reverse().find((e) => e.type === 'agent_event' && e.event?.type === 'done');
  if (done && nonEmpty(done.event.text)) {
    return build(done.event.text, done.event.reason ?? null, done.event.reason !== 'completed', null);
  }
  const salvage = salvageDeltas(events);
  if (nonEmpty(salvage)) return build(salvage, 'partial', true, null);

  throw new ReviewParseError('No parseable review in cline output', String(stdout).slice(-2000));
}

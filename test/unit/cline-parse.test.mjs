import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReview, ReviewParseError, EmptyReviewError, ReviewTimeoutError } from '../../plugins/multi/scripts/lib/adapters/cline-parse.mjs';

const fx = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

test('extracts a completed review from run_result (real fixture)', () => {
  const r = parseReview(fx('completed.jsonl'));
  assert.equal(r.finishReason, 'completed');
  assert.equal(r.model, 'cline-pass/glm-5.2');
  assert.equal(r.partial, false);
  assert.ok(r.text.startsWith('## Bug Report'));
  assert.equal(typeof r.durationMs, 'number');
});

test('minimal synthetic completed run_result', () => {
  const line = JSON.stringify({
    type: 'run_result', finishReason: 'completed', text: 'LGTM', durationMs: 5,
    aggregateUsage: { totalCost: 0.01 }, model: { id: 'cline-pass/glm-5.2' },
  });
  const r = parseReview(line + '\n');
  assert.equal(r.text, 'LGTM');
  assert.equal(r.usage.totalCost, 0.01);
  assert.equal(r.partial, false);
});

test('salvages partial findings when truncated mid-write (no run_result)', () => {
  const r = parseReview(fx('truncated-mid-text.jsonl'));
  assert.equal(r.partial, true);
  assert.ok(r.text.startsWith('## Bug Report'));
});

test('aborted mid-reasoning (no findings) throws ReviewTimeoutError', () => {
  assert.throws(() => parseReview(fx('truncated.jsonl')), ReviewTimeoutError);
});

test('completed run_result with empty text throws EmptyReviewError', () => {
  const line = JSON.stringify({ type: 'run_result', finishReason: 'completed', text: '   ', model: { id: 'm' } });
  assert.throws(() => parseReview(line), EmptyReviewError);
});

test('falls back to agent_event done text when no run_result', () => {
  const line = JSON.stringify({ type: 'agent_event', event: { type: 'done', reason: 'completed', text: 'FALLBACK' } });
  const r = parseReview(line);
  assert.equal(r.text, 'FALLBACK');
  assert.equal(r.partial, false);
});

test('skips blank and unparseable lines', () => {
  const line = JSON.stringify({ type: 'run_result', finishReason: 'completed', text: 'OK', model: { id: 'm' } });
  assert.equal(parseReview(`\ngarbage{\n${line}\n`).text, 'OK');
});

test('no usable content throws ReviewParseError', () => {
  assert.throws(() => parseReview('\n\n'), ReviewParseError);
});

// ABOUTME: Resolves the diff to review — uncommitted (incl. untracked) or a branch vs a base ref — and builds the review prompt.
// ABOUTME: Shared by the Cline and Cursor review paths; throws typed errors for git edge cases.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './cline-git.mjs';
import { truncateUtf8 } from '../text.mjs';

export class NotAGitRepoError extends Error { constructor(m = 'Not inside a git work tree') { super(m); this.name = 'NotAGitRepoError'; } }
export class NoCommitsError extends Error { constructor(m = 'Repository has no commits yet') { super(m); this.name = 'NoCommitsError'; } }
export class BaseRefNotFoundError extends Error { constructor(ref) { super(`Base ref not found: ${ref}`); this.name = 'BaseRefNotFoundError'; } }
export class NoMergeBaseError extends Error { constructor(ref) { super(`No common history with base: ${ref}`); this.name = 'NoMergeBaseError'; } }

function assertRepo(cwd) {
  const r = git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (r.code !== 0 || r.stdout.trim() !== 'true') throw new NotAGitRepoError();
}

// Diffs the working tree, untracked files included, without touching the real
// index. The scratch index is built from HEAD rather than copied from the repo:
// a copy would have to be located (git reports the index path relative to
// wherever it ran) and would carry stat data that makes git trust its cache, so
// an edit landing in the same clock tick as the last index write reads as clean.
function workingTreeDiff(cwd) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cline-idx-'));
  const env = { GIT_INDEX_FILE: join(tmpDir, 'index') };
  try {
    const readTree = git(['read-tree', 'HEAD'], cwd, env);
    if (readTree.code !== 0) {
      throw new Error(readTree.stderr.trim() || `git read-tree failed (${readTree.code})`);
    }
    const added = git(['add', '-N', '--', '.'], cwd, env);
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || `git add -N failed (${added.code})`);
    }
    return git(['diff', 'HEAD'], cwd, env).stdout;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function resolveDiff({ cwd, base }) {
  assertRepo(cwd);
  if (git(['rev-parse', '--verify', '-q', 'HEAD'], cwd).code !== 0) throw new NoCommitsError();

  let diff;
  if (base) {
    if (git(['rev-parse', '--verify', '-q', `${base}^{commit}`], cwd).code !== 0) throw new BaseRefNotFoundError(base);
    if (git(['merge-base', base, 'HEAD'], cwd).code !== 0) throw new NoMergeBaseError(base);
    diff = git(['diff', `${base}...HEAD`], cwd).stdout;
  } else {
    diff = workingTreeDiff(cwd);
  }

  const filesChanged = [...diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((m) => m[1]).filter((f) => f !== '/dev/null');
  return { diff, filesChanged, isEmpty: diff.trim().length === 0 };
}

const PROMPT_BUDGET = 768 * 1024;

/**
 * Builds the diff-as-prompt body for a review run (Cline or Cursor). Truncates large diffs
 * with a descriptive marker. Appends an optional reviewer focus instruction.
 */
export function buildReviewPrompt(diff, { focus } = {}) {
  const body = "Review this diff for bugs:\n";
  const { text: diffText, truncated, origBytes } = truncateUtf8(diff, PROMPT_BUDGET - body.length - 200);
  const marker = truncated
    ? `[TRUNCATED: diff was ${Math.round(origBytes / 1024)} KB; reviewing first ${Math.round(Buffer.byteLength(diffText, "utf8") / 1024)} KB. Narrow with --base or review fewer files.]\n`
    : "";
  const focusSuffix = focus && focus.trim() ? `\n\nReviewer focus: ${focus.trim()}` : "";
  return body + marker + diffText + focusSuffix;
}

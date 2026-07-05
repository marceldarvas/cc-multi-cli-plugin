// ABOUTME: Resolves the diff to review — uncommitted (incl. untracked) or a branch vs a base ref.
// ABOUTME: Returns { diff, filesChanged, isEmpty } and throws typed errors for git edge cases.
import { git } from './cline-git.mjs';

export class NotAGitRepoError extends Error { constructor(m = 'Not inside a git work tree') { super(m); this.name = 'NotAGitRepoError'; } }
export class NoCommitsError extends Error { constructor(m = 'Repository has no commits yet') { super(m); this.name = 'NoCommitsError'; } }
export class BaseRefNotFoundError extends Error { constructor(ref) { super(`Base ref not found: ${ref}`); this.name = 'BaseRefNotFoundError'; } }
export class NoMergeBaseError extends Error { constructor(ref) { super(`No common history with base: ${ref}`); this.name = 'NoMergeBaseError'; } }

function assertRepo(cwd) {
  const r = git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (r.code !== 0 || r.stdout.trim() !== 'true') throw new NotAGitRepoError();
}

function untrackedDiff(cwd) {
  // NUL-delimited so spaces/newlines in names are safe.
  const listed = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  const files = listed.stdout.split('\0').filter(Boolean);
  let out = '';
  for (const f of files) {
    // --no-index exits 1 when a diff exists; only >1 is a real error.
    const d = git(['diff', '--no-index', '--', '/dev/null', f], cwd);
    if (d.code > 1) continue; // unreadable/binary edge: skip rather than fail
    out += d.stdout;
  }
  return out;
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
    diff = git(['diff', 'HEAD'], cwd).stdout + untrackedDiff(cwd);
  }

  const filesChanged = [...diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((m) => m[1]).filter((f) => f !== '/dev/null');
  return { diff, filesChanged, isEmpty: diff.trim().length === 0 };
}

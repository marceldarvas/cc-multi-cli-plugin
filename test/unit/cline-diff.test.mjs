import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../plugins/multi/scripts/lib/adapters/cline-git.mjs';
import { resolveDiff, NotAGitRepoError, BaseRefNotFoundError, NoCommitsError } from '../../plugins/multi/scripts/lib/adapters/cline-diff.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'clr-'));
  git(['init', '-q'], dir); git(['config', 'user.email', 't@t.t'], dir); git(['config', 'user.name', 't'], dir);
  return dir;
}
function commit(dir, name, body) { writeFileSync(join(dir, name), body); git(['add', '.'], dir); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', name], dir); }

test('empty when no changes', () => {
  const dir = repo(); commit(dir, 'a.js', 'x\n');
  assert.equal(resolveDiff({ cwd: dir }).isEmpty, true);
  rmSync(dir, { recursive: true, force: true });
});

test('includes tracked uncommitted changes', () => {
  const dir = repo(); commit(dir, 'a.js', 'x\n'); writeFileSync(join(dir, 'a.js'), 'y\n');
  const { diff, isEmpty } = resolveDiff({ cwd: dir });
  assert.equal(isEmpty, false);
  assert.match(diff, /a\.js/);
  rmSync(dir, { recursive: true, force: true });
});

test('includes an untracked file (even with a space in its name)', () => {
  const dir = repo(); commit(dir, 'a.js', 'x\n');
  writeFileSync(join(dir, 'new file.js'), 'const secret = 1;\n');
  const { diff } = resolveDiff({ cwd: dir });
  assert.match(diff, /new file\.js/);
  assert.match(diff, /const secret/);
  rmSync(dir, { recursive: true, force: true });
});

test('base review uses three-dot range', () => {
  const dir = repo(); commit(dir, 'a.js', 'x\n');
  // detect the actual default branch before we branch off
  const defaultBranch = git(['symbolic-ref', '--short', 'HEAD'], dir).stdout.trim();
  git(['checkout', '-qb', 'feat'], dir); commit(dir, 'b.js', 'feature\n');
  const { diff, isEmpty } = resolveDiff({ cwd: dir, base: defaultBranch });
  assert.equal(isEmpty, false);
  assert.match(diff, /b\.js/);
  rmSync(dir, { recursive: true, force: true });
});

test('missing base ref throws BaseRefNotFoundError', () => {
  const dir = repo(); commit(dir, 'a.js', 'x\n');
  assert.throws(() => resolveDiff({ cwd: dir, base: 'nope-xyz' }), BaseRefNotFoundError);
  rmSync(dir, { recursive: true, force: true });
});

test('non-repo throws NotAGitRepoError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nr-'));
  assert.throws(() => resolveDiff({ cwd: dir }), NotAGitRepoError);
  rmSync(dir, { recursive: true, force: true });
});

test('unborn branch (no commits) throws NoCommitsError', () => {
  const dir = repo();
  assert.throws(() => resolveDiff({ cwd: dir }), NoCommitsError);
  rmSync(dir, { recursive: true, force: true });
});

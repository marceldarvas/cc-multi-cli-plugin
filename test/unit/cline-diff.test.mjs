import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

function indexHash(dir) {
  const indexPath = git(['rev-parse', '--git-path', 'index'], dir).stdout.trim();
  return { indexPath, hash: createHash('sha256').update(readFileSync(indexPath)).digest('hex') };
}

test('temp-index path leaves the real index and working tree untouched', () => {
  const dir = repo();
  commit(dir, 'a.js', 'x\n');
  writeFileSync(join(dir, 'a.js'), 'y\n');
  writeFileSync(join(dir, 'new file.js'), 'const secret = 1;\n');
  const before = indexHash(dir);
  const statusBefore = git(['status', '--porcelain', '--untracked-files=all'], dir).stdout;
  const { diff, isEmpty } = resolveDiff({ cwd: dir });
  assert.equal(isEmpty, false);
  assert.match(diff, /a\.js/);
  assert.match(diff, /new file\.js/);
  assert.match(diff, /const secret/);
  const after = indexHash(dir);
  assert.equal(after.indexPath, before.indexPath);
  assert.equal(after.hash, before.hash);
  assert.equal(git(['status', '--porcelain', '--untracked-files=all'], dir).stdout, statusBefore);
  rmSync(dir, { recursive: true, force: true });
});

test('linked worktree resolves the index via git-path, not .git/index', () => {
  const dir = repo();
  commit(dir, 'a.js', 'x\n');
  const wt = mkdtempSync(join(tmpdir(), 'clr-wt-'));
  rmSync(wt, { recursive: true, force: true });
  const added = git(['worktree', 'add', '-q', wt], dir);
  assert.equal(added.code, 0, added.stderr);
  try {
    assert.equal(existsSync(join(wt, '.git')), true);
    assert.equal(existsSync(join(wt, '.git', 'index')), false, 'linked worktree must not have .git/index');
    writeFileSync(join(wt, 'wt-only.js'), 'export const n = 1;\n');
    const before = indexHash(wt);
    const { diff } = resolveDiff({ cwd: wt });
    assert.match(diff, /wt-only\.js/);
    const after = indexHash(wt);
    assert.equal(after.hash, before.hash);
    assert.match(git(['rev-parse', '--git-path', 'index'], wt).stdout, /index/);
    assert.ok(!git(['rev-parse', '--git-path', 'index'], wt).stdout.includes(`${wt}/.git/index`));
  } finally {
    git(['worktree', 'remove', '--force', wt], dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDiff uses a temp GIT_INDEX_FILE via git-path index, not per-file --no-index', () => {
  const src = readFileSync(fileURLToPath(new URL('../../plugins/multi/scripts/lib/adapters/cline-diff.mjs', import.meta.url)), 'utf8');
  assert.match(src, /--git-path/);
  assert.match(src, /GIT_INDEX_FILE/);
  assert.match(src, /add['"\s,]+-N/);
  assert.doesNotMatch(src, /function untrackedDiff/);
  assert.doesNotMatch(src, /--no-index/);
});

test('temp-index still surfaces a rename, a symlink, a binary file, and a no-trailing-newline file', () => {
  const dir = repo();
  commit(dir, 'old-name.js', 'same\n');
  commit(dir, 'plain.txt', 'plain\n');
  git(['mv', 'old-name.js', 'new-name.js'], dir);
  writeFileSync(join(dir, 'no-nl.txt'), 'no newline');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
  symlinkSync('plain.txt', join(dir, 'link.txt'));
  const before = indexHash(dir);
  const { diff } = resolveDiff({ cwd: dir });
  assert.match(diff, /new-name\.js|old-name\.js/);
  assert.match(diff, /no-nl\.txt/);
  assert.match(diff, /blob\.bin|GIT binary patch|Binary files/);
  assert.match(diff, /link\.txt/);
  assert.equal(indexHash(dir).hash, before.hash);
  rmSync(dir, { recursive: true, force: true });
});

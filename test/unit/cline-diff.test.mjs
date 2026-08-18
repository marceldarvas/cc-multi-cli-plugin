import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
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

test('linked worktree, which has no .git/index, diffs without touching its index', () => {
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

test('resolves the index path independently of the process cwd', () => {
  // `git rev-parse --git-path index` answers relative to the directory git ran
  // in (".git/index" at the top level, "../.git/index" below it), so anything
  // resolving it against the node process cwd reads the wrong index or none.
  // Runs in a child process so the review never depends on our own cwd.
  const dir = repo();
  commit(dir, 'a.js', 'x\n');
  writeFileSync(join(dir, 'a.js'), 'y\n');
  writeFileSync(join(dir, 'untracked.js'), 'const n = 1;\n');
  const elsewhere = mkdtempSync(join(tmpdir(), 'clr-cwd-'));
  const mod = pathToFileURL(fileURLToPath(new URL('../../plugins/multi/scripts/lib/adapters/cline-diff.mjs', import.meta.url))).href;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { resolveDiff } from ${JSON.stringify(mod)};\n` +
      `process.stdout.write(JSON.stringify(resolveDiff({ cwd: ${JSON.stringify(dir)} })));`],
      { cwd: elsewhere, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const { diff } = JSON.parse(r.stdout);
    assert.match(diff, /a\.js/);
    assert.match(diff, /untracked\.js/);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDiff builds a temp GIT_INDEX_FILE from HEAD, never copying the real index', () => {
  const src = readFileSync(fileURLToPath(new URL('../../plugins/multi/scripts/lib/adapters/cline-diff.mjs', import.meta.url)), 'utf8');
  assert.match(src, /GIT_INDEX_FILE/);
  assert.match(src, /read-tree/);
  assert.match(src, /add['"\s,]+-N/);
  assert.doesNotMatch(src, /function untrackedDiff/);
  assert.doesNotMatch(src, /--no-index/);
  assert.doesNotMatch(src, /copyFileSync/, 'copying the real index reintroduces its stale stat cache');
});

test('detects an edit made in the same clock tick as the commit', () => {
  // A copied index carries stat data git trusts, so a same-size edit landing in
  // the same tick as the last index write used to read as clean (~1 in 200).
  for (let i = 0; i < 25; i++) {
    const dir = repo();
    commit(dir, 'a.js', 'const x = 1;\n');
    writeFileSync(join(dir, 'a.js'), 'const x = 2;\n'); // same size, no delay
    const { diff, isEmpty } = resolveDiff({ cwd: dir });
    assert.equal(isEmpty, false, `missed the edit on iteration ${i}`);
    assert.match(diff, /const x = 2/);
    rmSync(dir, { recursive: true, force: true });
  }
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

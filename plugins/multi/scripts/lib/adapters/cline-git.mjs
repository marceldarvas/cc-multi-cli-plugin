// ABOUTME: Minimal git helpers over spawnSync with shell:false (injection-safe).
// ABOUTME: git() runs an args array; repoRoot() resolves the work-tree toplevel.
import { spawnSync } from 'node:child_process';

export function git(args, cwd, env) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : undefined
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? (r.signal ? 128 : 0) };
}

export function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

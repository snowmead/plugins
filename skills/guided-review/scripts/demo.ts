#!/usr/bin/env bun
/* The demo: a small pull request ("Retry failed webhook deliveries with backoff") and its guide, built into
   examples/demo.artifact.html and examples/demo.preview.html. test.ts and the screenshots use it too.

     bun scripts/demo.ts

   examples/demo/base/ is the repository on main; examples/demo/head/ holds the files the pull request adds or
   changes. makeDemoRepo() commits the two on main and on a branch in a scratch repository. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DEMO = join(ROOT, 'examples', 'demo');

export const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', '-c', 'user.name=Example Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

/** A scratch repository: main holds the base, branch retry-webhooks the pull request. Returns its path. */
export function makeDemoRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'guided-review-demo-'));
  git(repo, 'init', '-q', '-b', 'main');
  cpSync(join(DEMO, 'base'), repo, { recursive: true });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'Webhook deliveries, posted once');
  git(repo, 'checkout', '-qb', 'retry-webhooks');
  cpSync(join(DEMO, 'head'), repo, { recursive: true });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'Retry failed webhook deliveries with backoff');
  return repo;
}

/** Gather the demo's diff and build its guide into <out>.artifact.html and <out>.preview.html. */
export function buildDemo(out = join(ROOT, 'examples', 'demo'), quiet = false): { code: number; log: string } {
  const repo = makeDemoRepo();
  try {
    const diff = join(repo, 'diff.json');
    const steps = [
      ['bun', join(ROOT, 'scripts/gather.ts'), '--base=main', '--head=retry-webhooks', `--out=${diff}`],
      ['bun', join(ROOT, 'scripts/build.ts'), `--diff=${diff}`, `--guide=${join(ROOT, 'examples/demo.guide.json')}`, `--out=${out}`, `--repo=${repo}`],
    ];
    let log = '';
    for (const cmd of steps) {
      const p = Bun.spawnSync(cmd, { cwd: repo, stdout: quiet ? 'pipe' : 'inherit', stderr: quiet ? 'pipe' : 'inherit' });
      if (quiet) log += (p.stdout?.toString() ?? '') + (p.stderr?.toString() ?? '');
      if (p.exitCode) return { code: p.exitCode, log };
    }
    return { code: 0, log };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(buildDemo().code);

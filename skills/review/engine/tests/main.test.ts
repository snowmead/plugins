// The engine's command line, run as the skill runs it.

import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a local review refuses every option but its own, before it writes or reads anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-'))
  const file = join(dir, 'written')
  for (const extra of [['--events', file], ['--out', file], ['--report', file], ['--read-dir', '/'], ['--rules', '/etc/hostname'], ['--mode', 'tune']]) {
    const p = Bun.spawnSync([process.execPath, '--no-env-file', join(import.meta.dir, '../main.ts'), 'local', '--repo', dir, ...extra], { stdout: 'pipe', stderr: 'pipe' })
    expect([extra[0], p.exitCode]).toEqual([extra[0], 1])
    expect(p.stderr.toString()).toContain(`a local review takes only --repo, --base, --committed, --note, --concurrency, --json, not ${extra[0]}`)
  }
  expect(existsSync(file)).toBe(false)
})

test('a local review takes only a commit as its base, never an option for git', () => {
  const repo = mkdtempSync(join(tmpdir(), 'local-'))
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'one')
  git('branch', 'side')
  const local = (...args: string[]) =>
    Bun.spawnSync([process.execPath, '--no-env-file', join(import.meta.dir, '../main.ts'), 'local', '--repo', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const file = join(repo, 'written')
  for (const base of [`--output=${file}`, 'no-such-branch']) {
    const p = local('--base', base)
    expect([base, p.exitCode]).toEqual([base, 1])
    expect(p.stderr.toString()).toContain(`--base ${base} names no commit`)
  }
  expect(existsSync(file)).toBe(false)
  // A commit or a branch goes on as its merge base with HEAD, here HEAD
  // itself, so --committed finds nothing to review and stops before any agent.
  const head = git('rev-parse', '--short', 'HEAD').stdout.toString().trim()
  for (const base of ['HEAD', 'side']) {
    const p = local('--base', base, '--committed')
    expect([base, p.exitCode]).toEqual([base, 1])
    expect(p.stderr.toString()).toContain(`HEAD is the base ${head}, so there are no commits to review`)
  }
})

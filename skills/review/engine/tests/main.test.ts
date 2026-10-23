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

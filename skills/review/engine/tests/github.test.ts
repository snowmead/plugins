// The tuning routine's GitHub reads and file writes: one repository's routes,
// and files inside one directory.

import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeRefusal, writeInside } from '../github.ts'

test("the agents read only the repository's own routes", () => {
  for (const ok of [
    'repos/o/r/pulls/5/comments?per_page=100',
    'repos/o/r',
    '/repos/o/r/commits/abc',
    'search/issues?q=repo:o/r+is:pr',
    `search/issues?q=${encodeURIComponent('is:pr repo:o/r merged:2026-10-05..2026-10-12')}&page=2`,
  ]) {
    expect([ok, routeRefusal(ok, 'o/r')]).toEqual([ok, null])
  }
  for (const bad of [
    'repos/o/other/pulls',
    'repos/o/rx/pulls',
    'user',
    'https://api.github.com/repos/o/r',
    '//evil/repos/o/r',
    'repos/o/r/../../user',
    'repos/o/r/pulls 5',
    // fetch reads an escaped dot as a dot.
    'repos/o/r/%2e%2e/%2e%2e/%2e%2e/user/repos',
    'repos/o/r/.%2E/.%2e/x',
    'repos/o/r\\..\\x',
    // A search reads one repository: GitHub joins several scopes with OR.
    'search/issues?q=is:pr',
    'search/issues?q=repo:o/r+repo:other/private',
    'search/issues?q=repo:o/r+org:other',
    'search/issues?q=repo:o/r+user:someone',
    'search/issues?q=repo:o/r&q=repo:other/private',
  ]) {
    expect([bad, routeRefusal(bad, 'o/r')]).not.toEqual([bad, null])
  }
})

test('the draft writes only inside its directory, and through no link', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tune-'))
  expect(writeInside('o/prs/1.json', 'x', 'o', cwd)).toBeNull()
  expect(readFileSync(join(cwd, 'o/prs/1.json'), 'utf8')).toBe('x')
  expect(writeInside('REVIEW.md', 'x', 'o', cwd)).toContain('Only files inside o')
  expect(writeInside('o/../REVIEW.md', 'x', 'o', cwd)).toContain('Only files inside o')
  expect(writeInside('o', 'x', 'o', cwd)).toContain('Only files inside o')
  symlinkSync(cwd, join(cwd, 'o/up'))
  expect(writeInside('o/up/REVIEW.md', 'x', 'o', cwd)).toContain('goes through a link')
  // Refused before any directory is made through the link.
  expect(writeInside('o/up/a/b/x.md', 'x', 'o', cwd)).toContain('goes through a link')
  expect(existsSync(join(cwd, 'a'))).toBe(false)
  symlinkSync(join(cwd, 'REVIEW.md'), join(cwd, 'o/file'))
  expect(writeInside('o/file', 'x', 'o', cwd)).toContain('goes through a link')
  expect(existsSync(join(cwd, 'REVIEW.md'))).toBe(false)
})

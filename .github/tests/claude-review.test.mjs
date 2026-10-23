// Tests the review job's choice of which copy of the review action runs
// (.github/workflows/claude-review.yml, "Take the review action from the base
// branch"): the job holds the Claude credential, so a pull request's own copy
// may run only on a pull request event before any branch has the action.
// Runs the step's script as GitHub does, over a repository with one branch per
// case. The Review skill workflow runs it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const JOB = join(dirname(fileURLToPath(import.meta.url)), '../workflows/claude-review.yml')
const STEP = 'Take the review action from the base branch'

// The step's `run` block, without its indentation.
function script() {
  const lines = readFileSync(JOB, 'utf8').split('\n')
  const step = lines.findIndex((line) => line.trim() === `- name: ${STEP}`)
  assert.ok(step >= 0, `the job has no "${STEP}" step`)
  const run = lines.findIndex((line, i) => i > step && line.trim() === 'run: |')
  const indent = lines[run].search(/\S/)
  const body = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break
    body.push(line)
  }
  const margin = Math.min(...body.filter((line) => line.trim()).map((line) => line.search(/\S/)))
  return body.map((line) => line.slice(margin)).join('\n')
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

// A workspace with the pull request checked out in `pr`: origin/bare has no
// action, origin/base and origin/main each have their own copy, and the head
// has the pull request's. Returns the workspace and the head commit.
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'review-job-'))
  const pr = join(dir, 'pr')
  mkdirSync(pr)
  const git = (...args) => execFileSync('git', args, { cwd: pr, env: { ...process.env, ...GIT_ENV } }).toString().trim()
  git('init', '-q', '-b', 'main')
  const commit = (branch, action) => {
    if (action) {
      mkdirSync(join(pr, 'skills/review'), { recursive: true })
      writeFileSync(join(pr, 'skills/review/action.yml'), action)
    }
    writeFileSync(join(pr, 'README.md'), branch)
    git('add', '-A')
    git('commit', '-q', '-m', branch)
    git('update-ref', `refs/remotes/origin/${branch}`, 'HEAD')
    return git('rev-parse', 'HEAD')
  }
  commit('bare')
  commit('base', 'the base copy')
  commit('main', 'the default copy')
  const head = commit('head', 'the pull request copy')
  return { dir, head }
}

function step(env) {
  const { dir, head } = workspace()
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script()], {
    cwd: dir,
    env: { PATH: process.env.PATH, ...GIT_ENV, HEAD: head, ...env },
    encoding: 'utf8',
  })
  const action = join(dir, '.review-action/skills/review/action.yml')
  const copy = existsSync(action) ? readFileSync(action, 'utf8') : null
  rmSync(dir, { recursive: true, force: true })
  return { status: run.status, out: run.stdout + run.stderr, copy }
}

test('the base branch copy runs when the base has the action', () => {
  const run = step({ BASE: 'base', DEFAULT: 'main', EVENT: 'workflow_dispatch' })
  assert.equal(run.status, 0, run.out)
  assert.equal(run.copy, 'the base copy')
  assert.doesNotMatch(run.out, /::notice/)
})

test('the default branch copy runs when the base has none', () => {
  const run = step({ BASE: 'bare', DEFAULT: 'main', EVENT: 'pull_request' })
  assert.equal(run.status, 0, run.out)
  assert.equal(run.copy, 'the default copy')
  assert.match(run.out, /origin\/bare has no review action, so the review uses main's\./)
})

test("the pull request's copy runs only on a pull request event before any branch has the action", () => {
  const event = step({ BASE: 'bare', DEFAULT: 'bare', EVENT: 'pull_request' })
  assert.equal(event.status, 0, event.out)
  assert.equal(event.copy, 'the pull request copy')
  assert.match(event.out, /No branch has the review action yet/)
  const manual = step({ BASE: 'bare', DEFAULT: 'bare', EVENT: 'workflow_dispatch' })
  assert.equal(manual.status, 1, manual.out)
  assert.equal(manual.copy, null)
  assert.match(manual.out, /::error title=Claude review::Neither origin\/bare nor origin\/bare has the review action\./)
})

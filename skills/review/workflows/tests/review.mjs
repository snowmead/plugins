// The review workflow over the args on stdin, with stub agents, for the
// action's Rust tests of what passes between the workflow and the job: the
// security segment finds one Nit on src/a.rs:3 when it runs, its skeptic
// confirms it, the editor posts every finding it gets, and the follow-up says
// thread T1 is fixed and answers a person in thread T2 with text that starts
// with "Fixed ". Prints the workflow's result.

import { readFileSync } from 'node:fs'
import { review, run } from './harness.mjs'

const args = JSON.parse(readFileSync(0, 'utf8'))
const finding = { path: 'src/a.rs', line: 3, severity: 'nit', title: 'refused inline', body: 'b', trace: 't' }
let found = false
const { result } = await run('pr-review.js', args, (label) => {
  if (label === 'security') {
    found = true
    return { findings: [finding] }
  }
  if (label.startsWith('verify ')) return { verdict: 'confirmed', severity: 'nit', reason: 'r', trace: 't', security_or_privacy: false }
  if (label === 'follow-up') {
    return {
      threads: [
        { id: 'T1', title: 't', state: 'fixed', commit: 'd'.repeat(40), note: 'n' },
        { id: 'T2', title: 't', state: 'open', answer: 'Fixed only for a full list: `src/a.rs:3` still reads an empty one.' },
      ],
    }
  }
  if (label === 'editor') return { ...review('editor'), summary_only: [], post: found ? [{ ...finding, keys: ['security-1'], slug: 's' }] : [] }
  return review(label)
})
process.stdout.write(JSON.stringify(result))

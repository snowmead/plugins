// The review engine over the args on stdin, with stub agents, for the action's
// Rust tests of what passes between the engine and the job: the security
// segment finds one Nit on src/a.rs:3 when it runs, its skeptic confirms it,
// the editor posts every finding it gets, and the follow-up says thread T1 is
// fixed and answers a person in thread T2 with text that starts with
// "Fixed ". The threads file the args name holds this reviewer's open threads
// T1 and T2. Prints the engine's result.

import { readFileSync } from 'node:fs'
import type { AgentCall, Args } from '../review.ts'
import { review as reviewed } from '../review.ts'
import { review, stubIo, thread } from './harness.ts'

const args: Args = JSON.parse(readFileSync(0, 'utf8'))
const finding = { path: 'src/a.rs', line: 3, severity: 'nit', title: 'refused inline', body: 'b', trace: 't' }
let found = false
const answer = (label: string) => {
  if (label === 'security') {
    found = true
    return { findings: [finding] }
  }
  if (label.startsWith('verify ')) return { verdict: 'confirmed', severity: 'nit', reason: 'r', security_or_privacy: false }
  if (label === 'follow-up') {
    return {
      threads: [
        { id: 'T1', state: 'fixed', holds: false, commit: 'd'.repeat(40), note: 'n' },
        { id: 'T2', state: 'open', holds: false, answer: 'Fixed only for a full list: `src/a.rs:3` still reads an empty one.' },
      ],
    }
  }
  if (label === 'editor') return { ...(review('editor') as object), summary_only: [], post: found ? [{ keys: ['security-1'], slug: 's' }] : [] }
  return review(label)
}
const reviewer = typeof args.reviewer === 'string' ? args.reviewer : 'github-actions'
const threads = [thread('T1', { severity: 'Nit', title: 't', path: 'src/a.rs', line: 3, reviewer }), thread('T2', { severity: 'Nit', title: 't', path: 'src/a.rs', line: 3, reviewer, replies: [{ author: 'person', body: 'Fixed?' }] })]
const files: Record<string, string> = typeof args.threads === 'string' ? { [args.threads]: JSON.stringify(threads) } : {}
const rt = { knowledgeBase: true, log: () => {}, agent: async (call: AgentCall) => answer(call.label) }
const result = await reviewed(args, rt, stubIo({ files }))
process.stdout.write(JSON.stringify(result))

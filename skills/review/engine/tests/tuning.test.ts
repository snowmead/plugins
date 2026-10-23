// The tuning routine with every agent answered by a stub, GitHub and the
// files answered from memory, and the review engine's replays stubbed.

import { expect, test } from 'bun:test'
import type { AgentCall, Args, Io } from '../review.ts'
import { review } from '../review.ts'
import { type Engine, type TuningIo, tune } from '../tuning.ts'
import { CONFIG, SEGMENTS, stubIo } from './harness.ts'

const ARGS = { repo: 'o/r', since: '2026-10-05', until: '2026-10-12', out_dir: 'o', rules: 'RULES.md', config_file: 'c.json' }
const CASE = (id: string, pr = 60) => ({ id, pr, base: 'b'.repeat(40), head: 'c'.repeat(40), segment: 'bugs', expect: 'find', path: 'src/a.rs', line: 3, issue: 'i' })

interface World {
  files: Record<string, string>
  written: Record<string, string>
  status?: string
  diff?: string
  prefix?: string
}

function io(w: World): TuningIo {
  const base = stubIo({ files: w.files })
  return {
    read: (path) => (path in w.written ? w.written[path]! : base.read(path)),
    async git(args) {
      if (args[0] === 'status') return w.status || ''
      if (args.join(' ') === 'rev-parse --show-prefix') return `${w.prefix || ''}\n`
      return base.git(args)
    },
    async github(route) {
      if (route.startsWith('search/issues?')) return [{ number: 70 }]
      if (/^repos\/o\/r\/pulls\/\d+$/.test(route)) return { title: 'T', body: '', html_url: 'u', base: { ref: 'main' }, head: { sha: 'h'.repeat(40) } }
      if (/^repos\/o\/r\/pulls\/\d+\/files/.test(route)) return [{ filename: 'src/a.rs', additions: 1, deletions: 0 }]
      return null
    },
    write(path, text) {
      w.written[path] = text
    },
    async diff() {
      return w.diff || ''
    },
  }
}

test('tuning opens a pull request for new cases, or when the eval scores better and no quiet case breaks', async () => {
  const row = (id: string, expect: string, matched?: boolean) => ({ id, expect, matched })
  // Without the change, f1 and q1 come out right.
  const without = [row('f1', 'find', true), row('f2', 'find', false), row('f3', 'find', false), row('q1', 'quiet', false)]
  const one = [row('f1', 'find', true), row('f2', 'find', true), row('f3', 'find', false), row('q1', 'quiet', false)]
  for (const [name, change, withChange, decision, kind = 'segment-check'] of [
    ['adds only cases', { diff: '', add: true }, null, 'open-pr'],
    ['adds a case the eval cannot replay', { diff: '', add: true, bad: true }, null, 'rejected'],
    ['changes nothing', { diff: '' }, null, 'no-change'],
    ['breaks a rule of the loop', { diff: '+t', ok: false }, null, 'rejected'],
    ['changes an existing case', { diff: '+t', edit: true }, null, 'rejected'],
    ['changes a file outside its directory', { diff: '+t', status: ' M src/a.rs\0?? o/REVIEW.candidate.md\0' }, null, 'rejected'],
    ['moves a file from outside its directory', { diff: '+t', status: 'R  o/REVIEW.candidate.md\0src/a.rs\0' }, null, 'rejected'],
    ['writes only in its directory, given as ./o/', { diff: '+t', status: '?? o/REVIEW.candidate.md\0', out: './o/' }, one, 'open-pr'],
    ['writes only in its directory, from a subdirectory', { diff: '+t', status: '?? sub/o/REVIEW.candidate.md\0', prefix: 'sub/' }, one, 'open-pr'],
    ['finds one more', { diff: '+t' }, one, 'open-pr'],
    ['finds one more with a Learned row', { diff: '+t' }, one, 'open-pr', 'learned-row'],
    ['scores the same', { diff: '+t' }, without, 'no-gain'],
    ['finds two more but breaks a quiet case', { diff: '+t' }, [row('f1', 'find', true), row('f2', 'find', true), row('f3', 'find', true), row('q1', 'quiet', true)], 'no-gain'],
    ['finds one more but scores too few cases', { diff: '+t' }, [row('f1', 'find', true), row('f2', 'find', true), row('f3', 'find', undefined), row('q1', 'quiet', false)], 'inconclusive'],
  ] as [string, { diff: string; add?: boolean; bad?: boolean; edit?: boolean; ok?: boolean; status?: string; out?: string; prefix?: string }, ReturnType<typeof row>[] | null, string, string?][]) {
    const w: World = {
      files: { 'RULES.md': '# Rules\n\n## Tuning\n\nOnly Learned rows.\n', 'c.json': JSON.stringify({ ...CONFIG, examples: [] }), '.claude/review-evals.json': JSON.stringify({ cases: [CASE('f1')] }) },
      written: {},
      status: change.status,
      diff: change.diff,
      prefix: change.prefix,
    }
    const calls: Record<string, AgentCall> = {}
    const answer = (call: AgentCall) => {
      calls[call.label] = call
      if (call.label === '#70') return { findings: [], misses: [{ url: 'u', reviewer: 'cursor', segment: 'bugs', kind: 'k', path: 'src/a.rs', line: 3, head: 'h', issue: 'i', fix: 'f' }] }
      if (call.label === 'propose') return { changes: [{ kind, segment: 'bugs', text: 't', evidence: ['u'] }], new_cases: [], affected: ['bugs'], rationale: 'r' }
      if (call.label === 'draft') {
        w.written['o/REVIEW.candidate.md'] = 'candidate'
        const added = change.bad ? { ...CASE('f9', 61), base: 'abc1234' } : CASE('f9', 61)
        const cases = [change.edit ? { ...CASE('f1'), line: 4 } : CASE('f1'), ...(change.add ? [added] : [])]
        w.written['o/review-evals.candidate.json'] = JSON.stringify({ cases })
        return { done: true }
      }
      if (call.label === 'guard') return { ok: change.ok ?? true, violations: change.ok === false ? ['v'] : [] }
      throw new Error(`no answer for ${call.label}`)
    }
    let replays = 0
    const engine: Engine = async (a: Args, rt, eio: Io) => {
      // The settings were read once, without their examples, for every run.
      expect(a.config).toEqual(CONFIG)
      if (a.mode === 'names') return review(a, { ...rt, agent: () => Promise.reject(new Error('an agent in names mode')) }, eio)
      replays += 1
      // A rule change replays the segments it can alter; a Learned row, which
      // every segment reads, replays them all.
      expect(a.only).toEqual(kind === 'learned-row' ? SEGMENTS : ['bugs'])
      expect(a.max_segment_runs).toBeGreaterThan(0)
      expect(a.pr_dir).toBe('o/prs')
      const rows = a.rules === 'RULES.md' ? without : withChange
      return { cases: 4, recall: 0, quiet: 1, found: '', quiet_held: '', unscored: [], dropped: [], rows }
    }
    const rt = { knowledgeBase: false, log: () => {}, agent: async (call: AgentCall) => answer(call) }
    const result = await tune({ ...ARGS, out_dir: change.out || 'o' }, rt, io(w), engine)
    expect([name, result.decision]).toEqual([name, decision])
    // Only a rule change is replayed, once without it and once with it.
    expect([name, replays]).toEqual([name, withChange ? 2 : 0])
    // The outcome agents read GitHub; only the draft writes, and only in out_dir; the guard reads nothing.
    expect(calls['#70']!.github).toEqual({})
    expect(calls.draft!.github).toEqual({ write: 'o' })
    if (calls.guard) expect(calls.guard.tools).toBe('none')
    // The engine writes each case's pull request file from GitHub.
    expect(JSON.parse(w.written['o/prs/60.json']!)).toEqual({ title: 'T', body: '', url: 'u', baseRefName: 'main', headRefOid: 'h'.repeat(40), files: [{ path: 'src/a.rs', additions: 1, deletions: 0 }] })
    if (result.guard) {
      expect(result.guard.cases_added).toBe(change.add ? 1 : 0)
      if (change.edit) expect(result.guard.violations).toContain('changed the eval case f1')
      if (change.bad) expect(result.guard.violations).toEqual([expect.stringContaining('the eval case "f9" is not valid')])
      if (change.status) expect(result.guard.violations).toEqual(decision === 'rejected' ? ['changed outside o: src/a.rs'] : [])
    }
  }
})

test('tuning refuses an out_dir outside the repository', async () => {
  const w: World = { files: {}, written: {} }
  const rt = { knowledgeBase: false, log: () => {}, agent: async (call: AgentCall) => expect.unreachable(call.label) }
  for (const out_dir of ['/tmp/o', '../o', '.', './']) {
    await expect(tune({ ...ARGS, out_dir }, rt, io(w))).rejects.toThrow('out_dir must be a directory inside the repository')
  }
})

test('tuning stops with the settings message when its settings file holds no object', async () => {
  const w: World = { files: { 'RULES.md': 'r', 'c.json': 'null' }, written: {} }
  const rt = { knowledgeBase: false, log: () => {}, agent: async (call: AgentCall) => expect.unreachable(call.label) }
  await expect(tune(ARGS, rt, io(w))).rejects.toThrow(/settings are invalid: they are not a JSON object/)
})

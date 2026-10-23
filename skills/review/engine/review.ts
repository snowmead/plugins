// The review pipeline: the context stage writes a brief, each segment (lens)
// that applies reviews the change, a skeptic checks each finding, the
// follow-up stage settles this reviewer's earlier threads, and the editor turns
// what survives into the comments, replies, and summary the action posts.
// Also the sweep mode, which reviews areas of the repository as it stands, the
// eval mode, which replays known findings, and the names mode.
//
// The review rules (REVIEW.md by default) own what each segment reports and
// how findings are graded. This module owns when a segment runs and how the
// agents connect. The settings say which files are which, which segments a
// repository adds, and which model and effort each stage runs on.
//
// Args, as the action's prepare step (src/prepare.rs) writes them:
//   pr             pull request number (required in review mode)
//   repo           owner/name, for links in the summary
//   config         the settings, as the action passes them
//   config_file    a file to read the settings from when config is absent
//   reviewer       the login this reviewer posts as (default github-actions)
//   base, head     commits to review; found from pr_file when absent
//   checkout       true when the working tree is at head (the action's case)
//   worktree       a local review of the files on disk against base
//   branch         the local branch, for the prompts
//   base_copies    paths the action replaced with the trusted branch's copy
//   rules          path of the review rules (default REVIEW.md)
//   changed        files the change touches; gates the segments
//   since          last reviewed commit, on later pushes after a complete review
//   reviewed       last reviewed commit in the head's history, also when that
//                  review was partial or of this head; the limit on new Nits
//                  counts from it
//   changed_since  files the commits after `since` change, among those the pull
//                  request changes now or changed at `since`
//   carried        the last review's findings listed only in its summary, each
//                  with an id (S1, S2, ...), kept until a fix or an answer
//   last_id        the highest id an earlier review gave, so that no id names
//                  two findings
//   threads        path of a JSON file with the pull request's review threads
//   fixed_before   ids of this reviewer's open threads that already have its
//                  "Fixed" reply
//   pr_file        path of the pull request as `gh pr view --json` writes it
//   description    a local review's description, in place of pr_file
//   conversation   path of the pull request's comments and reviews, where an
//                  author answers findings listed only in the summary
//   mode           "review" (default), "sweep", "eval", or "names"
//   sweep mode:
//     since        a commit or date; code changed after it is reviewed first
//     covered      areas earlier sweeps covered, reviewed last
//     max_areas    how many areas to review (default the settings' sweep.max_areas)
//   eval mode:
//     cases        cases from the eval set
//     cases_file   a file to read the cases from instead
//     only         segments to replay; a quiet case replays these instead of
//                  its own segment
//     max_segment_runs  run at most this many segments at a case's commit,
//                  newest PRs first, with at least half for each kind of case
//                  when it needs that many
//     max_agents   start at most this many agents; the cases left without one
//                  stay unscored
//     pr_dir       a directory with <pr>.json for each case's PR

import {
  type Case,
  type Change,
  type Shared,
  contextPrompt,
  editorPrompt,
  finderSystem,
  followupPrompt,
  judgePrompt,
  knowledgeBaseStep,
  passPrompt,
  scopePrompt,
  segmentPrompt,
  skepticPrompt,
  skepticSystem,
  sweepEditorPrompt,
  sweepPrompt,
  sweepSystem,
} from './prompts.ts'
import { type Rules, parseRules } from './rules.ts'
import { ICON, badge, cell, commentBody, link, lines, mermaid, readable } from './render.ts'
import {
  type Area,
  type Brief,
  type Edit,
  type Edited,
  type Finding,
  type Findings,
  type Match,
  type Schema,
  type Scope,
  type Severity,
  type SweepEdit,
  type ThreadState,
  type Verdict,
  BRIEF,
  EDIT,
  FINDINGS,
  FINDING_FIELDS,
  FOLLOWUP,
  MATCH,
  MAX_AREAS,
  MAX_PER_AGENT,
  SCOPE,
  SEVERITY,
  SWEEP_EDIT,
  VERDICT,
  VERDICTS,
} from './schemas.ts'
import { type Effort, type Segment, type Settings, type StageName, settle } from './settings.ts'

// --- What the pipeline runs on ------------------------------------------------

export type Phase = 'Context' | 'Scope' | 'Segments' | 'Verify' | 'Follow-up' | 'Edit' | 'Judge' | 'Outcomes' | 'Propose' | 'Draft' | 'Guard'

/** One agent: its prompts, the schema its answer takes, and what it may use. */
export interface AgentCall {
  label: string
  phase: Phase
  stage: StageName
  model: string
  effort: Effort
  system: string
  prompt: string
  schema: Schema
  /** "read": the read tools and the git tool; "none": no tools. */
  tools: 'read' | 'none'
  /** Whether the agent also gets the knowledge base's read tools. */
  knowledgeBase?: boolean
  /** With "read": the tuning routine's GitHub read tool, Greptile's comment read tools, and, with `write`, a tool that writes files inside that directory. */
  github?: { write?: string }
}

export interface Runtime {
  /** The agent's answer, or null when it failed. */
  agent(call: AgentCall): Promise<unknown>
  log(message: string): void
  /** Whether agents can reach the knowledge base's read tools. */
  knowledgeBase: boolean
}

/** The engine's own reads, outside any agent. */
export interface Io {
  /** A file's text, or null when it cannot be read; a relative path is read from the checkout. */
  read(path: string): string | null
  /** git's output in the checkout, or null when git fails. */
  git(args: string[]): Promise<string | null>
}

export type Args = Record<string, any>

/** A barrier: every thunk's value, or null where it threw. */
export const parallel = <T>(thunks: (() => Promise<T>)[]): Promise<(T | null)[]> => Promise.all(thunks.map((t) => t().catch(() => null)))

/** Each item through every stage on its own, with no barrier between stages; null where a stage threw. */
export function pipeline<I>(items: I[], ...stages: ((value: any, item: I, index: number) => any)[]): Promise<any[]> {
  return Promise.all(
    items.map(async (item, i) => {
      let value: unknown = item
      for (const stage of stages) {
        try {
          value = await stage(value, item, i)
        } catch {
          return null
        }
      }
      return value
    }),
  )
}

// --- Constants ----------------------------------------------------------------

const NAME_OF: Record<string, Severity> = { Important: 'important', Nit: 'nit', 'Pre-existing': 'preexisting' }
// The line the job adds to its answer in a disputed thread.
const DISPUTED = '**Disputed:** this finding blocks the merge and the reason given does not hold, so a person decides: fix it, or resolve this thread to keep the code as it is.'
// How much of the diff the shared prompts carry, in characters (about 15,000 tokens).
export const MAX_DIFF = 60_000
const MAX_DESCRIPTION = 8_000
const MAX_COMMENT = 1_500
const FINDING_KEYS = Object.keys(FINDING_FIELDS) as (keyof Finding)[]

// --- Helpers --------------------------------------------------------------------

const json = <T>(text: string | null): T | null => {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text)
const unique = <T>(xs: T[]) => [...new Set(xs)]

/** The finding fields of x, without the pipeline's own. */
function findingOf(x: Record<string, unknown> | undefined): Partial<Finding> {
  const out: Record<string, unknown> = {}
  for (const k of FINDING_KEYS) if (x && x[k] !== undefined && x[k] !== null) out[k] = x[k]
  return out as Partial<Finding>
}

/** An editor's entry with the fields it left out taken from its first key's candidate. */
function filled<T extends Edited>(x: T, byKey: Record<string, object>): T & Partial<Finding> {
  const first = byKey[(x.keys || [])[0] ?? ''] as Record<string, unknown> | undefined
  const given = Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== null))
  return { ...findingOf(first), ...given } as T & Partial<Finding>
}

/** The diff without generated files, in whole files up to MAX_DIFF characters, and the files left out. */
export function diffText(raw: string, keep: (path: string) => boolean, max = MAX_DIFF): string {
  const files = raw.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '))
  const pathOf = (section: string) => {
    const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(section)
    return m ? m[2]! : section.split('\n')[0]!
  }
  const shown: string[] = []
  const generated: string[] = []
  const left: string[] = []
  let size = 0
  for (const section of files) {
    const path = pathOf(section)
    if (!keep(path)) generated.push(path)
    else if (size + section.length <= max) {
      shown.push(section)
      size += section.length
    } else left.push(path)
  }
  const notes = []
  if (generated.length) notes.push(`Generated files, left out: ${generated.join(', ')}.`)
  if (left.length) notes.push(`Too long to include here, so read these files' hunks with the git tool: ${left.join(', ')}.`)
  if (!files.length) return 'The diff is empty.'
  return [shown.length ? '```diff\n' + shown.join('').trimEnd() + '\n```' : '', notes.join(' ')].filter(Boolean).join('\n\n')
}

/** Text from a pull request file: its title and description. */
function describePr(pr: Record<string, unknown> | null): { title: string; text: string } {
  if (!pr) return { title: '', text: 'No description was given.' }
  const title = String(pr.title || '')
  const body = String(pr.body || '').trim()
  return { title, text: `Title: ${title}\n\n${body ? cut(body, MAX_DESCRIPTION) : 'The description is empty.'}` }
}

/** The text of the skill a repository names for its knowledge base, without its front matter. */
function skillText(io: Io, name: string): string | null {
  if (!name) return null
  for (const dir of ['.claude/skills', '.agents/skills']) {
    const text = io.read(`${dir}/${name}/SKILL.md`)
    if (text !== null) return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  }
  return null
}

interface ThreadComment {
  author?: { login?: string; __typename?: string } | null
  body?: string
  url?: string
}
interface Thread {
  id: string
  isResolved: boolean
  isOutdated?: boolean
  path?: string
  line?: number | null
  comments?: { nodes?: ThreadComment[] }
}
const commentsOf = (t: Thread) => (t.comments && t.comments.nodes) || []

/** What the first comment of one of this reviewer's threads says: its severity, title, and the place an anchor comment names. */
export function firstComment(body: string): { severity?: Severity; title: string; path?: string; line?: number } {
  const alt = /<img alt="([^"]+)"/.exec(body)
  const icon = Object.entries(ICON).find(([, i]) => body.trimStart().startsWith(i))
  const severity = (alt && NAME_OF[alt[1]!]) || (icon && (icon[0] as Severity)) || undefined
  const bold = /\*\*(.+?)\*\*/.exec(body.split('\n')[0] || '')
  const title = bold ? bold[1]! : readable(body).split('\n')[0]!.slice(0, 200)
  const anchor = /^On (?:\[)?`([^`]+?):(\d+)`/m.exec(body)
  return { severity, title, ...(anchor ? { path: anchor[1], line: Number(anchor[2]) } : {}) }
}

// --- The engine -----------------------------------------------------------------

export interface Result {
  [key: string]: unknown
}

export async function review(args: Args | number | string, rt: Runtime, io: Io): Promise<Result> {
  const A: Args = typeof args === 'object' && args !== null ? args : { pr: Number(args) }
  const PR = Number(A.pr)
  const MODE: string = ['eval', 'names', 'sweep'].includes(A.mode) ? A.mode : 'review'
  const REVIEWER: string = A.reviewer || 'github-actions'
  const RULES: string = A.rules || 'REVIEW.md'
  if (!Number.isInteger(PR) && MODE === 'review' && !A.local) {
    throw new Error('the review needs a pull request number: args {"pr": 69}')
  }

  // Every agent starts through ask, which counts them. Past max_agents it starts
  // none and answers null, as a failed agent does.
  let started = 0
  const ask = <T>(call: AgentCall): Promise<T | null> => {
    if (A.max_agents && started >= A.max_agents) return Promise.resolve(null)
    started += 1
    return rt.agent(call).then((v) => (v ?? null) as T | null)
  }

  let config = A.config
  if (config === undefined && A.config_file) {
    const text = io.read(A.config_file)
    if (text !== null && text.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { error: `${A.config_file} is not JSON` }
      }
      if (typeof parsed === 'object' && parsed !== null) delete (parsed as Record<string, unknown>).examples
      config = parsed
    }
  }
  const settled = settle(config)
  if ('error' in settled) return { error: settled.error }
  const S: Settings = settled
  const SEGMENTS = S.segments
  const isCode = (f: string) => S.inClass('code', f)
  // The diff the agents read leaves out generated files and assets.
  const inDiff = (f: string) => !S.inClass('generated', f) && !S.inClass('assets', f)
  /** The model and effort an agent of `stage` runs on, for segment `seg` when it sets its own. */
  const on = (stage: StageName, seg?: Segment) => ({ ...S.agents[stage], ...((seg && seg.agents && seg.agents[stage as 'finder' | 'skeptic']) || {}) })
  const KB = S.knowledgeBase

  if (MODE === 'names') return { segments: SEGMENTS.map((s) => s.name), severities: [...SEVERITY] }

  const rulesText = io.read(RULES)
  if (rulesText === null) return { error: `could not read the review rules from ${RULES}` }
  const rules: Rules = parseRules(rulesText)
  const kbSkill = KB ? skillText(io, KB.skill) : null
  const kbStep = (paths: string) => (rt.knowledgeBase ? knowledgeBaseStep(KB, kbSkill, paths) : null)
  const kbUnread = KB ? `${KB.name} is not connected, so it was not read.` : 'The settings turn the knowledge base off.'

  // --- Verify -------------------------------------------------------------------

  interface Kept extends Finding {
    verdict: 'confirmed' | 'unverified'
    doubt?: string
  }
  interface SegResult {
    seg: Segment
    area?: Area & { why?: string }
    findings: Finding[]
    kept?: Kept[]
    failed?: boolean
    runs?: number
    areas?: number
  }

  // Asks a skeptic about each of a segment's findings, and keeps what survives:
  // a confirmed finding, and, for a segment that keeps unverified findings or a
  // finding about security or privacy, one the skeptic cannot settle. A finding
  // of a segment that keeps unverified findings whose skeptic failed is kept as
  // unverified too. Findings of one segment at one place go to one skeptic.
  async function verify(res: SegResult, system: string, label: string): Promise<SegResult & { kept: Kept[] }> {
    const groups: Finding[][] = []
    const at = new Map<string, Finding[]>()
    for (const f of res.findings) {
      const where = `${f.path}:${f.line}:${f.side === 'LEFT' ? 'L' : 'R'}`
      if (!at.has(where)) {
        at.set(where, [])
        groups.push(at.get(where)!)
      }
      at.get(where)!.push(f)
    }
    const checked = await parallel(
      groups.map((group) => async () => {
        const call = {
          label: `${label}verify ${res.seg.name} ${group[0]!.path}:${group[0]!.line}`,
          phase: 'Verify' as const,
          stage: 'skeptic' as const,
          ...on('skeptic', res.seg),
          ...skepticPrompt(res.seg, system, group),
          tools: 'read' as const,
        }
        if (group.length === 1) {
          const v = await ask<Verdict>({ ...call, schema: VERDICT })
          return [v]
        }
        const vs = await ask<{ verdicts: (Verdict & { finding: number })[] }>({ ...call, schema: VERDICTS })
        return group.map((_, i) => (vs && vs.verdicts.find((v) => v.finding === i + 1)) || null)
      }),
    )
    const kept: Kept[] = []
    let unchecked = 0
    groups.forEach((group, g) => {
      group.forEach((f, i) => {
        const v = checked[g] && checked[g]![i]
        if (!v) {
          unchecked += 1
          if (res.seg.keep_unverified) kept.push({ ...f, verdict: 'unverified', doubt: 'its skeptic did not finish' })
        } else if (v.verdict === 'confirmed') {
          // Only the places the skeptic confirms stay; leaving them out confirms none.
          kept.push({ ...f, severity: v.severity, trace: v.trace || f.trace, places: v.places || [], verdict: 'confirmed' })
        } else if (v.verdict === 'unsure' && (res.seg.keep_unverified || v.security_or_privacy)) {
          kept.push({ ...f, verdict: 'unverified', doubt: v.reason })
        }
      })
    })
    if (unchecked) rt.log(`${label}${res.seg.name}: ${unchecked} findings went unchecked because their skeptic failed`)
    return { ...res, kept, failed: res.failed || unchecked > 0 }
  }

  // --- Gather ---------------------------------------------------------------------

  interface Review extends Args {
    pr: number
    replay?: boolean
    segments?: string[]
    focus?: string[]
  }

  type FullBrief = Brief & { pr: number; repo: string | null; title: string; head: string }

  interface Gathered {
    c: Change
    brief: FullBrief
    changed: string[]
    plan: (Segment & { state: 'run' | 'skipped' | 'not-rerun'; reason?: string })[]
    done: (SegResult & { kept: Kept[] })[]
    failed: string[]
    candidates: (Kept & { key: string; segment: string })[]
    followed: (ThreadState & { url?: string; title: string; severity?: Severity; path?: string; line?: number })[] | null
  }

  // Context, the segments with their skeptics, and the follow-up. R is one review:
  // the args in review mode, or one pull request commit of the eval set.
  async function gather(R: Review): Promise<Gathered | { error: string }> {
    const tag = R.replay ? `#${R.pr} ` : ''
    const prFile = R.pr_file ? json<Record<string, any>>(io.read(R.pr_file)) : null
    let head: string | undefined = R.head || (prFile && prFile.headRefOid) || undefined
    let base: string | undefined = R.base
    if (!base && head && prFile && prFile.baseRefName) base = (await io.git(['merge-base', `origin/${prFile.baseRefName}`, head]))?.trim()
    if (!base || !head) return { error: 'The args name no base and head, and the pull request file does not give them.' }
    if (!R.worktree && (await io.git(['cat-file', '-e', `${head}^{commit}`])) === null) return { error: `The head ${head} is not in the local clone.` }
    const checkout = R.checkout !== undefined ? Boolean(R.checkout) : (await io.git(['rev-parse', 'HEAD']))?.trim() === head
    const c: Change = {
      pr: R.local ? undefined : R.pr,
      repo: R.repo || null,
      branch: R.branch,
      base,
      head,
      checkout,
      worktree: Boolean(R.worktree),
      base_copies: R.base_copies || [],
    }
    const range = c.worktree ? [base] : [`${base}...${head}`]
    const changed: string[] | null =
      R.changed || (await io.git(['diff', '--name-only', ...range]))?.split('\n').filter(Boolean) || null
    if (!changed) return { error: `git could not list the files that ${range[0]} changes.` }
    // a/ and b/ whatever the user's diff.noprefix or diff.mnemonicPrefix, for diffText.
    const raw = (await io.git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', ...range])) ?? ''
    const stat = (await io.git(['diff', '--stat=120', ...range]))?.trim() ?? ''
    const pr = describePr(prFile)
    const shared: Shared = { rules, description: R.description ? cut(String(R.description), MAX_DESCRIPTION) : pr.text, diff: diffText(raw, inDiff) }

    const ctx = await ask<Brief>({
      label: `${tag}context`,
      phase: 'Context',
      stage: 'context',
      ...on('context'),
      ...contextPrompt(c, shared, changed, stat, kbStep('the changed paths')),
      schema: BRIEF,
      tools: 'read',
      knowledgeBase: rt.knowledgeBase,
    })
    const brief: FullBrief = {
      pr: R.pr,
      repo: c.repo ?? null,
      head,
      title: pr.title,
      intent: (ctx && ctx.intent) || 'The context stage failed; read the description yourself.',
      claims: (ctx && ctx.claims) || [],
      rules: (ctx && ctx.rules) || [],
      risks: (ctx && ctx.risks) || [],
      areas: ((ctx && ctx.areas) || []).map((a) => ({ name: a.name, files: [...a.files] })),
      knowledge_base: (ctx && (rt.knowledgeBase ? ctx.knowledge_base : kbUnread)) || 'not read',
      knowledge_base_read: Boolean(ctx && rt.knowledgeBase && ctx.knowledge_base_read),
    }
    if (!ctx) rt.log(`${tag}context stage failed; the segments run with the args and no brief`)

    // Code files the context stage left out of every area still get a pass.
    const inAreas = new Set(brief.areas.flatMap((a) => a.files))
    const loose = changed.filter((f) => isCode(f) && !inAreas.has(f))
    if (loose.length && brief.areas.length < MAX_AREAS) brief.areas.push({ name: 'other changes', files: loose })
    else if (loose.length) brief.areas[brief.areas.length - 1]!.files.push(...loose)

    // A replay looks for known findings, so its two-pass segments cover only the
    // areas that hold the cases' files.
    if (R.focus) {
      const near = brief.areas.filter((a) => a.files.some((f) => R.focus!.includes(f)))
      brief.areas = near.length ? near : [{ name: 'cases', files: R.focus }]
    }

    const later = Boolean(R.since && R.changed_since)
    const plan: Gathered['plan'] = SEGMENTS.map((s) => {
      if (R.replay && !R.segments!.includes(s.name)) return { ...s, state: 'skipped' as const, reason: 'not in this replay' }
      if (!changed.length) return { ...s, state: 'skipped' as const, reason: 'the change touches no files' }
      if (!s.applies(changed)) return { ...s, state: 'skipped' as const, reason: 'no files in its scope' }
      if (later && !s.always && !s.applies(R.changed_since)) {
        return { ...s, state: 'not-rerun' as const, reason: `no changes in its scope since ${String(R.since).slice(0, 7)}` }
      }
      return { ...s, state: 'run' as const }
    })
    rt.log(`${tag}segments: ${plan.map((s) => `${s.name} ${s.state}`).join(', ')}`)

    const finders = finderSystem(c, shared, brief)
    const skeptics = skepticSystem(c, shared)
    const finder = (seg: Segment, label: string, prompt: { system: string; prompt: string }) =>
      ask<Findings>({ label, phase: 'Segments', stage: 'finder', ...on('finder', seg), ...prompt, schema: FINDINGS, tools: 'read' })

    const runSegment = async (seg: Segment): Promise<SegResult> => {
      if (seg.passes !== 2) {
        const r = await finder(seg, `${tag}${seg.name}`, segmentPrompt(seg, finders))
        if (!r) return { seg, failed: true, findings: [], kept: [] }
        if (r.dropped) rt.log(`${tag}${seg.name}: left out ${r.dropped} findings over the cap of ${MAX_PER_AGENT}`)
        return { seg, findings: r.findings }
      }
      // Areas that hold none of its files get no pass; when none holds any,
      // its files are one area. A replay keeps the areas of its cases' files.
      const own = R.focus ? brief.areas : brief.areas.filter((a) => seg.applies(a.files))
      const areas = own.length ? own : [{ name: seg.title, files: changed.filter((f) => seg.applies([f])) }]
      const passes = await parallel(
        areas.flatMap((area, i) => ([1, 2] as const).map((pass) => () => finder(seg, `${tag}${seg.name} ${i + 1}.${pass}`, passPrompt(seg, finders, area, pass)))),
      )
      const ok = passes.filter((r): r is Findings => Boolean(r))
      for (const r of ok) if (r.dropped) rt.log(`${tag}${seg.name}: a pass left out ${r.dropped} findings over the cap`)
      // Both passes' findings go to the skeptics; the editor merges the ones with one cause.
      return { seg, failed: ok.length < passes.length, findings: ok.flatMap((r) => r.findings), runs: passes.length, areas: areas.length }
    }

    // The follow-up reads this reviewer's open threads; the engine picks them.
    const allThreads = R.threads && !R.replay ? json<Thread[]>(io.read(R.threads)) : null
    const own = (allThreads || []).filter((t) => {
      const first = commentsOf(t)[0]
      return t.isResolved === false && first && first.author && first.author.login === REVIEWER
    })
    const wantFollowup = Boolean(R.threads) && !R.replay
    const followup = async (): Promise<Gathered['followed']> => {
      if (!wantFollowup) return null
      if (!allThreads) return null
      if (!own.length) return []
      const shown = own.map((t) => ({
        id: t.id,
        path: t.path,
        line: t.line,
        outdated: t.isOutdated,
        comments: commentsOf(t).map((x) => ({ author: x.author?.login, person: x.author?.__typename === 'User', body: readable(x.body || '') })),
      }))
      const answer = await ask<{ threads: ThreadState[] }>({
        label: 'follow-up',
        phase: 'Follow-up',
        stage: 'followup',
        ...on('followup'),
        ...followupPrompt(c, rules, REVIEWER, shown, R.fixed_before || [], R.since),
        schema: FOLLOWUP,
        tools: 'read',
      })
      if (!answer) return null
      // Each open thread is followed once, whatever the answer repeats or
      // names besides; one it leaves out stays open. The engine knows each
      // thread's place, title, and severity from its first comment.
      const told = new Map(answer.threads.map((s) => [s.id, s]))
      const left = own.filter((t) => !told.has(t.id)).map((t) => t.id)
      if (left.length) rt.log(`${tag}follow-up: no answer for ${left.join(', ')}, kept open`)
      return own.map((t) => {
        const s: ThreadState = told.get(t.id) ?? { id: t.id, state: 'open', holds: false }
        const first = commentsOf(t)[0]!
        const said = firstComment(first.body || '')
        return { ...s, url: first.url, title: said.title, severity: said.severity, path: said.path || t.path, line: s.line || said.line || t.line || undefined }
      })
    }

    const running = plan.filter((s) => s.state === 'run')
    const [segResults, followups] = await Promise.all([
      pipeline(running, runSegment, (res: SegResult) => verify(res, skeptics, tag)),
      followup().catch(() => null),
    ])
    const done = (segResults || []).filter(Boolean) as Gathered['done']
    const failed = running.filter((s) => !done.some((r) => r.seg.name === s.name && !r.failed)).map((s) => s.name)
    if (!ctx) failed.unshift('context')
    if (wantFollowup && !followups) failed.push('follow-up')

    const candidates: Gathered['candidates'] = []
    for (const r of done) {
      for (const f of r.kept) candidates.push({ key: `${r.seg.name}-${candidates.length + 1}`, segment: r.seg.name, ...f })
    }
    return { c, brief, changed, plan, done, failed, candidates, followed: followups }
  }

  // --- Finish -----------------------------------------------------------------------

  // What the editor is told about earlier reviews. After a partial review, or
  // a rerun of the same head, every segment runs again, but the limit on new
  // Nits still counts from the last reviewed commit.
  function lastReviewed(R: Review, head: string) {
    const last = R.reviewed || R.since
    if (!last) return "No commit in this branch's history was reviewed before, so this is the first review."
    const diff = `\`git diff ${last} ${head}\` shows what changed since.`
    if (R.since) return `This is a later review. The last reviewed commit was ${last}; ${diff}`
    return `The last reviewed commit was ${last}. That review did not finish, or it reviewed this same commit, so every segment ran again; ${diff}`
  }

  // The editor, then the comments, replies in earlier threads, and summary the action posts.
  async function finish(R: Review, g: Gathered): Promise<Result> {
    const { c, brief, changed, plan, done, failed, candidates, followed } = g
    // Each finding the summary lists without a thread has an id, S1, S2, and so
    // on, and stays listed until the code fixes it or the author answers it,
    // whichever segments run again. An id is never given again, even once its
    // entry is settled, so an answer that names one names one finding. An entry
    // from before ids gets one now.
    let lastId = Math.max(
      Number.isInteger(R.last_id) && R.last_id > 0 ? R.last_id : 0,
      ...(R.carried || []).map((x: { id?: string }) => Number((/^S([0-9]+)$/.exec(x.id || '') || [])[1] || 0)),
    )
    const nextId = () => `S${(lastId += 1)}`
    const entries: Record<string, any>[] = (R.carried || []).map((x: Record<string, any>) => (x.id ? x : { ...x, id: nextId() }))

    const threads = R.threads ? json<Thread[]>(io.read(R.threads)) : null
    const conversation = R.conversation ? json<{ comments?: any[]; reviews?: any[] }>(io.read(R.conversation)) : null
    const notMine = (x: { author?: unknown }) => x.author !== REVIEWER
    const edit = await ask<Edit>({
      label: 'editor',
      phase: 'Edit',
      stage: 'editor',
      ...on('editor'),
      ...editorPrompt(c, rules, {
        candidates,
        followups: followed,
        earlier: entries.map((x) => ({ id: x.id, severity: x.severity, path: x.path, line: x.line, places: x.places, title: x.title, listed: x.note, from: x.from })),
        threads: threads
          ? threads.map((t) => ({
              url: commentsOf(t)[0]?.url,
              path: t.path,
              line: t.line,
              resolved: t.isResolved,
              outdated: t.isOutdated,
              comments: commentsOf(t).map((x) => ({ author: x.author?.login, person: x.author?.__typename === 'User', body: cut(readable(x.body || ''), MAX_COMMENT) })),
            }))
          : null,
        conversation: conversation
          ? {
              comments: (conversation.comments || []).filter(notMine).map((x) => ({ author: x.author, url: x.url, body: cut(String(x.body || ''), MAX_COMMENT) })),
              reviews: (conversation.reviews || []).filter((x) => notMine(x) && x.body).map((x) => ({ author: x.author, state: x.state, body: cut(String(x.body), MAX_COMMENT) })),
            }
          : null,
        changed,
        lastReviewed: lastReviewed(R, brief.head),
      }),
      schema: EDIT,
      tools: 'read',
    })
    if (!edit) failed.push('editor')

    const byKey = Object.fromEntries(candidates.map((x) => [x.key, x])) as Record<string, (typeof candidates)[number]>
    // Without the editor, nothing is merged or checked against open threads, so
    // posting would repeat findings. The summary lists them all instead; the
    // review is partial, so the next run is a full one.
    const complete = (p: Partial<Finding>): p is Finding => Boolean(p.path && p.line && p.severity && p.title && p.body && p.trace)
    const posts = edit
      ? edit.post.map((p) => filled(p, byKey)).filter((p) => {
          if (complete(p)) return true
          rt.log(`editor: left out a post with no ${['path', 'line', 'severity', 'title', 'body', 'trace'].filter((k) => !(p as any)[k]).join(', ')}`)
          return false
        })
      : []
    const summaryOnly: (Edit['summary_only'][number] & Partial<Finding>)[] = edit
      ? edit.summary_only.map((s) => filled(s, byKey)).filter((s) => s.path && s.title && s.severity)
      : candidates.map((x) => ({ ...x, keys: [x.key], why: x.verdict === 'confirmed' ? ('no-editor' as const) : ('unverified' as const) }))
    const segmentsOf = (keys: string[] | undefined) => unique((keys || []).map((k) => byKey[k]).filter(Boolean).map((x) => x!.segment))
    // A removed line (side LEFT) exists only in the base version.
    const where = (x: { line?: number; side?: string; path?: string }, head = brief.head) =>
      x.line ? link(brief.repo, x.side === 'LEFT' ? c.base : head, x.path!, x.line) : `\`${x.path}\``

    // A finding on a file the pull request does not change goes on its anchor,
    // the changed line that makes it true, and says where the problem is.
    const inChange = new Set(changed)
    const comments = (posts as (Finding & Edit['post'][number])[]).map((p) => {
      const moved = !inChange.has(p.path) && p.anchor && inChange.has(p.anchor.path)
      const sources = (p.keys || []).map((k) => byKey[k]).filter(Boolean)
      const segments = segmentsOf(p.keys)
      const meta = {
        id: `${segments[0] || 'unknown'}-${p.slug}`,
        segments,
        severity: p.severity,
        reports: sources.length || 1,
        verdict: sources.some((s) => s!.verdict === 'confirmed') ? 'confirmed' : 'unverified',
        head: brief.head,
      }
      // What the summary keeps when GitHub refuses the comment.
      const carry: Record<string, unknown> = { severity: p.severity, path: p.path, line: p.line, side: p.side, title: p.title, places: p.places, note: 'not posted inline', from: brief.head }
      if (moved) return { path: p.anchor!.path, line: p.anchor!.line, side: 'RIGHT', body: commentBody(p, meta, where(p)), carry }
      return {
        path: p.path,
        line: p.line,
        start_line: p.start_line && p.start_line < p.line ? p.start_line : undefined,
        side: p.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        body: commentBody(p, meta),
        carry,
      }
    })

    const short = (sha?: string) => (sha || brief.head).slice(0, 7)
    // Without the fixing commit, say only that the head no longer has the problem.
    const fixedIn = (t: { commit?: string }) => (t.commit ? `Fixed in ${short(t.commit)}` : `Fixed as of ${short(brief.head)}`)
    // A thread is settled when it is fixed, or answered with a reason that
    // holds. A Nit or a pre-existing finding does not block the merge, so the
    // author's answer settles it either way; a finding of unknown severity
    // counts as blocking.
    const settledState = (t: { state?: string; holds?: boolean; severity?: string }) =>
      t.state === 'fixed' || (t.state === 'answered' && (t.holds === true || ['nit', 'preexisting'].includes(t.severity || '')))
    // Any other answered thread is disputed: it stays open, and a person
    // decides whether the code changes.
    const disputed = (t: { state?: string; holds?: boolean; severity?: string }) => t.state === 'answered' && !settledState(t)
    // The job posts the "Fixed" line only in a thread without one yet, the
    // answer only in a thread where a person commented last, and lists for
    // resolving only this reviewer's open threads (src/prepare.rs).
    const replies = (followed || []).flatMap((t) => {
      const reply: Record<string, unknown> = { thread_id: t.id }
      if (t.state === 'fixed') reply.fixed = `${fixedIn(t)}${t.note ? `: ${t.note}` : '.'}`
      // A disputed thread's answer says that a person decides; with no answer,
      // such as after thanks, the thread gets no reply.
      const answer = t.answer && t.answer.trim()
      if (answer) reply.answer = disputed(t) ? `${answer}\n\n${DISPUTED}` : answer
      if (settledState(t)) reply.resolve = true
      return reply.fixed || reply.answer || reply.resolve ? [reply] : []
    })

    const why: Record<string, string> = {
      'open-thread': 'raised in an open thread',
      'nit-cap': 'over the cap of five Nits',
      'unchanged-line': 'on a line the new commits did not change',
      unverified: 'unverified: the skeptic could not settle it',
      'no-editor': 'not posted: the editor did not finish',
    }
    // The issue list, which the job renders: it links each title to the comment
    // GitHub took for `comment`, an index into `comments`, or else to `link`.
    const issue = (x: { severity?: string; title?: string }, location: string, note: string, more: Record<string, unknown>) => ({
      badge: badge(x.severity),
      title: cell(x.title),
      where: location,
      note: note ? cell(note) : '',
      ...more,
    })
    const postIssues: Record<string, unknown>[] = posts.map((p, i) => issue(p, where(p), '', { comment: i }))
    const issues = [...postIssues]
    // A disputed thread stays open, so it counts as open.
    const openThreads = (followed || []).filter((x) => x.state === 'open' || disputed(x))
    for (const t of openThreads) {
      const decides = disputed(t) ? ', disputed: a person decides' : ''
      issues.push(issue(t, t.path ? where(t) : '-', `open thread from an earlier review${decides}`, t.url ? { link: t.url } : {}))
    }
    // Findings listed only in the summary. One that is an earlier entry, by its
    // id, its thread, or its place and title, keeps that entry's id.
    const openUrls = new Set(openThreads.map((t) => t.url).filter(Boolean))
    const carried: Record<string, any>[] = []
    const settledEntries: Record<string, any>[] = []
    const relisted = new Set<string>()
    const same = (a: Record<string, any>, b: Record<string, any>) => a.path === b.path && a.line === b.line && a.title === b.title
    const also = (x: { places?: string[] }) => (x.places && x.places.length ? `; also at ${x.places.map((p) => `\`${p}\``).join(', ')}` : '')
    const listed = (x: Record<string, any>) => `${x.id}: ${x.note}${also(x)}`
    for (const s of summaryOnly) {
      // Without the editor, a finding repeats an earlier entry only at the same
      // place with the same title; one found again in other words gets an id of
      // its own, since a finding the next review misses must not vanish.
      const prior = entries.find((x) => x.id === s.id || (x.thread_url && x.thread_url === s.thread_url) || same(x, s))
      if (prior) relisted.add(prior.id)
      // The open thread's row lists it, and the entry it repeats with it.
      if (s.why === 'open-thread' && openUrls.has(s.thread_url)) continue
      const fields = {
        severity: s.severity,
        path: s.path,
        line: s.line,
        side: s.side,
        title: s.title,
        places: s.places || (prior && prior.places),
        thread_url: s.thread_url,
        from: brief.head,
      }
      // An answer that holds settles a finding, as it settles a thread.
      if (s.why === 'answered') {
        settledEntries.push({ ...fields, id: prior && prior.id, state: 'answered' })
        continue
      }
      const entry = { id: prior ? prior.id : nextId(), ...fields, note: why[s.why] }
      issues.push(issue(entry, where(entry), listed(entry), s.thread_url ? { link: s.thread_url } : {}))
      carried.push(entry)
    }
    // An earlier entry this run did not list again or post stays as it was,
    // unless the editor calls it settled as a thread would be. One an open
    // thread already raises gets no second row.
    const posted = new Set(posts.flatMap((p) => (p as Edit['post'][number]).earlier || []))
    const states = new Map(((edit && edit.earlier) || []).map((e) => [e.id, e]))
    let disputedEntries = 0
    for (const x of entries) {
      if (posted.has(x.id) || relisted.has(x.id)) continue
      if (x.thread_url && openUrls.has(x.thread_url)) continue
      const told: Record<string, any> = states.get(x.id) || {}
      const state = { ...x, state: told.state, holds: told.holds, commit: told.commit, note: told.note }
      if (settledState(state)) {
        settledEntries.push(state)
        continue
      }
      const decides = disputed(state) ? ', answered, disputed: a person decides' : ''
      if (decides) disputedEntries += 1
      issues.push(issue(x, where(x, x.from), `${listed(x)}${decides}, from the review of \`${short(x.from)}\``, x.thread_url ? { link: x.thread_url } : {}))
      carried.push(x)
    }
    // What GitHub may refuse to take inline joins the entries with an id: the
    // earlier entry's that it posts, or one of its own. The job shows it on the
    // issue's row only when GitHub refuses the comment.
    comments.forEach((x, i) => {
      const earlierId = ((posts[i] as Edit['post'][number]).earlier || []).find((id) => entries.some((e) => e.id === id))
      x.carry.id = earlierId || nextId()
      postIssues[i]!.id = x.carry.id
    })

    const earlier = [
      ...(followed || []).filter(settledState),
      ...settledEntries.map((e) => ({ ...e, title: e.id ? `${e.id} ${e.title}` : e.title, url: e.thread_url })),
    ].map((t: Record<string, any>) => {
      const ref = t.url ? `[${cell(t.title)}](${t.url})` : cell(t.title)
      return t.state === 'fixed' ? `- ${fixedIn(t)}: ${ref}` : `- Answered: ${ref}${t.note ? `. ${t.note}` : ''}`
    })

    const segRows = plan.map((s) => {
      const r = done.find((x) => x.seg.name === s.name)
      let state = 'Ran'
      if (s.state === 'skipped') state = `Did not apply: ${s.reason}`
      else if (s.state === 'not-rerun') state = `Not run again: ${s.reason}`
      else if (failed.includes(s.name)) state = 'Failed: an agent did not finish'
      else if (s.passes === 2 && r) state = `Ran: ${r.runs} passes over ${r.areas} area${r.areas === 1 ? '' : 's'}`
      return `| ${s.title} | ${cell(state)} | ${r ? `${r.kept.length} of ${r.findings.length}` : '-'} |`
    })

    const partial = failed.length > 0
    const disputes = openThreads.filter(disputed).length + disputedEntries
    const diagram = edit ? mermaid(edit.diagram) : ''
    // The summary goes in the job's section of the pull request description:
    // `top`, the issue list the job renders, then `bottom` and the job's footer.
    const top = lines([
      edit ? `## Claude review · Confidence to merge: ${edit.confidence.score}/5` : '## Claude review',
      '',
      partial ? `> [!WARNING]\n> This review is incomplete: ${failed.join(', ')} did not finish. Run the job again for a full review.\n` : '',
      `**${edit ? edit.verdict : `${carried.length} findings, listed below and not posted, because the editor did not finish`}**`,
      '',
      disputes ? `**${disputes} disputed finding${disputes === 1 ? '' : 's'}: a person decides.**` : '',
      '',
      edit ? edit.confidence.reason : '',
      '',
      '<details open><summary><h3>Summary</h3></summary>',
      '',
      edit ? edit.overview : brief.intent,
      '',
      '</details>',
      '',
      ...(diagram ? ['<details open><summary><h3>Diagram</h3></summary>', '', '```mermaid', diagram, '```', '', '</details>'] : []),
    ])
    const bottom = lines([
      ...(earlier.length ? [`<details><summary>Earlier findings: ${earlier.length}</summary>`, '', ...earlier, '', '</details>', ''] : []),
      '<details><summary>Segments</summary>',
      '',
      '| Segment | State | Kept |',
      '|---|---|---|',
      ...segRows,
      '',
      '</details>',
      '',
      KB && !brief.knowledge_base_read ? `${KB.name} was not read, so this review read only the repository.` : '',
    ])

    // The action ends the review's body with the marker, after adding what it could not post.
    const marker = { head: brief.head, partial, failed, carried, last_id: lastId }
    // The args as this run got them: the action posts only when they match its own.
    // A local review renders its report from the findings themselves.
    const local = A.local
      ? {
          base: c.base,
          intent: brief.intent,
          overview: edit ? edit.overview : brief.intent,
          verdict: edit ? edit.verdict : '',
          confidence: edit ? edit.confidence : null,
          posts,
          listed: carried,
          segments: plan.map((s) => ({ title: s.title, state: s.state === 'run' && failed.includes(s.name) ? 'failed' : s.state, reason: s.reason })),
        }
      : undefined
    return { head: brief.head, partial, failed, comments, replies, summary: { top, issues, bottom }, marker, args: A, ...(local ? { local } : {}) }
  }

  // --- Sweep -----------------------------------------------------------------------

  // A sweep: the scope stage picks areas of the repository, each segment that
  // applies to an area's files reviews it in one pass, skeptics check every
  // finding, and the editor merges them. It posts nothing; the routine that
  // runs it fixes what it returns.
  async function sweep(): Promise<Result> {
    const maxAreas: number = Number.isInteger(A.max_areas) && A.max_areas > 0 ? A.max_areas : S.sweep.max_areas
    const head = (await io.git(['rev-parse', 'HEAD']))?.trim()
    if (!head) return { mode: 'sweep', error: 'git could not read HEAD.' }
    const scope = await ask<Scope>({
      label: 'scope',
      phase: 'Scope',
      stage: 'scope',
      ...on('scope'),
      ...scopePrompt(A.repo, rules, head, maxAreas, A.since, A.covered || [], kbStep("the chosen areas' paths")),
      schema: SCOPE,
      tools: 'read',
      knowledgeBase: rt.knowledgeBase,
    })
    if (!scope || !scope.areas.length) return { mode: 'sweep', error: scope ? 'The scope stage chose no areas.' : 'The scope stage failed.' }
    const areas = scope.areas.slice(0, maxAreas).map((a) => ({ ...a, files: a.files.filter((f) => !f.endsWith('/')) }))
    if (scope.areas.length > maxAreas) rt.log(`sweep: the scope stage chose ${scope.areas.length} areas; reviewing the first ${maxAreas}`)
    const notes = { head, rules: scope.rules, risks: scope.risks, knowledge_base: rt.knowledgeBase ? scope.knowledge_base : kbUnread }
    const finders = sweepSystem(A.repo, { rules }, notes)
    const skeptics = skepticSystem({ base: head, head, checkout: true, base_copies: [], sweep: true }, { rules, diff: '' })
    const runs = areas.flatMap((area, i) => SEGMENTS.filter((s) => s.applies(area.files)).map((seg) => ({ area, i, seg })))
    rt.log(`sweep: ${areas.length} areas, ${runs.length} segment runs`)
    const results = await pipeline(
      runs,
      async ({ area, i, seg }: (typeof runs)[number]): Promise<SegResult> => {
        const r = await ask<Findings>({
          label: `${seg.name} @${i + 1}`,
          phase: 'Segments',
          stage: 'finder',
          ...on('finder', seg),
          ...sweepPrompt(seg, finders, area),
          schema: FINDINGS,
          tools: 'read',
        })
        if (!r) return { seg, area, failed: true, findings: [], kept: [] }
        if (r.dropped) rt.log(`${seg.name} @${i + 1}: left out ${r.dropped} findings over the cap of ${MAX_PER_AGENT}`)
        return { seg, area, findings: r.findings }
      },
      (res: SegResult, run) => verify(res, skeptics, `@${run.i + 1} `),
    )
    const done = results.filter(Boolean) as (SegResult & { kept: Kept[] })[]
    const failed = runs
      .filter((run) => !done.some((r) => r.seg.name === run.seg.name && r.area === run.area && !r.failed))
      .map((run) => `${run.seg.name} in ${run.area.name}`)
    const candidates: (Kept & { key: string; segment: string; area: string })[] = []
    for (const r of done) {
      for (const f of r.kept) candidates.push({ key: `${r.seg.name}-${candidates.length + 1}`, segment: r.seg.name, area: r.area!.name, ...f })
    }
    const edit = candidates.length
      ? await ask<SweepEdit>({ label: 'editor', phase: 'Edit', stage: 'editor', ...on('editor'), ...sweepEditorPrompt(head, rules, candidates), schema: SWEEP_EDIT, tools: 'read' })
      : { findings: [], dropped: [], overview: 'The sweep found nothing to fix.' }
    if (!edit) failed.push('editor')
    const byKey = Object.fromEntries(candidates.map((x) => [x.key, x])) as Record<string, (typeof candidates)[number]>
    const findings = edit
      ? edit.findings.map((f) => {
          const full = filled(f, byKey)
          const sources = (f.keys || []).map((k) => byKey[k]).filter(Boolean)
          return {
            ...full,
            segments: unique(sources.map((s) => s!.segment)),
            areas: unique(sources.map((s) => s!.area)),
            verdict: sources.some((s) => s!.verdict === 'confirmed') ? 'confirmed' : 'unverified',
          }
        })
      : candidates.map((x) => ({ ...x, keys: [x.key], segments: [x.segment], areas: [x.area] }))
    const partial = failed.length > 0
    const summary = lines([
      `## Sweep of \`${head.slice(0, 7)}\``,
      '',
      partial ? `> [!WARNING]\n> This sweep is incomplete: ${failed.join(', ')} did not finish.\n` : '',
      edit ? edit.overview : `${findings.length} findings, not merged, because the editor did not finish.`,
      '',
      findings.length
        ? ['| | Location | Issue |', '|---|---|---|', ...findings.map((f) => `| ${ICON[f.severity as Severity] || ''} | ${link(A.repo, head, f.path!, f.line!)} | ${cell(f.title)} |`)].join('\n')
        : 'No findings.',
      '',
      '### Areas',
      '',
      ...areas.map((a) => `- ${a.name} (${a.files.length} files): ${cell(a.why)}`),
      '',
      KB && !(rt.knowledgeBase && scope.knowledge_base_read) ? `${KB.name} was not read, so this sweep read only the repository.` : '',
    ])
    return { mode: 'sweep', head, areas, findings, partial, failed, summary }
  }

  // --- Eval -------------------------------------------------------------------------

  // Replay each case's segment at the commit its finding was posted on, then
  // judge whether the reviewer reported it (or, for a quiet case, kept quiet).
  async function evaluate(): Promise<Result> {
    let cases: Case[] | null = A.cases || null
    if (!cases && A.cases_file) {
      const file = json<{ cases?: Case[] }>(io.read(A.cases_file))
      if (!file || !Array.isArray(file.cases)) return { error: `could not read the cases from ${A.cases_file}` }
      cases = file.cases
    }
    const names = SEGMENTS.map((s) => s.name)
    for (const x of cases || []) {
      const ok =
        x && typeof x.id === 'string' && Number.isInteger(x.pr) && /^[0-9a-f]{40}$/.test(x.base) && /^[0-9a-f]{40}$/.test(x.head) &&
        names.includes(x.segment) && ['find', 'quiet'].includes(x.expect) && typeof x.path === 'string' && Number.isInteger(x.line) && typeof x.issue === 'string'
      if (!ok) return { error: `the eval case ${JSON.stringify(x && x.id)} is not valid: it needs id, pr, base, head, segment (one of ${names.join(', ')}), expect, path, line, and issue` }
    }
    let list = (cases || []).filter((x) => !A.only || A.only.includes(x.segment) || x.expect === 'quiet')
    // A quiet case checks that the segments under test do not make its wrong
    // claim: the ones a rule change can alter, or its own in a plain eval.
    const scopeOf = (x: Case): string[] => (x.expect === 'quiet' && A.only ? A.only : [x.segment])
    // A caller that replays twice in one run shares its cap on agents, so it
    // caps how many segments the replay runs, counting a segment once per pull
    // request commit however many cases there need it, as the replay groups
    // them. Quiet cases take up to half first, find cases the rest, and quiet
    // cases what find cases leave; within a kind the newest pull requests'
    // cases come first, since a rule change targets those.
    let dropped: string[] = []
    const runs = (xs: Case[]) => new Set(xs.flatMap((x) => scopeOf(x).map((s) => `${x.pr} ${x.head} ${s}`))).size
    if (A.max_segment_runs && runs(list) > A.max_segment_runs) {
      const kept: Case[] = []
      const fill = (expect: string, max: number) => {
        const newest = list.filter((x) => (x.expect === 'quiet') === (expect === 'quiet')).sort((x, y) => y.pr - x.pr)
        for (const x of newest) if (!kept.includes(x) && runs([...kept, x]) <= max) kept.push(x)
      }
      fill('quiet', Math.floor(A.max_segment_runs / 2))
      fill('find', A.max_segment_runs)
      fill('quiet', A.max_segment_runs)
      dropped = list.filter((x) => !kept.includes(x)).map((x) => x.id)
      list = list.filter((x) => kept.includes(x))
      rt.log(`eval: ${dropped.length} cases left out to stay within ${A.max_segment_runs} segment runs: ${dropped.join(', ')}`)
    }
    const groups: { pr: number; head: string; base: string; cases: Case[] }[] = []
    for (const x of list) {
      let g = groups.find((y) => y.pr === x.pr && y.head === x.head)
      if (!g) groups.push((g = { pr: x.pr, head: x.head, base: x.base, cases: [] }))
      g.cases.push(x)
    }
    rt.log(`eval: ${list.length} cases at ${groups.length} pull request commits, rules from ${RULES}`)
    type Row = { id: string; expect: string; segment: string; matched?: boolean; finding?: string; reason?: string; reported?: number; error?: string; not_applicable?: string }
    const results = await pipeline(
      groups,
      (g: (typeof groups)[number]) =>
        gather({
          pr: g.pr,
          repo: A.repo,
          base: g.base,
          head: g.head,
          checkout: false,
          replay: true,
          pr_file: A.pr_dir ? `${A.pr_dir}/${g.pr}.json` : undefined,
          segments: unique(g.cases.flatMap(scopeOf)),
          focus: unique(g.cases.map((x) => x.path)),
        }),
      (r: Gathered | { error: string } | null, g: (typeof groups)[number]) =>
        parallel(
          g.cases.map((x) => async (): Promise<Row> => {
            const base = { id: x.id, expect: x.expect, segment: x.segment }
            if (!r || 'error' in r) return { ...base, error: (r && 'error' in r && r.error) || 'replay failed' }
            const scope = scopeOf(x)
            if (r.failed.some((s) => scope.includes(s))) return { ...base, error: `failed: ${r.failed.join(', ')}` }
            // A segment its gate skipped reviewed nothing, so the case says nothing
            // about it. A quiet case the segments under test do not apply to is
            // not a case for the change, so it is not counted.
            const segs = r.plan.filter((s) => scope.includes(s.name))
            if (!segs.some((s) => s.state === 'run')) {
              const reason = segs.map((s) => `${s.name}: ${s.reason}`).join('; ') || 'unknown'
              if (x.expect === 'quiet') return { ...base, not_applicable: reason }
              return { ...base, error: `segment did not run: ${reason}` }
            }
            // A false positive from any segment in its scope breaks a quiet case.
            const found = r.candidates.filter((f) => scope.includes(f.segment))
            const m = await ask<Match>({
              label: `judge ${x.id}`,
              phase: 'Judge',
              stage: 'judge',
              ...on('judge'),
              ...judgePrompt(x, scope, found),
              schema: MATCH,
              tools: 'none',
            })
            return { ...base, matched: m ? m.matched : undefined, finding: m ? m.finding : undefined, reason: m ? m.reason : 'judge failed', reported: found.length }
          }),
        ),
    )
    // A stage that throws leaves null where its rows would be, so those cases
    // stay as unscored rows instead of dropping out of every list.
    const replayed: Row[] = groups.flatMap((g, i) =>
      g.cases.map((x, j) => (results[i] && results[i][j]) || { id: x.id, expect: x.expect, segment: x.segment, error: 'replay failed' }),
    )
    const notApplicable = replayed.filter((r) => r.not_applicable)
    const rows = replayed.filter((r) => !r.not_applicable)
    const scored = rows.filter((r) => typeof r.matched === 'boolean')
    const finds = scored.filter((r) => r.expect === 'find')
    const quiets = scored.filter((r) => r.expect === 'quiet')
    const ratio = (a: number, b: number) => (b ? Math.round((100 * a) / b) / 100 : null)
    return {
      rules: RULES,
      agents: started,
      cases: list.length - notApplicable.length,
      recall: ratio(finds.filter((r) => r.matched).length, finds.length),
      quiet: ratio(quiets.filter((r) => !r.matched).length, quiets.length),
      found: `${finds.filter((r) => r.matched).length} of ${finds.length}`,
      quiet_held: `${quiets.filter((r) => !r.matched).length} of ${quiets.length}`,
      findings_per_case: ratio(
        scored.reduce((sum, r) => sum + (r.reported || 0), 0),
        scored.length,
      ),
      unscored: rows.filter((r) => typeof r.matched !== 'boolean').map((r) => ({ id: r.id, why: r.error || r.reason })),
      dropped,
      not_applicable: notApplicable.map((r) => ({ id: r.id, why: r.not_applicable })),
      by_segment: SEGMENTS.map((s) => ({
        segment: s.name,
        found: finds.filter((r) => r.segment === s.name && r.matched).length,
        of: finds.filter((r) => r.segment === s.name).length,
      })).filter((s) => s.of > 0),
      rows,
    }
  }

  // --- Entry --------------------------------------------------------------------------

  if (MODE === 'sweep') return await sweep()
  if (MODE === 'eval') return await evaluate()
  const R: Review = { ...A, pr: PR }
  const g = await gather(R)
  if ('error' in g) return { partial: true, failed: ['context'], error: g.error }
  return await finish(R, g)
}

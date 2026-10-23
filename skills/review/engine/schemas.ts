// The JSON schemas each stage answers in. Claude Code checks an agent's answer
// against its schema and asks again when it does not match. An answer carries
// only what its agent decides: the engine fills in what it already holds.

export type Schema = Record<string, unknown>

export const SEVERITY = ['important', 'nit', 'preexisting'] as const
export type Severity = (typeof SEVERITY)[number]

export const MAX_PER_AGENT = 6
export const MAX_AREAS = 4

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required })
const text = (description?: string): Schema => (description ? { type: 'string', description } : { type: 'string' })
const texts = (description?: string): Schema => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) })
const line = (description?: string): Schema => ({ type: 'integer', minimum: 1, ...(description ? { description } : {}) })

export const FINDING_FIELDS = {
  path: text('Repository-relative path'),
  line: line('Line in the head version (the base version for side LEFT); the last line of a range'),
  start_line: line('First line of a range, when the finding spans lines'),
  side: { type: 'string', enum: ['RIGHT', 'LEFT'], description: 'LEFT only when the finding is about a removed line' },
  severity: { type: 'string', enum: [...SEVERITY] },
  title: text('One line: what goes wrong'),
  body: text('Markdown: what fails, for which input or state, and the wrong result'),
  trace: text('Why this was flagged: input or state, its path through the code with file:line, the wrong result'),
  rule: text('Document and section of the broken rule, when one applies'),
  suggestion: text('Replacement text for start_line..line, only for a small local fix'),
  places: texts('Every other place, as path:line, where the same wrong pattern occurs in code the pull request changes or relies on'),
} satisfies Record<string, Schema>
const FINDING_REQUIRED = ['path', 'line', 'severity', 'title', 'body', 'trace']

export interface Finding {
  path: string
  line: number
  start_line?: number
  side?: 'RIGHT' | 'LEFT'
  severity: Severity
  title: string
  body: string
  trace: string
  rule?: string
  suggestion?: string
  places?: string[]
}

export const FINDINGS = object(
  {
    findings: { type: 'array', items: object(FINDING_FIELDS, FINDING_REQUIRED) },
    dropped: { type: 'integer', minimum: 0, description: 'Findings left out to stay within the cap' },
  },
  ['findings'],
)
export interface Findings {
  findings: Finding[]
  dropped?: number
}

const AREA = object({ name: text(), files: texts() }, ['name', 'files'])
export interface Area {
  name: string
  files: string[]
  why?: string
}
const RULE = object({ source: text('document#section'), rule: text() }, ['source', 'rule'])
export interface Rule {
  source: string
  rule: string
}

const KNOWLEDGE = {
  knowledge_base: text('What the knowledge base added, where it disagreed with the repository, or why it was not read'),
  knowledge_base_read: { type: 'boolean', description: 'True when a knowledge-base read tool returned documentation' },
}

export const BRIEF = object(
  {
    intent: text('Two or three sentences: what the change is for'),
    claims: texts('What the description says the change does'),
    rules: { type: 'array', items: RULE },
    risks: texts('Where defects are likely, with file:line'),
    areas: { type: 'array', maxItems: MAX_AREAS, items: AREA },
    ...KNOWLEDGE,
  },
  ['intent', 'claims', 'rules', 'risks', 'areas', 'knowledge_base', 'knowledge_base_read'],
)
export interface Brief {
  intent: string
  claims: string[]
  rules: Rule[]
  risks: string[]
  areas: Area[]
  knowledge_base: string
  knowledge_base_read: boolean
}

export const SCOPE = object(
  {
    areas: {
      type: 'array',
      items: object({ name: text(), files: texts(), why: text('Why this area this week: changed since, or not covered yet') }, ['name', 'files', 'why']),
    },
    rules: { type: 'array', items: RULE },
    risks: texts('Where defects are likely in these areas, with file:line'),
    ...KNOWLEDGE,
  },
  ['areas', 'rules', 'risks', 'knowledge_base', 'knowledge_base_read'],
)
export interface Scope {
  areas: (Area & { why: string })[]
  rules: Rule[]
  risks: string[]
  knowledge_base: string
  knowledge_base_read: boolean
}

const VERDICT_FIELDS = {
  verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unsure'] },
  severity: { type: 'string', enum: [...SEVERITY] },
  reason: text(),
  trace: text("Only when the finding's trace is wrong: the trace you checked, corrected"),
  places: texts("The finding's other places that have the same problem"),
  security_or_privacy: {
    type: 'boolean',
    description: 'True when the finding is about security or privacy: a secret, an access or trust check, or personal data reaching someone it should not',
  },
}
const VERDICT_REQUIRED = ['verdict', 'severity', 'reason', 'security_or_privacy']
export const VERDICT = object(VERDICT_FIELDS, VERDICT_REQUIRED)
// One skeptic for the findings of one segment at the same place.
export const VERDICTS = object(
  {
    verdicts: {
      type: 'array',
      items: object({ finding: { type: 'integer', minimum: 1, description: 'The number of the finding this verdict is on' }, ...VERDICT_FIELDS }, [
        'finding',
        ...VERDICT_REQUIRED,
      ]),
    },
  },
  ['verdicts'],
)
export interface Verdict {
  verdict: 'confirmed' | 'refuted' | 'unsure'
  severity: Severity
  reason: string
  trace?: string
  places?: string[]
  security_or_privacy: boolean
}

export const FOLLOWUP = object(
  {
    threads: {
      type: 'array',
      items: object(
        {
          id: text('The thread id'),
          state: { type: 'string', enum: ['fixed', 'answered', 'open'] },
          commit: text('For fixed: the commit that fixed it'),
          note: text('For fixed: how; for answered: the reason given and whether it holds'),
          holds: { type: 'boolean', description: 'For answered: whether the reason holds; false for fixed or open' },
          answer: text('When a person wrote the last comment and it needs an answer: the reply this reviewer posts in the thread'),
          line: line('The line the finding is about in the head version, when it moved and still exists'),
        },
        ['id', 'state', 'holds'],
      ),
    },
  },
  ['threads'],
)
export interface ThreadState {
  id: string
  state: 'fixed' | 'answered' | 'open'
  commit?: string
  note?: string
  holds: boolean
  answer?: string
  line?: number
}

const KEYS = texts('Keys of the candidate findings this merges')
// The editor names the candidates it keeps by key and gives only the fields
// it changes; the engine takes the rest from the first key's finding.
const CHANGED = 'Give only when it differs from the first key\'s finding: '
const EDITED = Object.fromEntries(
  Object.entries(FINDING_FIELDS).map(([name, schema]) => [name, { ...schema, description: `${CHANGED}${(schema as { description?: string }).description || name}` }]),
)

export const EDIT = object(
  {
    verdict: text('No blocking issues, or the count per severity'),
    overview: text('Two to four sentences on what the pull request changes'),
    diagram: text('Mermaid source, without a fence, of the main flow the pull request adds or changes; empty when it has no flow to draw'),
    confidence: object({ score: { type: 'integer', minimum: 1, maximum: 5 }, reason: text() }, ['score', 'reason']),
    post: {
      type: 'array',
      description: 'Findings to post as new threads',
      items: object(
        {
          keys: KEYS,
          slug: text('Short kebab-case name of the finding'),
          ...EDITED,
          earlier: texts('Ids of the earlier summary entries this finding posts as a thread'),
          anchor: {
            ...object({ path: text(), line: line() }, ['path', 'line']),
            description: 'When path is a file the pull request does not change: the changed line whose change makes the finding true, where the comment goes',
          },
        },
        ['keys', 'slug'],
      ),
    },
    summary_only: {
      type: 'array',
      description: 'Findings listed only in the summary',
      items: object(
        {
          keys: KEYS,
          why: { type: 'string', enum: ['open-thread', 'answered', 'nit-cap', 'unchanged-line', 'unverified'] },
          id: text('The id of the earlier summary entry this lists again, when it is one'),
          thread_url: text(),
          severity: EDITED.severity!,
          path: EDITED.path!,
          line: EDITED.line!,
          side: EDITED.side!,
          title: EDITED.title!,
          places: EDITED.places!,
        },
        ['keys', 'why'],
      ),
    },
    earlier: {
      type: 'array',
      description: 'What became of each earlier summary entry that you neither list again nor post',
      items: object(
        {
          id: text('The entry id'),
          state: { type: 'string', enum: ['fixed', 'answered', 'open'] },
          commit: text('For fixed: the commit that fixed it'),
          note: text('For fixed: how; for answered: the reason given and whether it holds'),
          holds: { type: 'boolean', description: 'For answered: whether the reason holds' },
        },
        ['id', 'state'],
      ),
    },
    dropped: {
      type: 'array',
      description: 'Candidates neither posted nor listed, with the reason (merged, never report)',
      items: object({ key: text(), why: text() }, ['key', 'why']),
    },
  },
  ['verdict', 'overview', 'confidence', 'post', 'summary_only', 'earlier', 'dropped'],
)
export type Edited = Partial<Finding> & { keys: string[] }
export interface Edit {
  verdict: string
  overview: string
  diagram?: string
  confidence: { score: number; reason: string }
  post: (Edited & { slug: string; earlier?: string[]; anchor?: { path: string; line: number } })[]
  summary_only: (Edited & {
    why: 'open-thread' | 'answered' | 'nit-cap' | 'unchanged-line' | 'unverified' | 'no-editor'
    id?: string
    thread_url?: string
  })[]
  earlier: { id: string; state: 'fixed' | 'answered' | 'open'; commit?: string; note?: string; holds?: boolean }[]
  dropped: { key: string; why: string }[]
}

export const SWEEP_EDIT = object(
  {
    findings: {
      type: 'array',
      description: 'The findings to fix, merged where they share a cause',
      items: object({ keys: KEYS, ...EDITED }, ['keys']),
    },
    dropped: (EDIT.properties as Record<string, Schema>).dropped!,
    overview: text('Two to four sentences on what the sweep found'),
  },
  ['findings', 'dropped', 'overview'],
)
export interface SweepEdit {
  findings: Edited[]
  dropped: { key: string; why: string }[]
  overview: string
}

export const MATCH = object(
  {
    matched: { type: 'boolean', description: 'find: a finding reports this issue; quiet: a finding makes this claim' },
    finding: text('The matching finding title, if any'),
    reason: text(),
  },
  ['matched', 'reason'],
)
export interface Match {
  matched: boolean
  finding?: string
  reason: string
}

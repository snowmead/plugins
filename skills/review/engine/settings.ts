// The review's settings: which files are which, the segments (lenses) and
// when each runs, and the model and effort of each stage. A repository's
// settings file (README.md, "Settings") goes over DEFAULTS.

import { dirname, join } from 'node:path'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface Stage {
  model: string
  effort: Effort
}

export const STAGES = ['context', 'scope', 'finder', 'skeptic', 'followup', 'editor', 'judge', 'tuner'] as const
export type StageName = (typeof STAGES)[number]
// Stages an older settings file may still name. The engine starts no agent for
// them: the session that called the Workflow tool, and the agents that read a
// file for a script that could not.
const RETIRED_STAGES = ['session', 'loader']
const SEGMENT_STAGES = ['finder', 'skeptic'] as const
type SegmentStage = (typeof SEGMENT_STAGES)[number]

export interface SegmentSpec {
  name: string
  title: string
  files: string[]
  always?: boolean
  passes?: 1 | 2
  agents?: Partial<Record<SegmentStage, Partial<Stage>>>
  keep_unverified?: boolean
  note?: string
  sweep_note?: string
  enabled?: boolean
}

export interface Segment extends SegmentSpec {
  passes: 1 | 2
  /** Whether any of `files` is in the segment's scope. */
  applies(files: string[]): boolean
}

export interface KnowledgeBase {
  name: string
  skill: string
}

export interface Settings {
  agents: Record<StageName, Stage>
  classes: Record<string, string[]>
  /** Whether `file` is in the class `name`; `code` is every file not generated, prose, or an asset. */
  inClass(name: string, file: string): boolean
  segments: Segment[]
  knowledgeBase: KnowledgeBase | null
  sweep: { max_areas: number }
}

// What the settings leave out. A class in the settings replaces the class of
// the same name here; a segment merges over the one of the same name, and a
// new one runs after these; a stage merges over its model and effort.
export const DEFAULTS = {
  classes: {
    generated: ['**/{Cargo.lock,package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,poetry.lock,uv.lock,Gemfile.lock,go.sum,composer.lock,flake.lock}'],
    prose: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.txt', 'docs/**', 'LICENSE*'],
    assets: ['**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf,otf,mp4,webm,mp3,wav,pdf}'],
    // The instructions agents and this review follow, and design documents.
    design: ['docs/**', '**/{AGENTS,CLAUDE}{,.local}.md', 'REVIEW.md', '.claude/**', '.agents/**'],
  } as Record<string, string[]>,
  segments: [
    { name: 'bugs', title: 'Bugs', files: ['@code'], passes: 2 },
    {
      name: 'security',
      title: 'Security',
      files: ['@code', '@design'],
      // A missed security finding costs the most, so its finder keeps the strongest model.
      agents: { finder: { model: 'claude-opus-5-5', effort: 'high' } },
      keep_unverified: true,
      note: 'Follow data that crosses a trust boundary: request input, tokens, sessions, personal data, secrets, and CI permissions.',
    },
    { name: 'tests', title: 'Tests', files: ['@code'] },
    {
      name: 'design',
      title: 'Design',
      files: ['@code', '@design'],
      note: 'Compare the diff with the claims in the brief: report what the description promises that the diff does not do, and what the diff does that the description does not say.',
      sweep_note: 'Compare the code with the documents that describe it, as the rules and the instruction files assign ownership: report what the code does that they do not say, and what they promise that the code does not do.',
    },
    {
      name: 'docs',
      title: 'Docs',
      files: ['**'],
      always: true,
      note: 'For each behavior, command, or decision the diff changes, find the document that owns it, as the rules and the instruction files assign ownership, and check that it is current. Check links to files the diff moves or deletes (`git diff --name-status <base>...<head>`).',
      sweep_note: "For each behavior, command, or decision in the area, find the document that owns it, as the rules and the instruction files assign ownership, and check that it is current. Check that the links in the area's documents lead to files that exist.",
    },
  ] as SegmentSpec[],
  agents: {
    context: { model: 'claude-sonnet-5-5', effort: 'high' },
    scope: { model: 'claude-sonnet-5-5', effort: 'high' },
    finder: { model: 'claude-sonnet-5-5', effort: 'high' },
    // The skeptics decide which findings stay, so they keep the strongest model.
    skeptic: { model: 'claude-opus-5-5', effort: 'medium' },
    followup: { model: 'claude-sonnet-5-5', effort: 'high' },
    editor: { model: 'claude-sonnet-5-5', effort: 'high' },
    judge: { model: 'claude-sonnet-5-5', effort: 'low' },
    // The tuning routine's agents: the outcomes, the proposal, the draft, and the guard.
    tuner: { model: 'claude-sonnet-5-5', effort: 'high' },
  } as Record<StageName, Stage>,
  knowledge_base: { name: "Greptile's knowledge base", skill: '' } as KnowledgeBase,
  sweep: { max_areas: 4 },
}

const SEGMENT_FIELDS = ['name', 'title', 'files', 'always', 'passes', 'agents', 'keep_unverified', 'note', 'sweep_note', 'enabled']
const SETTINGS_FIELDS = ['classes', 'segments', 'agents', 'knowledge_base', 'sweep', 'examples']

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPatterns = (value: unknown): value is string[] => Array.isArray(value) && value.every((p) => typeof p === 'string')

/**
 * A glob over a repository path, matched against the whole path, in any case:
 * `**` crosses directories, `*` and `?` stay within one, and `{a,b}` is either.
 */
export function globRegex(glob: string): RegExp {
  let out = ''
  let depth = 0
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!
    if (ch === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/'
      const atStart = i === 0 || glob[i - 1] === '/'
      if (atStart && slashAfter) {
        out += '(?:.*/)?'
        i += 2
      } else if (atStart && i + 2 === glob.length && i > 0) {
        // dir/** is dir and everything under it.
        out = out.slice(0, -1) + '(?:/.*)?'
        i += 1
      } else {
        out += '.*'
        i += 1
      }
    } else if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else if (ch === '{') {
      out += '(?:'
      depth += 1
    } else if (ch === '}' && depth > 0) {
      out += ')'
      depth -= 1
    } else if (ch === ',' && depth > 0) out += '|'
    else out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  if (depth > 0) throw new Error('a { has no }')
  return new RegExp(`^${out}$`, 'i')
}

/** The settings in effect: DEFAULTS with `config` over them, or an error that names what is wrong. */
export function settle(config: unknown): Settings | { error: string } {
  const C = config === undefined ? {} : config
  const fail = (message: string) => ({ error: `The review's settings are invalid: ${message}` })
  if (!isObject(C)) return fail('they are not a JSON object.')
  for (const key of Object.keys(C)) if (!SETTINGS_FIELDS.includes(key)) return fail(`${key} is not a setting.`)
  const stageError = (where: string, stages: unknown, allowed: readonly string[], retired: readonly string[] = []) => {
    if (!isObject(stages)) return `${where} is not an object of stages.`
    for (const [name, stage] of Object.entries(stages)) {
      if (!allowed.includes(name) && !retired.includes(name)) return `${where} names ${name}, which is not one of ${allowed.join(', ')}.`
      if (!isObject(stage)) return `${where}.${name} is not {model, effort}.`
      for (const [key, value] of Object.entries(stage)) {
        if (key === 'model' && typeof value === 'string') continue
        if (key === 'effort' && EFFORTS.includes(value as Effort)) continue
        return `${where}.${name}.${key} is ${JSON.stringify(value)}; a stage takes a model name and an effort (${EFFORTS.join(', ')}).`
      }
    }
    return null
  }
  const agents = {} as Record<StageName, Stage>
  for (const name of STAGES) agents[name] = { ...DEFAULTS.agents[name] }
  if (C.agents !== undefined) {
    const e = stageError('agents', C.agents, STAGES, RETIRED_STAGES)
    if (e) return fail(e)
    for (const [name, stage] of Object.entries(C.agents as Json)) {
      if ((STAGES as readonly string[]).includes(name)) Object.assign(agents[name as StageName], stage)
    }
  }
  // No prototype, so a class reference such as @toString names no class.
  const classes: Record<string, string[]> = Object.assign(Object.create(null), DEFAULTS.classes)
  if (C.classes !== undefined) {
    if (!isObject(C.classes)) return fail('classes is not an object of pattern lists.')
    for (const [name, patterns] of Object.entries(C.classes)) {
      if (name === 'code') return fail('code is built in: it is every file that is not generated, prose, or an asset.')
      if (!isPatterns(patterns)) return fail(`classes.${name} is not a list of patterns.`)
      classes[name] = patterns
    }
  }
  const segments: SegmentSpec[] = DEFAULTS.segments.map((s) => ({ ...s }))
  if (C.segments !== undefined) {
    if (!Array.isArray(C.segments)) return fail('segments is not a list.')
    for (const s of C.segments as unknown[]) {
      if (!isObject(s) || typeof s.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(s.name)) {
        return fail(`a segment has no name of lowercase letters, digits, and dashes: ${JSON.stringify(s)}.`)
      }
      for (const key of Object.keys(s)) if (!SEGMENT_FIELDS.includes(key)) return fail(`segment ${s.name} sets ${key}, which a segment does not have.`)
      if (s.files !== undefined && !isPatterns(s.files)) return fail(`segment ${s.name}'s files are not a list of patterns.`)
      if (s.passes !== undefined && s.passes !== 1 && s.passes !== 2) return fail(`segment ${s.name}'s passes is ${JSON.stringify(s.passes)}; it is 1 or 2.`)
      for (const key of ['title', 'note', 'sweep_note']) if (s[key] !== undefined && typeof s[key] !== 'string') return fail(`segment ${s.name}'s ${key} is not text.`)
      for (const key of ['always', 'keep_unverified', 'enabled']) {
        if (s[key] !== undefined && typeof s[key] !== 'boolean') return fail(`segment ${s.name}'s ${key} is ${JSON.stringify(s[key])}; it is true or false.`)
      }
      if (s.agents !== undefined) {
        const e = stageError(`segment ${s.name}'s agents`, s.agents, SEGMENT_STAGES)
        if (e) return fail(e)
      }
      const spec = s as unknown as SegmentSpec
      const known = segments.find((x) => x.name === spec.name)
      if (known) {
        const agentsOf: SegmentSpec['agents'] = { ...(known.agents || {}) }
        for (const [name, stage] of Object.entries(spec.agents || {})) {
          agentsOf[name as SegmentStage] = { ...(agentsOf[name as SegmentStage] || {}), ...stage }
        }
        Object.assign(known, spec, { agents: agentsOf })
      } else {
        if (!spec.files) return fail(`segment ${spec.name} is new, so it needs files.`)
        segments.push({ ...spec, title: spec.title ?? spec.name[0]!.toUpperCase() + spec.name.slice(1) })
      }
    }
  }
  const patternError = (where: string, patterns: string[]) => {
    for (const p of patterns) {
      const body = p.replace(/^!/, '')
      if (body.startsWith('@')) continue
      try {
        globRegex(body)
      } catch (e) {
        return `${where} has the pattern ${JSON.stringify(p)}, which is not valid: ${(e as Error).message}.`
      }
    }
    return null
  }
  for (const [name, patterns] of Object.entries(classes)) {
    for (const p of patterns) {
      const ref = p.replace(/^!/, '')
      if (ref.startsWith('@') && ref !== '@code' && !classes[ref.slice(1)]) return fail(`classes.${name} names the class ${ref}, which the settings do not define.`)
    }
    const e = patternError(`classes.${name}`, patterns)
    if (e) return fail(e)
  }
  for (const s of segments) {
    for (const p of s.files) {
      const ref = p.replace(/^!/, '')
      if (ref.startsWith('@') && ref !== '@code' && !classes[ref.slice(1)]) return fail(`segment ${s.name} names the class ${ref}, which the settings do not define.`)
    }
    const e = patternError(`segment ${s.name}'s files`, s.files)
    if (e) return fail(e)
  }
  let knowledgeBase: KnowledgeBase | null = DEFAULTS.knowledge_base
  if (C.knowledge_base === false) knowledgeBase = null
  else if (C.knowledge_base !== undefined) {
    const kb = C.knowledge_base
    if (!isObject(kb) || Object.entries(kb).some(([key, value]) => !['name', 'skill'].includes(key) || typeof value !== 'string')) {
      return fail('knowledge_base is not {name, skill} or false.')
    }
    knowledgeBase = { ...DEFAULTS.knowledge_base, ...(kb as Partial<KnowledgeBase>) }
  }
  if (C.sweep !== undefined && !isObject(C.sweep)) return fail('sweep is not an object.')
  const sweep = { ...DEFAULTS.sweep, ...((C.sweep as Json | undefined) ?? {}) } as { max_areas: number }
  if (!Number.isInteger(sweep.max_areas) || sweep.max_areas < 1) return fail('sweep.max_areas is not a positive whole number.')

  // A class is a pattern list; @code is every file that is not generated,
  // prose, or an asset. A pattern list is read in order, and the last
  // pattern that matches a file decides, so !pattern takes a file back out.
  const regexes = new Map<string, RegExp>()
  const inClass = (name: string, f: string, seen: string[] = []): boolean => {
    if (name === 'code') return !['generated', 'prose', 'assets'].some((c) => classes[c] && inClass(c, f, seen))
    if (seen.includes(name)) return false
    return matches(classes[name] || [], f, [...seen, name])
  }
  const matches = (patterns: string[], f: string, seen: string[] = []): boolean => {
    let hit = false
    for (const p of patterns) {
      const negated = p.startsWith('!')
      const body = negated ? p.slice(1) : p
      let match: boolean
      if (body.startsWith('@')) match = inClass(body.slice(1), f, seen)
      else {
        if (!regexes.has(body)) regexes.set(body, globRegex(body))
        match = regexes.get(body)!.test(f)
      }
      if (match) hit = !negated
    }
    return hit
  }
  const live: Segment[] = segments
    .filter((s) => s.enabled !== false)
    .map((s) => ({ ...s, passes: s.passes || 1, applies: (fs: string[]) => fs.some((f) => matches(s.files, f)) }))
  return { agents, classes, inClass: (name, f) => inClass(name, f), segments: live, knowledgeBase, sweep }
}

/** An example in a settings file that its segments do not bear out, or settings that are not valid. */
export interface ExampleProblem {
  /** The line the example starts on, or 1. */
  line: number
  title: string
  body: string
  trace: string
}

/**
 * Checks the settings file `text` and its `examples`: the segments that review
 * a change to an example's `changed` must be the ones it names. Settings that
 * are not valid are one problem, since every review would stop on them. Only
 * JSON and the patterns are read; nothing runs.
 */
export function exampleProblems(text: string, file: string): { checked: number; problems: ExampleProblem[] } {
  const invalid = (why: string) => ({
    checked: 0,
    problems: [{ line: 1, title: `The settings in ${file} are not valid, so every review would stop on them`, body: why, trace: `The engine read ${file} at the head and found: ${why}` }],
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return invalid(`${file} is not JSON: ${(e as Error).message}.`)
  }
  const settled = settle(parsed)
  if ('error' in settled) return invalid(settled.error)
  const examples = (parsed as Json).examples
  if (examples === undefined) return { checked: 0, problems: [] }
  if (!Array.isArray(examples)) return invalid('The examples are not a list of {changed, segments}.')
  const names = settled.segments.map((s) => s.name)
  const lines = exampleLines(text)
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(', ') : 'none')
  const problems: ExampleProblem[] = []
  examples.forEach((x: unknown, i) => {
    const line = lines[i] ?? 1
    const n = i + 1
    if (!isObject(x) || !isPatterns(x.changed) || !isPatterns(x.segments)) {
      problems.push({ line, title: `Example ${n} is not {changed, segments}`, body: `Example ${n} needs \`changed\`, the files a pull request changes, and \`segments\`, the segments that review it, each a list of text.`, trace: `examples[${i}] in ${file} is ${JSON.stringify(x)}.` })
      return
    }
    const changed = x.changed as string[]
    const want = unique(x.segments as string[])
    const got = changed.length ? settled.segments.filter((s) => s.applies(changed)).map((s) => s.name) : []
    const missing = want.filter((s) => !got.includes(s))
    const extra = got.filter((s) => !want.includes(s))
    if (!missing.length && !extra.length) return
    const unknown = missing.filter((s) => !names.includes(s))
    const parts = [
      `For a change to ${list(changed)}, example ${n} expects ${list(want)}, but the settings run ${list(got)}.`,
      missing.length ? `Not run: ${list(missing)}${unknown.length ? `, of which ${list(unknown)} ${unknown.length === 1 ? 'is not a segment' : 'are not segments'}` : ''}.` : '',
      extra.length ? `Run but not expected: ${list(extra)}.` : '',
      'Change the segments or the example, whichever is wrong.',
    ]
    problems.push({
      line,
      title: `Example ${n} expects ${want.join(', ') || 'no segments'}, but the settings run ${got.join(', ') || 'none'}`,
      body: parts.filter(Boolean).join(' '),
      trace: `examples[${i}] in ${file} lists ${list(changed)}. Each enabled segment runs when one of those files matches its files patterns, the last matching pattern deciding: ${settled.segments.map((s) => `${s.name} ${got.includes(s.name) ? 'matches' : 'does not'}`).join(', ')}.`,
    })
  })
  return { checked: examples.length, problems }
}

/** How long checkExamples lets exampleProblems run. */
export const EXAMPLES_MS = 10_000

/**
 * exampleProblems on a change's own copy of the settings, in a process that is
 * killed after `ms`: the change wrote the patterns and the paths they are
 * matched against, and a pattern such as `{a,a}` repeated, or many `*`, can
 * backtrack for hours. A check that runs out of time is one problem.
 */
export async function checkExamples(text: string, file: string, ms = EXAMPLES_MS): Promise<{ checked: number; problems: ExampleProblem[] }> {
  const p = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'check-examples.ts')], {
    cwd: dirname(import.meta.dir),
    env: { PATH: process.env.PATH ?? '' },
    stdin: new TextEncoder().encode(JSON.stringify({ text, file })),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: ms,
    killSignal: 'SIGKILL',
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code === 0) return JSON.parse(out)
  if (!p.signalCode) throw new Error(`The check of the examples in ${file} failed: ${err.trim()}`)
  const s = ms / 1000
  return {
    checked: 0,
    problems: [
      {
        line: 1,
        title: `Checking the examples in ${file} took over ${s} seconds, so it was stopped`,
        body: `A \`files\` pattern in these settings takes too long to match an example's path, which happens when many \`*\` or \`{…,…}\` groups can match the same text. A review that matches the pattern against a changed file can stall the same way. Simplify the pattern.`,
        trace: `The engine checked ${file} at the head in a process of its own and stopped it after ${s} seconds.`,
      },
    ],
  }
}

const unique = (xs: string[]) => [...new Set(xs)]

// The line each element of the top-level "examples" list starts on, since
// JSON.parse keeps no places. A later "examples" key wins, as in JSON.parse.
function exampleLines(text: string): number[] {
  let lines: number[] = []
  let depth = 0
  let line = 1
  let key = ''
  let inside = false
  let next = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (ch === '\n') {
      line += 1
      continue
    }
    if (inside && depth === 2 && next && !/[\s,\]]/.test(ch)) {
      lines.push(line)
      next = false
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (depth === 1) key = text.slice(i + 1, j)
      i = j
    } else if (ch === '{' || ch === '[') {
      depth += 1
      if (depth === 2 && ch === '[' && key === 'examples') {
        lines = []
        inside = true
        next = true
      }
    } else if (ch === '}' || ch === ']') {
      if (depth === 2) inside = false
      depth -= 1
    } else if (ch === ',' && inside && depth === 2) next = true
  }
  return lines
}

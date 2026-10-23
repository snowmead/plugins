// Runs the review engine with every agent answered by a stub, and the engine's
// own reads answered from memory: the files a test gives, and git's answers
// for a repository whose pull request changes Rust, web, and docs files.

import { readFileSync } from 'node:fs'
import { type AgentCall, type Args, type Io, review as runReview } from '../review.ts'

export const SHA = (c: string) => c.repeat(40)

// The settings of a repository with Rust and web code, in the shape a
// repository's settings file takes.
export const CONFIG = JSON.parse(readFileSync(new URL('config.json', import.meta.url), 'utf8'))

// The segments CONFIG runs, in the order the engine plans them.
export const SEGMENTS = ['bugs', 'security', 'tests', 'design', 'docs', 'rust', 'web']

// The files the pull request changes, unless a test says otherwise.
export const CHANGED = ['src/a.rs', 'web/x.tsx', 'docs/y.md']

// The skill's default rules, which every run reads unless a test gives its own.
export const RULES = readFileSync(new URL('../../rules.md', import.meta.url), 'utf8')

/** The segments whose agents started, from their labels. */
export const ran = (labels: string[], segments = SEGMENTS) => segments.filter((s) => labels.some((l) => l === s || l.startsWith(`${s} `)))

export type Answer = (label: string, prompt: string, call: AgentCall) => unknown

export interface Setup {
  /** Files the engine reads, by path. */
  files?: Record<string, string>
  /** The files each range changes; CHANGED for any other. */
  changed?: Record<string, string[]>
  /** What `git rev-parse HEAD` says. */
  head?: string
  /** Whether the knowledge base's tools are connected (default true). */
  knowledgeBase?: boolean
}

export interface Ran {
  result: any
  labels: string[]
  calls: Record<string, AgentCall>
  /** Each agent's system prompt and prompt, joined. */
  prompts: Record<string, string>
  logs: string[]
}

export function stubIo(setup: Setup = {}): Io {
  const files: Record<string, string> = { 'REVIEW.md': RULES, '/t.json': '[]', ...(setup.files || {}) }
  return {
    read: (path) => (path in files ? files[path]! : null),
    async git(args) {
      const [sub, ...rest] = args
      if (sub === 'rev-parse') return `${setup.head || SHA('h')}\n`
      if (sub === 'merge-base') return `${SHA('b')}\n`
      if (sub === 'cat-file') return ''
      if (sub === 'diff' && rest[0] === '--name-only') {
        const range = rest[rest.length - 1]!
        return `${((setup.changed && setup.changed[range]) || CHANGED).join('\0')}\0`
      }
      if (sub === 'diff') return ''
      return null
    },
  }
}

/** The engine's result for `args`, with each agent answered by `answer`, in the order the agents started. */
export async function run(args: Args, answer: Answer, setup: Setup = {}): Promise<Ran> {
  const labels: string[] = []
  const calls: Record<string, AgentCall> = {}
  const prompts: Record<string, string> = {}
  const logs: string[] = []
  const rt = {
    knowledgeBase: setup.knowledgeBase !== false,
    log: (m: string) => logs.push(m),
    async agent(call: AgentCall) {
      labels.push(call.label)
      calls[call.label] = call
      const prompt = `${call.system}\n\n${call.prompt}`
      prompts[call.label] = prompt
      return answer(call.label, prompt, call)
    },
  }
  const result = await runReview(args, rt, stubIo(setup))
  return { result, labels, calls, prompts, logs }
}

/** A pull request where no segment finds anything and the editor lists one finding from an open thread. */
export function review(label: string): unknown {
  if (label === 'context') {
    return {
      intent: 'I', claims: [], rules: [], risks: [], areas: [{ name: 'api', files: ['src/a.rs'] }], knowledge_base: '', knowledge_base_read: true,
    }
  }
  if (label === 'follow-up') return { threads: [] }
  if (label === 'editor') {
    return {
      verdict: '1 Nit', overview: 'o', confidence: { score: 4, reason: 'r' }, post: [], dropped: [], earlier: [],
      summary_only: [{ keys: [], severity: 'nit', path: 'src/c.rs', line: 7, title: 'raised in a thread', why: 'open-thread', thread_url: 'https://x/t9' }],
    }
  }
  if (ran([label]).length) return { findings: [] }
  throw new Error(`no answer for ${label}`)
}

/** A review thread this reviewer started, as the action's prepare step writes them. */
export function thread(id: string, opts: { severity?: string; title?: string; path?: string; line?: number; url?: string; reviewer?: string; resolved?: boolean; replies?: { author: string; person?: boolean; body: string }[] } = {}) {
  const alt = opts.severity ? `<img alt="${opts.severity}" src="https://img.shields.io/badge/x-cf222e?style=flat" align="top"> ` : ''
  return {
    id,
    isResolved: opts.resolved ?? false,
    isOutdated: false,
    path: opts.path,
    line: opts.line,
    comments: {
      nodes: [
        { author: { login: opts.reviewer || 'github-actions', __typename: 'Bot' }, body: `${alt}**${opts.title || 't'}**\n\nb\n\n<!-- claude-review {"id":"x"} -->`, url: opts.url || `https://x/${id}` },
        ...(opts.replies || []).map((r) => ({ author: { login: r.author, __typename: r.person === false ? 'Bot' : 'User' }, body: r.body, url: `https://x/${id}/r` })),
      ],
    },
  }
}

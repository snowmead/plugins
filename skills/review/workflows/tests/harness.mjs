// Runs a workflow as Claude Code runs it, with every agent answered by a
// stub, and the stub reviewer the tests and the Rust contract test share.

import { readFileSync } from 'node:fs'

const WORKFLOWS = new URL('../', import.meta.url)

export const SHA = (c) => c.repeat(40)

// Claude Code runs a workflow's body as an async function with these hooks.
// A stage or thunk that throws resolves to null, as in the runtime. Each
// agent's label and options are kept, in the order they started.
export async function run(file, args, answer, workflow = null) {
  const source = readFileSync(new URL(file, WORKFLOWS), 'utf8').replace(/^export const meta/m, 'const meta')
  const labels = []
  const options = {}
  const agent = async (prompt, opts = {}) => {
    labels.push(opts.label)
    options[opts.label] = opts
    return answer(opts.label, prompt)
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        let value = item
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
  const body = new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', `return (async () => {${source}})()`)
  const result = await body(args, agent, parallel, pipeline, () => {}, () => {}, workflow)
  return { result, labels, options }
}

// The settings of a repository with Rust and web code, in the shape a
// repository's settings file takes.
export const CONFIG = JSON.parse(readFileSync(new URL('config.json', import.meta.url), 'utf8'))

// The segments CONFIG runs, in the order the workflow plans them.
export const SEGMENTS = ['bugs', 'security', 'tests', 'design', 'docs', 'rust', 'web']

// The segments whose agents started, from their labels.
export const ran = (labels, segments = SEGMENTS) => segments.filter((s) => labels.some((l) => l === s || l.startsWith(`${s} `)))

// A pull request that changes Rust, web, and docs files, where no segment
// finds anything and the editor lists one finding from an open thread.
export function review(label) {
  if (label === 'context') {
    return {
      repo: 'o/r', base: SHA('b'), head: SHA('h'), checkout: true, title: 'T', intent: 'I', claims: [], rules: [], risks: [],
      areas: [{ name: 'api', files: ['src/a.rs'] }], files: ['src/a.rs', 'web/x.tsx', 'docs/y.md'],
      knowledge_base: '', knowledge_base_read: true,
    }
  }
  if (label === 'follow-up') return { threads: [] }
  if (label === 'editor') {
    return {
      verdict: '1 Nit', overview: 'o', confidence: { score: 4, reason: 'r' }, post: [], dropped: [],
      summary_only: [{ keys: [], severity: 'nit', path: 'src/c.rs', line: 7, title: 'raised in a thread', why: 'open-thread', thread_url: 'https://x/t9' }],
    }
  }
  if (ran([label]).length) return { findings: [] }
  throw new Error(`no answer for ${label}`)
}

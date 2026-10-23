// What a run spent, by stage and by model, and the Markdown report of a local
// review, which the engine writes where git never tracks it.

import { cell, fence, ICON, NAME } from './render.ts'
import type { Finding, Severity } from './schemas.ts'
import type { AgentUsage, SdkRuntime } from './runtime.ts'

const n = (x: number) => x.toLocaleString('en-US')
const usd = (x: number) => `$${x.toFixed(2)}`

/** One row per stage, then the total: agents, tokens, and the cost at API prices. */
export function usageTable(usage: AgentUsage[]): string {
  const stages = new Map<string, AgentUsage[]>()
  for (const u of usage) stages.set(u.stage, [...(stages.get(u.stage) || []), u])
  const row = (name: string, us: AgentUsage[]) => {
    const sum = (k: 'input' | 'output' | 'cache_read' | 'cache_write' | 'cost') => us.reduce((s, u) => s + u[k], 0)
    const failed = us.filter((u) => u.status !== 'ok').length
    return `| ${name} | ${us.length}${failed ? ` (${failed} failed)` : ''} | ${n(sum('input'))} | ${n(sum('cache_read'))} | ${n(sum('cache_write'))} | ${n(sum('output'))} | ${usd(sum('cost'))} |`
  }
  return [
    '| Stage | Agents | Input | Cache read | Cache write | Output | Cost |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...[...stages].map(([name, us]) => row(name, us)),
    row('**Total**', usage),
  ].join('\n')
}

export function modelTable(models: SdkRuntime['models']): string {
  return [
    '| Model | Input | Cache read | Cache write | Output | Cost |',
    '|---|---:|---:|---:|---:|---:|',
    ...Object.entries(models).map(([m, u]) => `| ${m} | ${n(u.input)} | ${n(u.cache_read)} | ${n(u.cache_write)} | ${n(u.output)} | ${usd(u.cost)} |`),
  ].join('\n')
}

export interface LocalResult {
  base: string
  intent: string
  overview: string
  verdict: string
  confidence: { score: number; reason: string } | null
  posts: Finding[]
  listed: (Partial<Finding> & { id?: string; note?: string })[]
  segments: { title: string; state: string; reason?: string }[]
}

const ORDER: Severity[] = ['important', 'nit', 'preexisting']
const STATE: Record<string, string> = { run: 'Ran', skipped: 'Did not apply', 'not-rerun': 'Not run again', failed: 'Failed: an agent did not finish' }

/** The findings, most severe first, as one line each for the terminal. */
export function terminalList(r: LocalResult): string[] {
  const all = [...r.posts, ...r.listed.filter((x) => x.path)] as Partial<Finding>[]
  all.sort((a, b) => ORDER.indexOf(a.severity as Severity) - ORDER.indexOf(b.severity as Severity))
  return all.map((f) => `${ICON[f.severity as Severity] || '-'} ${f.path}${f.line ? `:${f.line}` : ''}  ${f.title}`)
}

export function localReport(o: {
  branch: string
  head: string
  worktree: boolean
  started: Date
  result: LocalResult
  failed: string[]
  usage: AgentUsage[]
  models: SdkRuntime['models']
}): string {
  const r = o.result
  const scope = o.worktree ? `the working tree against \`${r.base.slice(0, 7)}\` (committed or not; HEAD was \`${o.head.slice(0, 7)}\`)` : `\`${r.base.slice(0, 7)}..${o.head.slice(0, 7)}\``
  const out = [`# Review of ${o.branch}`, '', `${scope}, ${o.started.toISOString().replace(/\.\d+Z$/, 'Z')}.`, '']
  if (o.failed.length) out.push(`> **Incomplete:** ${o.failed.join(', ')} did not finish.`, '')
  if (r.verdict) out.push(`**${r.verdict}**${r.confidence ? ` · confidence ${r.confidence.score}/5: ${r.confidence.reason}` : ''}`, '')
  out.push(r.overview, '')
  for (const severity of ORDER) {
    const posts = r.posts.filter((f) => f.severity === severity)
    if (!posts.length) continue
    out.push(`## ${ICON[severity]} ${NAME[severity]}`, '')
    for (const f of posts) {
      out.push(`### \`${f.path}:${f.line}\` ${f.title}`, '', f.body, '')
      if (f.places && f.places.length) out.push('Also at:', ...f.places.map((p) => `- \`${p}\``), '')
      if (f.rule) out.push(`Rule: ${f.rule}`, '')
      if (f.suggestion) {
        const text = f.suggestion.replace(/\n$/, '')
        out.push('Suggested:', fence(text), text, fence(text), '')
      }
      out.push('<details><summary>Why this was flagged</summary>', '', f.trace, '', '</details>', '')
    }
  }
  if (r.listed.length) {
    out.push('## Listed, not raised', '', '| | Location | Finding | Why |', '|---|---|---|---|')
    for (const x of r.listed) out.push(`| ${ICON[x.severity as Severity] || ''} | \`${x.path}${x.line ? `:${x.line}` : ''}\` | ${cell(x.title)} | ${cell(x.note || '')} |`)
    out.push('')
  }
  out.push('## Segments', '', '| Segment | State |', '|---|---|', ...r.segments.map((s) => `| ${s.title} | ${STATE[s.state] || s.state}${s.reason ? `: ${s.reason}` : ''} |`), '')
  out.push('## Tokens', '', usageTable(o.usage), '', modelTable(o.models), '', 'Costs are at API prices; on a Claude subscription they count against its usage limits instead.', '')
  return out.join('\n')
}

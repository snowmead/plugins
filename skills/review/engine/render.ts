// The Markdown the review posts: links, table cells, severity badges, the
// diagram, and each inline comment.

import type { Finding, Severity } from './schemas.ts'

// A review's severities show as badges, which GitHub loads from shields.io; a
// sweep's summary and a local report keep the icons.
export const NAME: Record<Severity, string> = { important: 'Important', nit: 'Nit', preexisting: 'Pre-existing' }
const COLOR: Record<Severity, string> = { important: 'cf222e', nit: 'bf8700', preexisting: '8250df' }
export const ICON: Record<Severity, string> = { important: '🔴', nit: '🟡', preexisting: '🟣' }

// plain=1 shows a rendered file, such as Markdown, as source, where line
// anchors work; other files ignore it.
export function link(repo: string | null | undefined, head: string, path: string, line: number): string {
  const loc = `${path}:${line}`
  return repo ? `[\`${loc}\`](https://github.com/${repo}/blob/${head}/${path}?plain=1#L${line})` : `\`${loc}\``
}

export function cell(text: unknown): string {
  return String(text).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

/** The badge of a severity, as an image; none for a severity not known. */
export function badge(severity: string | undefined): string {
  const name = NAME[severity as Severity]
  if (!name) return ''
  // shields.io reads a single dash as a separator and two as one dash.
  return `<img alt="${name}" src="https://img.shields.io/badge/${encodeURIComponent(name.replace(/-/g, '--'))}-${COLOR[severity as Severity]}?style=flat" align="top">`
}

/** The editor's Mermaid source without a fence it added; none when the source holds a fence of its own, which would end the diagram early. */
export function mermaid(diagram: string | undefined): string {
  const source = String(diagram || '')
    .trim()
    .replace(/^```(?:mermaid)?[ \t]*\n/, '')
    .replace(/\n?```$/, '')
    .trim()
  return source && !source.includes('```') ? source : ''
}

/** A code fence longer than any run of backticks in `text`, so no line of the text ends the block early. */
export function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Lines joined, with no two blank lines in a row and none at either end. */
export function lines(parts: string[]): string {
  return parts
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
    .trim()
}

/**
 * A comment on an anchor names the line the finding is about, `elsewhere`,
 * and shows its suggestion as plain code, which GitHub would otherwise apply
 * to the anchor.
 */
export function commentBody(p: Finding, meta: unknown, elsewhere?: string): string {
  const parts = [`${badge(p.severity)} **${p.title}**`, '']
  if (elsewhere) parts.push(`On ${elsewhere}, which this pull request does not change.`, '')
  parts.push(p.body)
  if (p.places && p.places.length) parts.push('', 'The same problem is also at:', ...p.places.map((x) => `- \`${x}\``))
  if (p.rule) parts.push('', `Rule: ${p.rule}`)
  if (p.suggestion) {
    const text = p.suggestion.replace(/\n$/, '')
    const f = fence(text)
    if (elsewhere) parts.push('', 'Suggested text for that line:', f, text, f)
    else parts.push('', `${f}suggestion`, text, f)
  }
  parts.push('', '<details><summary>Why this was flagged</summary>', '', p.trace, '', '</details>')
  // Escaped so no text in the marker can end the HTML comment early.
  parts.push('', `<!-- claude-review ${JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`)
  return parts.join('\n')
}

/**
 * A comment of this review as an agent reads it: the severity as a word in
 * place of its badge, and without the marker the job reads.
 */
export function readable(body: string): string {
  return body
    .replace(/<img alt="([^"]+)" src="https:\/\/img\.shields\.io\/[^"]*"[^>]*>/g, '[$1]')
    .replace(/\n*<!-- claude-review[\s\S]*?-->\s*$/, '')
    .trim()
}

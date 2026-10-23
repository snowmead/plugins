// GitHub for the tuning routine: GET requests to one repository's REST routes,
// with the engine's token, which no agent holds. The agents get a tool that
// reads one route; the engine reads lists across pages. Nothing here writes.

import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MAX_OUTPUT = 60_000
const MAX_PAGES = 10

export interface GitHub {
  /** The repository the routes must name, as owner/name. */
  repo: string
  token?: string
  /** The REST API's root (GITHUB_API_URL); https://api.github.com by default. */
  api?: string
}

// The search qualifiers that pick which repositories a search reads.
// A qualifier that names where a search looks, anywhere in its query:
// GitHub reads one inside parentheses or after a minus too.
const SCOPE = /(repo|org|user|owner):/gi
// GitHub's search reads AND, OR, NOT and parentheses as logic, so
// "repo:o/r OR is:private" searches beyond the repository.
const LOGIC = /[()]|(?:^|\s)(?:and|or|not)(?=\s|$)/i

/** Why the agents may not read `route`, or null when they may. */
export function routeRefusal(route: string, repo: string): string | null {
  const [path = '', query = ''] = route.replace(/^\//, '').split(/\?(.*)/s)
  if (/^[a-z]+:|^\/|\s|\.\.|\\|#/i.test(path) || /\s|#/.test(query)) return 'Give a route relative to the API root, such as repos/owner/name/pulls/5, with no spaces, and no ".." in its path.'
  // fetch reads %2e as a dot, so an escaped "..", or any escape, could leave the path.
  if (path.includes('%')) return 'Give the route\'s path without % escapes.'
  if (path === `repos/${repo}` || path.startsWith(`repos/${repo}/`)) return null
  if (path === 'search/issues') {
    const q = new URLSearchParams(query).getAll('q')
    const scopes = (q[0] || '').match(SCOPE) || []
    const terms = (q[0] || '').toLowerCase().split(/\s+/)
    if (q.length === 1 && scopes.length === 1 && !LOGIC.test(q[0]!) && terms.includes(`repo:${repo}`.toLowerCase())) return null
    return `A search must name repo:${repo} in one q, with no other repo:, org:, user: or owner:, and no AND, OR, NOT or parentheses.`
  }
  return `Only routes under repos/${repo}/, and search/issues with repo:${repo}, are read.`
}

interface Page {
  ok: boolean
  status: number
  body: string
  next: string | null
}

async function get(route: string, g: GitHub): Promise<Page> {
  const root = (g.api || 'https://api.github.com').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (g.token) headers.Authorization = `Bearer ${g.token}`
  try {
    const r = await fetch(`${root}/${route.replace(/^\//, '')}`, { headers, redirect: 'follow' })
    const link = r.headers.get('link') || ''
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1]
    return { ok: r.ok, status: r.status, body: await r.text(), next: next && next.startsWith(root) ? next.slice(root.length + 1) : null }
  } catch (e) {
    return { ok: false, status: 0, body: String((e as Error)?.message || e), next: null }
  }
}

/** The agents' read of one route: its JSON, cut to MAX_OUTPUT characters, and the route of the next page. */
export async function agentGet(route: string, g: GitHub): Promise<{ text: string; error: boolean }> {
  const why = routeRefusal(route, g.repo)
  if (why) return { text: `Refused: ${why}`, error: true }
  const page = await get(route, g)
  if (!page.ok) return { text: `GitHub answered ${page.status || 'nothing'}: ${page.body.slice(0, 2000)}`, error: true }
  let text = page.body
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n[cut at ${MAX_OUTPUT} characters: ask for fewer items with per_page, or one item]`
  if (page.next) text += `\n[next page: ${page.next}]`
  return { text, error: false }
}

/** The engine's read of `route`: its JSON, with every page of a list joined, up to MAX_PAGES; null when GitHub refuses. */
export async function readAll(route: string, g: GitHub): Promise<unknown> {
  let items: unknown[] | null = null
  let next: string | null = route
  for (let i = 0; next && i < MAX_PAGES; i += 1) {
    const page = await get(next, g)
    if (!page.ok) return null
    const value = JSON.parse(page.body)
    // A search answers with its items in an object.
    const list = Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : null
    if (!list) return value
    items = [...(items || []), ...list]
    next = page.next
  }
  return items
}

/** Writes `text` to `path`, which must be inside `dir`; why not, or null. */
export function writeInside(path: string, text: string, dir: string, cwd: string): string | null {
  const root = resolve(cwd, dir)
  const target = resolve(cwd, path)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return `Only files inside ${dir} are written.`
  try {
    // A link inside the directory can lead outside it, so no part of the path
    // may be one, checked before any directory is made.
    let at = root
    for (const part of rel.split(sep)) {
      at = join(at, part)
      let link = false
      try {
        link = lstatSync(at).isSymbolicLink()
      } catch {
        break
      }
      if (link) return `${path} goes through a link.`
    }
    mkdirSync(dirname(target), { recursive: true })
    const parent = relative(realpathSync(root), realpathSync(dirname(target)))
    if (parent.startsWith('..') || isAbsolute(parent)) return `${path} leads outside ${dir}.`
    writeFileSync(target, text)
    return null
  } catch (e) {
    return String((e as Error)?.message || e)
  }
}

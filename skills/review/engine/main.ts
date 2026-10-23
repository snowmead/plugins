// The engine's command line:
//
//   bun --no-env-file --cwd <skill> engine/main.ts <mode> [--repo <dir>] [options]
//
// Bun runs the bunfig.toml and loads the .env files of the directory it starts
// in, so it starts in the skill's directory, never in the repository under
// review, which --repo names (the directory it starts in by default).
//
//   local [--base <rev>] [--committed] [--note <text>]
//       Reviews this branch without a pull request: the files on disk against
//       the merge base with the default branch (or --base), or only the
//       commits with --committed. Prints the findings and writes a Markdown report under
//       the git directory (review/).
//   ci --args <file> --out <file> --events <file> [--read-dir <dir>]...
//       The action's run step: reviews the pull request the args name and
//       writes the record the result step reads.
//   tune --repo-name <owner/name> --since <date> --until <date> --out-dir <dir>
//       The tuning routine (engine/tuning.ts), with GitHub's token from
//       GH_TOKEN, GITHUB_TOKEN, or gh.
//   sweep|eval|names [--<arg> <value>]...
//       The other modes, with their args (engine/review.ts) as options.
//
// Any mode takes --<arg> <value> for an arg (a value that parses as JSON is
// read as JSON; --repo-name gives the arg repo), --args <file> for all of them,
// --out <file> for the result's JSON, and --concurrency <n>. A relative path
// in an option is read from the repository. GREPTILE_API_KEY turns on the knowledge base's
// tools, and REVIEW_CLAUDE names a Claude Code program to use instead of the
// one the Agent SDK ships.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { git } from './git.ts'
import { type GitHub, readAll } from './github.ts'
import { type LocalResult, localReport, modelTable, terminalList, usageTable } from './report.ts'
import { type Args, type Io, review } from './review.ts'
import { sdkRuntime } from './runtime.ts'
import { type TuningIo, tune } from './tuning.ts'

const SKILL_DIR = resolve(import.meta.dir, '..')
// Progress goes to stderr as plain text: Bun's console.error colors a terminal's
// lines red, which reads as an error.
const say = (m: string) => process.stderr.write(`${m}\n`)
const ENGINE_OPTIONS = ['repo', 'args', 'out', 'events', 'read-dir', 'concurrency', 'report', 'json', 'committed', 'note']

interface Cli {
  mode: string
  args: Args
  options: Record<string, string[]>
}

function parse(argv: string[]): Cli {
  const [mode = 'local', ...rest] = argv
  const options: Record<string, string[]> = {}
  const args: Args = {}
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!
    if (!flag.startsWith('--')) throw new Error(`unexpected argument ${flag}`)
    const name = flag.slice(2)
    const flagOnly = ['json', 'committed'].includes(name)
    const value = flagOnly ? 'true' : rest[++i]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (ENGINE_OPTIONS.includes(name)) (options[name] ??= []).push(value)
    else {
      // JSON for a number, an object or a list; a value such as the short
      // commit 1234e56, which reads as a number it does not spell, stays text.
      let parsed: unknown = value
      try {
        const json = JSON.parse(value)
        if (typeof json !== 'number' || String(json) === value) parsed = json
      } catch {}
      args[name.replace(/-/g, '_')] = parsed
    }
  }
  return { mode, args, options }
}

const one = (o: Cli['options'], name: string) => (o[name] ? o[name]![o[name]!.length - 1] : undefined)

async function main() {
  const cli = parse(Bun.argv.slice(2))
  const concurrency = Number(one(cli.options, 'concurrency') || 8)
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency needs a whole number of agents, 1 or more')
  const cwd = resolve(one(cli.options, 'repo') || process.cwd())
  const run = async (args: string[]) => {
    const r = await git(args, cwd)
    return r.ok ? r.out : null
  }
  const io: Io = {
    read(path) {
      try {
        return readFileSync(isAbsolute(path) ? path : join(cwd, path), 'utf8')
      } catch {
        return null
      }
    },
    git: run,
  }
  // Paths the options give are read from the repository, as Bun starts elsewhere.
  const path = (name: string) => {
    const p = one(cli.options, name)
    return p ? resolve(cwd, p) : undefined
  }
  const fileArgs = path('args')
  let args: Args = fileArgs ? JSON.parse(readFileSync(fileArgs, 'utf8')) : {}
  args = { ...args, ...cli.args }
  if (!['local', 'ci', 'review', 'sweep', 'eval', 'names', 'tune'].includes(cli.mode)) {
    throw new Error(`unknown mode ${cli.mode}: local, ci, review, sweep, eval, names, or tune`)
  }
  // The repository's name on GitHub is its own option, apart from --repo, the checkout.
  if (args.repo_name) {
    args.repo = args.repo_name
    delete args.repo_name
  }
  if (['sweep', 'eval', 'names'].includes(cli.mode)) args.mode = cli.mode

  // A repository without its own rules or settings follows the skill's.
  if (cli.mode !== 'ci') {
    if (!args.rules) args.rules = existsSync(join(cwd, 'REVIEW.md')) ? 'REVIEW.md' : join(SKILL_DIR, 'rules.md')
    if (args.config === undefined && !args.config_file && existsSync(join(cwd, '.claude/review.json'))) args.config_file = '.claude/review.json'
  }

  let branch = ''
  let started = new Date()
  if (cli.mode === 'local') {
    const head = (await run(['rev-parse', 'HEAD']))?.trim()
    if (!head) throw new Error('this is not a git repository with a commit')
    branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || 'HEAD'
    let base = args.base as string | undefined
    if (!base) {
      const remote = (await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim()
      const candidates = [remote, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean) as string[]
      for (const ref of candidates) {
        const mb = (await run(['merge-base', 'HEAD', ref]))?.trim()
        if (mb) {
          base = mb
          break
        }
      }
    } else {
      // The fork point, as for the default branch: against a base that moved
      // on, the files on disk would show its new commits reversed.
      const rev = (await run(['rev-parse', '--verify', `${base}^{commit}`]))?.trim() || String(base)
      base = (await run(['merge-base', 'HEAD', rev]))?.trim() || rev
    }
    if (!base) throw new Error('found no default branch to review against: give --base <rev>')
    const committed = Boolean(one(cli.options, 'committed'))
    const dirty = Boolean((await run(['status', '--porcelain', '--untracked-files=no']))?.trim())
    const log = (await run(['log', '--format=- %s%n%n%b', `${base}..${head}`]))?.trim() || ''
    const note = cli.options.note ? cli.options.note.join('\n') : ''
    args = {
      ...args,
      local: true,
      branch,
      base,
      head,
      worktree: !committed,
      checkout: !dirty,
      description: [note && `What the change is for: ${note}`, log ? `Commits:\n${log}` : 'No commits yet: the change is uncommitted.'].filter(Boolean).join('\n\n'),
    }
    if (base === head && committed) throw new Error(`HEAD is the base ${base.slice(0, 7)}, so there are no commits to review`)
    if (!one(cli.options, 'json')) say(`Reviewing ${branch}: ${committed ? 'its commits' : 'the files on disk'} against ${base.slice(0, 7)}.`)
  }

  const eventsFile = path('events')
  if (eventsFile) writeFileSync(eventsFile, '')
  // A local review says each agent as it ends, so a run of minutes shows its progress.
  const progress = cli.mode === 'local' && !one(cli.options, 'json')
  const emit = (event: Record<string, unknown>) => {
    if (eventsFile) appendFileSync(eventsFile, `${JSON.stringify(event)}\n`)
    if (progress && event.type === 'agent') {
      say(`${event.status === 'ok' ? '✓' : '✗'} ${event.label} (${Math.round(Number(event.ms) / 1000)} s)${event.status === 'ok' ? '' : `: ${event.status}`}`)
    }
  }
  const abort = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => abort.abort())
  let github: GitHub | undefined
  if (cli.mode === 'tune') {
    let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
    if (!token) {
      try {
        const p = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'ignore' })
        token = (await new Response(p.stdout).text()).trim()
      } catch {}
    }
    github = { repo: String(args.repo || ''), token: token || undefined, api: process.env.GITHUB_API_URL || undefined }
  }
  const rt = sdkRuntime({
    cwd,
    github,
    readDirs: (cli.options['read-dir'] || []).map((d) => resolve(cwd, d)),
    concurrency,
    greptileKey: process.env.GREPTILE_API_KEY || undefined,
    claudePath: process.env.REVIEW_CLAUDE || undefined,
    onEvent: emit,
    log: (m) => {
      say(m)
      emit({ type: 'log', message: m })
    },
    signal: abort.signal,
  })
  emit({ type: 'system', subtype: 'init', engine: 'review', mode: cli.mode, knowledge_base: rt.knowledgeBase })
  started = new Date()
  let result: Record<string, unknown>
  let error: string | null = null
  try {
    if (cli.mode === 'tune') {
      const tuningIo: TuningIo = {
        ...io,
        github: async (route) => readAll(route, github!),
        write(path, text) {
          const at = isAbsolute(path) ? path : join(cwd, path)
          mkdirSync(dirname(at), { recursive: true })
          writeFileSync(at, text)
        },
        async diff(a, b) {
          return (await git(['diff', '--no-index', '--no-color', '--', a, b], cwd)).out
        },
      }
      result = await tune(args, rt, tuningIo)
    } else result = await review(args, rt, io)
  } catch (e) {
    error = String((e as Error)?.message || e)
    result = { error }
  }
  const finished = new Date()
  const totalCost = rt.usage.reduce((s, u) => s + u.cost, 0)
  emit({
    type: 'result',
    subtype: error || result.error ? 'error_during_execution' : 'success',
    is_error: Boolean(error || result.error),
    terminal_reason: abort.signal.aborted ? 'stopped' : undefined,
    api_error_status: rt.limit.refused ? 429 : undefined,
    mcp_servers: Object.entries(rt.servers).map(([name, status]) => ({ name, status })),
    total_cost_usd: totalCost,
    modelUsage: Object.fromEntries(
      Object.entries(rt.models).map(([m, u]) => [
        m,
        { inputTokens: u.input, outputTokens: u.output, cacheReadInputTokens: u.cache_read, cacheCreationInputTokens: u.cache_write, costUSD: u.cost },
      ]),
    ),
  })
  const record = { result, agents: rt.usage, models: rt.models, started: started.toISOString(), finished: finished.toISOString(), ms: finished.getTime() - started.getTime() }
  const out = path('out')
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true })
    writeFileSync(out, `${JSON.stringify(cli.mode === 'ci' ? record : { ...result, usage: rt.usage, models: rt.models })}\n`)
  }

  if (cli.mode === 'local' && result.local && !one(cli.options, 'json')) {
    const local = result.local as LocalResult
    const reportPath =
      path('report') || join(resolve(cwd, (await run(['rev-parse', '--git-path', 'review']))?.trim() || '.git/review'), `${started.toISOString().replace(/[:.]/g, '-')}-${String(args.head).slice(0, 7)}.md`)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, localReport({ branch, head: String(args.head), worktree: Boolean(args.worktree), started, result: local, failed: (result.failed as string[]) || [], usage: rt.usage, models: rt.models }))
    const list = terminalList(local)
    console.log([local.verdict || 'Review finished.', ...(list.length ? list : ['No findings.']), '', `Report: ${reportPath}`].join('\n'))
  } else if (cli.mode !== 'ci') {
    if (!out || one(cli.options, 'json')) console.log(JSON.stringify(result, null, 2))
    if (rt.usage.length) say(`\n${usageTable(rt.usage)}\n\n${modelTable(rt.models)}`)
  }
  if (error) throw new Error(error)
  if (result.error && cli.mode !== 'ci') process.exitCode = 1
}

main().catch((e) => {
  console.error(`review: ${String((e as Error)?.message || e)}`)
  process.exit(1)
})

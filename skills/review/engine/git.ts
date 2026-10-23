// git for the engine and for its agents. The engine runs fixed commands (the
// diff, the changed files). The agents get one tool that runs a read-only git
// subcommand with the arguments they give, without a shell. In the action,
// the git first on PATH is the action's guard (src/guard.rs), which refuses
// every option that reads or writes a file outside the checkout or runs a
// command; the checks here are the same wall for a local run, where no guard
// stands in front of git.

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const SUBCOMMANDS = ['log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'merge-base', 'cat-file']

// Options that read or write a file outside the checkout, run a command, or
// point git at another repository. git takes any unambiguous prefix of a long
// option, so a prefix of one of these is refused too, unless it is an option
// of its own.
const REFUSED = [
  '--output',
  '--output-directory',
  '--no-index',
  '--contents',
  '--ignore-revs-file',
  '--ext-diff',
  '--textconv',
  '--open-files-in-pager',
  '--file',
  '--shallow-file',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--upload-pack',
  '--exec',
]
const OPTIONS_OF_THEIR_OWN = ['--text', '--ignore-rev', '--exit-code']
// Short options that take a file or run a command, by subcommand: grep's -O
// (pager) and -f (patterns from a file), blame's -S (revisions from a file).
const SHORT: Record<string, string> = { grep: 'Of', blame: 'S' }

export const MAX_OUTPUT = 30_000
const TIMEOUT_MS = 60_000

/** Why `args` (without "git") may not run, or null when they may. */
export function refusal(args: string[], cwd: string): string | null {
  const [sub, ...rest] = args
  if (!sub || !SUBCOMMANDS.includes(sub)) return `git ${sub ?? ''} is not one of ${SUBCOMMANDS.join(', ')}; give the subcommand first, with no option before it.`
  let paths = false
  for (const arg of rest) {
    if (arg === '--') {
      paths = true
      continue
    }
    if (!paths && arg.startsWith('--')) {
      const name = arg.split('=')[0]!
      const hit = REFUSED.find((r) => r === name || (name.length > 3 && r.startsWith(name) && !OPTIONS_OF_THEIR_OWN.includes(name)))
      if (hit) return `${hit} is refused: it reads or writes a file outside the checkout, or runs a command.`
    } else if (!paths && arg.startsWith('-') && arg.length > 1 && SHORT[sub]) {
      // blame's -L takes the rest of its cluster as a range (-L/Struct/,+5).
      const cluster = sub === 'blame' ? arg.slice(1).split('L')[0]! : arg.slice(1)
      const bad = [...SHORT[sub]!].find((ch) => cluster.includes(ch))
      if (bad) {
        return `git ${sub} -${bad} is refused: it reads a file or runs a command. To search for text that starts with -, write that - as [-] in a pattern (git grep -e '[-]-output').`
      }
    }
    // diff compares two files outside a repository when a path leads out of
    // it, as --no-index does.
    if (sub === 'diff' && !arg.startsWith('-') && !arg.includes('...') && outside(arg, cwd)) {
      return `${arg} leads outside the checkout. Attach a value that starts with / or holds .. to its option (git diff -S/api/).`
    }
  }
  return null
}

function outside(arg: string, cwd: string): boolean {
  const path = arg.replace(/^:\([^)]*\)/, '').replace(/^:\/?/, '')
  if (!isAbsolute(path) && !path.split('/').includes('..')) {
    // A symlink the change adds can lead outside.
    try {
      const real = realpathSync(resolve(cwd, path))
      const rel = relative(realpathSync(cwd), real)
      return rel.startsWith('..') || isAbsolute(rel)
    } catch {
      return false
    }
  }
  const rel = relative(cwd, resolve(cwd, path))
  return rel.startsWith('..') || isAbsolute(rel)
}

/** The environment git runs in: no credentials, no pager, no prompt. */
export function gitEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
  const env: Record<string, string> = {}
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]!
  return { ...env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
}

// Off for every command: a bare repository git finds on its own, and a
// filesystem monitor that a repository's config names.
const SAFE = ['-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false']

export interface Ran {
  ok: boolean
  out: string
  err: string
}

/** git with `args` in `cwd`; never throws. */
export async function git(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<Ran> {
  try {
    const p = Bun.spawn(['git', ...SAFE, ...args], { cwd, env: gitEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { ok: code === 0, out, err }
  } catch (e) {
    return { ok: false, out: '', err: String(e) }
  }
}

/** The agents' git: the text they get back, cut to MAX_OUTPUT characters. */
export async function agentGit(args: string[], cwd: string): Promise<{ text: string; error: boolean }> {
  const why = refusal(args, cwd)
  if (why) return { text: `Refused: ${why}`, error: true }
  const r = await git(args, cwd)
  let text = r.ok ? r.out : `git exited with an error.\n${r.err}${r.out}`
  if (!text.trim()) text = r.ok ? '(no output)' : text
  if (text.length > MAX_OUTPUT) {
    text = `${text.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters: narrow the command, with a path, a range, or -n]`
  }
  return { text, error: !r.ok }
}

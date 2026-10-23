// The runtime the pipeline's agents run on: one Claude Code process per agent
// through the Agent SDK, each with its own system prompt, tools, answer schema,
// and turn limit, and nothing from the repository's own Claude Code settings.
// It counts each agent's tokens, keeps at most `concurrency` agents running,
// and starts the first agent of each shared prompt alone, so the others read
// that prompt from the cache instead of each writing it.

import { type McpServerConfig, type Options, type SDKMessage, createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { agentGit } from './git.ts'
import { type GitHub, agentGet, writeInside } from './github.ts'
import type { AgentCall, Runtime } from './review.ts'
import type { StageName } from './settings.ts'

/** One agent's account. */
export interface AgentUsage {
  label: string
  phase: string
  stage: StageName
  model: string
  /** "ok", or how the agent failed. */
  status: string
  turns: number
  ms: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost: number
}

export interface SdkRuntimeOptions {
  /** The checkout the agents read. */
  cwd: string
  /** Other directories the agents may read, such as the action's review directory. */
  readDirs?: string[]
  /** How many agents run at once. */
  concurrency?: number
  /** Greptile's API key, for the knowledge base's read tools and, in tuning, its comment read tools. */
  greptileKey?: string
  /** The repository the tuning routine's agents read on GitHub, with the engine's token. */
  github?: GitHub
  /** The Claude Code program; the SDK's own when absent. */
  claudePath?: string
  /** Each event of the run, for the action's events file. */
  onEvent?: (event: Record<string, unknown>) => void
  log?: (message: string) => void
  signal?: AbortSignal
  /** The Agent SDK's query; tests pass their own. */
  query?: typeof query
}

// Turn limits, well above what a normal agent of each stage takes, so they stop
// only an agent that loops.
export const MAX_TURNS: Record<StageName, number> = { context: 60, scope: 60, finder: 80, skeptic: 50, followup: 40, editor: 30, judge: 6, tuner: 120 }
// How long the agents of a shared prompt wait for the first one to start.
const PRIME_WAIT_MS = 30_000

const GREPTILE = 'https://api.greptile.com/mcp'
const KNOWLEDGE_TOOLS = ['list_knowledge_bases', 'list_knowledge_base_documents', 'get_knowledge_base_document', 'search_knowledge_base']
const COMMENT_TOOLS = ['list_merge_request_comments', 'search_greptile_comments']
// The environment the agents' processes get, by name: the system's basics,
// proxies and certificates, and Claude Code's own settings and credential.
// Nothing else of the job's reaches them: no GitHub token, no Greptile key
// (which goes in the MCP config instead), and no other secret.
const ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'TERM',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'MAX_THINKING_TOKENS', 'MAX_MCP_OUTPUT_TOKENS', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT', 'API_TIMEOUT_MS', 'USE_BUILTIN_RIPGREP',
])
const ENV_PREFIXES = ['LC_', 'ANTHROPIC_', 'CLAUDE_', 'DISABLE_']
// A cloud provider's credentials, only when Claude Code is set to use it.
const PROVIDERS: [string, RegExp][] = [
  ['CLAUDE_CODE_USE_BEDROCK', /^AWS_/],
  ['CLAUDE_CODE_USE_VERTEX', /^(GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|CLOUD_ML_REGION|VERTEX_REGION_)/],
]

/** The agents' environment from `source`: only the names above. */
export function agentEnv(source: Record<string, string | undefined>): Record<string, string> {
  const truthy = (v?: string) => Boolean(v && v !== '0' && v.toLowerCase() !== 'false')
  const providers = PROVIDERS.filter(([flag]) => truthy(source[flag])).map(([, names]) => names)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (ENV_NAMES.has(upper) || ENV_PREFIXES.some((p) => upper.startsWith(p)) || providers.some((names) => names.test(upper))) env[name] = value
  }
  return env
}

/** The tools an agent gets: Claude Code's own, and the names it may call. */
export function agentTools(call: Pick<AgentCall, 'tools' | 'knowledgeBase' | 'github'>, has: { github: boolean; knowledgeBase: boolean }) {
  const reading = call.tools === 'read'
  const allowed: string[] = []
  if (reading) {
    allowed.push('mcp__review__git')
    if (call.github && has.github) allowed.push('mcp__review__github')
    if (call.github?.write) allowed.push('mcp__review__write_file')
  }
  const greptile = has.knowledgeBase ? [...(reading && call.knowledgeBase ? KNOWLEDGE_TOOLS : []), ...(reading && call.github ? COMMENT_TOOLS : [])] : []
  allowed.push(...greptile.map((t) => `mcp__greptile__${t}`))
  return { builtin: reading ? ['Read', 'Grep', 'Glob'] : [], allowed, greptile }
}

class Slots {
  private free: number
  private queue: (() => void)[] = []
  constructor(n: number) {
    this.free = n
  }
  async take() {
    if (this.free > 0) {
      this.free -= 1
      return
    }
    await new Promise<void>((r) => this.queue.push(r))
  }
  give() {
    const next = this.queue.shift()
    if (next) next()
    else this.free += 1
  }
}

export interface SdkRuntime extends Runtime {
  usage: AgentUsage[]
  /** The tokens of every model the agents called, background calls included. */
  models: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cost: number }>
  /** The last rate limit event, and whether an agent was refused for the usage limit. */
  limit: { info: Record<string, unknown> | null; refused: boolean }
  /** Each MCP server's status as the agents' sessions started: connected when any agent connected to it. */
  servers: Record<string, string>
}

export function sdkRuntime(o: SdkRuntimeOptions): SdkRuntime {
  const slots = new Slots(o.concurrency ?? 8)
  const primed = new Map<string, Promise<void>>()
  const emit = o.onEvent ?? (() => {})
  const run = o.query ?? query
  const env = agentEnv(process.env)
  // Every tool loads up front, so none hides behind a search tool the agents do not have.
  env.ENABLE_TOOL_SEARCH = 'false'
  // No instructions the agents cannot use (git's, for commits; CLAUDE.md
  // files; memory), and no background model calls: measured, these cut a
  // request's prompt from about 10,400 tokens to 3,700.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1'
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'review'

  // One server per agent: an SDK server serves one Claude Code process at a time.
  const reviewServer = (github: AgentCall['github']) => {
    const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = [
      tool(
        'git',
        'Runs one read-only git command in the repository root and returns its output. Give the arguments without "git", subcommand first: log, show, diff, blame, grep, ls-files, ls-tree, rev-parse, rev-list, merge-base, or cat-file.',
        { args: z.array(z.string()).min(1).describe('The arguments after "git", such as ["grep", "-n", "pattern", "HEAD", "--", "src"]') },
        async ({ args }) => {
          const r = await agentGit(args, o.cwd)
          return { content: [{ type: 'text' as const, text: r.text }], isError: r.error }
        },
        { annotations: { readOnlyHint: true } },
      ),
    ]
    if (github && o.github) {
      const gh = o.github
      tools.push(
        tool(
          'github',
          `Reads one GitHub REST route of ${gh.repo} (a GET) and returns its JSON, such as repos/${gh.repo}/pulls/5/comments?per_page=100, or search/issues?q=repo:${gh.repo}+is:pr. A list says the route of its next page.`,
          { route: z.string().min(1).describe(`The route after the API root, under repos/${gh.repo}/`) },
          async ({ route }) => {
            const r = await agentGet(route, gh)
            return { content: [{ type: 'text' as const, text: r.text }], isError: r.error }
          },
          { annotations: { readOnlyHint: true } },
        ),
      )
    }
    if (github?.write) {
      const dir = github.write
      tools.push(
        tool(
          'write_file',
          `Writes a whole file inside ${dir}, creating its directories; nothing outside it.`,
          { path: z.string().min(1).describe(`The file's path, inside ${dir}`), text: z.string().describe('The whole text of the file') },
          async ({ path, text }) => {
            const why = writeInside(path, text, dir, o.cwd)
            return { content: [{ type: 'text' as const, text: why ? `Refused: ${why}` : `Wrote ${path}.` }], isError: Boolean(why) }
          },
        ),
      )
    }
    return createSdkMcpServer({ name: 'review', tools })
  }
  const knowledgeBase: McpServerConfig | null = o.greptileKey
    ? { type: 'http', url: GREPTILE, headers: { Authorization: `Bearer ${o.greptileKey}` } }
    : null

  const rt: SdkRuntime = {
    usage: [],
    models: {},
    limit: { info: null, refused: false },
    servers: {},
    knowledgeBase: Boolean(knowledgeBase),
    log: o.log ?? ((m) => console.error(m)),
    async agent(call: AgentCall) {
      const key = `${call.model}\0${call.tools}\0${call.knowledgeBase ? 1 : 0}\0${call.github ? `gh${call.github.write || ''}` : ''}\0${call.system}`
      let ready: (() => void) | null = null
      const first = !primed.has(key)
      if (first) primed.set(key, new Promise<void>((r) => (ready = r)))
      else if (!o.signal?.aborted) await Promise.race([primed.get(key), new Promise((r) => setTimeout(r, PRIME_WAIT_MS))])
      const prime = () => {
        if (ready) ready()
        ready = null
      }
      await slots.take()
      const started = Date.now()
      const account: AgentUsage = {
        label: call.label,
        phase: call.phase,
        stage: call.stage,
        model: call.model,
        status: 'ok',
        turns: 0,
        ms: 0,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cost: 0,
      }
      const { builtin, allowed, greptile } = agentTools(call, { github: Boolean(o.github), knowledgeBase: Boolean(knowledgeBase) })
      const servers: Record<string, McpServerConfig> = {}
      if (call.tools === 'read') servers.review = reviewServer(call.github)
      if (greptile.length && knowledgeBase) {
        servers.greptile = { ...knowledgeBase, tools: greptile.map((name) => ({ name, permission_policy: 'always_allow' as const })) }
      }
      const abort = new AbortController()
      const stop = () => abort.abort()
      o.signal?.addEventListener('abort', stop)
      // A signal fires once: an agent that starts after it stops at once.
      if (o.signal?.aborted) stop()
      const options: Options = {
        systemPrompt: call.system,
        tools: builtin,
        allowedTools: allowed,
        mcpServers: servers,
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        permissionMode: 'dontAsk',
        model: call.model,
        effort: call.effort,
        maxTurns: MAX_TURNS[call.stage],
        cwd: o.cwd,
        additionalDirectories: o.readDirs ?? [],
        env,
        outputFormat: { type: 'json_schema', schema: call.schema },
        includePartialMessages: true,
        abortController: abort,
        ...(o.claudePath ? { pathToClaudeCodeExecutable: o.claudePath } : {}),
      }
      let answer: unknown = null
      try {
        if (abort.signal.aborted) throw new Error('stopped')
        for await (const m of run({ prompt: call.prompt, options }) as AsyncIterable<SDKMessage>) {
          if (m.type === 'stream_event' || m.type === 'assistant') prime()
          if (m.type === 'system' && m.subtype === 'init') {
            for (const s of m.mcp_servers) if (rt.servers[s.name] !== 'connected') rt.servers[s.name] = s.status
          }
          if (m.type === 'rate_limit_event') {
            rt.limit.info = m.rate_limit_info as Record<string, unknown>
            emit({ type: 'rate_limit_event', rate_limit_info: m.rate_limit_info })
          }
          if (m.type !== 'result') continue
          account.turns = m.num_turns
          account.cost = m.total_cost_usd || 0
          for (const [model, u] of Object.entries(m.modelUsage || {})) {
            account.input += u.inputTokens
            account.output += u.outputTokens
            account.cache_read += u.cacheReadInputTokens
            account.cache_write += u.cacheCreationInputTokens
            const total = (rt.models[model] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 })
            total.input += u.inputTokens
            total.output += u.outputTokens
            total.cache_read += u.cacheReadInputTokens
            total.cache_write += u.cacheCreationInputTokens
            total.cost += u.costUSD
          }
          for (const d of m.permission_denials || []) {
            emit({ type: 'system', subtype: 'permission_denied', agent: call.label, tool_name: d.tool_name, tool_use_id: d.tool_use_id, tool_input: d.tool_input })
          }
          if ((m as { api_error_status?: number }).api_error_status === 429) rt.limit.refused = true
          if (m.subtype === 'success' && m.structured_output && typeof m.structured_output === 'object') answer = m.structured_output
          else account.status = m.subtype === 'success' ? 'no structured answer' : m.subtype
        }
      } catch (e) {
        account.status = abort.signal.aborted ? 'stopped' : `error: ${String((e as Error)?.message || e).split('\n')[0]}`
      } finally {
        prime()
        o.signal?.removeEventListener('abort', stop)
        slots.give()
      }
      if (answer === null && account.status === 'ok') account.status = 'no result'
      account.ms = Date.now() - started
      rt.usage.push(account)
      emit({ type: 'agent', ...account })
      if (answer === null) rt.log(`${call.label}: ${account.status}`)
      return answer
    },
  }
  return rt
}

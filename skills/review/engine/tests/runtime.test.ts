// The runtime's guards, without a model: the environment and the tools each
// agent gets, and an agent that starts after the run was stopped.

import { expect, test } from 'bun:test'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentCall } from '../review.ts'
import { type AgentUsage, agentEnv, agentTools, sdkRuntime } from '../runtime.ts'

const CALL: AgentCall = { label: 'a', phase: 'Segments', stage: 'finder', model: 'm', effort: 'low', system: 's', prompt: 'p', schema: { type: 'object' }, tools: 'read' }

test('the agents get the basics and the Claude credential, and no other secret', () => {
  const job = {
    PATH: '/bin',
    HOME: '/h',
    LC_ALL: 'C',
    https_proxy: 'http://proxy',
    NODE_EXTRA_CA_CERTS: '/ca.pem',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'key',
    DISABLE_TELEMETRY: '1',
    GH_TOKEN: 'gh',
    GITHUB_TOKEN: 'gh',
    GREPTILE_API_KEY: 'greptile',
    ACTIONS_RUNTIME_TOKEN: 'actions',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
    NPM_TOKEN: 'npm',
    AWS_SECRET_ACCESS_KEY: 'aws',
    GOOGLE_APPLICATION_CREDENTIALS: '/gcp.json',
  }
  expect(Object.keys(agentEnv(job)).sort()).toEqual(
    ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_TELEMETRY', 'HOME', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'PATH', 'https_proxy'].sort(),
  )
  // A cloud provider's credentials only when Claude Code uses it.
  expect(agentEnv({ ...job, CLAUDE_CODE_USE_BEDROCK: '1' }).AWS_SECRET_ACCESS_KEY).toBe('aws')
  expect(agentEnv({ ...job, CLAUDE_CODE_USE_BEDROCK: '0' }).AWS_SECRET_ACCESS_KEY).toBeUndefined()
  expect(agentEnv({ ...job, CLAUDE_CODE_USE_VERTEX: 'true' }).GOOGLE_APPLICATION_CREDENTIALS).toBe('/gcp.json')
  expect(agentEnv({ ...job, CLAUDE_CODE_USE_VERTEX: 'true' }).NPM_TOKEN).toBeUndefined()
})

test('an agent reads, and only the tuning draft writes', () => {
  const none = { github: false, knowledgeBase: false }
  expect(agentTools(CALL, none)).toEqual({ builtin: ['Read', 'Grep', 'Glob'], allowed: ['mcp__review__git'], greptile: [] })
  expect(agentTools({ ...CALL, tools: 'none' }, { github: true, knowledgeBase: true })).toEqual({ builtin: [], allowed: [], greptile: [] })
  // GitHub only for a tuning call, with the engine's GitHub set up.
  expect(agentTools({ ...CALL, github: {} }, none).allowed).toEqual(['mcp__review__git'])
  expect(agentTools({ ...CALL, github: {} }, { github: true, knowledgeBase: false }).allowed).toEqual(['mcp__review__git', 'mcp__review__github'])
  expect(agentTools({ ...CALL, github: { write: 'o' } }, { github: true, knowledgeBase: false }).allowed).toEqual([
    'mcp__review__git',
    'mcp__review__github',
    'mcp__review__write_file',
  ])
  // The knowledge base's read tools only with its key.
  expect(agentTools({ ...CALL, knowledgeBase: true }, none).greptile).toEqual([])
  const kb = agentTools({ ...CALL, knowledgeBase: true }, { github: false, knowledgeBase: true })
  expect(kb.greptile).toContain('search_knowledge_base')
  expect(kb.allowed).toContain('mcp__greptile__search_knowledge_base')
  expect(kb.allowed.some((t) => t.includes('write'))).toBe(false)
})

test("the runtime hands the agent those tools and that environment, and an agent after a stop doesn't run", async () => {
  const seen: Options[] = []
  const query = ((q: { options: Options }) => {
    seen.push(q.options)
    return (async function* () {
      yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, modelUsage: {}, structured_output: { ok: true } }
    })()
  }) as never
  const saved = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'gh'
  const stop = new AbortController()
  try {
    const rt = sdkRuntime({ cwd: '/r', query, signal: stop.signal, log: () => {} })
    expect(await rt.agent(CALL)).toEqual({ ok: true })
    expect(seen[0]!.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(seen[0]!.allowedTools).toEqual(['mcp__review__git'])
    expect(seen[0]!.env!.GH_TOKEN).toBeUndefined()
    expect(seen[0]!.permissionMode).toBe('dontAsk')
    expect(seen[0]!.settingSources).toEqual([])
    stop.abort()
    expect(await rt.agent({ ...CALL, label: 'b' })).toBeNull()
    expect(seen.length).toBe(1)
    expect((rt.usage as AgentUsage[]).map((u) => [u.label, u.status])).toEqual([
      ['a', 'ok'],
      ['b', 'stopped'],
    ])
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved
  }
})

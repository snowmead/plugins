// The engine's own logic, run with every agent answered by a stub: the
// settings, which segments a push reviews again, what the skeptics keep, what
// the summary carries over, the sweep, the eval's cap, quiet cases, and failed
// replays. The action's Rust tests run the engine too, for what passes between
// it and the job (src/post.rs).
//
// REVIEW_CONFIG names a repository's settings file whose "examples" to check:
// each lists the files a pull request changes and the segments that review it.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { diffText, firstComment } from '../review.ts'
import { refusal } from '../git.ts'
import { commentBody, fence } from '../render.ts'
import { CONFIG, SEGMENTS, SHA, ran, review, run, thread } from './harness.ts'

const BASE = { pr: 5, repo: 'o/r', threads: '/t.json', config: CONFIG, base: SHA('b'), head: SHA('h'), checkout: true }
// What the job adds to its answer in a disputed thread.
const DISPUTED = '**Disputed:** this finding blocks the merge and the reason given does not hold, so a person decides: fix it, or resolve this thread to keep the code as it is.'
// The badge an Important finding shows, in its comment and its issue row.
const IMPORTANT = '<img alt="Important" src="https://img.shields.io/badge/Important-cf222e?style=flat" align="top">'
const hex = (n: number) => n.toString(16).padStart(40, '0')
const threads = (...ts: unknown[]) => ({ files: { '/t.json': JSON.stringify(ts) } })

/** A skeptic's answer: one verdict, or one per finding when the skeptic checks several at one place. */
function verdict(prompt: string, v: Record<string, unknown> | ((finding: string) => Record<string, unknown> | null)) {
  const numbered = prompt.split('\n').filter((l) => /^\d+\. \{/.test(l))
  const of = (text: string) => (typeof v === 'function' ? v(text) : v)
  if (!numbered.length) return of(prompt.split('reported this finding:\n').pop() || '')
  return { verdicts: numbered.map((l, i) => ({ finding: i + 1, ...(of(l) || {}) })).filter((x) => 'verdict' in x) }
}

test('a later push reviews again only the segments its new commits touch', async () => {
  for (const [changedSince, expected] of [
    [undefined, SEGMENTS],
    [['README.md'], ['docs']],
    // The rules agents and the review follow.
    [['AGENTS.md'], ['security', 'design', 'docs']],
    [['REVIEW.md'], ['security', 'design', 'docs']],
    // A skill, and each link an agent reads it through.
    [['.agents/skills/x/SKILL.md'], ['security', 'design', 'docs']],
    [['.claude/skills/x'], ['security', 'design', 'docs']],
    [['.codex/skills/x'], ['security', 'design', 'docs']],
    [['web/x.tsx'], ['bugs', 'security', 'tests', 'design', 'docs', 'web']],
    // Generated and prose files under web/ are not web code.
    [['web/src/api.gen.ts', 'web/README.md'], ['docs']],
    [['deps.lock', 'plugins-lock.json'], ['docs']],
    // A prompt is code, though it is text.
    [['src/prompts/summary_prompt.txt'], ['bugs', 'security', 'tests', 'design', 'docs']],
    [['migrations/0001_init.sql'], ['bugs', 'security', 'tests', 'design', 'docs', 'rust']],
    [['crates/client/Cargo.toml'], ['bugs', 'security', 'tests', 'design', 'docs', 'rust']],
    [['assets/logo.svg'], ['docs']],
    // Patterns match a path in any case.
    [['docs-site/README.MD', 'assets/LOGO.PNG'], ['docs']],
  ] as [string[] | undefined, string[]][]) {
    const args: Record<string, unknown> = { ...BASE }
    if (changedSince) Object.assign(args, { since: SHA('a'), reviewed: SHA('a'), changed_since: changedSince })
    // The args as the job writes them to args.json, before the run.
    const written = structuredClone(args)
    const { labels, result } = await run(args, review)
    expect(ran(labels)).toEqual(expected)
    // The job posts only a review whose args match its own.
    expect(result.args).toEqual(written)
  }
})

test('each stage runs on its model and effort: the defaults, the settings, then the segment', async () => {
  const { calls } = await run(BASE, review, threads(thread('T1')))
  const on = (label: string) => [calls[label]!.model, calls[label]!.effort]
  expect(on('context')).toEqual(['claude-sonnet-5-5', 'high'])
  expect(on('bugs 1.1')).toEqual(['claude-sonnet-5-5', 'high'])
  // A missed security finding costs the most, so its finder keeps Opus.
  expect(on('security')).toEqual(['claude-opus-5-5', 'high'])
  // The settings' web segment takes Haiku for its finder, at the finders' effort.
  expect(on('web')).toEqual(['claude-haiku-5-5', 'high'])
  // The settings lower the editor's effort and keep its model.
  expect(on('editor')).toEqual(['claude-sonnet-5-5', 'medium'])
  // The follow-up answers people in its threads, so it reasons at high effort.
  expect(on('follow-up')).toEqual(['claude-sonnet-5-5', 'high'])
  // The judge reads only text, so it gets no tools; the others read the checkout.
  expect(calls.context!.tools).toBe('read')
})

test('every agent of a stage shares one system prompt, and only the lens, area, or finding differs', async () => {
  const finding = (line: number) => ({ path: 'src/a.rs', line, severity: 'nit', title: `t${line}`, body: 'b', trace: 't' })
  const { calls } = await run(BASE, (label, prompt) => {
    if (label === 'bugs 1.1') return { findings: [finding(3)] }
    if (label === 'design') return { findings: [finding(4)] }
    if (label.startsWith('verify ')) return verdict(prompt, { verdict: 'confirmed', severity: 'nit', reason: 'r', security_or_privacy: false })
    return review(label)
  })
  const finders = ['bugs 1.1', 'bugs 2.2', 'security', 'tests', 'design', 'docs', 'rust', 'web'].map((l) => calls[l]!.system)
  expect(new Set(finders).size).toBe(1)
  expect(calls['bugs 1.1']!.prompt).toStartWith('You are the Bugs reviewer')
  expect(calls['verify bugs src/a.rs:3']!.system).toBe(calls['verify design src/a.rs:4']!.system)
  expect(calls['verify bugs src/a.rs:3']!.prompt).toContain('"title":"t3"')
  // The rules sections the stage reads are in the shared prompt, and the follow-up's are not.
  expect(finders[0]).toContain('## Never report')
  expect(finders[0]).not.toContain('## Later reviews')
})

test('settings merge over the defaults: a segment can change, stop, or join', async () => {
  const config = {
    segments: [
      { name: 'bugs', passes: 1 },
      { name: 'tests', enabled: false },
      { name: 'infra', title: 'Infrastructure', files: ['.github/**', '**/*.tf'], note: 'Check the runners.' },
    ],
  }
  const { labels, prompts } = await run({ ...BASE, config, changed: ['src/a.rs', '.github/ci.yml'] }, (label) => (label === 'infra' ? { findings: [] } : review(label)))
  expect(ran(labels, ['bugs', 'security', 'tests', 'design', 'docs', 'infra'])).toEqual(['bugs', 'security', 'design', 'docs', 'infra'])
  // One pass, so one bugs agent over the whole change.
  expect(labels.includes('bugs') && !labels.some((l) => l.startsWith('bugs '))).toBe(true)
  expect(prompts.infra).toContain('You are the Infrastructure reviewer')
  expect(prompts.infra).toContain('Check the runners.')
  // Without settings for the knowledge base, the default reads it with its tools.
  expect(prompts.context).toContain("Read Greptile's knowledge base for the changed paths: Use the knowledge base tools you have.")
  // The names mode, which the tuning routine reads, lists the segments the settings run.
  const names = await run({ mode: 'names', config }, () => {
    throw new Error('an agent in names mode')
  })
  expect(names.result.segments).toEqual(['bugs', 'security', 'design', 'docs', 'infra'])
})

test('the knowledge base is read through the steps of the skill the settings name, or not at all', async () => {
  const keep = (label: string) => (label === 'context' ? { ...(review('context') as object), knowledge_base_read: false } : review(label))
  const skill = { files: { '.claude/skills/docs-index/SKILL.md': '---\nname: docs-index\n---\n\n# Docs index\n\n1. Call list_knowledge_bases.' } }
  const named = await run(BASE, keep, skill)
  expect(named.prompts.context).toContain("Read the knowledge base for the changed paths: Follow the docs-index skill's steps")
  expect(named.prompts.context).toContain('1. Call list_knowledge_bases.')
  expect(named.prompts.context).not.toContain('name: docs-index')
  expect(named.calls.context!.knowledgeBase).toBe(true)
  expect(named.result.summary.bottom).toContain('the knowledge base was not read, so this review read only the repository.')
  // Without its tools connected, no agent is asked to read it.
  const unplugged = await run(BASE, review, { ...skill, knowledgeBase: false })
  expect(unplugged.prompts.context).not.toContain('knowledge base for')
  expect(unplugged.result.summary.bottom).toContain('the knowledge base was not read')
  const off = await run({ ...BASE, config: { ...CONFIG, knowledge_base: false } }, keep, skill)
  expect(off.prompts.context).not.toContain('knowledge base for')
  expect(off.result.summary.bottom).not.toContain('was not read')
})

test('settings that are not valid stop the review before any agent, and say what is wrong', async () => {
  for (const [config, message] of [
    [[], 'they are not a JSON object'],
    [null, 'they are not a JSON object'],
    [{ models: {} }, 'models is not a setting'],
    [{ agents: { reviewer: { model: 'm' } } }, 'agents names reviewer'],
    [{ agents: { editor: { effort: 'huge' } } }, 'agents.editor.effort is "huge"'],
    [{ classes: { code: ['**'] } }, 'code is built in'],
    [{ classes: { prose: '**/*.md' } }, 'classes.prose is not a list of patterns'],
    [{ segments: [{ name: 'Infra', files: ['**'] }] }, 'no name of lowercase letters'],
    [{ segments: [{ name: 'infra' }] }, 'segment infra is new, so it needs files'],
    [{ segments: [{ name: 'bugs', passes: 3 }] }, "segment bugs's passes is 3"],
    [{ segments: [{ name: 'bugs', sweep_note: 3 }] }, "segment bugs's sweep_note is not text"],
    [{ segments: [{ name: 'bugs', title: 5 }] }, "segment bugs's title is not text"],
    [{ classes: { prose: ['@nope'] } }, 'classes.prose names the class @nope'],
    [{ classes: { prose: ['@toString'] } }, 'classes.prose names the class @toString'],
    [{ segments: [{ name: 'infra', files: ['@constructor'] }] }, 'segment infra names the class @constructor'],
    [{ knowledge_base: true }, 'knowledge_base is not {name, skill} or false'],
    [{ knowledge_base: { name: 5 } }, 'knowledge_base is not {name, skill} or false'],
    [{ sweep: [] }, 'sweep is not an object'],
    [{ segments: [{ name: 'bugs', enabled: 'no' }] }, "segment bugs's enabled is \"no\"; it is true or false"],
    [{ segments: [{ name: 'bugs', always: 1 }] }, "segment bugs's always is 1; it is true or false"],
    [{ segments: [{ name: 'bugs', keep_unverified: 'yes' }] }, "segment bugs's keep_unverified is \"yes\"; it is true or false"],
    [{ classes: { prose: ['docs/{a,b'] } }, 'classes.prose has the pattern "docs/{a,b", which is not valid: a { has no }'],
    [{ segments: [{ name: 'infra', files: ['!src/{x'] }] }, `segment infra's files has the pattern "!src/{x", which is not valid`],
    [{ segments: [{ name: 'bugs', when: 'always' }] }, 'segment bugs sets when'],
    [{ segments: [{ name: 'bugs', agents: { editor: { effort: 'low' } } }] }, 'editor, which is not one of finder, skeptic'],
    [{ segments: [{ name: 'infra', files: ['@infra'] }] }, 'names the class @infra'],
    [{ sweep: { max_areas: 0 } }, 'sweep.max_areas is not a positive whole number'],
  ] as [unknown, string][]) {
    const { result, labels } = await run({ ...BASE, config }, review)
    expect(result.error).toStartWith("The review's settings are invalid: ")
    expect(result.error).toContain(message)
    expect(labels).toEqual([])
  }
  // Stages an older settings file names, which no agent runs on now, are not an error.
  const retired = await run({ ...BASE, config: { agents: { session: { model: 'm' }, loader: { effort: 'low' } } } }, review)
  expect(retired.result.error).toBeUndefined()
})

test('without settings in the args, the review reads them from config_file', async () => {
  const args = { pr: 5, repo: 'o/r', threads: '/t.json', config_file: '.claude/review.json', base: SHA('b'), head: SHA('h') }
  const file = (text: string) => ({ files: { '.claude/review.json': text } })
  const loaded = await run(args, review, file(JSON.stringify({ ...CONFIG, examples: [{ changed: [], segments: [] }] })))
  // The engine reads the file itself, so no agent starts for it.
  expect(loaded.labels[0]).toBe('context')
  expect(ran(loaded.labels)).toEqual(SEGMENTS)
  // A missing or empty file is no settings, so the defaults run.
  expect(ran((await run(args, review)).labels)).toEqual(['bugs', 'security', 'tests', 'design', 'docs'])
  expect(ran((await run(args, review, file(''))).labels)).toEqual(['bugs', 'security', 'tests', 'design', 'docs'])
  expect((await run(args, review, file('{'))).result.error).toBe('.claude/review.json is not JSON')
  // JSON that is not an object is settings that are not valid.
  expect((await run(args, review, file('null'))).result.error).toContain('settings are invalid: they are not a JSON object')
})

test('the shared prompts carry the description and the diff without generated files, cut to a limit', async () => {
  const pr = { title: 'Add a cache', body: 'Caches the lookups.' }
  const { prompts } = await run({ ...BASE, pr_file: '/pr.json' }, review, { files: { '/pr.json': JSON.stringify(pr) } })
  expect(prompts.context).toContain('Title: Add a cache\n\nCaches the lookups.')
  expect(prompts['bugs 1.1']).toContain('Title: Add a cache')
  const section = (path: string, size: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${'x'.repeat(size)}\n`
  const raw = section('Cargo.lock', 10) + section('src/a.rs', 100) + section('src/big.rs', 1000) + section('src/b.rs', 100)
  const text = diffText(raw, (p) => p !== 'Cargo.lock', 500)
  expect(text).toContain('+++ b/src/a.rs')
  expect(text).toContain('+++ b/src/b.rs')
  expect(text).not.toContain('+++ b/src/big.rs')
  expect(text).toContain('Generated files, left out: Cargo.lock.')
  expect(text).toContain("read these files' hunks with the git tool: src/big.rs.")
})

test('without a brief from the context stage, the changed code still gets a bugs pass and the review is partial', async () => {
  const args = { ...BASE, changed: ['src/a.rs', 'web/x.tsx', 'docs/y.md'] }
  const { result, prompts } = await run(args, (label) => (label === 'context' ? null : review(label)))
  const own = prompts['bugs 1.1']!.split("Read the area's files in this order, ")[1]!.split(': ')[1]!.split('. Report what')[0]!
  expect(own.split(', ').sort()).toEqual(['src/a.rs', 'web/x.tsx'])
  expect(result.partial).toBe(true)
  expect(result.marker.failed).toEqual(['context'])
  // Without a base and a head there is nothing to review, and no agent starts.
  const { base, head, ...bare } = BASE
  const none = await run(bare, review)
  expect(none.labels).toEqual([])
  expect(none.result.failed).toEqual(['context'])
})

test('changed code files no area lists still get a bugs pass', async () => {
  const area = (n: number, files: string[]) => ({ name: `area ${n}`, files })
  for (const [areas, pass, passes] of [
    // A new area while there is room, else the last area takes them.
    [[area(1, ['src/a.rs'])], 'bugs 2.1', 4],
    [[1, 2, 3, 4].map((n) => area(n, [`src/${n}.rs`])), 'bugs 4.1', 8],
  ] as [unknown[], string, number][]) {
    const { prompts } = await run(BASE, (label) => (label === 'context' ? { ...(review('context') as object), areas } : review(label)))
    const own = prompts[pass]!.split("Read the area's files in this order, ")[1]!.split(': ')[1]!.split('. Report what')[0]!
    expect(own.split(', ')).toContain('web/x.tsx')
    expect(Object.keys(prompts).filter((l) => l.startsWith('bugs ')).length).toBe(passes)
  }
})

test('a two-pass segment reviews only the areas that hold its files, or its files as one area', async () => {
  const config = { ...CONFIG, segments: [...CONFIG.segments, { name: 'notes', files: ['@prose'], passes: 2 }] }
  const { labels, result } = await run({ ...BASE, config }, (label) => (label.startsWith('notes ') ? { findings: [] } : review(label)))
  // No area holds docs/y.md, so it is the one area; bugs keeps its two code areas.
  expect(labels.filter((l) => l.startsWith('notes ')).sort()).toEqual(['notes 1.1', 'notes 1.2'])
  expect(labels.filter((l) => l.startsWith('bugs ')).length).toBe(4)
  expect(result.summary.bottom).toContain('| Notes | Ran: 2 passes over 1 area |')
  expect(result.summary.bottom).toContain('| Bugs | Ran: 4 passes over 2 areas |')
})

test("a replay's two-pass segment reviews the area of its case's file, even one that holds none of the segment's files", async () => {
  const c = { id: 'f5', pr: 5, head: hex(5), base: hex(55), segment: 'bugs', expect: 'find', issue: 'i', path: 'docs/y.md', line: 1 }
  const { labels, prompts } = await run({ mode: 'eval', config: CONFIG, cases: [c] }, (label) =>
    label.startsWith('judge ') ? { matched: false, reason: 'r' } : review(label.replace(/^#\d+ /, '')),
  )
  expect(labels.filter((l) => l.startsWith('#5 bugs ')).sort()).toEqual(['#5 bugs 1.1', '#5 bugs 1.2'])
  expect(prompts['#5 bugs 1.1']).toContain('You review one area, "cases", in pass 1 of 2')
  expect(prompts['#5 bugs 1.1']).toContain('following each call outward: docs/y.md.')
})

test("an issue's location links to its line, in a Markdown file's source too", async () => {
  const listed = (path: string) => ({ keys: [], severity: 'nit', path, line: 7, title: path, why: 'open-thread', thread_url: `https://x/${path}` })
  const { result } = await run(BASE, (label) => (label === 'editor' ? { ...(review('editor') as object), summary_only: [listed('docs/y.md'), listed('src/c.rs')] } : review(label)))
  // GitHub renders Markdown, which has no line anchors, unless plain=1 asks for its source.
  const where = result.summary.issues.map((i: { where: string }) => i.where)
  for (const path of ['docs/y.md', 'src/c.rs']) expect(where).toContain(`[\`${path}:7\`](https://github.com/o/r/blob/${SHA('h')}/${path}?plain=1#L7)`)
})

test('the summary heads with the confidence score, draws the diagram, and names the comment of each posted issue', async () => {
  const post = (line: number, severity: string) => ({ keys: [], slug: `s${line}`, path: 'src/a.rs', line, severity, title: `t${line}`, body: 'b', trace: 't' })
  const editor = (diagram: string | undefined) => ({ ...(review('editor') as object), diagram, post: [post(3, 'nit'), post(5, 'preexisting')] })
  const answer = (diagram: string | undefined) => (label: string) => (label === 'editor' ? editor(diagram) : review(label))
  const { result } = await run(BASE, answer('```mermaid\nflowchart LR\n  A --> B\n```'))
  const { top, issues } = result.summary
  expect(top).toStartWith('## Claude review · Confidence to merge: 4/5\n')
  // The job's fence wraps the diagram once, though the editor wrote its own.
  expect(top).toEndWith('<details open><summary><h3>Diagram</h3></summary>\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n</details>')
  // The job links a posted issue to the comment GitHub takes, and a listed one to its thread.
  expect(issues.map((i: any) => [i.title, i.comment, i.link])).toEqual([
    ['t3', 0, undefined],
    ['t5', 1, undefined],
    ['raised in a thread', undefined, 'https://x/t9'],
  ])
  expect(issues[1].badge).toBe('<img alt="Pre-existing" src="https://img.shields.io/badge/Pre--existing-8250df?style=flat" align="top">')
  // A fence inside the source would end the diagram early; without a diagram,
  // the summary has no Diagram part.
  for (const diagram of ['flowchart LR\n```\nA', '', undefined]) {
    const other = await run(BASE, answer(diagram))
    expect(other.result.summary.top).not.toContain('Diagram')
  }
})

test('the editor names its findings by key and writes only what it changes; the engine fills in the rest', async () => {
  const finding = { path: 'src/a.rs', line: 5, severity: 'important', title: 'unchecked', body: 'the body', trace: 'the trace', suggestion: 'fix()\n' }
  const { result, logs } = await run(BASE, (label, prompt) => {
    if (label === 'design') return { findings: [finding] }
    if (label.startsWith('verify ')) return verdict(prompt, { verdict: 'confirmed', severity: 'important', reason: 'r', security_or_privacy: false })
    if (label === 'editor') {
      return {
        ...(review('editor') as object),
        summary_only: [],
        post: [
          { keys: ['design-1'], slug: 'u' },
          { keys: ['design-1'], slug: 'v', title: 'sharper title', severity: 'nit' },
          { keys: ['nope'], slug: 'w' },
        ],
      }
    }
    return review(label)
  })
  const [kept, sharper] = result.comments
  expect(result.comments.length).toBe(2)
  expect(kept.body).toContain(`${IMPORTANT} **unchecked**`)
  expect(kept.body).toContain('the body')
  // The skeptic gave no trace, so the finder's stays.
  expect(kept.body).toContain('the trace')
  expect(kept.body).toContain('```suggestion\nfix()\n```')
  expect(sharper.body).toContain('**sharper title**')
  expect(sharper.carry.severity).toBe('nit')
  // A post whose key names no candidate has nothing to fill in from.
  expect(logs.some((l) => l.startsWith('editor: left out a post with no path'))).toBe(true)
})

test('a finding on a file the pull request does not change goes on its anchor, and says where it is', async () => {
  const anchor = { path: 'docs/y.md', line: 3 }
  const finding = (path: string, more: object = {}) => ({ keys: [], slug: path, path, line: 9, severity: 'important', title: path, body: 'b', trace: 't', suggestion: 'new\n', ...more })
  const { result, prompts } = await run(BASE, (label) =>
    label === 'editor'
      ? {
          ...(review('editor') as object),
          post: [finding('README.md', { anchor }), finding('src/a.rs', { anchor, start_line: 7 }), finding('notes.md'), finding('other.md', { anchor: { path: 'notes.md', line: 1 } })],
        }
      : review(label),
  )
  // The editor learns which files GitHub takes comments on.
  expect(prompts.editor).toContain('src/a.rs, web/x.tsx, docs/y.md')
  const [moved, changed, ...kept] = result.comments
  // README.md is not in the diff, so the comment goes on the changed line that
  // makes it true. Its suggestion is plain code, since GitHub would apply it
  // to that line, and the summary keeps it at its own line.
  expect([moved.path, moved.line, moved.start_line, moved.side]).toEqual(['docs/y.md', 3, undefined, 'RIGHT'])
  expect(moved.body).toStartWith(`${IMPORTANT} **README.md**\n\nOn [\`README.md:9\`](https://github.com/o/r/blob/${SHA('h')}/README.md?plain=1#L9), which this pull request does not change.\n\nb\n`)
  expect(moved.body).toContain('Suggested text for that line:\n```\nnew\n```')
  expect(moved.body).not.toContain('```suggestion')
  expect([moved.carry.path, moved.carry.line]).toEqual(['README.md', 9])
  // A finding on a changed file stays on its lines. One without an anchor in
  // the diff stays too, for the job to try and then list in the summary.
  expect([changed.path, changed.line, changed.start_line]).toEqual(['src/a.rs', 9, 7])
  expect(changed.body).toContain('```suggestion\nnew\n```')
  expect(kept.map((c: any) => [c.path, c.line])).toEqual([
    ['notes.md', 9],
    ['other.md', 9],
  ])
})

test("a suggestion that holds a code fence gets a longer fence, so the fence inside doesn't end it", () => {
  const finding = { path: 'README.md', line: 3, severity: 'nit', title: 't', body: 'b', trace: 't', suggestion: '```sh\nbun install\n```\n' } as const
  expect(commentBody(finding, {})).toContain('````suggestion\n```sh\nbun install\n```\n````\n')
  expect(commentBody(finding, {}, '`README.md:3`')).toContain('Suggested text for that line:\n````\n```sh')
  expect(fence('a ````` b')).toBe('``````')
  expect(fence('no backticks')).toBe('```')
})

test('the summary keeps each entry under its id until a fix or an answer, whichever segments run, once each', async () => {
  const entry = (id: string | null, title: string, more = {}) => ({ ...(id ? { id } : {}), severity: 'nit', path: 'src/b.rs', line: 4, title, note: 'n', from: SHA('c'), ...more })
  const { result, prompts } = await run(
    {
      ...BASE,
      since: SHA('a'),
      reviewed: SHA('a'),
      changed_since: ['README.md'],
      carried: [
        entry('S1', 'kept as it is'),
        entry('S2', 'fixed since'),
        entry('S3', 'answered nit'),
        entry('S4', 'declined important', { severity: 'important' }),
        entry('S5', 'listed again'),
        entry('S6', 'posted now'),
        entry('S7', 'answered and found again'),
        entry(null, 'from before ids'),
        entry('S8', 'thread listed again', { thread_url: 'https://x/t9' }),
        entry('S9', 'raised by an open thread'),
      ],
    },
    (label) => {
      if (label === 'follow-up') return { threads: [{ id: 'T1', state: 'open', holds: false }] }
      if (label !== 'editor') return review(label)
      const listed = { keys: [], severity: 'nit', path: 'src/d.rs', line: 1 }
      return {
        ...(review('editor') as object),
        post: [{ keys: [], slug: 'p', path: 'src/a.rs', line: 3, severity: 'important', title: 'posted now', body: 'b', trace: 't', earlier: ['S6'] }],
        summary_only: [
          { ...listed, id: 'S5', title: 'listed again, reworded', why: 'nit-cap' },
          { ...listed, title: 'raised in a thread', why: 'open-thread', thread_url: 'https://x/t9' },
          { ...listed, title: 'new', why: 'nit-cap', places: ['src/e.rs:2'] },
          { ...listed, id: 'S7', title: 'answered and found again', why: 'answered' },
          { ...listed, id: 'S9', title: 'raised by an open thread', why: 'open-thread', thread_url: 'https://x/t10' },
        ],
        earlier: [
          { id: 'S2', state: 'fixed', commit: SHA('d'), note: 'moved' },
          { id: 'S3', state: 'answered', holds: false, note: 'r' },
          { id: 'S4', state: 'answered', holds: false, note: 'r' },
          { id: 'S1', state: 'open' },
        ],
      }
    },
    threads(thread('T1', { severity: 'Nit', title: 'raised by an open thread', url: 'https://x/t10', path: 'src/b.rs', line: 4 })),
  )
  // Every earlier segment ran again or not, the editor hears of every entry,
  // and one from before ids gets the next free one.
  expect(prompts.editor).toContain('"id":"S10"')
  expect(prompts.editor).toContain('from before ids')
  expect(result.marker.carried.map((c: any) => [c.id, c.title])).toEqual([
    ['S5', 'listed again, reworded'],
    ['S8', 'raised in a thread'],
    ['S11', 'new'],
    ['S1', 'kept as it is'],
    ['S4', 'declined important'],
    ['S10', 'from before ids'],
  ])
  const notes = Object.fromEntries(result.summary.issues.map((i: any) => [i.title, i.note]))
  expect(notes['listed again, reworded']).toBe('S5: over the cap of five Nits')
  // A finding of one class lists its other places.
  expect(notes.new).toBe('S11: over the cap of five Nits; also at `src/e.rs:2`')
  expect(result.marker.carried.find((c: any) => c.id === 'S11').places).toEqual(['src/e.rs:2'])
  expect(notes['kept as it is']).toBe('S1: n, from the review of `ccccccc`')
  // A blocking entry whose answer does not hold stays, and a person decides;
  // a fixed one and an answered Nit move to the earlier findings.
  expect(notes['declined important']).toBe('S4: n, answered, disputed: a person decides, from the review of `ccccccc`')
  expect(result.summary.top).toContain('**1 disputed finding: a person decides.**')
  expect(result.summary.bottom).toContain('- Fixed in ddddddd: S2 fixed since')
  expect(result.summary.bottom).toContain('- Answered: S3 answered nit. r')
  // One found again that the author answered with a reason that holds is
  // settled too, though the editor listed it.
  expect(result.summary.bottom).toContain('- Answered: S7 answered and found again\n')
  expect('answered and found again' in notes).toBe(false)
  expect(result.summary.issues.filter((i: any) => i.link === 'https://x/t9').length).toBe(1)
  // An entry the editor finds raised by an open thread is that thread's row only.
  expect(result.summary.issues.filter((i: any) => i.title === 'raised by an open thread').length).toBe(1)
  // What GitHub may refuse to take inline keeps the id of the entry it posts,
  // which its row shows if GitHub refuses it, and no id is given twice.
  expect(result.comments[0].carry.id).toBe('S6')
  expect(result.summary.issues.find((i: any) => i.comment === 0).id).toBe('S6')
  expect(result.marker.last_id).toBe(11)
})

test('a settled id is not given again, and a new comment gets an id of its own', async () => {
  const { result } = await run({ ...BASE, carried: [], last_id: 4 }, (label) =>
    label === 'editor'
      ? {
          ...(review('editor') as object),
          post: [{ keys: [], slug: 'p', path: 'src/a.rs', line: 3, severity: 'important', title: 'posted', body: 'b', trace: 't', places: ['src/c.rs:8'] }],
          summary_only: [{ keys: [], severity: 'nit', path: 'src/d.rs', line: 1, title: 'listed', why: 'nit-cap' }],
        }
      : review(label),
  )
  expect(result.marker.carried.map((c: any) => c.id)).toEqual(['S5'])
  expect([result.comments[0].carry.id, result.comments[0].carry.places]).toEqual(['S6', ['src/c.rs:8']])
  expect(result.marker.last_id).toBe(6)
})

test('the follow-up gets only this reviewer\'s open threads, and the engine reads each one\'s title, severity, and place', async () => {
  const mine = (id: string, more = {}) => thread(id, { reviewer: 'review-bot', ...more })
  const file = threads(
    mine('T1', { severity: 'Important', title: 'leaks the token', path: 'src/a.rs', line: 3 }),
    mine('T2', { resolved: true }),
    thread('T3', { reviewer: 'someone' }),
    mine('T4', { severity: 'Nit', title: 'stale doc', path: 'docs/y.md', line: 1 }),
  )
  const { result, prompts } = await run({ ...BASE, reviewer: 'review-bot' }, (label) => (label === 'follow-up' ? { threads: [{ id: 'T1', state: 'open', holds: false }, { id: 'T4', state: 'open', holds: false, line: 9 }, { id: 'T3', state: 'fixed', holds: false }] } : review(label)), file)
  expect(prompts['follow-up']).toContain('"id":"T1"')
  expect(prompts['follow-up']).toContain('"id":"T4"')
  expect(prompts['follow-up']).not.toContain('"id":"T2"')
  expect(prompts['follow-up']).not.toContain('"id":"T3"')
  // Comments reach the agent without their badge image and the job's marker.
  expect(prompts['follow-up']).toContain('[Important] **leaks the token**')
  expect(prompts['follow-up']).not.toContain('claude-review {')
  const rows = result.summary.issues.filter((i: any) => i.note.startsWith('open thread'))
  expect(rows.map((i: any) => [i.badge === IMPORTANT, i.title, i.link])).toEqual([
    [true, 'leaks the token', 'https://x/T1'],
    [false, 'stale doc', 'https://x/T4'],
  ])
  // A line the follow-up says moved wins over the thread's.
  expect(rows[1].where).toContain('docs/y.md:9')
  // A thread the agent names that is not one of these gets no reply.
  expect(result.replies).toEqual([])
  // A thread the answer leaves out stays open, and one it repeats counts once.
  const left = await run({ ...BASE, reviewer: 'review-bot' }, (label) => (label === 'follow-up' ? { threads: [{ id: 'T4', state: 'open', holds: false }, { id: 'T4', state: 'open', holds: false }] } : review(label)), file)
  expect(left.result.summary.issues.filter((i: any) => i.note.startsWith('open thread')).map((i: any) => i.title)).toEqual(['leaks the token', 'stale doc'])
  expect(left.logs).toContain('follow-up: no answer for T1, kept open')
  // Without any such thread, no follow-up agent starts.
  const none = await run({ ...BASE, reviewer: 'review-bot' }, review, threads(thread('T3', { reviewer: 'someone' })))
  expect(none.labels).not.toContain('follow-up')
  expect(none.result.partial).toBe(false)
  expect(firstComment('🔴 **old style**\n\nb')).toEqual({ severity: 'important', title: 'old style' })
  expect(firstComment('**t**\n\nOn [`src/x.rs:4`](https://x), which this pull request does not change.')).toMatchObject({ path: 'src/x.rs', line: 4 })
})

test('a fixed thread gets a line that names its commit, a person gets an answer, and settled threads are resolved', async () => {
  const followed = {
    threads: [
      { id: 'T1', state: 'fixed', commit: SHA('d'), note: 'n' },
      { id: 'T2', state: 'fixed', answer: ' The empty list is covered too. ' },
      { id: 'T3', state: 'answered', holds: true, answer: 'Agreed: the caller checks it.' },
      { id: 'T4', state: 'open', answer: 'Not for an empty list.' },
      { id: 'T5', state: 'open', answer: ' ' },
      // A blocking finding stays open while the author's reason does not
      // hold, or the follow-up does not say that it holds, and the answer
      // says a person decides; a thread with no answer, such as after
      // thanks, gets no reply.
      { id: 'T6', state: 'answered', holds: false, answer: 'It still fails for an empty list.' },
      { id: 'T9', state: 'answered', holds: false },
      { id: 'T12', state: 'answered' },
      // The author's answer settles a finding that does not block the merge.
      { id: 'T10', state: 'answered', holds: false },
      { id: 'T11', state: 'answered', holds: false, answer: 'It still fails for an empty list.' },
    ],
  }
  const mine = (id: string, severity?: string, title = 't') => thread(id, { reviewer: 'review-bot', severity, title })
  const file = threads(
    mine('T1'), mine('T2'), mine('T3', 'Important'), mine('T4'), mine('T5'), mine('T6', 'Important', 'declined important'),
    mine('T9'), mine('T12', 'Important'), mine('T10', 'Nit', 'declined nit'), mine('T11', 'Pre-existing'),
  )
  const { result, prompts } = await run({ ...BASE, reviewer: 'review-bot', fixed_before: ['T7', 'T8'] }, (label) => (label === 'follow-up' ? followed : review(label)), file)
  // The job decides which part each thread may get (src/post.rs): a thread
  // with nothing to say or do gets no entry.
  expect(result.replies).toEqual([
    { thread_id: 'T1', fixed: 'Fixed in ddddddd: n', resolve: true },
    { thread_id: 'T2', fixed: 'Fixed as of hhhhhhh.', answer: 'The empty list is covered too.', resolve: true },
    { thread_id: 'T3', answer: 'Agreed: the caller checks it.', resolve: true },
    { thread_id: 'T4', answer: 'Not for an empty list.' },
    { thread_id: 'T6', answer: `It still fails for an empty list.\n\n${DISPUTED}` },
    { thread_id: 'T10', resolve: true },
    { thread_id: 'T11', answer: 'It still fails for an empty list.', resolve: true },
  ])
  // The disputed thread stays open, so the summary counts it as open; the
  // settled Nit is listed with the earlier findings.
  expect(
    result.summary.issues.some(
      (i: any) => i.badge === IMPORTANT && i.title === 'declined important' && i.where === '-' && i.note === 'open thread from an earlier review, disputed: a person decides',
    ),
  ).toBe(true)
  expect(result.summary.top).toContain('**3 disputed findings: a person decides.**')
  expect(result.summary.bottom).not.toContain('Answered: declined important')
  expect(result.summary.bottom).toContain('- Answered: [declined nit](https://x/T10)')
  // The follow-up takes the threads of the reviewer the job posts as, and
  // answers by the rules.
  expect(prompts['follow-up']).toContain('started by this reviewer, review-bot')
  expect(prompts['follow-up']).toContain('as "Later reviews" below says')
  expect(prompts['follow-up']).toContain('## Later reviews')
  // It learns which threads have the "Fixed" reply from the job, not from the
  // reply text, which an answer can start the same way.
  expect(prompts['follow-up']).toContain('These threads have a "Fixed" reply from review-bot, so they were fixed before: T7, T8.')
})

test('the skeptics decide what is kept, and the earlier entries stay when the editor fails', async () => {
  const finding = (line: number, title: string) => ({ path: 'src/a.rs', line, severity: 'important', title, body: 'b', trace: 't' })
  // Skeptic verdicts by line, and whether the skeptic calls the finding one
  // about security or privacy; the skeptics of lines 7 and 8 fail.
  const verdicts: Record<string, [string, boolean?]> = { 3: ['unsure'], 4: ['confirmed'], 5: ['confirmed'], 6: ['unsure'], 9: ['unsure', true], 10: ['refuted', true] }
  const answer = (label: string) => {
    if (label === 'security') return { findings: [finding(3, 'security unsure'), finding(8, 'security unchecked'), finding(10, 'security refuted')] }
    // The design segment also finds its earlier entry again, at the same place with the same title.
    if (label === 'design') {
      const again = { ...finding(4, 'design earlier'), path: 'src/b.rs' }
      return { findings: [finding(5, 'design confirmed'), finding(6, 'design unsure'), finding(9, 'design privacy unsure'), again] }
    }
    if (label === 'rust') return { findings: [finding(7, 'rust unchecked')] }
    // One of the bugs segment's two passes fails, and so does the whole tests segment.
    if (label === 'tests' || label === 'bugs 1.2' || label === 'editor') return null
    if (label.startsWith('verify ')) {
      const [v, privacy = false] = verdicts[label.split(':').pop()!] || []
      return v ? { verdict: v, severity: 'important', reason: 'r', trace: 't', security_or_privacy: privacy } : null
    }
    return review(label)
  }
  const earlier = (segment: string) => ({ segments: [segment], severity: 'nit', path: 'src/b.rs', line: 4, title: `${segment} earlier`, note: 'n', from: SHA('c') })
  const { result } = await run({ ...BASE, since: SHA('a'), reviewed: SHA('a'), changed_since: ['src/a.rs'], carried: ['bugs', 'tests', 'rust', 'design', 'security'].map(earlier) }, answer)
  expect(result.marker.partial).toBe(true)
  expect([...result.marker.failed].sort()).toEqual(['bugs', 'editor', 'rust', 'security', 'tests'])
  // Without the editor, the marker keeps every earlier entry and every new
  // finding, so one the next review misses stays listed; the one found again
  // at the same place with the same title keeps its entry's id.
  expect(result.marker.carried.map((c: any) => `${c.id} ${c.title}`).sort()).toEqual([
    'S1 bugs earlier', 'S2 tests earlier', 'S3 rust earlier', 'S4 design earlier', 'S5 security earlier',
    'S6 security unsure', 'S7 security unchecked', 'S8 design confirmed', 'S9 design privacy unsure',
  ])
  expect(result.marker.last_id).toBe(9)
  // Nothing is posted, and the summary, with no score or diagram, says why
  // and lists each of those findings with why it is there, none linked to a comment.
  expect(result.comments).toEqual([])
  const { top, issues } = result.summary
  expect(top).toStartWith('## Claude review\n\n> [!WARNING]\n> This review is incomplete: ')
  expect(top).toContain('**9 findings, listed below and not posted, because the editor did not finish**')
  expect(top).not.toMatch(/Confidence to merge|Diagram/)
  // The summary lists every kept finding and every earlier entry once: an
  // unsure finding stays only for security or privacy, an unchecked one only
  // for security, and a refuted one never. The earlier entries, which had no
  // ids, take the first ones.
  const unverified = 'unverified: the skeptic could not settle it'
  const from = 'n, from the review of `ccccccc`'
  expect(issues.map((i: any) => [i.title, i.note, 'comment' in i])).toEqual([
    ['security unsure', `S6: ${unverified}`, false],
    ['security unchecked', `S7: ${unverified}`, false],
    ['design confirmed', 'S8: not posted: the editor did not finish', false],
    ['design privacy unsure', `S9: ${unverified}`, false],
    ['design earlier', 'S4: not posted: the editor did not finish', false],
    ['bugs earlier', `S1: ${from}`, false],
    ['tests earlier', `S2: ${from}`, false],
    ['rust earlier', `S3: ${from}`, false],
    ['security earlier', `S5: ${from}`, false],
  ])
})

test('findings of one segment at one place go to one skeptic, which gives each its own verdict', async () => {
  const at = (title: string) => ({ path: 'src/a.rs', line: 3, severity: 'important', title, body: 'b', trace: 't' })
  const { labels, calls, result } = await run(BASE, (label, prompt) => {
    if (label === 'bugs 1.1') return { findings: [at('first pass')] }
    if (label === 'bugs 1.2') return { findings: [at('second pass'), { ...at('other line'), line: 4 }] }
    if (label === 'design') return { findings: [at('design view')] }
    if (label.startsWith('verify ')) return verdict(prompt, (f) => ({ verdict: f.includes('second pass') ? 'refuted' : 'confirmed', severity: 'nit', reason: 'r', security_or_privacy: false }))
    if (label === 'editor') return { ...(review('editor') as object), summary_only: [] }
    return review(label)
  })
  // The bugs passes' two findings at src/a.rs:3 share a skeptic; another line
  // and another segment get their own.
  expect(labels.filter((l) => l.startsWith('verify ')).sort()).toEqual(['verify bugs src/a.rs:3', 'verify bugs src/a.rs:4', 'verify design src/a.rs:3'])
  expect(calls['verify bugs src/a.rs:3']!.prompt).toContain('reported these 2 findings at the same place')
  expect(result.summary.bottom).toContain('| Bugs | Ran: 4 passes over 2 areas | 2 of 3 |')
})

test('a finding keeps the other places of its pattern that its skeptic confirms, and its comment lists them', async () => {
  const finding = { path: 'src/a.rs', line: 5, severity: 'important', title: 'unchecked', body: 'b', trace: 't', places: ['src/a.rs:9', 'src/b.rs:2'] }
  const { result, prompts } = await run(BASE, (label, prompt) => {
    if (label === 'design') return { findings: [finding] }
    if (label.startsWith('verify design')) return verdict(prompt, { verdict: 'confirmed', severity: 'important', reason: 'r', places: ['src/b.rs:2'], security_or_privacy: false })
    if (label === 'editor') return { ...(review('editor') as object), summary_only: [], earlier: [], post: [{ keys: ['design-1'], slug: 'u' }] }
    return review(label)
  })
  // The editor gets the places the skeptic confirmed, not the finder's.
  expect(prompts.editor).toContain('"src/b.rs:2"')
  expect(prompts.editor).not.toContain('src/a.rs:9')
  expect(result.comments[0].body).toContain('b\n\nThe same problem is also at:\n- `src/b.rs:2`\n')
  // A skeptic that confirms the finding and lists no places confirms none.
  const bare = await run(BASE, (label, prompt) => {
    if (label === 'design') return { findings: [finding] }
    if (label.startsWith('verify design')) return verdict(prompt, { verdict: 'confirmed', severity: 'important', reason: 'r', security_or_privacy: false })
    return review(label)
  })
  expect(bare.prompts.editor).toContain('"title":"unchecked"')
  expect(bare.prompts.editor).not.toContain('src/a.rs:9')
  expect(bare.prompts.editor).not.toContain('src/b.rs:2')
})

// A repository of three areas: a Rust API, a web app, and its docs.
function sweeping(more: Record<string, unknown> = {}) {
  const finding = (path: string, title: string) => ({ path, line: 2, severity: 'important', title, body: 'b', trace: 't' })
  const answer = (label: string, prompt: string) => {
    if (label === 'scope') {
      return {
        rules: [], risks: [], knowledge_base: '', knowledge_base_read: true,
        areas: [
          { name: 'api', files: ['src/a.rs', 'src/b.rs', 'src/'], why: 'changed since' },
          { name: 'web', files: ['web/x.tsx', 'web/README.md'], why: 'not covered yet' },
          { name: 'docs', files: ['docs/y.md'], why: 'not covered yet' },
        ],
      }
    }
    if (label === 'bugs @1') return { findings: [finding('src/a.rs', 'api bug')] }
    if (label === 'web @2') return { findings: [finding('web/x.tsx', 'web bug'), finding('web/x.tsx', 'web doubt')] }
    if (label.includes(' verify ')) return verdict(prompt, (f) => ({ verdict: f.includes('web doubt') ? 'refuted' : 'confirmed', severity: 'important', reason: 'r', security_or_privacy: false }))
    if (label === 'editor') return { overview: 'Two bugs.', dropped: [], findings: [{ keys: ['bugs-1', 'web-2'] }] }
    if (/ @\d$/.test(label)) return { findings: [] }
    if (more[label] !== undefined) return more[label]
    throw new Error(`no answer for ${label}`)
  }
  return { answer, setup: { head: SHA('s') } }
}

test('a sweep reviews each area with the segments that apply to it, verifies, and merges what it found', async () => {
  const { answer, setup } = sweeping()
  const { result, labels, prompts } = await run({ mode: 'sweep', repo: 'o/r', config: CONFIG, since: '2026-10-01', covered: ['docs'] }, answer, setup)
  expect(labels.filter((l) => / @\d$/.test(l)).sort()).toEqual([
    'bugs @1', 'bugs @2', 'design @1', 'design @2', 'design @3', 'docs @1', 'docs @2', 'docs @3',
    'rust @1', 'security @1', 'security @2', 'security @3', 'tests @1', 'tests @2', 'web @2',
  ])
  // The scope stage hears what to put first and last.
  expect(prompts.scope).toContain('git log --name-only --format= --since=2026-10-01')
  expect(prompts.scope).toContain('Earlier sweeps covered these areas, so they come last: docs.')
  expect(prompts['bugs @1']).toContain('Its files: src/a.rs, src/b.rs.')
  // A sweep has no diff or description, so a segment gives its sweep note, or its note without one.
  expect(prompts['design @1']).toContain('Compare the code with the documents that describe it')
  expect(prompts['design @1']).not.toContain('claims in the brief')
  expect(prompts['docs @1']).toContain("Check that the links in the area's documents lead to files that exist.")
  expect(prompts['docs @1']).not.toContain('--name-status')
  expect(prompts['security @1']).toContain('Follow data that crosses a trust boundary')
  expect(result.mode).toBe('sweep')
  expect(result.head).toBe(SHA('s'))
  expect(result.partial).toBe(false)
  // The editor merged the two kept findings, giving only their keys; the
  // refuted one never reached it.
  expect(result.findings.map((f: any) => [f.title, f.segments, f.areas, f.verdict])).toEqual([['api bug', ['bugs', 'web'], ['api', 'web'], 'confirmed']])
  expect(prompts.editor).not.toContain('web doubt')
  expect(result.summary).toStartWith('## Sweep of `sssssss`')
  expect(result.summary).toContain(`[\`src/a.rs:2\`](https://github.com/o/r/blob/${SHA('s')}/src/a.rs?plain=1#L2)`)
})

test('a sweep reviews at most max_areas areas, and says what did not finish', async () => {
  const { answer, setup } = sweeping()
  const failing = (label: string, prompt: string) => (label === 'security @1' ? null : answer(label, prompt))
  const { result, labels } = await run({ mode: 'sweep', config: CONFIG, max_areas: 2 }, failing, setup)
  expect(labels.some((l) => l.endsWith(' @3'))).toBe(false)
  expect(result.areas.map((a: any) => a.name)).toEqual(['api', 'web'])
  expect(result.partial).toBe(true)
  expect(result.failed).toEqual(['security in api'])
  // The settings' max_areas applies when the args name none.
  const capped = await run({ mode: 'sweep', config: { ...CONFIG, sweep: { max_areas: 1 } } }, answer, setup)
  expect(capped.result.areas.map((a: any) => a.name)).toEqual(['api'])
  expect(capped.result.summary).toContain('- api (2 files): changed since')
})

test('a sweep with nothing to fix runs no editor, and one without a scope stops', async () => {
  const { answer, setup } = sweeping()
  const quiet = (label: string, prompt: string) => (label === 'bugs @1' || label === 'web @2' ? { findings: [] } : answer(label, prompt))
  const { result, labels } = await run({ mode: 'sweep', config: CONFIG }, quiet, setup)
  expect(labels).not.toContain('editor')
  expect(result.findings).toEqual([])
  expect(result.summary).toContain('The sweep found nothing to fix.')
  const failed = await run({ mode: 'sweep', config: CONFIG }, () => null, setup)
  expect(failed.result).toEqual({ mode: 'sweep', error: 'The scope stage failed.' })
})

const judged = (label: string) => (label.startsWith('judge ') ? { matched: true, reason: 'r' } : review(label.replace(/^#\d+ /, '')))

test("a capped eval keeps the newest pull requests' cases, with at least half the segment runs for each kind", async () => {
  const c = (expect: string, pr: number, more = {}) => ({ id: `${expect[0]}${pr}`, pr, head: hex(pr), base: hex(pr + 1000), segment: 'bugs', expect, issue: 'i', path: 'src/a.rs', line: 1, ...more })
  for (const [max, only, cases, kept] of [
    [3, undefined, [c('find', 50), c('find', 10), c('quiet', 5), c('find', 60)], ['f50', 'f60', 'q5']],
    [4, undefined, [c('quiet', 1), c('quiet', 2), c('quiet', 3), c('find', 4), c('find', 5), c('find', 6)], ['f5', 'f6', 'q2', 'q3']],
    [2, undefined, [c('quiet', 1), c('quiet', 2), c('quiet', 3)], ['q2', 'q3']],
    // A quiet case runs both segments under test; a case at a pull request
    // commit and segment another case already runs costs nothing more.
    [4, ['bugs', 'design'], [c('quiet', 7), c('quiet', 8), c('find', 9), c('find', 10), c('find', 9, { id: 'f9b' })], ['f10', 'f9', 'f9b', 'q8']],
    // Two pull requests at one commit replay it twice.
    [1, undefined, [c('find', 5, { head: hex(99) }), c('find', 6, { head: hex(99) })], ['f6']],
  ] as [number, string[] | undefined, any[], string[]][]) {
    const { result } = await run({ mode: 'eval', config: CONFIG, max_segment_runs: max, only, cases }, judged)
    expect(result.rows.map((r: any) => r.id).sort()).toEqual(kept)
    expect(result.dropped.sort()).toEqual(cases.map((x) => x.id).filter((id) => !kept.includes(id)).sort())
  }
})

test('an eval reads its cases from a file, and refuses a case it cannot replay', async () => {
  const c = { id: 'f1', pr: 1, head: hex(1), base: hex(2), segment: 'bugs', expect: 'find', issue: 'i', path: 'src/a.rs', line: 1 }
  const { result } = await run({ mode: 'eval', config: CONFIG, cases_file: 'evals.json' }, judged, { files: { 'evals.json': JSON.stringify({ cases: [c] }) } })
  expect(result.found).toBe('1 of 1')
  const bad = await run({ mode: 'eval', config: CONFIG, cases: [{ ...c, head: 'h1' }] }, judged)
  expect(bad.result.error).toContain('the eval case "f1" is not valid')
  expect(bad.labels).toEqual([])
  const missing = await run({ mode: 'eval', config: CONFIG, cases_file: 'nope.json' }, judged)
  expect(missing.result.error).toBe('could not read the cases from nope.json')
})

test('an eval case whose replay throws stays as an unscored row', async () => {
  const find = (pr: number) => ({ id: `f${pr}`, pr, head: hex(pr), base: hex(pr + 100), segment: 'bugs', expect: 'find', issue: 'i', path: 'src/a.rs', line: 1 })
  const answer = (label: string) => {
    if (label === '#6 context') throw new Error('replay broke')
    return judged(label)
  }
  const { result, calls } = await run({ mode: 'eval', config: CONFIG, cases: [find(6), find(7)] }, answer)
  expect(result.rows.map((r: any) => r.id)).toEqual(['f6', 'f7'])
  expect(result.unscored).toEqual([{ id: 'f6', why: 'replay failed' }])
  expect(result.found).toBe('1 of 1')
  expect([calls['judge f7']!.model, calls['judge f7']!.effort, calls['judge f7']!.tools]).toEqual(['claude-sonnet-5-5', 'low', 'none'])
})

test('an eval replay starts no agent past its cap, and the cases left without one stay unscored', async () => {
  const find = (pr: number) => ({ id: `f${pr}`, pr, head: hex(pr), base: hex(pr + 100), segment: 'bugs', expect: 'find', issue: 'i', path: 'src/a.rs', line: 1 })
  // Every pass finds something, so each finding also gets a skeptic.
  const answer = (label: string, prompt: string) => {
    const name = label.replace(/^#\d+ /, '')
    if (name.startsWith('judge ')) return { matched: true, reason: 'r' }
    if (name.startsWith('bugs ')) return { findings: [{ path: 'src/a.rs', line: 1, severity: 'nit', title: 't', body: 'b', trace: 't' }] }
    if (name.startsWith('verify ')) return verdict(prompt, { verdict: 'confirmed', severity: 'nit', reason: 'r', security_or_privacy: false })
    return review(name)
  }
  const cases = [find(1), find(2), find(3)]
  const whole = await run({ mode: 'eval', config: CONFIG, cases }, answer)
  expect(whole.result.agents).toBe(whole.labels.length)
  expect(whole.result.found).toBe('3 of 3')
  const max = whole.labels.length - 1
  const capped = await run({ mode: 'eval', config: CONFIG, cases, max_agents: max }, answer)
  expect(capped.labels.length).toBe(max)
  expect(capped.result.agents).toBe(max)
  expect(capped.result.rows.length).toBe(3)
  expect(capped.result.unscored.length).toBe(1)
})

test("a find case with a severity has the judge check it, and the judge sees each finding's severity and places", async () => {
  const find = (id: string, more = {}) => ({ id, pr: 3, head: hex(3), base: hex(4), segment: 'bugs', expect: 'find', issue: 'i', path: 'src/a.rs', line: 1, ...more })
  const prompts: Record<string, string> = {}
  const answer = (label: string, prompt: string) => {
    const name = label.replace(/^#\d+ /, '')
    prompts[name] = prompt
    if (name.startsWith('judge ')) return { matched: true, reason: 'r' }
    if (name.startsWith('bugs ')) return { findings: [{ path: 'src/a.rs', line: 1, severity: 'nit', title: 't', body: 'b', trace: 't', places: ['src/b.rs:2'] }] }
    if (name.startsWith('verify ')) return verdict(prompt, { verdict: 'confirmed', severity: 'nit', reason: 'r', places: ['src/b.rs:2'], security_or_privacy: false })
    return review(name)
  }
  await run({ mode: 'eval', config: CONFIG, cases: [find('graded', { expect_severity: 'important' }), find('plain')] }, answer)
  expect(prompts['judge graded']).toContain('must have severity important')
  expect(prompts['judge plain']).not.toContain('must have severity')
  expect(prompts['judge plain']).toContain('"severity":"nit"')
  expect(prompts['judge plain']).toContain('"src/b.rs:2"')
})

test('a quiet case replays the segments under test, breaks on their claim, and is not counted where they do not apply', async () => {
  const quiet = (pr: number, segment: string) => ({ id: `q${pr}`, pr, head: hex(pr), base: hex(pr + 100), segment, expect: 'quiet', issue: 'i', path: 'src/a.rs', line: 1 })
  const answer = (label: string, prompt: string) => {
    const name = label.replace(/^#\d+ /, '')
    if (name === 'design') return { findings: [{ path: 'src/a.rs', line: 1, severity: 'nit', title: 'the wrong claim', body: 'b', trace: 't' }] }
    if (name.startsWith('verify ')) return verdict(prompt, { verdict: 'confirmed', severity: 'nit', reason: 'r' })
    if (name.startsWith('judge ')) return { matched: prompt.includes('the wrong claim'), reason: 'r' }
    return review(name)
  }
  // Pull request 8 changes only prose, so the design segment does not apply.
  const setup = { changed: { [`${hex(108)}...${hex(8)}`]: ['README.md'] } }
  const { result, labels } = await run({ mode: 'eval', config: CONFIG, only: ['design'], cases: [quiet(9, 'bugs'), quiet(8, 'docs')] }, answer, setup)
  expect(ran(labels.map((l) => l.replace(/^#\d+ /, '')))).toEqual(['design'])
  expect(result.rows.map((r: any) => [r.id, r.matched])).toEqual([['q9', true]])
  expect(result.cases).toBe(1)
  expect(result.not_applicable.map((r: any) => r.id)).toEqual(['q8'])
})

test("the agents' git runs only read commands, and none that reads or writes outside the checkout", () => {
  const cwd = process.cwd()
  for (const ok of [
    ['log', '-1', '--format=%s'],
    ['grep', '-n', '-e', 'pattern', 'HEAD', '--', 'src'],
    ['diff', '--no-ext-diff', 'HEAD~1...HEAD', '--', 'src'],
    ['diff', '-S/api/'],
    // A path in a revision names a file in that commit's tree, never one on disk.
    ['show', 'HEAD:../README.md'],
    ['diff', '--text'],
    ['blame', '--ignore-rev', 'abc', 'src/a.rs'],
    // A range that holds an S is not blame's -S.
    ['blame', '-L/Struct/,+5', 'src/a.rs'],
    ['blame', '-wL/Struct/,+5', 'src/a.rs'],
  ]) {
    expect(refusal(ok, cwd)).toBeNull()
  }
  for (const [bad, why] of [
    [['push'], 'not one of'],
    [['-C', '/', 'log'], 'not one of'],
    [['log', '--output=/tmp/x'], '--output is refused'],
    [['log', '--out=/tmp/x'], '--output is refused'],
    [['diff', '--no-index', '/etc/hostname', 'README.md'], '--no-index is refused'],
    [['diff', '/etc/hostname'], 'leads outside the checkout'],
    [['diff', '../other'], 'leads outside the checkout'],
    [['blame', '--contents', '/etc/hostname', 'x'], '--contents is refused'],
    [['blame', '-S', 'revs', 'x'], 'blame -S is refused'],
    [['blame', '-wS', 'revs', 'x'], 'blame -S is refused'],
    [['grep', '-O', 'x'], 'grep -O is refused'],
    [['grep', '-nf', 'patterns'], 'grep -f is refused'],
    [['grep', '--open-files-in-pager=vi', 'x'], '--open-files-in-pager is refused'],
    [['diff', '--ext-diff'], '--ext-diff is refused'],
    [['log', '--textconv'], '--textconv is refused'],
  ] as [string[], string][]) {
    expect(refusal(bad, cwd)).toContain(why)
  }
})

test("a repository's settings file reviews each of its examples with the segments the example names", async () => {
  if (!process.env.REVIEW_CONFIG) return
  const settings = JSON.parse(readFileSync(process.env.REVIEW_CONFIG, 'utf8'))
  expect(Array.isArray(settings.examples) && settings.examples.length > 0).toBe(true)
  const { examples, ...config } = settings
  const { result: names } = await run({ mode: 'names', config }, () => {
    throw new Error('an agent in names mode')
  })
  expect(names.error).toBeUndefined()
  for (const example of examples) {
    const answer = (label: string) => {
      if (label === 'context') return { ...(review('context') as object), areas: [] }
      if (label === 'editor') return review(label)
      return { findings: [] }
    }
    const { labels } = await run({ ...BASE, config, changed: example.changed }, answer)
    expect(ran(labels, names.segments)).toEqual(example.segments)
  }
})

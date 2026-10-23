// The review workflows' own logic, run as Claude Code runs them with every
// agent answered by a stub: the settings, which segments a push reviews
// again, what the skeptics keep, what the summary carries over, the sweep,
// the eval's cap, quiet cases, and failed replays, and the tuning routine's
// decision. The action's Rust tests run the workflow too, for what passes
// between it and the job (src/post.rs).
//
// REVIEW_CONFIG names a repository's settings file whose "examples" to check:
// each lists the files a pull request changes and the segments that review it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CONFIG, SEGMENTS, SHA, ran, review, run } from './harness.mjs'

const BASE = { pr: 5, repo: 'o/r', threads: '/t.json', config: CONFIG }
// What the job adds to its answer in a disputed thread, which the agents'
// workflow guide tells them to look for.
const DISPUTED = '**Disputed:** this finding blocks the merge and the reason given does not hold, so a person decides: fix it, or resolve this thread to keep the code as it is.'
// The badge an Important finding shows, in its comment and its issue row.
const IMPORTANT = '<img alt="Important" src="https://img.shields.io/badge/Important-cf222e?style=flat" align="top">'

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
  ]) {
    const args = { ...BASE }
    if (changedSince) Object.assign(args, { since: SHA('a'), reviewed: SHA('a'), changed_since: changedSince })
    // The args as the job writes them to args.json, before the run.
    const written = structuredClone(args)
    const { labels, result } = await run('pr-review.js', args, review)
    assert.deepEqual(ran(labels), expected, `changed since: ${changedSince}`)
    // The job posts only a review whose args match its own.
    assert.deepEqual(result.args, written)
  }
})

test('each stage runs on its model and effort: the defaults, the settings, then the segment', async () => {
  const { options } = await run('pr-review.js', BASE, review)
  const on = (label) => [options[label].model, options[label].effort]
  assert.deepEqual(on('context'), ['claude-sonnet-5-5', 'high'])
  assert.deepEqual(on('bugs 1.1'), ['claude-sonnet-5-5', 'high'])
  // A missed security finding costs the most, so its finder keeps Opus.
  assert.deepEqual(on('security'), ['claude-opus-5-5', 'high'])
  // The settings' web segment takes Haiku for its finder, at the finders' effort.
  assert.deepEqual(on('web'), ['claude-haiku-5-5', 'high'])
  // The settings lower the editor's effort and keep its model.
  assert.deepEqual(on('editor'), ['claude-sonnet-5-5', 'medium'])
  // The follow-up answers people in its threads, so it reasons at high effort.
  assert.deepEqual(on('follow-up'), ['claude-sonnet-5-5', 'high'])
})

test('settings merge over the defaults: a segment can change, stop, or join', async () => {
  const config = {
    segments: [
      { name: 'bugs', passes: 1 },
      { name: 'tests', enabled: false },
      { name: 'infra', title: 'Infrastructure', files: ['.github/**', '**/*.tf'], note: 'Check the runners.' },
    ],
  }
  const prompts = {}
  const answer = (label, prompt) => {
    prompts[label] = prompt
    if (label === 'infra') return { findings: [] }
    return review(label)
  }
  const { labels } = await run('pr-review.js', { ...BASE, config, changed: ['src/a.rs', '.github/ci.yml'] }, answer)
  assert.deepEqual(ran(labels, ['bugs', 'security', 'tests', 'design', 'docs', 'infra']), ['bugs', 'security', 'design', 'docs', 'infra'])
  // One pass, so one bugs agent over the whole change.
  assert.ok(labels.includes('bugs') && !labels.some((l) => l.startsWith('bugs ')))
  assert.ok(prompts.infra.includes('You are the Infrastructure reviewer') && prompts.infra.includes('Check the runners.'))
  // Without settings for the knowledge base, the default reads it through ToolSearch.
  assert.ok(prompts.context.includes('use ToolSearch with the query "knowledge base"'))
  // The names mode, which the tuning routine reads, lists the segments the settings run.
  const names = await run('pr-review.js', { mode: 'names', config }, () => assert.fail('an agent in names mode'))
  assert.deepEqual(names.result.segments, ['bugs', 'security', 'design', 'docs', 'infra'])
})

test('the knowledge base is read through the skill the settings name, or not at all', async () => {
  const prompts = {}
  const keep = (label, prompt) => {
    prompts[label] = prompt
    return label === 'context' ? { ...review('context'), knowledge_base_read: false } : review(label)
  }
  const named = await run('pr-review.js', BASE, keep)
  assert.ok(prompts.context.includes('Read the knowledge base for the changed paths: load the docs-index skill with the Skill tool'))
  assert.ok(named.result.summary.bottom.includes('the knowledge base was not read, so this review read only the repository.'))
  const off = await run('pr-review.js', { ...BASE, config: { ...CONFIG, knowledge_base: false } }, keep)
  assert.ok(!prompts.context.includes('knowledge base for'))
  assert.ok(!off.result.summary.bottom.includes('was not read'))
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
  ]) {
    const { result, labels } = await run('pr-review.js', { ...BASE, config }, review)
    assert.ok(result.error && result.error.startsWith("The review's settings are invalid: "), JSON.stringify(config))
    assert.ok(result.error.includes(message), `${result.error} / ${message}`)
    assert.deepEqual(labels, [])
  }
})

test('without settings in the args, the review loads them from config_file', async () => {
  const file = (text) => (label) => (label === 'load settings' ? (text === null ? null : { text }) : review(label))
  const args = { pr: 5, repo: 'o/r', threads: '/t.json', config_file: '.claude/review.json' }
  const loaded = await run('pr-review.js', args, file(JSON.stringify({ ...CONFIG, examples: [{ changed: [], segments: [] }] })))
  assert.equal(loaded.labels[0], 'load settings')
  assert.deepEqual(ran(loaded.labels), SEGMENTS)
  assert.equal(loaded.options['load settings'].model, 'claude-haiku-5-5')
  // A missing file is no settings, so the defaults run.
  const empty = await run('pr-review.js', args, file(''))
  assert.deepEqual(ran(empty.labels), ['bugs', 'security', 'tests', 'design', 'docs'])
  assert.match((await run('pr-review.js', args, file('{'))).result.error, /^\.claude\/review\.json is not JSON: /)
  // JSON that is not an object is settings that are not valid.
  assert.match((await run('pr-review.js', args, file('null'))).result.error, /settings are invalid: they are not a JSON object/)
  assert.equal((await run('pr-review.js', args, file(null))).result.error, 'could not load the settings from .claude/review.json')
})

test('without a brief from the context stage, the changed code still gets a bugs pass and the review is partial', async () => {
  const prompts = {}
  const args = { ...BASE, base: SHA('b'), head: SHA('h'), changed: ['src/a.rs', 'web/x.tsx', 'docs/y.md'] }
  const { result } = await run('pr-review.js', args, (label, prompt) => {
    prompts[label] = prompt
    return label === 'context' ? null : review(label)
  })
  const own = prompts['bugs 1.1'].split("Read the area's files in this order, ")[1].split(': ')[1].split('. Report what')[0]
  assert.deepEqual(own.split(', ').sort(), ['src/a.rs', 'web/x.tsx'])
  assert.equal(result.partial, true)
  assert.deepEqual(result.marker.failed, ['context'])
  // Without the args' base, head, and files there is nothing to review.
  const bare = await run('pr-review.js', BASE, (label) => (label === 'context' ? null : review(label)))
  assert.deepEqual(bare.labels, ['context'])
  assert.deepEqual(bare.result.failed, ['context'])
})

test('changed code files no area lists still get a bugs pass', async () => {
  const area = (n, files) => ({ name: `area ${n}`, files })
  for (const [areas, pass, passes] of [
    // A new area while there is room, else the last area takes them.
    [[area(1, ['src/a.rs'])], 'bugs 2.1', 4],
    [[1, 2, 3, 4].map((n) => area(n, [`src/${n}.rs`])), 'bugs 4.1', 8],
  ]) {
    const prompts = {}
    await run('pr-review.js', BASE, (label, prompt) => {
      prompts[label] = prompt
      return label === 'context' ? { ...review('context'), areas } : review(label)
    })
    // The pass's own reading order, not the brief every prompt embeds.
    const own = prompts[pass].split("Read the area's files in this order, ")[1].split(': ')[1].split('. Report what')[0]
    assert.ok(own.split(', ').includes('web/x.tsx'), pass)
    assert.equal(Object.keys(prompts).filter((l) => l.startsWith('bugs ')).length, passes, pass)
  }
})

test('a two-pass segment reviews only the areas that hold its files, or its files as one area', async () => {
  const config = { ...CONFIG, segments: [...CONFIG.segments, { name: 'notes', files: ['@prose'], passes: 2 }] }
  const { labels, result } = await run('pr-review.js', { ...BASE, config }, (label) =>
    label.startsWith('notes ') ? { findings: [] } : review(label),
  )
  // No area holds docs/y.md, so it is the one area; bugs keeps its two code areas.
  assert.deepEqual(labels.filter((l) => l.startsWith('notes ')).sort(), ['notes 1.1', 'notes 1.2'])
  assert.equal(labels.filter((l) => l.startsWith('bugs ')).length, 4)
  assert.ok(result.summary.bottom.includes('| Notes | Ran: 2 passes over 1 area |'), result.summary.bottom)
  assert.ok(result.summary.bottom.includes('| Bugs | Ran: 4 passes over 2 areas |'), result.summary.bottom)
})

test("a replay's two-pass segment reviews the area of its case's file, even one that holds none of the segment's files", async () => {
  const c = { id: 'f5', pr: 5, head: 'h5', base: 'b5', segment: 'bugs', expect: 'find', issue: 'i', path: 'docs/y.md', line: 1 }
  const prompts = {}
  const { labels } = await run('pr-review.js', { mode: 'eval', config: CONFIG, cases: [c] }, (label, prompt) => {
    prompts[label] = prompt
    return label.startsWith('judge ') ? { matched: false, reason: 'r' } : review(label.replace(/^#\d+ /, ''))
  })
  assert.deepEqual(labels.filter((l) => l.startsWith('#5 bugs ')).sort(), ['#5 bugs 1.1', '#5 bugs 1.2'])
  assert.ok(prompts['#5 bugs 1.1'].includes('You review one area, "cases", in pass 1 of 2'), prompts['#5 bugs 1.1'])
  assert.ok(prompts['#5 bugs 1.1'].includes('following each call outward: docs/y.md.'), prompts['#5 bugs 1.1'])
})

test("an issue's location links to its line, in a Markdown file's source too", async () => {
  const listed = (path) => ({ keys: [], severity: 'nit', path, line: 7, title: path, why: 'open-thread', thread_url: `https://x/${path}` })
  const { result } = await run('pr-review.js', BASE, (label) =>
    label === 'editor' ? { ...review('editor'), summary_only: [listed('docs/y.md'), listed('src/c.rs')] } : review(label),
  )
  // GitHub renders Markdown, which has no line anchors, unless plain=1 asks for its source.
  const where = result.summary.issues.map((i) => i.where)
  for (const path of ['docs/y.md', 'src/c.rs']) assert.ok(where.includes(`[\`${path}:7\`](https://github.com/o/r/blob/${SHA('h')}/${path}?plain=1#L7)`), path)
})

test('the summary heads with the confidence score, draws the diagram, and names the comment of each posted issue', async () => {
  const post = (line, severity) => ({ keys: [], slug: `s${line}`, path: 'src/a.rs', line, severity, title: `t${line}`, body: 'b', trace: 't' })
  const editor = (diagram) => ({ ...review('editor'), diagram, post: [post(3, 'nit'), post(5, 'preexisting')] })
  const answer = (diagram) => (label) => (label === 'editor' ? editor(diagram) : review(label))
  const { result } = await run('pr-review.js', BASE, answer('```mermaid\nflowchart LR\n  A --> B\n```'))
  const { top, issues } = result.summary
  assert.ok(top.startsWith('## Claude review · Confidence to merge: 4/5\n'), top)
  // The job's fence wraps the diagram once, though the editor wrote its own.
  assert.ok(top.endsWith('<details open><summary><h3>Diagram</h3></summary>\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n</details>'), top)
  // The job links a posted issue to the comment GitHub takes, and a listed
  // one to its thread.
  assert.deepEqual(issues.map((i) => [i.title, i.comment, i.link]), [
    ['t3', 0, undefined],
    ['t5', 1, undefined],
    ['raised in a thread', undefined, 'https://x/t9'],
  ])
  assert.equal(issues[1].badge, '<img alt="Pre-existing" src="https://img.shields.io/badge/Pre--existing-8250df?style=flat" align="top">')
  // A fence inside the source would end the diagram early; without a
  // diagram, the summary has no Diagram part.
  for (const diagram of ['flowchart LR\n```\nA', '', undefined]) {
    const other = await run('pr-review.js', BASE, answer(diagram))
    assert.ok(!other.result.summary.top.includes('Diagram'), String(diagram))
  }
})

test('a finding on a file the pull request does not change goes on its anchor, and says where it is', async () => {
  const anchor = { path: 'docs/y.md', line: 3 }
  const finding = (path, more) => ({ keys: [], slug: path, path, line: 9, severity: 'important', title: path, body: 'b', trace: 't', suggestion: 'new\n', ...more })
  const prompts = {}
  const { result } = await run('pr-review.js', BASE, (label, prompt) => {
    prompts[label] = prompt
    return label === 'editor' ? { ...review('editor'), post: [
      finding('README.md', { anchor }),
      finding('src/a.rs', { anchor, start_line: 7 }),
      finding('notes.md'),
      finding('other.md', { anchor: { path: 'notes.md', line: 1 } }),
    ] } : review(label)
  })
  // The editor learns which files GitHub takes comments on.
  assert.ok(prompts.editor.includes('src/a.rs, web/x.tsx, docs/y.md'))
  const [moved, changed, ...kept] = result.comments
  // README.md is not in the diff, so the comment goes on the changed line
  // that makes it true. Its suggestion is plain code, since GitHub would apply
  // it to that line, and the summary keeps it at its own line.
  assert.deepEqual([moved.path, moved.line, moved.start_line, moved.side], ['docs/y.md', 3, undefined, 'RIGHT'])
  assert.ok(moved.body.startsWith(`${IMPORTANT} **README.md**\n\nOn [\`README.md:9\`](https://github.com/o/r/blob/${SHA('h')}/README.md?plain=1#L9), which this pull request does not change.\n\nb\n`))
  assert.ok(moved.body.includes('Suggested text for that line:\n```\nnew\n```') && !moved.body.includes('```suggestion'))
  assert.deepEqual([moved.carry.path, moved.carry.line], ['README.md', 9])
  // A finding on a changed file stays on its lines. One without an anchor in
  // the diff stays too, for the job to try and then list in the summary.
  assert.deepEqual([changed.path, changed.line, changed.start_line], ['src/a.rs', 9, 7])
  assert.ok(changed.body.includes('```suggestion\nnew\n```'))
  assert.deepEqual(kept.map((c) => [c.path, c.line]), [['notes.md', 9], ['other.md', 9]])
})

test('the summary keeps each entry under its id until a fix or an answer, whichever segments run, once each', async () => {
  const entry = (id, title, more = {}) => ({ ...(id ? { id } : {}), severity: 'nit', path: 'src/b.rs', line: 4, title, note: 'n', from: SHA('c'), ...more })
  const prompts = {}
  const { result } = await run(
    'pr-review.js',
    {
      ...BASE, since: SHA('a'), reviewed: SHA('a'), changed_since: ['README.md'],
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
    (label, prompt) => {
      prompts[label] = prompt
      if (label === 'follow-up') return { threads: [{ id: 'T1', title: 'raised by an open thread', state: 'open', url: 'https://x/t10', path: 'src/b.rs', line: 4 }] }
      if (label !== 'editor') return review(label)
      const listed = { keys: [], severity: 'nit', path: 'src/d.rs', line: 1 }
      return {
        ...review('editor'),
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
  )
  // Every earlier segment ran again or not, the editor hears of every entry,
  // and one from before ids gets the next free one.
  assert.ok(prompts.editor.includes('"id": "S10"') && prompts.editor.includes('from before ids'))
  assert.deepEqual(result.marker.carried.map((c) => [c.id, c.title]), [
    ['S5', 'listed again, reworded'],
    ['S8', 'raised in a thread'],
    ['S11', 'new'],
    ['S1', 'kept as it is'],
    ['S4', 'declined important'],
    ['S10', 'from before ids'],
  ])
  const notes = Object.fromEntries(result.summary.issues.map((i) => [i.title, i.note]))
  assert.equal(notes['listed again, reworded'], 'S5: over the cap of five Nits')
  // A finding of one class lists its other places.
  assert.equal(notes.new, 'S11: over the cap of five Nits; also at `src/e.rs:2`')
  assert.deepEqual(result.marker.carried.find((c) => c.id === 'S11').places, ['src/e.rs:2'])
  assert.equal(notes['kept as it is'], 'S1: n, from the review of `ccccccc`')
  // A blocking entry whose answer does not hold stays, and a person decides;
  // a fixed one and an answered Nit move to the earlier findings.
  assert.equal(notes['declined important'], 'S4: n, answered, disputed: a person decides, from the review of `ccccccc`')
  assert.ok(result.summary.top.includes('**1 disputed finding: a person decides.**'))
  assert.ok(result.summary.bottom.includes('- Fixed in ddddddd: S2 fixed since'))
  assert.ok(result.summary.bottom.includes('- Answered: S3 answered nit. r'))
  // One found again that the author answered with a reason that holds is
  // settled too, though the editor listed it.
  assert.ok(result.summary.bottom.includes('- Answered: S7 answered and found again\n'))
  assert.ok(!('answered and found again' in notes))
  assert.equal(result.summary.issues.filter((i) => i.link === 'https://x/t9').length, 1)
  // An entry the editor finds raised by an open thread is that thread's row
  // only.
  assert.equal(result.summary.issues.filter((i) => i.title === 'raised by an open thread').length, 1)
  // What GitHub may refuse to take inline keeps the id of the entry it posts,
  // which its row shows if GitHub refuses it, and no id is given twice.
  assert.equal(result.comments[0].carry.id, 'S6')
  assert.equal(result.summary.issues.find((i) => i.comment === 0).id, 'S6')
  assert.equal(result.marker.last_id, 11)
})

test('a settled id is not given again, and a new comment gets an id of its own', async () => {
  const { result } = await run('pr-review.js', { ...BASE, carried: [], last_id: 4 }, (label) =>
    label === 'editor'
      ? {
          ...review('editor'),
          post: [{ keys: [], slug: 'p', path: 'src/a.rs', line: 3, severity: 'important', title: 'posted', body: 'b', trace: 't', places: ['src/c.rs:8'] }],
          summary_only: [{ keys: [], severity: 'nit', path: 'src/d.rs', line: 1, title: 'listed', why: 'nit-cap' }],
        }
      : review(label),
  )
  assert.deepEqual(result.marker.carried.map((c) => c.id), ['S5'])
  assert.deepEqual([result.comments[0].carry.id, result.comments[0].carry.places], ['S6', ['src/c.rs:8']])
  assert.equal(result.marker.last_id, 6)
})

test('a fixed thread gets a line that names its commit, a person gets an answer, and settled threads are resolved', async () => {
  const followed = {
    threads: [
      { id: 'T1', title: 't', state: 'fixed', commit: SHA('d'), note: 'n' },
      { id: 'T2', title: 't', state: 'fixed', answer: ' The empty list is covered too. ' },
      { id: 'T3', title: 't', severity: 'important', state: 'answered', holds: true, answer: 'Agreed: the caller checks it.' },
      { id: 'T4', title: 't', state: 'open', answer: 'Not for an empty list.' },
      { id: 'T5', title: 't', state: 'open', answer: ' ' },
      // A blocking finding stays open while the author's reason does not
      // hold, or the follow-up does not say that it holds, and the answer
      // says a person decides; a thread with no answer, such as after
      // thanks, gets no reply.
      { id: 'T6', title: 'declined important', severity: 'important', state: 'answered', holds: false, answer: 'It still fails for an empty list.' },
      { id: 'T9', title: 't', state: 'answered', holds: false },
      { id: 'T12', title: 't', severity: 'important', state: 'answered' },
      // The author's answer settles a finding that does not block the merge.
      { id: 'T10', title: 'declined nit', severity: 'nit', state: 'answered', holds: false },
      { id: 'T11', title: 't', severity: 'preexisting', state: 'answered', holds: false, answer: 'It still fails for an empty list.' },
    ],
  }
  const prompts = {}
  const { result } = await run('pr-review.js', { ...BASE, reviewer: 'review-bot', fixed_before: ['T7', 'T8'] }, (label, prompt) => {
    prompts[label] = prompt
    return label === 'follow-up' ? followed : review(label)
  })
  // The job decides which part each thread may get (src/post.rs): a thread
  // with nothing to say or do gets no entry.
  assert.deepEqual(result.replies, [
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
  assert.ok(result.summary.issues.some((i) =>
    i.badge === IMPORTANT && i.title === 'declined important' && i.where === '-' &&
    i.note === 'open thread from an earlier review, disputed: a person decides'))
  assert.ok(result.summary.top.includes('**3 disputed findings: a person decides.**'))
  assert.ok(!result.summary.bottom.includes('Answered: declined important'))
  assert.ok(result.summary.bottom.includes('- Answered: declined nit'))
  // The follow-up takes the threads of the reviewer the job posts as, and
  // answers by the rules.
  assert.ok(prompts['follow-up'].includes('with author login "review-bot"'))
  assert.ok(prompts['follow-up'].includes('"Later reviews" in REVIEW.md'))
  // It learns which threads have the "Fixed" reply from the job, not from the
  // reply text, which an answer can start the same way.
  assert.ok(prompts['follow-up'].includes('These threads have a "Fixed" reply from review-bot, so they were fixed before: T7, T8.'))
})

test('the skeptics decide what is kept, and the earlier entries stay when the editor fails', async () => {
  const finding = (line, title) => ({ path: 'src/a.rs', line, severity: 'important', title, body: 'b', trace: 't' })
  // Skeptic verdicts by line, and whether the skeptic calls the finding one
  // about security or privacy; the skeptics of lines 7 and 8 fail.
  const verdicts = { 3: ['unsure'], 4: ['confirmed'], 5: ['confirmed'], 6: ['unsure'], 9: ['unsure', true], 10: ['refuted', true] }
  const answer = (label) => {
    if (label === 'security') {
      return { findings: [finding(3, 'security unsure'), finding(8, 'security unchecked'), finding(10, 'security refuted')] }
    }
    // The design segment also finds its earlier entry again, at the same place
    // with the same title.
    if (label === 'design') {
      const again = { ...finding(4, 'design earlier'), path: 'src/b.rs' }
      return { findings: [finding(5, 'design confirmed'), finding(6, 'design unsure'), finding(9, 'design privacy unsure'), again] }
    }
    if (label === 'rust') return { findings: [finding(7, 'rust unchecked')] }
    // One of the bugs segment's two passes fails, and so does the whole tests segment.
    if (label === 'tests' || label === 'bugs 1.2' || label === 'editor') return null
    if (label.startsWith('verify ')) {
      const [verdict, privacy = false] = verdicts[label.split(':').pop()] || []
      return verdict ? { verdict, severity: 'important', reason: 'r', trace: 't', security_or_privacy: privacy } : null
    }
    return review(label)
  }
  const earlier = (segment) => ({ segments: [segment], severity: 'nit', path: 'src/b.rs', line: 4, title: `${segment} earlier`, note: 'n', from: SHA('c') })
  const { result } = await run(
    'pr-review.js',
    {
      ...BASE, since: SHA('a'), reviewed: SHA('a'), changed_since: ['src/a.rs'],
      carried: ['bugs', 'tests', 'rust', 'design', 'security'].map(earlier),
    },
    answer,
  )
  assert.equal(result.marker.partial, true)
  assert.deepEqual([...result.marker.failed].sort(), ['bugs', 'editor', 'rust', 'security', 'tests'])
  // Without the editor, the marker keeps every earlier entry and every new
  // finding, so one the next review misses stays listed; the one found again
  // at the same place with the same title keeps its entry's id.
  assert.deepEqual(result.marker.carried.map((c) => `${c.id} ${c.title}`).sort(), [
    'S1 bugs earlier', 'S2 tests earlier', 'S3 rust earlier', 'S4 design earlier', 'S5 security earlier',
    'S6 security unsure', 'S7 security unchecked', 'S8 design confirmed', 'S9 design privacy unsure',
  ])
  assert.equal(result.marker.last_id, 9)
  // Nothing is posted, and the summary, with no score or diagram, says why
  // and lists each of those findings with why it is there, none linked to a
  // comment.
  assert.deepEqual(result.comments, [])
  const { top, issues } = result.summary
  assert.ok(top.startsWith('## Claude review\n\n> [!WARNING]\n> This review is incomplete: '), top)
  assert.ok(top.includes('**9 findings, listed below and not posted, because the editor did not finish**'), top)
  assert.doesNotMatch(top, /Confidence to merge|Diagram/)
  // The summary lists every kept finding and every earlier entry once: an
  // unsure finding stays only for security or privacy, an unchecked one only
  // for security, and a refuted one never. The earlier entries, which had no
  // ids, take the first ones.
  const unverified = 'unverified: the skeptic could not settle it'
  const from = 'n, from the review of `ccccccc`'
  assert.deepEqual(issues.map((i) => [i.title, i.note, 'comment' in i]), [
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

test('a finding keeps the other places of its pattern that its skeptic confirms, and its comment lists them', async () => {
  const finding = { path: 'src/a.rs', line: 5, severity: 'important', title: 'unchecked', body: 'b', trace: 't', places: ['src/a.rs:9', 'src/b.rs:2'] }
  const prompts = {}
  const { result } = await run('pr-review.js', BASE, (label, prompt) => {
    prompts[label] = prompt
    if (label === 'design') return { findings: [finding] }
    if (label.startsWith('verify design')) return { verdict: 'confirmed', severity: 'important', reason: 'r', trace: 't', places: ['src/b.rs:2'], security_or_privacy: false }
    if (label === 'editor') return { ...review('editor'), summary_only: [], earlier: [], post: [{ ...finding, places: ['src/b.rs:2'], keys: ['design-1'], slug: 'u' }] }
    return review(label)
  })
  // The editor gets the places the skeptic confirmed, not the finder's.
  assert.ok(prompts.editor.includes('"src/b.rs:2"') && !prompts.editor.includes('src/a.rs:9'))
  assert.ok(result.comments[0].body.includes('b\n\nThe same problem is also at:\n- `src/b.rs:2`\n'))
  // A skeptic that confirms the finding and lists no places confirms none.
  const bare = {}
  await run('pr-review.js', BASE, (label, prompt) => {
    bare[label] = prompt
    if (label === 'design') return { findings: [finding] }
    if (label.startsWith('verify design')) return { verdict: 'confirmed', severity: 'important', reason: 'r', trace: 't', security_or_privacy: false }
    return review(label)
  })
  assert.ok(bare.editor.includes('"title": "unchecked"') && !bare.editor.includes('src/a.rs:9') && !bare.editor.includes('src/b.rs:2'))
})

// A repository of three areas: a Rust API, a web app, and its docs.
function sweeping(more = {}) {
  const prompts = {}
  const finding = (path, title) => ({ path, line: 2, severity: 'important', title, body: 'b', trace: 't' })
  const answer = (label, prompt) => {
    prompts[label] = prompt
    if (label === 'scope') {
      return {
        head: SHA('s'), rules: [], risks: [], knowledge_base: '', knowledge_base_read: true,
        areas: [
          { name: 'api', files: ['src/a.rs', 'src/b.rs', 'src/'], why: 'changed since' },
          { name: 'web', files: ['web/x.tsx', 'web/README.md'], why: 'not covered yet' },
          { name: 'docs', files: ['docs/y.md'], why: 'not covered yet' },
        ],
      }
    }
    if (label === 'bugs @1') return { findings: [finding('src/a.rs', 'api bug')] }
    if (label === 'web @2') return { findings: [finding('web/x.tsx', 'web bug'), finding('web/x.tsx', 'web doubt')] }
    if (label.startsWith('@2 verify web') && prompt.includes('web doubt')) return { verdict: 'refuted', severity: 'important', reason: 'r', trace: 't', security_or_privacy: false }
    if (label.includes(' verify ')) return { verdict: 'confirmed', severity: 'important', reason: 'r', trace: 't', security_or_privacy: false }
    if (label === 'editor') {
      return {
        overview: 'Two bugs.', dropped: [],
        findings: [{ ...finding('src/a.rs', 'api bug'), keys: ['bugs-1', 'web-2'] }],
      }
    }
    if (/ @\d$/.test(label)) return { findings: [] }
    if (more[label] !== undefined) return more[label]
    throw new Error(`no answer for ${label}`)
  }
  return { prompts, answer }
}

test('a sweep reviews each area with the segments that apply to it, verifies, and merges what it found', async () => {
  const { prompts, answer } = sweeping()
  const { result, labels } = await run('pr-review.js', { mode: 'sweep', repo: 'o/r', config: CONFIG, since: '2026-10-01', covered: ['docs'] }, answer)
  const finders = labels.filter((l) => / @\d$/.test(l)).sort()
  assert.deepEqual(finders, [
    'bugs @1', 'bugs @2', 'design @1', 'design @2', 'design @3', 'docs @1', 'docs @2', 'docs @3',
    'rust @1', 'security @1', 'security @2', 'security @3', 'tests @1', 'tests @2', 'web @2',
  ])
  // The scope stage hears what to put first and last.
  assert.ok(prompts.scope.includes('git log --name-only --format= --since=2026-10-01'))
  assert.ok(prompts.scope.includes('Earlier sweeps covered these areas, so they come last: docs.'))
  assert.ok(prompts['bugs @1'].includes("The area's files: src/a.rs, src/b.rs."))
  // A sweep has no diff or description, so a segment gives its sweep note, or its note without one.
  assert.ok(prompts['design @1'].includes('Compare the code with the documents that describe it'))
  assert.ok(!prompts['design @1'].includes('claims in the brief'))
  assert.ok(prompts['docs @1'].includes("Check that the links in the area's documents lead to files that exist."))
  assert.ok(!prompts['docs @1'].includes('--name-status'))
  assert.ok(prompts['security @1'].includes('Follow data that crosses a trust boundary'))
  assert.equal(result.mode, 'sweep')
  assert.equal(result.head, SHA('s'))
  assert.equal(result.partial, false)
  // The editor merged the two kept findings; the refuted one never reached it.
  assert.deepEqual(result.findings.map((f) => [f.title, f.segments, f.areas, f.verdict]), [['api bug', ['bugs', 'web'], ['api', 'web'], 'confirmed']])
  assert.ok(!prompts.editor.includes('web doubt'))
  assert.ok(result.summary.startsWith('## Sweep of `sssssss`'))
  assert.ok(result.summary.includes(`[\`src/a.rs:2\`](https://github.com/o/r/blob/${SHA('s')}/src/a.rs?plain=1#L2)`))
})

test('a sweep reviews at most max_areas areas, and says what did not finish', async () => {
  const { answer } = sweeping()
  const failing = (label, prompt) => (label === 'security @1' ? null : answer(label, prompt))
  const { result, labels } = await run('pr-review.js', { mode: 'sweep', config: CONFIG, max_areas: 2 }, failing)
  assert.ok(!labels.some((l) => l.endsWith(' @3')))
  assert.deepEqual(result.areas.map((a) => a.name), ['api', 'web'])
  assert.equal(result.partial, true)
  assert.deepEqual(result.failed, ['security in api'])
  // The settings' max_areas applies when the args name none.
  const capped = await run('pr-review.js', { mode: 'sweep', config: { ...CONFIG, sweep: { max_areas: 1 } } }, answer)
  assert.deepEqual(capped.result.areas.map((a) => a.name), ['api'])
  assert.ok(capped.result.summary.includes('- api (2 files): changed since'))
})

test('a sweep with nothing to fix runs no editor, and one without a scope stops', async () => {
  const quiet = (label, prompt) => (label === 'bugs @1' || label === 'web @2' ? { findings: [] } : sweeping().answer(label, prompt))
  const { result, labels } = await run('pr-review.js', { mode: 'sweep', config: CONFIG }, quiet)
  assert.ok(!labels.includes('editor'))
  assert.deepEqual(result.findings, [])
  assert.ok(result.summary.includes('The sweep found nothing to fix.'))
  const failed = await run('pr-review.js', { mode: 'sweep', config: CONFIG }, () => null)
  assert.deepEqual(failed.result, { mode: 'sweep', error: 'The scope stage failed.' })
})

test('a capped eval keeps the newest pull requests\' cases, with at least half the segment runs for each kind', async () => {
  const c = (expect, pr, more = {}) => ({ id: `${expect[0]}${pr}`, pr, head: `h${pr}`, base: `b${pr}`, segment: 'bugs', expect, issue: 'i', path: 'src/a.rs', line: 1, ...more })
  for (const [max, only, cases, kept] of [
    [3, undefined, [c('find', 50), c('find', 10), c('quiet', 5), c('find', 60)], ['f50', 'f60', 'q5']],
    [4, undefined, [c('quiet', 1), c('quiet', 2), c('quiet', 3), c('find', 4), c('find', 5), c('find', 6)], ['f5', 'f6', 'q2', 'q3']],
    [2, undefined, [c('quiet', 1), c('quiet', 2), c('quiet', 3)], ['q2', 'q3']],
    // A quiet case runs both segments under test; a case at a pull request
    // commit and segment another case already runs costs nothing more.
    [4, ['bugs', 'design'], [c('quiet', 7), c('quiet', 8), c('find', 9), c('find', 10), c('find', 9, { id: 'f9b' })], ['f10', 'f9', 'f9b', 'q8']],
    // Two pull requests at one commit replay it twice.
    [1, undefined, [c('find', 5, { head: 'hx' }), c('find', 6, { head: 'hx' })], ['f6']],
  ]) {
    const { result } = await run(
      'pr-review.js',
      { mode: 'eval', config: CONFIG, max_segment_runs: max, only, cases },
      (label) => (label.startsWith('judge ') ? { matched: true, reason: 'r' } : review(label.replace(/^#\d+ /, ''))),
    )
    assert.deepEqual(result.rows.map((r) => r.id).sort(), kept, `max ${max}`)
    assert.deepEqual(result.dropped.sort(), cases.map((x) => x.id).filter((id) => !kept.includes(id)).sort(), `max ${max}`)
  }
})

test('an eval case whose replay throws stays as an unscored row', async () => {
  const find = (pr) => ({ id: `f${pr}`, pr, head: `h${pr}`, base: `b${pr}`, segment: 'bugs', expect: 'find', issue: 'i', path: 'src/a.rs', line: 1 })
  const answer = (label) => {
    if (label === '#6 context') throw new Error('replay broke')
    return label.startsWith('judge ') ? { matched: true, reason: 'r' } : review(label.replace(/^#\d+ /, ''))
  }
  const { result, options } = await run('pr-review.js', { mode: 'eval', config: CONFIG, cases: [find(6), find(7)] }, answer)
  assert.deepEqual(result.rows.map((r) => r.id), ['f6', 'f7'])
  assert.deepEqual(result.unscored, [{ id: 'f6', why: 'replay failed' }])
  assert.equal(result.found, '1 of 1')
  assert.deepEqual([options['judge f7'].model, options['judge f7'].effort], ['claude-sonnet-5-5', 'low'])
})

test('an eval replay starts no agent past its cap, and the cases left without one stay unscored', async () => {
  const find = (pr) => ({ id: `f${pr}`, pr, head: `h${pr}`, base: `b${pr}`, segment: 'bugs', expect: 'find', issue: 'i', path: 'src/a.rs', line: 1 })
  // Every pass finds something, so each finding also gets a skeptic.
  const answer = (label) => {
    const name = label.replace(/^#\d+ /, '')
    if (name.startsWith('judge ')) return { matched: true, reason: 'r' }
    if (name.startsWith('bugs ')) return { findings: [{ path: 'src/a.rs', line: 1, severity: 'nit', title: 't', body: 'b', trace: 't' }] }
    if (name.startsWith('verify ')) return { verdict: 'confirmed', severity: 'nit', reason: 'r', trace: 't', security_or_privacy: false }
    return review(name)
  }
  const cases = [find(1), find(2), find(3)]
  const whole = await run('pr-review.js', { mode: 'eval', config: CONFIG, cases }, answer)
  assert.equal(whole.result.agents, whole.labels.length)
  assert.equal(whole.result.found, '3 of 3')
  const max = whole.labels.length - 1
  const capped = await run('pr-review.js', { mode: 'eval', config: CONFIG, cases, max_agents: max }, answer)
  assert.equal(capped.labels.length, max)
  assert.equal(capped.result.agents, max)
  assert.equal(capped.result.rows.length, 3)
  assert.equal(capped.result.unscored.length, 1)
})

test("a find case with a severity has the judge check it, and the judge sees each finding's severity and places", async () => {
  const find = (id, more = {}) => ({ id, pr: 3, head: 'h3', base: 'b3', segment: 'bugs', expect: 'find', issue: 'i', path: 'src/a.rs', line: 1, ...more })
  const prompts = {}
  const answer = (label, prompt) => {
    const name = label.replace(/^#\d+ /, '')
    prompts[name] = prompt
    if (name.startsWith('judge ')) return { matched: true, reason: 'r' }
    if (name.startsWith('bugs ')) return { findings: [{ path: 'src/a.rs', line: 1, severity: 'nit', title: 't', body: 'b', trace: 't', places: ['src/b.rs:2'] }] }
    if (name.startsWith('verify ')) return { verdict: 'confirmed', severity: 'nit', reason: 'r', trace: 't', places: ['src/b.rs:2'], security_or_privacy: false }
    return review(name)
  }
  await run('pr-review.js', { mode: 'eval', config: CONFIG, cases: [find('graded', { expect_severity: 'important' }), find('plain')] }, answer)
  assert.ok(prompts['judge graded'].includes('must have severity important'))
  assert.ok(!prompts['judge plain'].includes('must have severity'))
  assert.ok(prompts['judge plain'].includes('"severity": "nit"') && prompts['judge plain'].includes('"src/b.rs:2"'))
})

test('a quiet case replays the segments under test, breaks on their claim, and is not counted where they do not apply', async () => {
  const quiet = (pr, segment) => ({ id: `q${pr}`, pr, head: `h${pr}`, base: `b${pr}`, segment, expect: 'quiet', issue: 'i', path: 'src/a.rs', line: 1 })
  const answer = (label, prompt) => {
    // Pull request 8 changes only prose, so the design segment does not apply.
    if (label === '#8 context') return { ...review('context'), files: ['README.md'], areas: [] }
    const name = label.replace(/^#\d+ /, '')
    if (name === 'design') return { findings: [{ path: 'src/a.rs', line: 1, severity: 'nit', title: 'the wrong claim', body: 'b', trace: 't' }] }
    if (name.startsWith('verify ')) return { verdict: 'confirmed', severity: 'nit', reason: 'r', trace: 't' }
    if (name.startsWith('judge ')) return { matched: prompt.includes('the wrong claim'), reason: 'r' }
    return review(name)
  }
  const { result, labels } = await run('pr-review.js', { mode: 'eval', config: CONFIG, only: ['design'], cases: [quiet(9, 'bugs'), quiet(8, 'docs')] }, answer)
  assert.deepEqual(ran(labels.map((l) => l.replace(/^#\d+ /, ''))), ['design'])
  assert.deepEqual(result.rows.map((r) => [r.id, r.matched]), [['q9', true]])
  assert.equal(result.cases, 1)
  assert.deepEqual(result.not_applicable.map((r) => r.id), ['q8'])
})

test('tuning opens a pull request for new cases, or when the eval scores better and no quiet case breaks', async () => {
  let guard
  let kind
  const tuning = (label) => {
    if (label === 'load settings') return { text: JSON.stringify({ ...CONFIG, examples: [] }) }
    if (label === 'merged PRs') return { prs: [70] }
    if (label === '#70') return { findings: [], misses: [{ url: 'u', reviewer: 'cursor', segment: 'bugs', kind: 'k', path: 'src/a.rs', line: 3, head: 'h', issue: 'i', fix: 'f' }] }
    if (label === 'propose') {
      return { changes: [{ kind, segment: 'bugs', text: 't', evidence: ['u'] }], new_cases: [], affected: ['bugs'], rationale: 'r' }
    }
    if (label === 'draft') return { review: 'o/REVIEW.candidate.md', evals: 'o/evals.json', pr_dir: 'o/prs' }
    if (label === 'guard') return guard
    throw new Error(`no answer for ${label}`)
  }
  const row = (id, expect, matched) => ({ id, expect, matched })
  // Without the change, f1 and q1 come out right.
  const without = [row('f1', 'find', true), row('f2', 'find', false), row('f3', 'find', false), row('q1', 'quiet', false)]
  const rules = { ok: true, violations: [], diff: '+t', cases_added: 0 }
  for (const [name, drafted, withChange, decision, changeKind = 'segment-check'] of [
    ['adds only cases', { ...rules, diff: '', cases_added: 1 }, null, 'open-pr'],
    ['changes nothing', { ...rules, diff: '' }, null, 'no-change'],
    ['breaks a rule of the loop', { ...rules, ok: false, violations: ['v'] }, null, 'rejected'],
    ['finds one more', rules, [row('f1', 'find', true), row('f2', 'find', true), row('f3', 'find', false), row('q1', 'quiet', false)], 'open-pr'],
    ['finds one more with a Learned row', rules, [row('f1', 'find', true), row('f2', 'find', true), row('f3', 'find', false), row('q1', 'quiet', false)], 'open-pr', 'learned-row'],
    ['scores the same', rules, without, 'no-gain'],
    ['finds two more but breaks a quiet case', rules, [row('f1', 'find', true), row('f2', 'find', true), row('f3', 'find', true), row('q1', 'quiet', true)], 'no-gain'],
    ['finds one more but scores too few cases', rules, [row('f1', 'find', true), row('f2', 'find', true), row('f3', 'find', undefined), row('q1', 'quiet', false)], 'inconclusive'],
  ]) {
    guard = drafted
    kind = changeKind
    let replays = 0
    let replayAgents = 0
    const workflow = async (ref, a) => {
      assert.equal(ref.scriptPath, 'engine/pr-review.js', name)
      // The settings were read once, without their examples, for every run.
      assert.deepEqual(a.config, CONFIG, name)
      if (a.mode === 'names') return (await run('pr-review.js', a, () => assert.fail('an agent in names mode'))).result
      replays += 1
      // A rule change replays the segments it can alter; a Learned row, which
      // every segment reads, replays them all.
      assert.deepEqual(a.only, kind === 'learned-row' ? SEGMENTS : ['bugs'], name)
      assert.ok(a.max_segment_runs > 0 && a.max_agents > 0, name)
      replayAgents += a.max_agents
      const rows = a.rules === 'RULES.md' ? without : withChange
      return { cases: 4, recall: 0, quiet: 1, found: '', quiet_held: '', unscored: [], dropped: [], rows }
    }
    const args = { repo: 'o/r', since: '2026-10-05', until: '2026-10-12', out_dir: 'o', rules: 'RULES.md', engine: 'engine/pr-review.js' }
    const { result, labels } = await run('review-tuning.js', args, tuning, workflow)
    assert.equal(result.decision, decision, name)
    // Only a rule change is replayed, once without it and once with it, and
    // the routine's own agents and both replays' caps fit in a run's 1000.
    assert.equal(replays, withChange ? 2 : 0, name)
    assert.ok(labels.length + replayAgents <= 1000, name)
  }
})

test('tuning needs the path of the review workflow', async () => {
  const args = { repo: 'o/r', since: '2026-10-05', until: '2026-10-12', out_dir: 'o' }
  await assert.rejects(run('review-tuning.js', args, (label) => assert.fail(label)), /needs args \{repo, since, until, out_dir, engine\}/)
})

test('tuning stops with the settings message when its settings file holds no object', async () => {
  const args = { repo: 'o/r', since: '2026-10-05', until: '2026-10-12', out_dir: 'o', rules: 'RULES.md', engine: 'engine/pr-review.js' }
  const answer = (label) => (label === 'load settings' ? { text: 'null' } : assert.fail(label))
  const workflow = async (ref, a) => (await run('pr-review.js', a, () => assert.fail('an agent in names mode'))).result
  await assert.rejects(run('review-tuning.js', args, answer, workflow), /settings are invalid: they are not a JSON object/)
})

test("a repository's settings file reviews each of its examples with the segments the example names", { skip: !process.env.REVIEW_CONFIG }, async () => {
  const settings = JSON.parse(readFileSync(process.env.REVIEW_CONFIG, 'utf8'))
  assert.ok(Array.isArray(settings.examples) && settings.examples.length, 'the settings have examples')
  const { examples, ...config } = settings
  const { result: names } = await run('pr-review.js', { mode: 'names', config }, () => assert.fail('an agent in names mode'))
  assert.ok(!names.error, names.error)
  for (const example of examples) {
    const answer = (label) => {
      if (label === 'context') return { ...review('context'), files: example.changed, areas: [] }
      if (label === 'follow-up' || label === 'editor') return review(label)
      return { findings: [] }
    }
    const { labels } = await run('pr-review.js', { ...BASE, config, changed: example.changed }, answer)
    assert.deepEqual(ran(labels, names.segments), example.segments, `changed: ${example.changed.join(', ')}`)
  }
})

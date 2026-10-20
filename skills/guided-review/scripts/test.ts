#!/usr/bin/env bun
/* Regression test, in two parts. Run it after changing anything in scripts/ or runtime/.

     bun scripts/test.ts        # needs git, Chrome and the network; set CHROME when it is not in a usual place

   1. scripts: gather.ts and build.ts against a scratch repository: the diff GitHub shows, kinds, scope labels,
      emptied, deleted, renamed, binary and moved code, refs, escaping, and every check that refuses a guide.
   2. page: builds the demo (scripts/demo.ts) and drives it in headless Chrome over DevTools: what the reader sees
      after each action, no console errors, and timing budgets (boot ≤ 30 ms, each interaction ≤ 12 ms, a redraw of
      the cards on screen ≤ one frame). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Diff, DiffFile, Guide } from '../runtime/types';
import { buildDemo, git } from './demo';

const ROOT = join(import.meta.dir, '..');
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) return;
  failed++;
  console.log(`fail  ${name}${detail ? `\n      ${detail.split('\n').join('\n      ')}` : ''}`);
};
const same = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}\n got      ${JSON.stringify(got)}`);

// ---------------------------------------------------------------- 1. scripts
const tmp = mkdtempSync(join(tmpdir(), 'guided-review-test-'));
const repo = join(tmp, 'repo');
mkdirSync(repo);
const put = (path: string, text: string | Uint8Array) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
const bun = (script: string, args: string[], cwd = repo) => {
  const p = Bun.spawnSync(['bun', join(ROOT, 'scripts', script), ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { status: p.exitCode, log: p.stdout.toString() + p.stderr.toString() };
};

// main: Rust files to change, empty, delete, rename and move code out of, notes with a fenced block, and a README
// the pull request leaves alone.
const MOVED = `fn moves() {
    let first_value_with_a_long_name = compute_the_first_thing();
    let second_value_with_a_long_name = compute_the_second_thing();
    let third = combine(first_value_with_a_long_name, second_value_with_a_long_name);
}
`;
git(repo, 'init', '-q', '-b', 'main');
put('src/a.rs', `fn one() {\n${lines(20, (i) => `    let x${i} = ${i};`)}}\n\nfn two() {\n${lines(20, (i) => `    let y${i} = ${i};`)}}\n`);
put('src/gone.rs', 'fn gone() {\n    1\n}\n');
put('src/old.rs', 'fn old() {\n    2\n}\n');
put('src/r.rs', `fn renamed() {\n${lines(10, (i) => `    let r${i} = ${i};`)}}\n`);
put('src/m.rs', `fn stays() {\n    let s = 0;\n}\n\n${MOVED}`);
put('src/tail.rs', 'impl Foo {\n    fn keep(&self) {\n        let a = 1;\n    }\n\n    fn trim(&self) {\n        let b = 2;\n        let c = 3;\n        let d = 4;\n    }\n}\n');
put('docs/notes.md', '# Notes\n\n## Setup\n\n```sh\n# install\njust up\n```\n\nSome text.\n');
put('README.md', '# Scratch\n\nA repository for the tests.\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'base');
const branchPoint = git(repo, 'rev-parse', 'HEAD').trim();

// The pull request: a change in each function of a.rs, an emptied file, a deleted one, a renamed one with an edit,
// a block moved to a new file, a method's tail removed, a line below a fenced block, and new files of each kind.
git(repo, 'checkout', '-qb', 'pr');
put('src/a.rs', read('src/a.rs').replace('let x10 = 10;', 'let x10 = 100;').replace('let y10 = 10;', 'let y10 = 100;'));
put('src/gone.rs', '');
git(repo, 'rm', '-q', 'src/old.rs');
git(repo, 'mv', 'src/r.rs', 'src/r2.rs');
put('src/r2.rs', read('src/r2.rs').replace('let r5 = 5;', 'let r5 = 50;'));
put('src/m.rs', read('src/m.rs').replace(`\n${MOVED}`, ''));
put('src/n.rs', MOVED);
put('src/tail.rs', read('src/tail.rs').replace('        let c = 3;\n        let d = 4;\n', ''));
put('docs/notes.md', read('docs/notes.md').replace('Some text.', 'Some more text.'));
put('tests/a_test.rs', '#[test]\nfn works() {}\n// </script><img src=x onerror=alert(1)>\n');
put('migrations/0001_init.sql', 'create table t (id int);\n');
put('api/schema.gen.ts', 'export type T = { id: number };\n');
put('assets/logo.bin', new Uint8Array([0, 1, 2, 255, 0, 3]));
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'change');
// main moves on after the branch point; the pull request's diff leaves that out.
git(repo, 'checkout', '-q', 'main');
put('later.txt', 'landed on main later\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'later');
git(repo, 'checkout', '-q', 'pr');

const diffPath = join(tmp, 'diff.json');
const gathered = bun('gather.ts', ['--base', 'main', '--head=pr', `--out=${diffPath}`, '--quiet'], join(repo, 'src'));
check('gather runs from a subfolder', gathered.status === 0, gathered.log);
const diff: Diff = gathered.status === 0 ? JSON.parse(readFileSync(diffPath, 'utf8')) : ({ files: [] } as unknown as Diff);
const file = (path: string) => diff.files.find((f) => f.path === path) ?? ({ hunks: [], moves: [] } as unknown as DiffFile);

same('gather diffs from the merge base', diff.base, branchPoint);
same('gather sorts every changed file by kind', Object.fromEntries(diff.files.map((f) => [f.path, f.kind]).sort()), {
  'api/schema.gen.ts': 'generated', 'assets/logo.bin': 'core', 'docs/notes.md': 'docs', 'migrations/0001_init.sql': 'database',
  'src/a.rs': 'core', 'src/gone.rs': 'core', 'src/m.rs': 'core', 'src/n.rs': 'core', 'src/old.rs': 'core', 'src/r2.rs': 'core',
  'src/tail.rs': 'core', 'tests/a_test.rs': 'tests',
});
same('gather labels each hunk with its scope', file('src/a.rs').hunks.map((h) => h.label), ['fn one() {', 'fn two() {']);
// The line left where a method's tail was removed is its closing brace, outside the method.
same('a removed tail keeps its method as the label', file('src/tail.rs').hunks.map((h) => h.label), ['fn trim(&self) {']);
// A comment inside a fenced block is not a heading.
same('a fenced comment is not a heading', file('docs/notes.md').hunks.map((h) => h.label), ['## Setup']);
const gone = file('src/gone.rs'), old = file('src/old.rs'), renamed = file('src/r2.rs'), bin = file('assets/logo.bin');
same('an emptied file stays modified', [gone.status, gone.newCount, gone.del], ['modified', 0, 3]);
same('a deleted file keeps its old text', [old.status, old.old, old.hunks.length], ['deleted', ['fn old() {', '    2', '}'], 1]);
same('a renamed file keeps its old path', [renamed.status, renamed.oldPath, renamed.add, renamed.del], ['renamed', 'src/r.rs', 1, 1]);
same('a binary file has no hunks', [bin.binary, bin.hunks.length], [true, 0]);
const pick = ({ side, from, to, other, otherFrom }: DiffFile['moves'][number]) => ({ side, from, to, other, otherFrom });
same('moved code is marked where it left', file('src/m.rs').moves.map(pick), [{ side: '-', from: 5, to: 9, other: 'src/n.rs', otherFrom: 1 }]);
same('moved code is marked where it landed', file('src/n.rs').moves.map(pick), [{ side: '+', from: 1, to: 5, other: 'src/m.rs', otherFrom: 5 }]);

// A guide that places every file and hunk, with refs written into its first chapter.
const later: Guide['chapters'] = [
  { id: 'notes', title: 'The notes', kind: 'docs', body: ['Notes.'], files: ['docs/notes.md'] },
  { id: 'db', title: 'A table', kind: 'database', body: ['A table.'], files: ['migrations/0001_init.sql'] },
  { id: 'tests', title: 'A test', kind: 'tests', body: ['A test.'], files: ['tests/a_test.rs'] },
  { id: 'gen', title: 'The schema', kind: 'generated', body: ['Generated.'], files: ['api/schema.gen.ts'] },
];
const rest = ['src/gone.rs', 'src/old.rs', 'src/r2.rs', 'src/m.rs', 'src/n.rs', 'src/tail.rs', 'assets/logo.bin'];
const guideFor = (body: string, chapters?: Guide['chapters']): Guide => ({
  pr: { number: 1, title: 'Scratch <change> & "more"', url: 'https://github.com/example/scratch/pull/1' },
  overview: { summary: 'Changes two values.', beforeAfter: { lines: [{ t: 'one sets x10', op: '+', ref: 'src/a.rs:11' }] } },
  chapters: chapters ?? [
    { id: 'one', title: 'The first value', body: [body], files: [{ path: 'src/a.rs', hunks: [1] }, ...rest] },
    { id: 'two', title: 'The second value', body: ['`two` changes too.'], files: [{ path: 'src/a.rs', hunks: [2] }] },
    ...later,
  ],
});
function build(guide: unknown) {
  const guidePath = join(tmp, 'guide.json');
  writeFileSync(guidePath, JSON.stringify(guide));
  rmSync(join(tmp, 'guide.artifact.html'), { force: true });
  const r = bun('build.ts', [`--diff=${diffPath}`, `--guide=${guidePath}`]);
  return { ...r, html: r.status === 0 ? readFileSync(join(tmp, 'guide.artifact.html'), 'utf8') : '' };
}

const built = build(guideFor('See [the readme](ref:README.md:3), [the old file](ref:src/old.rs:2) and **`x10`** in `handlers[i](ctx)`.'));
check('build writes a page for a guide that places every hunk once', built.status === 0, built.log);
// A file the pull request does not change links to GitHub at the head commit; a deleted one jumps to its old side.
check('an unchanged file links to GitHub at the head', built.html.includes(`href="https://github.com/example/scratch/blob/${diff.head}/README.md#L3"`));
check('a deleted file jumps to its old side', /data-ref="src\/old\.rs" data-line="2" data-side="o"/.test(built.html));
// Code spans stay code: inside bold, and when they look like a link.
check('code inside bold stays code', built.html.includes('<b><code>x10</code></b>'));
check('code that looks like a link stays code', built.html.includes('<code>handlers[i](ctx)</code>'));
check('the title is escaped', built.html.includes('<h1>Scratch &lt;change&gt; &amp; &quot;more&quot;</h1>'));
// The diff's own `</script>` line stays inside the data block.
const data = built.html.match(/<script type="application\/json" id="gr-data">([^<]*)<\/script>/)?.[1];
check('the data block ends at its own closing tag', !!data && JSON.parse(data).files.find((f: DiffFile) => f.path === 'tests/a_test.rs').new.includes('// </script><img src=x onerror=alert(1)>'));
check('fonts are inline and nothing blocks the first paint', built.html.includes('font/woff2;base64') && !/<link[^>]+rel="stylesheet"/.test(built.html));
check('the libraries are preloaded at exact versions', /<link rel="modulepreload" href="https:\/\/cdn\.jsdelivr\.net\/npm\/@pierre\/diffs@\d+\.\d+\.\d+[^"]*"/.test(built.html));
check('the published page loads no mermaid; the viewer draws flows', !built.html.includes('mermaid@'));
check('the title comes first, as a short name', built.html.startsWith('<title>Guided review #1</title>'));

const branchOnly = build({ ...guideFor('One.'), pr: { title: 'A branch with no pull request' } });
const splitGuide = build({ ...guideFor('One.'), diffStyle: 'split' });
check('a guide can start in split', splitGuide.status === 0 && splitGuide.html.includes('"diffStyle":"split"') && splitGuide.html.includes('data-diff-style="split" aria-pressed="true"'), splitGuide.log);
check('a branch with no pull request builds', branchOnly.status === 0 && !branchOnly.html.includes('Open #') && branchOnly.html.startsWith('<title>Review of pr</title>'), branchOnly.log);
const named = build({ ...guideFor('One.'), name: 'Scratch values review' });
check('a guide names its page', named.html.startsWith('<title>Scratch values review</title>'), named.log);

const refusals: [string, unknown, RegExp][] = [
  ['a hunk in no chapter', guideFor('One.', [
    { id: 'one', title: 'The first value', body: ['One.'], files: [{ path: 'src/a.rs', hunks: [1] }, ...rest] },
    ...later,
  ]), /src\/a\.rs hunk 2 .* is in no chapter/],
  ['a ref past the end of a file', guideFor('See [it](ref:src/a.rs:999).'), /past the end of the file/],
  ['a ref to a file that does not exist', guideFor('See [it](ref:src/missing.rs:1).'), /neither in this pull request nor at its head/],
  ['a core chapter after a tests chapter', guideFor('One.', [
    later[0], later[2],
    { id: 'one', title: 'The values', body: ['One.'], files: ['src/a.rs', ...rest] },
    later[1], later[3],
  ]), /\(one\): a core chapter comes after a database, tests or generated chapter/],
  ['a link that is not https', guideFor('See [it](javascript:alert(1)).'), /must start with https:\/\/ or ref:/],
  ['a links entry that is not https', { ...guideFor('One.'), links: [{ label: 'It', href: 'javascript:alert(1)' }] }, /links\[0\]: href must start with https:\/\//],
  ['a pull request number without its url', { ...guideFor('One.'), pr: { number: 1, title: 'T' } }, /pr needs both number and url/],
  ['a name that is a sentence', { ...guideFor('One.'), name: 'A guided review of the scratch values change' }, /name is the page's name in the gallery/],
  ['a diff style that is neither unified nor split', { ...guideFor('One.'), diffStyle: 'side-by-side' }, /diffStyle must be "unified" or "split"/],
];
for (const [name, guide, message] of refusals) {
  const r = build(guide);
  check(`build refuses ${name}`, r.status === 1 && message.test(r.log), r.log);
}
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `fail  scripts (${failed})` : 'ok    scripts (gather and build against a scratch repository)');

// ---------------------------------------------------------------- 2. page
const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', Bun.which('google-chrome'), Bun.which('chromium')]
  .find((p) => p && existsSync(p));
if (!chrome) { console.log('No Chrome found. Set CHROME=/path/to/chrome.'); process.exit(1); }

// `r` collects facts and `ms` timings: t(fn) times the synchronous work a click or key does before the browser can
// paint the result. An interaction must fit well inside one 60 Hz frame (16.7 ms).
// The diff layout switch answers in the click's frame and redraws the cards on screen in the next, which must fit one.
const BUDGET = { boot: 30, interaction: 12, frame: 16.7 };
const budget = { boot: BUDGET.boot, mark: BUDGET.interaction, key: BUDGET.interaction, tab: BUDGET.interaction, split: BUDGET.interaction, restyle: BUDGET.frame };
const expect: Record<string, unknown> = {
  railButtons: 8, generatedFolded: true, moveChip: '↑ 6 lines moved to src/webhooks/sign.ts line 3', code: true, plain: 0, flow: true,
  progress: '1 of 7 chapters reviewed', chapterFolds: true, saved: true, keyMoves: true, keyMarks: '2 of 7 chapters reviewed',
  jumpInGuide: true, jumpFoldToDiff: true, foldRow: true, diffCards: 10, tree: true, treeTick: true, soundOff: 'false', soundSaved: false,
  styleStart: 'true', split: true, styleSaved: 'split', splitJump: true, unified: true,
};

async function browser(profile: string) {
  const proc = Bun.spawn([chrome!, '--headless=new', '--remote-debugging-port=0', '--window-size=1440,900', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], { stderr: 'ignore', stdout: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(50);
  const port = (await Bun.file(portFile).text()).split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
  let id = 0;
  const waiting = new Map<number, (v: any) => void>();
  const events = new Map<string, () => void>();
  const errors: string[] = []; // any exception or console.error on the page fails the test
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id) return waiting.get(msg.id)?.(msg);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) errors.push(msg.params.args.map((a: any) => a.value ?? a.description).join(' '));
    events.get(msg.method)?.();
  });
  const send = (method: string, params: object = {}) => new Promise<any>((ok) => { waiting.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  await Promise.all([send('Page.enable'), send('Runtime.enable')]);
  return {
    errors,
    async open(url: string) {
      const loaded = new Promise<void>((ok) => events.set('Page.loadEventFired', ok));
      await send('Page.navigate', { url });
      await loaded;
    },
    async run(code: string) {
      const res = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true });
      return res.result?.exceptionDetails ? 'ERR ' + (res.result.exceptionDetails.exception?.description ?? 'error') : res.result?.result?.value;
    },
    close() { ws.close(); proc.kill(); },
  };
}

const RUN = `
  const card = (scope, path) => [...document.querySelectorAll(scope + ' .gr-file')].find((c) => c.dataset.path === path);
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(50); return !!fn(); };
  r.railButtons = document.querySelectorAll('.gr-rail button').length;
  r.generatedFolded = card('#gr-guide', 'src/api/schema.gen.ts').classList.contains('collapsed');

  // code renders as it comes near; the moved-code chip and the flow come with it
  $('#c-signing').scrollIntoView();
  r.code = await until(() => card('#c-signing', 'src/webhooks/deliver.ts')?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]'));
  await until(() => card('#c-signing', 'src/webhooks/deliver.ts').querySelector('.gr-move'));
  r.moveChip = card('#c-signing', 'src/webhooks/deliver.ts').querySelector('.gr-move button')?.textContent;
  r.plain = document.querySelectorAll('.gr-plain').length;
  r.flow = await until(() => document.querySelector('.flow svg'));

  // review marks
  scrollTo(0, 0); await sleep(100);
  const box = $('input[data-review-chapter="retry-decision"]');
  ms.mark = t(() => box.click());
  r.progress = $('#gr-progress').textContent;
  r.chapterFolds = [...document.querySelectorAll('#c-retry-decision .gr-file')].every((c) => c.classList.contains('collapsed'));
  r.saved = !!JSON.parse(localStorage.getItem('gr:42')).c['retry-decision'];

  // j moves to the next chapter, r marks the chapter at the reading line
  // The scroll brings new code cards near, which render; let their layout land first, so the timing is the key's.
  $('#c-retry-decision').scrollIntoView(); await sleep(800); document.body.offsetHeight;
  ms.key = t(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })));
  await sleep(150);
  r.keyMoves = Math.abs($('#c-worker').getBoundingClientRect().top - 60) < 30;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
  r.keyMarks = $('#gr-progress').textContent;

  // a before / after ref to a line a chapter shows stays in the guide and selects the line
  const ref = (line) => [...document.querySelectorAll('#overview .rf a[data-ref]')].find((a) => a.dataset.ref === 'src/webhooks/deliver.ts' && a.dataset.line === String(line));
  ref(31).click();
  r.jumpInGuide = await until(() => !$('#gr-guide').hidden && card('#c-retry-decision', 'src/webhooks/deliver.ts').querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line="31"][data-selected-line]'));

  // a ref to a line folded away in every chapter opens the Diff tab's card of the whole file at that line
  ref(16).click();
  r.jumpFoldToDiff = await until(() => !$('#gr-diff').hidden);
  r.foldRow = await until(() => card('#gr-diff', 'src/webhooks/deliver.ts')?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line="16"][data-selected-line]'));

  // the Diff tab: every file, and the tree with its review ticks
  $('.gr-tab[data-view="guide"]').click();
  ms.tab = t(() => $('.gr-tab[data-view="diff"]').click());
  r.diffCards = document.querySelectorAll('#gr-diff .gr-file').length;
  r.tree = await until(() => $('#gr-tree-host').shadowRoot || $('#gr-tree-host').children.length);
  const treeText = () => ($('#gr-tree-host').shadowRoot ?? $('#gr-tree-host')).textContent;
  r.treeTick = await until(() => treeText().includes('✓'));

  // the speaker button mutes, and remembers
  $('#gr-sound').click();
  r.soundOff = $('#gr-sound').getAttribute('aria-pressed');
  r.soundSaved = JSON.parse(localStorage.getItem('gr:sound'));

  // unified or split: the switch redraws every drawn card and is remembered, and refs land in the right column
  $('.gr-tab[data-view="guide"]').click();
  r.styleStart = $('[data-diff-style="unified"]').getAttribute('aria-pressed');
  const dcard = () => card('#c-retry-decision', 'src/webhooks/deliver.ts').querySelector('diffs-container')?.shadowRoot;
  ms.split = t(() => $('[data-diff-style="split"]').click());
  r.split = await until(() => dcard()?.querySelector('[data-diff-type="split"]'));
  ms.restyle = +performance.getEntriesByName('gr:restyle').at(-1).duration.toFixed(2);
  r.styleSaved = JSON.parse(localStorage.getItem('gr:diff-style'));
  ref(27).click();
  r.splitJump = await until(() => dcard()?.querySelector('[data-additions] [data-line="27"][data-selected-line]'));
  $('[data-diff-style="unified"]').click();
  r.unified = await until(() => dcard()?.querySelector('[data-diff-type="single"]'));`;

const out = join(mkdtempSync(join(tmpdir(), 'guided-review-page-')), 'demo');
const demo = buildDemo(out, true);
if (demo.code) { console.log(demo.log); process.exit(1); }
const tab = await browser(join(dirname(out), 'profile'));
try {
  await tab.open('file://' + out + '.preview.html');
  const raw = await tab.run(`(async () => {
    const r = {}, ms = {}, $ = (s) => document.querySelector(s), sleep = (n) => new Promise((ok) => setTimeout(ok, n));
    const t = (fn) => { const s = performance.now(); fn(); return +(performance.now() - s).toFixed(2); };
    await sleep(300);
    ms.boot = +performance.getEntriesByName('gr:boot')[0].duration.toFixed(2);
    ${RUN}
    return JSON.stringify({ r, ms });
  })()`);
  if (typeof raw !== 'string' || !raw.startsWith('{')) { console.log(`fail  page: ${raw}`); failed++; }
  else {
    const { r: got, ms } = JSON.parse(raw) as { r: Record<string, unknown>; ms: Record<string, number> };
    const bad = Object.entries(expect).filter(([k, v]) => got[k] !== v);
    for (const [k, v] of bad) console.log(`fail  page.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
    const slow = Object.entries(budget).filter(([k, max]) => !(ms[k] <= max));
    for (const [k, max] of slow) console.log(`slow  page.${k}: ${ms[k]} ms, budget ${max} ms`);
    for (const e of tab.errors) console.log(`error page: ${e.split('\n')[0]}`);
    if (!bad.length && !slow.length && !tab.errors.length)
      console.log(`ok    page (${Object.keys(expect).length} checks, no errors; ${Object.entries(ms).map(([k, v]) => `${k} ${v}ms`).join(', ')})`);
    failed += bad.length + slow.length + tab.errors.length;
  }
} finally {
  tab.close();
  rmSync(dirname(out), { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

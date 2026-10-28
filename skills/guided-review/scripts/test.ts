#!/usr/bin/env bun
/* Regression test, in two parts. Run it after changing anything in scripts/ or runtime/.

     bun scripts/test.ts        # needs git, Chrome and the network; set CHROME when it is not in a usual place

   1. scripts: gather.ts and build.ts against a scratch repository: the diff GitHub shows, kinds, scope labels,
      emptied, deleted, renamed, binary and moved code, refs, escaping, and every check that refuses a guide.
   2. page: builds the demo (scripts/demo.ts) and drives it in headless Chrome over DevTools: what the reader sees
      after each action, review comments (the gutter's "+" dragged with real mouse events, the sidebar, the send), no
      console errors, and timing budgets (boot ≤ 30 ms, each interaction ≤ 12 ms, a redraw of the cards on screen ≤
      one frame). */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Diff, DiffFile, Guide } from '../runtime/types';
import { buildDemo, buildStack as buildStackDemo, git } from './demo';
import { browser, findChrome } from '../kit/build/chrome';

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
/** A built page and the data file it loads from <stem>.files/. */
function page(stem: string) {
  const dir = join(tmp, `${stem}.files`), data = readdirSync(dir).find((f) => f.startsWith('data.'))!;
  return { html: readFileSync(join(tmp, `${stem}.artifact.html`), 'utf8'), data: readFileSync(join(dir, data), 'utf8') };
}
function build(guide: unknown) {
  const guidePath = join(tmp, 'guide.json');
  writeFileSync(guidePath, JSON.stringify(guide));
  rmSync(join(tmp, 'guide.artifact.html'), { force: true });
  const r = bun('build.ts', [`--diff=${diffPath}`, `--guide=${guidePath}`]);
  return { ...r, ...(r.status === 0 ? page('guide') : { html: '', data: '' }) };
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
// The diff's own `</script>` line reaches the page as text, from the data file.
const data = /^window\.GR_DATA = (.*);\n$/s.exec(built.data)?.[1];
check('the data file holds the diff as it is', !!data && JSON.parse(data).prs[0].files.find((f: DiffFile) => f.path === 'tests/a_test.rs').new.includes('// </script><img src=x onerror=alert(1)>'));
// A read of the published page returns at most 50,000 characters, so the page holds only its markup.
check('the page holds only its markup; Geist, styles, runtime and data load beside it', built.html.includes('fonts.googleapis.com/css2?family=Geist')
  && !built.html.includes('base64') && !built.html.includes('<style')
  && ['guided-review.css', 'data.js', 'guided-review.js'].every((f) => new RegExp(`(href|src)="guide\\.files/${f.replace(/\.(\w+)$/, '\\.[0-9a-f]{8}\\.$1')}"`).test(built.html)));
check('the libraries are preloaded at exact versions', /<link rel="modulepreload" href="https:\/\/cdn\.jsdelivr\.net\/npm\/@pierre\/diffs@\d+\.\d+\.\d+[^"]*"/.test(built.html));
check('the published page loads no mermaid; the viewer draws flows', !built.html.includes('mermaid@'));
check('the title comes first, as a short name', built.html.startsWith('<title>Guided review #1</title>'));

const branchOnly = build({ ...guideFor('One.'), pr: { title: 'A branch with no pull request' } });
const splitGuide = build({ ...guideFor('One.'), diffStyle: 'split' });
check('a guide can start in split', splitGuide.status === 0 && splitGuide.data.includes('"diffStyle":"split"') && splitGuide.html.includes('data-diff-style="split" aria-pressed="true"'), splitGuide.log);
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

// Several pull requests on one page: a stack.json lists each guide with its diff.
function buildStack(guides: unknown[]) {
  const prs = guides.map((g, i) => { writeFileSync(join(tmp, `g${i}.json`), JSON.stringify(g)); return { guide: `g${i}.json`, diff: 'diff.json' }; });
  const stackPath = join(tmp, 'stack.json');
  writeFileSync(stackPath, JSON.stringify({ prs }));
  rmSync(join(tmp, 'stack.artifact.html'), { force: true });
  const r = bun('build.ts', [`--stack=${stackPath}`]);
  return { ...r, ...(r.status === 0 ? page('stack') : { html: '', data: '' }) };
}
const second = { ...guideFor('Two.'), pr: { number: 2, title: 'The same change, again', url: 'https://github.com/example/scratch/pull/2' } };
const pair = buildStack([guideFor('One.'), second]);
check('a stack of two pull requests builds', pair.status === 0, pair.log);
check('each pull request gets its own panel and ids', pair.html.includes('id="pr1-c-one"') && pair.html.includes('id="pr2-c-one"') && pair.html.includes('id="pr1-overview"'));
check('the title becomes a menu of them', (pair.html.match(/class="gr-pick-item"/g) ?? []).length === 4 && pair.html.includes('2 pull requests'));
check('a stack page is named by its pull requests', pair.html.startsWith('<title>Guided review #1–#2</title>'));
check('the page data lists both', !!pair.data.match(/"prs":\[\{"id":"pr1"/) && pair.data.includes('"id":"pr2"'));
const twice = buildStack([guideFor('One.'), guideFor('One.')]);
check('build refuses a stack that lists a pull request twice', twice.status === 1 && /lists #1 2 times/.test(twice.log), twice.log);
const tagged = buildStack([guideFor('One.'), { ...second, chapters: second.chapters.slice(1) }]);
check('a stack\'s errors name their pull request', tagged.status === 1 && /error #2: src\/a\.rs hunk 1 .* is in no chapter/.test(tagged.log), tagged.log);
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `fail  scripts (${failed})` : 'ok    scripts (gather and build against a scratch repository)');

// ---------------------------------------------------------------- 2. page
findChrome();

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

const RUN = `
  r.railButtons = document.querySelectorAll('.gr-rail button').length;
  r.generatedFolded = card('.gr-guide', 'src/api/schema.gen.ts').classList.contains('collapsed');

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
  r.progress = $('.gr-progress').textContent;
  r.chapterFolds = [...document.querySelectorAll('#c-retry-decision .gr-file')].every((c) => c.classList.contains('collapsed'));
  r.saved = !!JSON.parse(localStorage.getItem('gr:42')).c['retry-decision'];

  // j moves to the next chapter, r marks the chapter at the reading line
  // The scroll brings new code cards near, which render; let their layout land first, so the timing is the key's.
  $('#c-retry-decision').scrollIntoView(); await sleep(800); document.body.offsetHeight;
  ms.key = t(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })));
  await sleep(150);
  r.keyMoves = Math.abs($('#c-worker').getBoundingClientRect().top - 60) < 30;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
  r.keyMarks = $('.gr-progress').textContent;

  // a before / after ref to a line a chapter shows stays in the guide and selects the line
  const ref = (line) => [...document.querySelectorAll('#overview .rf a[data-ref]')].find((a) => a.dataset.ref === 'src/webhooks/deliver.ts' && a.dataset.line === String(line));
  ref(31).click();
  r.jumpInGuide = await until(() => !$('.gr-guide').hidden && card('#c-retry-decision', 'src/webhooks/deliver.ts').querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line="31"][data-selected-line]'));

  // a ref to a line folded away in every chapter opens the Diff tab's card of the whole file at that line
  ref(16).click();
  r.jumpFoldToDiff = await until(() => !$('.gr-diff').hidden);
  r.foldRow = await until(() => card('.gr-diff', 'src/webhooks/deliver.ts')?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line="16"][data-selected-line]'));

  // the Diff tab: every file, and the tree with its review ticks
  $('.gr-tab[data-view="guide"]').click();
  ms.tab = t(() => $('.gr-tab[data-view="diff"]').click());
  r.diffCards = document.querySelectorAll('.gr-diff .gr-file').length;
  r.tree = await until(() => $('.gr-tree-host').shadowRoot || $('.gr-tree-host').children.length);
  const treeText = () => ($('.gr-tree-host').shadowRoot ?? $('.gr-tree-host')).textContent;
  r.treeTick = await until(() => treeText().includes('✓'));

  // the speaker button mutes, and remembers
  $('[data-k-sound]').click();
  r.soundOff = $('[data-k-sound]').getAttribute('aria-pressed');
  r.soundSaved = JSON.parse(localStorage.getItem('kit:sound'));

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

// The stack: #42 and #43, based on it, on one page. The picker, [ and ], marks kept per pull request, an anchor that
// opens #43, and a jump inside it.
const STACK_RUN = `
  const vis = (q) => [...document.querySelectorAll(q)].filter((e) => !e.hidden && !e.closest('[hidden]'));
  r.startsOn = vis('.gr-pr')[0]?.dataset.pr; r.count = vis('.gr-pick-n')[0]?.textContent;
  r.stacked = !!vis('.gr-picklist.stacked, .gr-pick .stacked').length || !!document.querySelector('.gr-pr:not([hidden]) .gr-picklist.stacked');
  vis('.gr-pick-btn')[0].click();
  r.opens = vis('.gr-picklist').length === 1 && document.activeElement?.dataset.pick === 'pr42';
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  r.arrowMoves = document.activeElement?.dataset.pick;
  ms.pick = t(() => document.activeElement.click());
  r.picked = vis('.gr-pr')[0]?.dataset.pr; r.closed = vis('.gr-picklist').length === 0;
  r.followers = [vis('.gr-head .t')[0]?.textContent, vis('.gr-bar .k-btn.is-primary')[0]?.textContent.trim(), vis('.gr-progress')[0]?.textContent].join(' | ');
  r.rail = [...document.querySelectorAll('.gr-rail button')].map((b) => b.dataset.target).join(' ');
  await until(() => vis('.gr-file diffs-container').length);
  ms.back = t(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true })));
  r.bracketBack = vis('.gr-pr')[0]?.dataset.pr;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
  r.bracketNext = vis('.gr-pr')[0]?.dataset.pr;
  vis('input[data-review-chapter="counts"]')[0].click();
  r.ownMarks = [!!JSON.parse(localStorage.getItem('gr:43') ?? '{}').c?.counts, !!JSON.parse(localStorage.getItem('gr:42') ?? '{"c":{}}').c?.counts].join();
  r.pickerProgress = document.querySelector('[data-progress-of="pr43"]').textContent;
  const ref = [...document.querySelectorAll('#pr43-overview .rf a[data-ref]')].find((a) => a.dataset.line === '17');
  ref.click();
  r.jump = await until(() => vis('.gr-file').find((c) => c.dataset.path === 'src/api/endpoint.ts')?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line="17"][data-selected-line]'));`;
const STACK_EXPECT: Record<string, unknown> = {
  startsOn: 'pr42', count: '1 of 2', stacked: true, opens: true, arrowMoves: 'pr43', picked: 'pr43', closed: true,
  followers: 'Show retrying deliveries on the endpoint page | Open #43 on GitHub↗ | 0 of 3 chapters reviewed',
  rail: 'pr43-overview pr43-c-counts pr43-c-docs pr43-c-tests', bracketBack: 'pr42', bracketNext: 'pr43',
  ownMarks: 'true,false', pickerProgress: '1/3', jump: true, anchor: 'pr43', anchorAt: true,
};

type Tab = Awaited<ReturnType<typeof browser>>;
/** Runs `code` in the page with the helpers every run uses ($, sleep, until, t, card) and returns its { r, ms }. */
async function inPage(tab: Tab, code: string) {
  const raw = await tab.run(`(async () => {
    const r = {}, ms = {}, $ = (s) => document.querySelector(s), sleep = (n) => new Promise((ok) => setTimeout(ok, n));
    const t = (fn) => { const s = performance.now(); fn(); return +(performance.now() - s).toFixed(2); };
    const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(50); return !!fn(); };
    const card = (scope, path) => [...document.querySelectorAll(scope + ' .gr-file')].find((c) => c.dataset.path === path);
    ${code}
    return JSON.stringify({ r, ms });
  })()`);
  if (typeof raw !== 'string' || !raw.startsWith('{')) throw new Error(String(raw));
  return JSON.parse(raw) as { r: Record<string, unknown>; ms: Record<string, number> };
}
function report(name: string, tab: Tab, got: Record<string, unknown>, ms: Record<string, number>, expect: Record<string, unknown>, budget: Record<string, number>) {
  const bad = Object.entries(expect).filter(([k, v]) => got[k] !== v);
  for (const [k, v] of bad) console.log(`fail  ${name}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
  const slow = Object.entries(budget).filter(([k, max]) => !(ms[k] <= max));
  for (const [k, max] of slow) console.log(`slow  ${name}.${k}: ${ms[k]} ms, budget ${max} ms`);
  for (const e of tab.errors) console.log(`error ${name}: ${e.split('\n')[0]}`);
  if (!bad.length && !slow.length && !tab.errors.length)
    console.log(`ok    ${name} (${Object.keys(expect).length} checks, no errors; ${Object.entries(ms).map(([k, v]) => `${k} ${v}ms`).join(', ')})`);
  failed += bad.length + slow.length + tab.errors.length;
}

async function runPage(name: string, file: string, run: string, expect: Record<string, unknown>, budget: Record<string, number>, after?: (tab: Tab, r: Record<string, unknown>) => Promise<void>) {
  const tab = await browser(join(dirname(file), `profile-${name}`), { warnings: true });
  try {
    await tab.open('file://' + file);
    let got: Record<string, unknown>, ms: Record<string, number>;
    try {
      ({ r: got, ms } = await inPage(tab, `await sleep(300);
        ms.boot = +performance.getEntriesByName('gr:boot')[0].duration.toFixed(2);
        ${run}`));
    } catch (e) { console.log(`fail  ${name}: ${(e as Error).message}`); failed++; return; }
    if (after) await after(tab, got);
    report(name, tab, got, ms, expect, budget);
  } finally {
    tab.close();
  }
}

// Review comments: a line and a file comment kept from an earlier visit draw in their cards and the sidebar; three
// lines selected by their numbers (a click, then a Shift-click), and the gutter's "+" dragged over three others, each
// with real mouse events, open a composer for them; a general comment comes from the sidebar; Send (copied here, with
// no Claude to send to) holds every comment and clears them, and the batch can be brought back.
async function runComments(file: string) {
  const name = 'comments';
  const tab = await browser(join(dirname(file), `profile-${name}`), { warnings: true });
  const got: Record<string, unknown> = {}, ms: Record<string, number> = {};
  const take = (x: { r: Record<string, unknown>; ms: Record<string, number> }) => { Object.assign(got, x.r); Object.assign(ms, x.ms); return x.r; };
  const mouse = (type: string, x: number, y: number, down = false, modifiers = 0) => tab.send('Input.dispatchMouseEvent', { type, x, y, modifiers, button: down || type !== 'mouseMoved' ? 'left' : 'none', buttons: down || type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  const click = async (at: { x: number; y: number }, modifiers = 0) => {
    await mouse('mouseMoved', at.x, at.y);
    await mouse('mousePressed', at.x, at.y, false, modifiers);
    await mouse('mouseReleased', at.x, at.y, false, modifiers);
  };
  const root = `card('#c-retry-decision', 'src/webhooks/deliver.ts').querySelector('diffs-container').shadowRoot`;
  const num = (line: number) => `${root}.querySelector('[data-column-number="${line}"]:not([data-line-type="change-deletion"])')`;
  /** The centre of an element on screen, or null. */
  const centre = async (el: string) => JSON.parse(await tab.run(`(() => { const card = (s, p) => [...document.querySelectorAll(s + ' .gr-file')].find((c) => c.dataset.path === p);
      const u = ${el}?.getBoundingClientRect();
      return JSON.stringify(u ? { x: u.left + u.width / 2, y: u.top + u.height / 2 } : null); })()`)) as { x: number; y: number } | null;
  /** The lines the card shows selected. */
  const picked = `[...${root}.querySelectorAll('[data-content] [data-line][data-selected-line]')].map((e) => e.dataset.line).join(' ')`;
  try {
    await tab.open('file://' + file);
    await inPage(tab, `const head = window.GR_DATA.prs[0].head;
      localStorage.setItem('gr:42:comments', JSON.stringify([
        { id: 'cseed1', kind: 'line', path: 'src/webhooks/deliver.ts', start: 27, side: 'n', end: 27, endSide: 'n', code: [['+', 'x']], text: 'Seeded line comment', head, at: '2026-01-01T00:00:00Z' },
        { id: 'cseed2', kind: 'file', path: 'src/webhooks/backoff.ts', text: 'Seeded file comment', head, at: '2026-01-01T00:00:00Z' },
      ]));`);
    await tab.open('about:blank');
    await tab.open('file://' + file);
    take(await inPage(tab, `await sleep(300);
      r.badge = $('.gr-note-count').textContent;
      $('#c-retry-decision').scrollIntoView();
      r.lineNote = await until(() => card('#c-retry-decision', 'src/webhooks/deliver.ts')?.querySelector('diffs-container .gr-note')?.textContent.includes('Seeded line comment'));
      r.fileNote = card('#c-retry-decision', 'src/webhooks/backoff.ts').querySelector('.gr-notes .gr-note-text')?.textContent;
      ms.side = t(() => $('[data-side-toggle]').click());
      r.sideItems = document.querySelectorAll('.gr-side-item').length;
      const box = $('.gr-side-general textarea');
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      r.typingKeepsKeys = document.body.classList.contains('gr-side-open');
      box.value = 'Seeded general comment';
      ms.add = t(() => box.form.requestSubmit());
      r.added = $('.gr-note-count').textContent + ' ' + document.querySelectorAll('.gr-side-item').length;
      ${num(31)}.scrollIntoView({ block: 'center' });
      await sleep(100);`));
    // A click on line 37's number, then a Shift-click on 35's, selects 35–37 and puts the "+" on 37. The clicks land on
    // the digits, left of where the "+" shows.
    const digits = (line: number) => `${num(line)}.querySelector('[data-line-number-content]')`;
    const n37 = await centre(digits(37)), n35 = await centre(digits(35));
    if (n37 && n35) { await click(n37); await click(n35, 8); }
    take(await inPage(tab, `await sleep(50);
      r.picked = ${picked};
      r.plusOnLast = ${root}.querySelector('[data-utility-button]')?.closest('[data-column-number]')?.dataset.columnNumber;`));
    const onLast = await centre(`${root}.querySelector('[data-utility-button]')`);
    if (onLast) await click(onLast);
    take(await inPage(tab, `await sleep(100);
      const form = card('#c-retry-decision', 'src/webhooks/deliver.ts').querySelector('.gr-composer');
      r.pickedComposer = form?.querySelector('.gr-composer-where')?.textContent;
      r.pickedKept = ${picked};
      if (form) { form.querySelector('textarea').value = 'Selected by their numbers'; form.requestSubmit(); }
      const saved = JSON.parse(localStorage.getItem('gr:42:comments')).find((c) => c.text === 'Selected by their numbers');
      r.pickedSaved = saved ? saved.start + '-' + saved.end + ' ' + saved.side + saved.endSide + ' ' + saved.code.map((l) => l[0]).join('') : null;
      r.pickedCleared = await until(() => !${root}.querySelector('[data-selected-line]'));`));
    const at = JSON.parse(await tab.run(`(() => { const card = (s, p) => [...document.querySelectorAll(s + ' .gr-file')].find((c) => c.dataset.path === p);
      const a = ${num(31)}.getBoundingClientRect(), b = ${num(33)}.getBoundingClientRect();
      return JSON.stringify({ x: a.left + a.width / 2, y: a.top + a.height / 2, y2: b.top + b.height / 2 }); })()`));
    await mouse('mouseMoved', at.x, at.y);
    const plus = JSON.parse(await tab.run(`(() => { const card = (s, p) => [...document.querySelectorAll(s + ' .gr-file')].find((c) => c.dataset.path === p);
      const u = ${root}.querySelector('[data-utility-button]')?.getBoundingClientRect();
      return JSON.stringify(u ? { x: u.left + u.width / 2, y: u.top + u.height / 2 } : null); })()`));
    got.plus = !!plus;
    if (plus) {
      await mouse('mousePressed', plus.x, plus.y);
      await mouse('mouseMoved', plus.x, at.y2, true);
      await mouse('mouseReleased', plus.x, at.y2);
    }
    take(await inPage(tab, `await sleep(100);
      const form = card('#c-retry-decision', 'src/webhooks/deliver.ts').querySelector('.gr-composer');
      r.composer = form?.querySelector('.gr-composer-where')?.textContent;
      r.composerFocused = document.activeElement === form?.querySelector('textarea');
      if (form) { form.querySelector('textarea').value = 'Dragged over three lines'; ms.lineAdd = t(() => form.requestSubmit()); }
      const saved = JSON.parse(localStorage.getItem('gr:42:comments')).find((c) => c.text === 'Dragged over three lines');
      r.dragged = saved ? saved.start + '-' + saved.end + ' ' + saved.side + saved.endSide + ' ' + saved.code.map((l) => l[0]).join('') : null;
      r.draggedDrawn = await until(() => [...card('#c-retry-decision', 'src/webhooks/deliver.ts').querySelectorAll('diffs-container .gr-note-text')].some((p) => p.textContent === 'Dragged over three lines'));
      let copied = null;
      navigator.clipboard.writeText = (text) => { copied = text; return Promise.resolve(); };
      $('[data-note-send]').click();
      await until(() => copied);
      r.sent = !!copied && copied.startsWith('# Review comments on #42 ') && copied.includes(': 5 comments')
        && copied.includes('1. General\\n   Seeded general comment') && copied.includes('src/webhooks/backoff.ts (the file)')
        && copied.includes('src/webhooks/deliver.ts:27\\n') && copied.includes('src/webhooks/deliver.ts:31-33\\n   | + ')
        && copied.includes('src/webhooks/deliver.ts:35-37\\n');
      r.cleared = $('.gr-note-count').hidden && !document.querySelector('.gr-guide .gr-note') && localStorage.getItem('gr:42:comments') === '[]';
      $('[data-note-restore]')?.click();
      r.restored = JSON.parse(localStorage.getItem('gr:42:comments')).length;`));
  } catch (e) {
    console.log(`fail  ${name}: ${(e as Error).message}`);
    failed++;
    return;
  } finally {
    tab.close();
  }
  report(name, tab, got, ms, {
    badge: '2', lineNote: true, fileNote: 'Seeded file comment', sideItems: 2, typingKeepsKeys: true, added: '3 3',
    picked: '35 36 37', plusOnLast: '37', pickedComposer: 'Comment on lines 35–37', pickedKept: '35 36 37', pickedSaved: '35-37 nn ++ ', pickedCleared: true,
    plus: true, composer: 'Comment on lines 31–33', composerFocused: true, dragged: '31-33 nn +++', draggedDrawn: true, sent: true, cleared: true, restored: 5,
  }, { side: BUDGET.interaction, add: BUDGET.interaction, lineAdd: BUDGET.frame });
}

const dir = mkdtempSync(join(tmpdir(), 'guided-review-page-'));
try {
  const demo = buildDemo(join(dir, 'demo'), true);
  const stack = buildStackDemo(join(dir, 'stack'), true);
  if (demo.code || stack.code) { console.log(demo.log + stack.log); process.exit(1); }
  await runPage('page', join(dir, 'demo.preview.html'), RUN, expect, budget);
  await runComments(join(dir, 'demo.preview.html'));
  await runPage('stack', join(dir, 'stack.preview.html'), STACK_RUN, STACK_EXPECT, { boot: BUDGET.boot, pick: BUDGET.interaction, back: BUDGET.interaction }, async (tab, r) => {
    // A link with #pr43-c-docs opens on #43, at that chapter.
    // Another document first: a navigation that changes only the anchor fires no load.
    await tab.open('about:blank');
    await tab.open('file://' + join(dir, 'stack.preview.html') + '#pr43-c-docs');
    const at = JSON.parse(await tab.run(`(async () => { await new Promise((ok) => setTimeout(ok, 400));
      const p = [...document.querySelectorAll('.gr-pr')].find((e) => !e.hidden);
      return JSON.stringify({ anchor: p?.dataset.pr, anchorAt: Math.abs(document.getElementById('pr43-c-docs').getBoundingClientRect().top - 60) < 40 || scrollY + innerHeight >= document.documentElement.scrollHeight - 2 }); })()`));
    Object.assign(r, at);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

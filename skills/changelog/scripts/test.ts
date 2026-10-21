#!/usr/bin/env bun
/* Regression test, in two parts. Run it after changing anything in scripts/ or runtime/.

     bun scripts/test.ts            # needs Chrome; set CHROME when it is not in a usual place
     bun scripts/test.ts --live     # also runs gather.ts against a busy public repository (needs gh and the network)
     bun scripts/test.ts --example  # only builds the example into examples/changelog.preview.html

   1. scripts: dates in a time zone, the window's edges, CI counting, the config's checks, and every rule entry.ts
      enforces, on the example entry and broken copies of it.
   2. page: builds the page with the example entry, an older one and one whose scene carries markup to strip, and drives
      it in headless Chrome over DevTools: what the reader sees after each action, no console errors, no sideways scroll
      at phone width, and timing budgets (boot ≤ 30 ms, the first render ≤ 30 ms, each view change ≤ 12 ms). */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from '../runtime/types';
import { type RawPr, type Run, dateIn, inWindow, label, loadConfig, prStats, runsOf, span, windowCi } from './lib';
import { browser, findChrome } from '../kit/build/chrome';

const ROOT = join(import.meta.dir, '..');
const argv = Bun.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), 'changelog-test-'));
const EX = { entry: join(ROOT, 'examples/entry.ts'), stats: join(ROOT, 'examples/stats.json'), config: join(ROOT, 'examples/changelog.json') };
const bun = (script: string, args: string[]) => {
  const p = Bun.spawnSync(['bun', join(ROOT, 'scripts', script), ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { status: p.exitCode, log: p.stdout.toString() + p.stderr.toString() };
};

if (argv.includes('--example')) {
  const steps = [bun('entry.ts', [EX.entry, EX.stats, tmp, '--config', EX.config]), bun('build.ts', ['--out', join(ROOT, 'examples/changelog'), '--config', EX.config, '--entries', tmp])];
  for (const s of steps) console.log(s.log.trim());
  rmSync(tmp, { recursive: true, force: true });
  process.exit(steps.some((s) => s.status) ? 1 : 0);
}

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) { failed++; console.log(`fail  ${name}${detail ? `\n      ${detail.split('\n').join('\n      ')}` : ''}`); } };
const same = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}\n got      ${JSON.stringify(got)}`);

// ---------------------------------------------------------------- 1. scripts
const TOR = 'America/Toronto';
same('a moment as a label in the time zone', label(new Date('2026-10-20T13:40:00Z'), TOR), 'Oct 20, 9:40 am');
same('noon and midnight read 12', [label(new Date('2026-10-20T16:00:00Z'), TOR), label(new Date('2026-10-20T04:00:00Z'), TOR)], ['Oct 20, 12:00 pm', 'Oct 20, 12:00 am']);
same('the date is the time zone\'s, not UTC\'s', dateIn(new Date('2026-10-21T03:30:00Z'), TOR), '2026-10-20');
same('a window\'s length', [span(16 * 3_600_000), span(3_600_000), span(30 * 3_600_000), span(3.4 * 86_400_000)], ['16 hours', '1 hour', '30 hours', '3 days']);

const pr = (n: number, merged: string | null, created = '2026-10-19T10:00:00Z', branch = `b${n}`): RawPr => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, author: 'dev', createdAt: created, updatedAt: merged ?? created, mergedAt: merged,
  headRefName: branch, additions: 10, deletions: 2, changedFiles: 3,
});
const since = new Date('2026-10-20T00:00:00Z'), until = new Date('2026-10-20T12:00:00Z');
same('the window holds merges after its start and up to its end, oldest first',
  inWindow([pr(1, '2026-10-20T00:00:00Z'), pr(2, '2026-10-20T12:00:00Z'), pr(3, '2026-10-20T05:00:00Z'), pr(4, null), pr(5, '2026-10-20T12:00:01Z')], since, until).map((p) => p.number), [3, 2]);
const run = (id: number, branch: string, created: string, conclusion: string | null, event = 'pull_request', start?: string, end?: string): Run => ({
  id, event, head_branch: branch, created_at: created, updated_at: end ?? created, run_started_at: start ?? created, status: conclusion ? 'completed' : 'in_progress',
  conclusion, head_sha: 'abcdef1234', display_title: 't',
});
const p3 = pr(3, '2026-10-20T05:00:00Z', '2026-10-20T01:00:00Z');
const ci = [
  run(1, 'b3', '2026-10-20T02:00:00Z', 'failure'), run(2, 'b3', '2026-10-20T03:00:00Z', 'success', 'pull_request', '2026-10-20T03:00:00Z', '2026-10-20T03:06:00Z'),
  run(3, 'b3', '2026-10-19T23:00:00Z', 'success'), run(4, 'b9', '2026-10-20T03:00:00Z', 'success', 'pull_request', '2026-10-20T03:00:00Z', '2026-10-20T03:10:00Z'),
  run(5, 'b3', '2026-10-20T04:00:00Z', 'success', 'push'), run(6, 'b9', '2026-10-20T06:00:00Z', null),
];
same('a PR\'s runs are pull_request runs on its branch between opening and merge', runsOf(p3, ci).map((r) => r.id), [1, 2]);
const s3 = prStats(p3, ci, null);
same('a PR\'s numbers', [s3.hours, s3.ci_runs, s3.ci_failed, s3.review_runs], [4, 2, 1, null]);
same('the window\'s CI: runs, failures, in progress and the median of successes', windowCi(ci, since, until), { ci_runs: 5, ci_failed: 1, ci_in_progress: 1, ci_median_min: 6 });
same('no CI workflow, no CI numbers', windowCi(null, since, until).ci_runs, null);

const cfgAt = async (c: object) => { const p = join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`); await Bun.write(p, JSON.stringify(c)); return loadConfig(p); };
const good = await Bun.file(EX.config).json();
check('the example config loads', !!(await loadConfig(EX.config)).config, (await loadConfig(EX.config)).errors.join('\n'));
check('a config needs an IANA time zone', (await cfgAt({ ...good, timezone: 'Toronto' })).errors.some((e) => /IANA/.test(e)));
check('a config needs owner/name', (await cfgAt({ ...good, repo: 'webhooks' })).errors.some((e) => /owner\/name/.test(e)));
check('a missing config says to set up', (await loadConfig(join(tmp, 'none.json'))).errors.some((e) => /set the changelog up/.test(e)));

const built = bun('entry.ts', [EX.entry, EX.stats, tmp, '--config', EX.config]);
check('the example entry builds', built.status === 0, built.log);
const doc: Entry = built.status === 0 ? await Bun.file(join(tmp, '2026-10-20.json')).json() : ({} as Entry);
const slack = built.status === 0 ? await Bun.file(join(tmp, 'slack.md')).text() : '';
same('the entry is dated by the window\'s end in the time zone', [doc.date, doc.window, doc.span], ['2026-10-20', 'Oct 19, 6:05 pm to Oct 20, 9:40 am', '16 hours']);
same('the numbers add up', doc.numbers, { prs: 2, add: 237, del: 42, ci_median_min: 6.4, ci_runs: 9, ci_failed: 1 });
check('scene markers are tied to the entry', !!doc.themes?.[0].scene.svg.includes('id="arr-2026-10-20-retries"'));
check('the Slack post links the entry and counts the PRs', slack.includes('(https://claude.ai/artifact/example#2026-10-20)') && slack.includes('2 PRs merged:') && slack.startsWith('**Relay changelog, Oct 20**'), slack);

// Broken copies of the example: each must stop the build with its own message.
const src = await Bun.file(EX.entry).text();
async function broken(name: string, edit: (s: string) => string, message: RegExp, stats = EX.stats) {
  const p = join(tmp, `broken-${name.replace(/\W+/g, '-')}.ts`);
  await Bun.write(p, edit(src).replace(`from '../runtime/types'`, `from '${ROOT}/runtime/types'`).replace(`from '../scripts/scenes'`, `from '${ROOT}/scripts/scenes'`));
  const r = bun('entry.ts', [p, stats, join(tmp, 'out-broken'), '--config', EX.config]);
  check(`entry.ts refuses ${name}`, r.status === 1 && message.test(r.log), r.log);
}
await Bun.write(join(tmp, 'out-broken', '.keep'), '');
await broken('a theme that names a PR outside the window', (s) => s.replace("prs: [44]", 'prs: [44, 99]'), /names #99, which did not merge in the window/);
await broken('a scene with a script', (s) => s.replace("return g.scene('A delivery waiting", "return { ...g.scene('x'), svg: g.svg().replace('</svg>', '<script>alert(1)</script></svg>') }; g.scene('A delivery waiting"), /markup the page strips \(<script>\)/);
await broken('a scene with an event handler', (s) => s.replace("return g.scene('A delivery waiting", "return { ...g.scene('x'), svg: g.svg().replace('<defs>', '<defs onload=\"x()\">') }; g.scene('A delivery waiting"), /markup the page strips \(onload=\)/);
await broken('two themes with one key', (s) => s.replace("key: 'endpoint'", "key: 'retries'"), /2 themes have the key "retries"/);
await broken('two scenes with one marker id', (s) => s.replace("new Svg('endpoint'", "new Svg('retries'"), /the id "arr-retries" is in 2 scenes/);
const empty = join(tmp, 'empty-stats.json');
await Bun.write(empty, JSON.stringify({ ...(await Bun.file(EX.stats).json()), prs: {} }));
await broken('a window with nothing merged', (s) => s, /no pull request merged in the window/, empty);
rmSync(join(tmp, 'out-broken'), { recursive: true, force: true });
console.log(failed ? `fail  scripts (${failed})` : 'ok    scripts (time zones, the window, CI counts, config, entry rules)');

if (argv.includes('--live')) {
  const live = join(tmp, 'live');
  await Bun.write(join(tmp, 'live.json'), JSON.stringify({ name: 'Bun', repo: 'oven-sh/bun', timezone: 'UTC', slack: null, workflows: {} }));
  const r = bun('gather.ts', ['--days', '2', '--out', live, '--config', join(tmp, 'live.json')]);
  const st = r.status === 0 ? await Bun.file(join(live, 'stats.json')).json() : null;
  const n = st ? Object.keys(st.prs).length : 0;
  check('gather reads a live repository', r.status === 0 && n > 0 && existsSync(join(live, 'prs', `${Object.keys(st.prs)[0]}.md`)), r.log.slice(-800));
  if (!failed) console.log(`ok    live (gather: ${n} PRs merged in oven-sh/bun in the last 2 days)`);
}

// ---------------------------------------------------------------- 2. page
findChrome();

// The feed's entries: the example, an older one, and one whose scene carries markup the page must strip.
const older: Entry = { ...doc, date: '2026-10-18', title: 'Deliveries keep their last status code', themes: doc.themes.slice(1), window_end: '2026-10-18T20:00:00Z' };
const hostile: Entry = { ...doc, date: '2026-10-10', title: 'An entry with markup to strip', themes: [{ ...doc.themes[0], key: 'x', scene: {
  caption: 'stripped', svg: '<svg viewBox="0 0 540 60" onload="window.__pwned=1"><script>window.__pwned=1</script><a href="https://example.com"><text x="10" y="20">link</text></a><image href="https://example.com/x.png"/><circle cx="20" cy="40" r="5"/></svg>' } }] };
for (const e of [older, hostile]) await Bun.write(join(tmp, `${e.date}.json`), JSON.stringify(e));
const page = bun('build.ts', ['--out', join(tmp, 'changelog'), '--config', EX.config, '--entries', tmp]);
if (page.status) { console.log(page.log); process.exit(1); }

const BUDGET = { boot: 30, render: 30, route: 12 };
const expect: Record<string, unknown> = {
  title: 'Relay Changelog', entries: 3, dots: 1, lead: true, shipped: 2, brand: 'Relay',
  entryThemes: 2, prLinks: 2, prRows: 2, scoreCol: true, watch: 2, pager: 'Older', backToFeed: true, missing: true,
  copied: true, stripped: true, soundOff: 'false', muted: 'false', narrowFeed: true, narrowEntry: true,
};

const PRELUDE = `const r = {}, ms = {}, $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)], sleep = (n) => new Promise((ok) => setTimeout(ok, n));
  const until = async (fn, n = 4000) => { const end = Date.now() + n; while (!fn() && Date.now() < end) await sleep(30); return !!fn(); };
  const last = (name) => +performance.getEntriesByName(name).at(-1).duration.toFixed(2);
  const go = async (hash) => { location.hash = hash; await sleep(80); return last('changelog:route'); };`;
const RUN = `
  await until(() => $('#e-2026-10-20'));
  ms.boot = last('changelog:boot'); ms.render = last('changelog:render');
  r.title = document.title; r.brand = $('.brand [data-name]').textContent;
  r.entries = $$('.feed .entry').length; r.dots = $$('.feed .dot').length;
  r.lead = !!$('#e-2026-10-20 figure.scene svg'); r.shipped = $$('#e-2026-10-20 .shipped li').length;
  r.stripped = !window.__pwned && !$('#e-2026-10-10 svg script') && !$('#e-2026-10-10 svg a') && !$('#e-2026-10-10 svg image') && !$('#e-2026-10-10 svg').hasAttribute('onload') && !!$('#e-2026-10-10 svg circle');

  ms.open = await go('#2026-10-20');
  r.entryThemes = $$('.theme').length; r.prLinks = $$('.prlinks a').length; r.prRows = $$('.prs tbody tr').length;
  r.scoreCol = $$('.prs thead th').some((th) => th.textContent === 'Score'); r.watch = $$('.watch li').length;
  r.pager = $('.pager .prev .label')?.textContent.split(' ')[1];
  $('.actions .k-btn').click();
  r.copied = await until(() => $('#k-toast')?.classList.contains('is-on') && (/Link copied/.test($('#k-toast').textContent) || ($('#k-copy')?.value ?? '') === 'https://claude.ai/artifact/example#2026-10-20'));
  ms.back = await go('');
  r.backToFeed = $$('.feed .entry').length === 3;
  await go('#2026-01-01');
  r.missing = /There is no entry for 2026-01-01/.test($('#app').textContent);
  await go('');
  $('[data-k-sound]').click();
  r.soundOff = $('[data-k-sound]').getAttribute('aria-pressed'); r.muted = localStorage.getItem('kit:sound');`;

const tab = await browser(join(tmp, 'profile'), { warnings: true });
try {
  await tab.open('file://' + join(tmp, 'changelog.preview.html'));
  const raw = await tab.run(`(async () => { ${PRELUDE} ${RUN}; return JSON.stringify({ r, ms }); })()`);
  // Phone width: neither the feed nor an entry may scroll sideways.
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await tab.open('file://' + join(tmp, 'changelog.preview.html'));
  const narrow = await tab.run(`(async () => { ${PRELUDE}
    await until(() => $('#e-2026-10-20')); await sleep(100);
    r.narrowFeed = document.documentElement.scrollWidth <= innerWidth;
    await go('#2026-10-20'); await sleep(100);
    r.narrowEntry = document.documentElement.scrollWidth <= innerWidth;
    return JSON.stringify(r); })()`);
  if (typeof raw !== 'string' || !raw.startsWith('{') || typeof narrow !== 'string' || !narrow.startsWith('{')) { console.log(`fail  page: ${raw} ${narrow}`); failed++; }
  else {
    const { r, ms } = JSON.parse(raw) as { r: Record<string, unknown>; ms: Record<string, number> };
    Object.assign(r, JSON.parse(narrow));
    const bad = Object.entries(expect).filter(([k, v]) => r[k] !== v);
    for (const [k, v] of bad) console.log(`fail  page.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(r[k])}`);
    const budget: Record<string, number> = { boot: BUDGET.boot, render: BUDGET.render, open: BUDGET.route, back: BUDGET.route };
    const slow = Object.entries(budget).filter(([k, max]) => !(ms[k] <= max));
    for (const [k, max] of slow) console.log(`slow  page.${k}: ${ms[k]} ms, budget ${max} ms`);
    for (const e of tab.errors) console.log(`error page: ${e.split('\n')[0]}`);
    if (!bad.length && !slow.length && !tab.errors.length)
      console.log(`ok    page (${Object.keys(expect).length} checks, no errors; ${Object.entries(ms).map(([k, v]) => `${k} ${v}ms`).join(', ')})`);
    failed += bad.length + slow.length + tab.errors.length;
  }
} finally {
  tab.close();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

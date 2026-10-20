#!/usr/bin/env bun
/* Turn a run's entry and gathered stats into one changelog entry and its Slack post.

     bun scripts/entry.ts <entry.ts> <stats.json> <out dir> [--config <path>]

   <entry.ts> is the run's copy of examples/entry.ts: a default export that takes { Svg } and returns the entry's text
   and scenes. Writes <out dir>/<date>.json (the database document; its id is the date) and <out dir>/slack.md (the
   post). The date is the window's end in the config's time zone. Stops with an error when the entry breaks a rule the
   page or the post relies on; warnings do not stop it. */
import { resolve } from 'node:path';
import type { Entry, EntryInput, PrRow, Stats } from '../runtime/types';
import { P, dateIn, label, loadConfig, opt, shortDate, span } from './lib';
import { Svg } from './scenes';

const argv = Bun.argv.slice(2);
const [entryPath, statsPath, outDir] = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--config'));
if (!entryPath || !statsPath || !outDir) {
  console.log('usage: bun scripts/entry.ts <entry.ts> <stats.json> <out dir> [--config <path>]');
  process.exit(2);
}
const { config, errors: cfgErrors } = await loadConfig(opt(argv, 'config'));
if (!config) { for (const e of cfgErrors) console.log(`error ${e}`); process.exit(1); }

const mod = await import(resolve(entryPath));
const C: EntryInput = typeof mod.default === 'function' ? mod.default({ Svg }) : mod.default;
const st: Stats = await Bun.file(statsPath).json();
const errors: string[] = [], warnings: string[] = [];
const tz = config.timezone;
const w0 = P(st.window.since), w1 = P(st.window.until);
const date = dateIn(w1, tz);

if (!config.page) warnings.push('config has no page link yet: the Slack post links nowhere until the page is published');
if (!C.title?.trim()) errors.push('title is missing');
if (!C.summary?.trim()) errors.push('summary is missing');

// ---------------------------------------------------------------- pull requests
const rows: PrRow[] = Object.entries(st.prs).sort(([, a], [, b]) => P(a.merged_at).getTime() - P(b.merged_at).getTime()).map(([n, p]) => {
  const score = C.scores?.[+n];
  if (C.scores && !score) warnings.push(`scores has no review score for #${n}`);
  if (score && !(score[0] >= 0 && score[0] <= 5)) errors.push(`the review score for #${n} must be 0 to 5`);
  return {
    n: +n, title: C.titles?.[+n] ?? p.title, merged: label(P(p.merged_at), tz), add: p.add, del: p.del, files: p.files, hours: p.hours,
    review_runs: p.review_runs, conf: score ? score[0] : null, conf_note: score ? score[1] : '', ci_failed: p.ci_failed, ci_runs: p.ci_runs,
  };
});
if (!rows.length) errors.push('no pull request merged in the window: a run with nothing merged writes no entry and posts nothing');

// ---------------------------------------------------------------- themes
// The page drops these from a scene; a scene that needs them would show broken, so they stop the build.
function stripped(svg: string) {
  const found: string[] = [];
  for (const m of svg.matchAll(/<(script|foreignobject|iframe|image|a)\b/gi)) found.push(`<${m[1].toLowerCase()}>`);
  for (const m of svg.matchAll(/\s(on\w+)\s*=/gi)) found.push(`${m[1]}=`);
  for (const m of svg.matchAll(/\s((?:xlink:)?href)\s*=\s*["']([^"']*)["']/gi)) if (!m[2].trim().startsWith('#')) found.push(`${m[1]}="${m[2]}"`);
  return found;
}
const covered = new Set<number>();
const ids = new Map<string, number>();
const keys = new Map<string, number>();
const themes: Entry['themes'] = [];
for (const t of C.themes ?? []) {
  const missing = (['key', 'kicker', 'title', 'sum', 'prs', 'paras', 'scene'] as const).filter((k) => !t[k] || (Array.isArray(t[k]) && !(t[k] as unknown[]).length));
  if (!missing.length && !(t.scene.svg && t.scene.caption)) missing.push('scene');
  if (missing.length) { errors.push(`theme "${t.key ?? '?'}" has no ${missing.join(', ')}`); continue; }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t.key)) errors.push(`theme "${t.key}": key must be lower case letters, digits and dashes`);
  keys.set(t.key, (keys.get(t.key) ?? 0) + 1);
  for (const n of t.prs) {
    covered.add(n);
    if (!st.prs[n]) errors.push(`theme "${t.key}" names #${n}, which did not merge in the window`);
  }
  let svg = t.scene.svg;
  if (!svg.startsWith('<svg') || !svg.includes('viewBox=')) errors.push(`theme "${t.key}": the scene is not an <svg> with a viewBox`);
  const bad = stripped(svg);
  if (bad.length) errors.push(`theme "${t.key}": the scene has markup the page strips (${bad.join(', ')})`);
  for (const m of svg.matchAll(/\sid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
  // Marker ids are page wide: tie them to this entry so two entries never share one.
  svg = svg.replace(new RegExp(`(id="|url\\(#)arr-(?!${date})`, 'g'), `$1arr-${date}-`);
  themes.push({ key: t.key, kicker: t.kicker, title: t.title, sum: t.sum, prs: t.prs, paras: t.paras, scene: { svg, caption: t.scene.caption } });
}
for (const [k, n] of keys) if (n > 1) errors.push(`${n} themes have the key "${k}": the page links each theme by its key`);
for (const [id, n] of ids) if (n > 1) errors.push(`the id "${id}" is in ${n} scenes: give each scene's Svg its own key`);
const left = rows.filter((r) => !covered.has(r.n)).map((r) => `#${r.n}`);
if (left.length) warnings.push(`no theme names ${left.join(', ')}`);
if (themes.length < 1 || themes.length > 5) warnings.push(`${themes.length} themes; an entry keeps 1 to 5`);
for (const k of ['intro', 'watch'] as const) if (!C.slack?.[k]?.trim()) errors.push(`slack.${k} is missing`);
if (!C.slack?.lines?.length) errors.push('slack.lines is empty: one line per theme');

// ---------------------------------------------------------------- the document
const entry: Entry = {
  date, window: `${label(w0, tz)} to ${label(w1, tz)}`, span: span(w1.getTime() - w0.getTime()), timezone: tz,
  window_start: st.window.since, window_end: st.window.until,
  title: C.title, summary: C.summary,
  numbers: {
    prs: rows.length, add: rows.reduce((s, r) => s + r.add, 0), del: rows.reduce((s, r) => s + r.del, 0),
    ci_median_min: st.window.ci_median_min, ci_runs: st.window.ci_runs, ci_failed: st.window.ci_failed,
  },
  themes, watch: C.watch ?? [], prs: rows, repo: `https://github.com/${config.repo}/pull/`, source: 'changelog run',
};
const doc = JSON.stringify(entry);
const size = new TextEncoder().encode(doc).length;
if (size > 256 * 1024) errors.push(`the entry is ${Math.round(size / 1024)} KiB; one document holds at most 256 KiB`);
else if (size > 200 * 1024) warnings.push(`the entry is ${Math.round(size / 1024)} KiB, close to the 256 KiB cap`);

// ---------------------------------------------------------------- the Slack post
// The Slack tools read standard Markdown: **bold** and [label](url). A single *x* comes out in italics.
const n = rows.length;
const slack = [
  `**${config.name} changelog, ${shortDate(date)}**`, '',
  ...(config.page ? [`**Read the entry:** [${entry.title}](${config.page}#${date})`, ''] : []),
  `${C.slack?.intro} (${entry.window}), ${n} PR${n === 1 ? '' : 's'} merged:`, '',
  ...(C.slack?.lines ?? []).map(([emoji, text]) => `${emoji} ${text}`),
  `:warning: Watch: ${C.slack?.watch}`,
].join('\n') + '\n';

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`error ${e}`);
if (errors.length) { console.log(`${errors.length} error(s). Nothing written.`); process.exit(1); }
await Bun.write(`${outDir}/${date}.json`, doc);
await Bun.write(`${outDir}/slack.md`, slack);
console.log(`ok    ${outDir}/${date}.json (${(size / 1024).toFixed(1)} KiB, ${n} PRs, ${themes.length} themes) and ${outDir}/slack.md`);
console.log(`      ${entry.window} (${tz}), ${entry.span} | ${JSON.stringify(entry.numbers)}`);

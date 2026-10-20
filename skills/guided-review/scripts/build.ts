#!/usr/bin/env bun
/* Check a guide against its diff, then pack the guided review into one file for the Artifact tool.

     bun scripts/build.ts --diff=<work>/diff.json --guide=<work>/guide.json [--out=<work>/guide] [--repo=<checkout>]
     bun scripts/build.ts ... --check          # check only, write nothing
     bun scripts/build.ts --refresh [--major]  # refresh runtime/libs.json only

   Writes <out>.artifact.html (publish it) and <out>.preview.html (a full document to open locally); <out> defaults
   to the guide's path without .json. Exit code 1 when the guide has errors; warnings do not stop the build.

   Libraries (@pierre/diffs, @pierre/trees, and mermaid for the preview) resolve to the newest release that is at
   least 14 days old (the artifact rule). A refresh runs on its own when libs.json is more than 7 days old, and is skipped quietly when
   offline. Speed: fonts are inline, the runtime is bundled and minified, and every library the page uses is
   preloaded from the head with its whole import graph, so nothing waits on a request chain. Flows are mermaid
   blocks, which the artifact viewer draws itself; only the preview loads mermaid. */
import { join } from 'node:path';
import type { BeforeAfter, Chapter, Diff, DiffFile, Guide, Kind, PageData, StateTable, Text } from '../runtime/types';

const ROOT = join(import.meta.dir, '..');
const RT = join(ROOT, 'runtime');
const LIBS = join(RT, 'libs.json');
const DAY = 86_400_000;

// ---------------------------------------------------------------- libraries
type Lib = { pkg: string; version: string; url: string; modules?: string[] };
type LibFile = { note: string; checked: string; libs: Record<string, Lib> };

/** Semver order, prereleases included: 1.0.0-beta.2 < 1.0.0-beta.10 < 1.0.0-rc.1 < 1.0.0 < 1.0.1. */
function compare(a: string, b: string): number {
  const split = (v: string) => { const i = v.indexOf('-'); return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)]; };
  const [am, ap] = split(a), [bm, bp] = split(b);
  const x = am.split('.').map(Number), y = bm.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (ap === bp) return 0;
  if (!ap || !bp) return ap ? -1 : 1;
  const p = ap.split('.'), q = bp.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const [pn, qn] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (pn && qn && +p[i] !== +q[i]) return +p[i] - +q[i];
    if (pn !== qn) return pn ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

async function refresh(major: boolean) {
  const data: LibFile = await Bun.file(LIBS).json();
  const cutoff = Date.now() - 14 * DAY;
  const changed: string[] = [];
  await Promise.all(Object.entries(data.libs).map(async ([name, lib]) => {
    let meta: { time?: Record<string, string> };
    try {
      meta = await (await fetch(`https://registry.npmjs.org/${lib.pkg}`, { signal: AbortSignal.timeout(8000) })).json();
    } catch (e) {
      console.log(`  libs: ${name} not checked (${(e as Error).name}); keeping ${lib.version}`);
      return;
    }
    // Stable releases of the same major; a prerelease pin also takes newer prereleases of its own version.
    const main = lib.version.split('-')[0], pre = lib.version.includes('-');
    let best: string | null = null;
    for (const [v, t] of Object.entries(meta.time ?? {})) {
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) || Date.parse(t) > cutoff) continue;
      if (!major && v.split('.')[0] !== main.split('.')[0]) continue;
      if (v.includes('-') && !(pre && v.split('-')[0] === main)) continue;
      if (!best || compare(v, best) > 0) best = v;
    }
    if (best && compare(best, lib.version) > 0) { changed.push(`${name} ${lib.version} -> ${best}`); lib.version = best; }
    lib.modules = await graph(lib.url.replace('{v}', lib.version)).catch(() => lib.modules ?? []);
  }));
  data.checked = new Date().toISOString().slice(0, 10);
  await Bun.write(LIBS, JSON.stringify(data, null, 1) + '\n');
  console.log('  libs: ' + (changed.length ? changed.join(', ') : 'up to date'));
}

/** Every module an ES module on jsDelivr imports statically, transitively, so a page can preload them in one round. */
async function graph(entry: string): Promise<string[]> {
  const seen = new Set([entry]), queue = [entry];
  while (queue.length) {
    const url = queue.shift()!;
    const src = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).text();
    for (const [, spec] of src.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)) {
      if (!spec.startsWith('/npm/') && !spec.startsWith('./') && !spec.startsWith('../')) continue;
      const next = new URL(spec, url).href;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return [...seen];
}

async function libs(force: boolean, major: boolean) {
  let data: LibFile = await Bun.file(LIBS).json();
  const stale = Date.now() - Date.parse(data.checked) > 7 * DAY || Object.values(data.libs).some((l) => !l.modules?.length);
  if (force || stale) { await refresh(major); data = await Bun.file(LIBS).json(); }
  return Object.fromEntries(Object.entries(data.libs).map(([k, l]) => [k, { url: l.url.replace('{v}', l.version), modules: l.modules ?? [] }]));
}

const argv = Bun.argv.slice(2);
/** --name=value or --name value. */
const opt = (name: string, fallback?: string) => {
  const i = argv.findIndex((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  return argv[i].includes('=') ? argv[i].slice(name.length + 3) : (argv[i + 1] ?? fallback);
};
const flag = (f: string) => argv.includes(`--${f}`);
const libmap = await libs(flag('refresh'), flag('major'));
if (!opt('guide')) {
  if (flag('refresh')) process.exit(0);
  console.log('usage: bun scripts/build.ts --diff=diff.json --guide=guide.json [--out=guide] [--check] [--repo=<checkout>]');
  process.exit(flag('help') ? 0 : 2);
}
const guidePath = opt('guide')!;
const diff: Diff = await Bun.file(opt('diff', 'diff.json')!).json();
const guide: Guide = await Bun.file(guidePath).json();
const stem = (opt('out') ?? guidePath).replace(/\.(json|html?)$/, '').replace(/\.artifact$/, '');

const KINDS: Kind[] = ['core', 'docs', 'database', 'tests', 'generated'];
const LABEL: Partial<Record<Kind, string>> = { docs: 'Docs', database: 'Database', tests: 'Tests', generated: 'Generated' };
const LATE = new Set<Kind>(['database', 'tests', 'generated']);

const errors: string[] = [];
const warns: string[] = [];
const err = (m: string) => errors.push(m);
const warn = (m: string) => warns.push(m);
const words = (s: unknown) => String(s ?? '').replace(/`[^`]*`/g, 'x').split(/\s+/).filter(Boolean).length;
const paras = (b: Text | undefined) => (Array.isArray(b) ? b : b == null ? [] : [b]).map(String);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pad2 = (n: number) => String(n).padStart(2, '0');

const FILES = new Map<string, DiffFile>(diff.files.map((f) => [f.path, f]));

// ---------------------------------------------------------------- refs
// "path:line" names a line on the new side, or on the old side for a removed line. A file the pull request does
// not change links to GitHub at the head commit, and so does a line the page cannot show: one outside the hunks of
// a file kept without its text.
type Ref = { path: string; line: number; side?: 'o' | 'n'; external?: string };
const pr = guide.pr ?? ({} as Guide['pr']);
const repoUrl = String(pr.url ?? '').replace(/\/pull\/\d+.*$/, '') || diff.repo;
const checkout = opt('repo', process.cwd())!;
const atHead = (path: string) => Bun.spawnSync(['git', '-C', checkout, 'cat-file', '-e', `${diff.head}:${path}`], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const inHunks = (f: DiffFile, line: number, s: 'o' | 'n') => f.hunks.some((h) => h.lines.some((l) => (s === 'o' ? l[1] : l[2]) === line));
const blob = (rev: string, path: string, line: number) => `${repoUrl}/blob/${rev}/${path}${line ? `#L${line}` : ''}`;

function parseRef(ref: string, side: 'o' | 'n', where: string): Ref | null {
  const m = String(ref).match(/^(.+?)(?::(\d+))?$/);
  const line = m?.[2] ? Number(m[2]) : 0;
  const f = m && FILES.get(m[1]);
  if (!m || !f) {
    if (m && atHead(m[1])) {
      if (!repoUrl) { err(`${where}: ref "${ref}" names a file the pull request does not change, and there is no repository URL to link it to (set pr.url).`); return null; }
      return { path: m[1], line, external: blob(diff.head, m[1], line) };
    }
    err(`${where}: ref "${ref}" names a file that is neither in this pull request nor at its head in ${checkout} (pass --repo=<checkout>).`);
    return null;
  }
  const s = f.status === 'deleted' ? 'o' : f.status === 'added' ? 'n' : side;
  if (side === 'o' && f.status === 'added') { err(`${where}: ref "${ref}" points at the old side of an added file.`); return null; }
  const count = s === 'n' ? (f.newCount ?? f.new?.length) : (f.old?.length ?? f.oldCount);
  if (line && count != null && line > count) { err(`${where}: ref "${ref}" is past the end of the file (${count} lines).`); return null; }
  // The page shows a line outside the hunks only when it has the file's text.
  if (line && !f.new && !f.old && !inHunks(f, line, s)) {
    if (!repoUrl) { err(`${where}: ref "${ref}" is outside the hunks of a file kept without its text, and there is no repository URL to link it to.`); return null; }
    return { path: f.path, line, external: s === 'o' ? blob(diff.base, f.oldPath ?? f.path, line) : blob(diff.head, f.path, line) };
  }
  return { path: f.path, line, side: s };
}
/** A ref as a link: an in-page jump for a changed file, GitHub for any other. */
function refLink(r: Ref, text: string, cls = '') {
  const title = `${r.path}${r.line ? `:${r.line}` : ''}`;
  if (r.external) return `<a class="${cls}" href="${esc(r.external)}" target="_blank" rel="noopener" title="${esc(title)} on GitHub">${text}</a>`;
  return `<a href="#" class="${cls}" data-ref="${esc(r.path)}" data-line="${r.line}" data-side="${r.side}" title="${esc(title)}">${text}</a>`;
}

// ---------------------------------------------------------------- check the guide
if (!pr.title) err('pr.title is missing. Copy the pull request\'s title.');
if ((pr.number == null) !== (pr.url == null)) err('pr needs both number and url, or neither (for a branch with no pull request).');
if (pr.url && !/^https:\/\//.test(pr.url)) err('pr.url must start with https://.');
if (guide.name != null && (!String(guide.name).trim() || words(guide.name) > 5)) err('name is the page\'s name in the gallery: 2 to 4 words, such as "Webhook retries review".');
if (pr.number == null && guide.name == null) warn('Give a guide with no pull request number a name (2 to 4 words); the page is called "Review of <branch>" otherwise.');
if (guide.diffStyle != null && guide.diffStyle !== 'unified' && guide.diffStyle !== 'split') err('diffStyle must be "unified" or "split".');
const ov = guide.overview ?? ({} as Guide['overview']);
if (!ov.summary) err('overview.summary is missing: say what the pull request changes in 2 to 4 sentences.');
else if (words(paras(ov.summary).join(' ')) > 80) warn(`overview.summary has ${words(paras(ov.summary).join(' '))} words. Keep it under 80; the chapters carry the detail.`);
const steps = ov.steps ?? [];
if (steps.length > 5) warn(`overview.steps has ${steps.length} items. Keep 2 to 5.`);
steps.forEach((s, i) => { if (words(s) > 30) warn(`overview.steps[${i}] has ${words(s)} words. One line each.`); });
if (!ov.beforeAfter) err('overview.beforeAfter is missing. Every guide opens with a before / after.');

const chapters: Chapter[] = guide.chapters ?? [];
if (!chapters.length) err('The guide has no chapters.');
if (chapters.length > 12) warn(`The guide has ${chapters.length} chapters. Merge small ones; aim for 3 to 8.`);
const ids = new Set<string>();
const covered = new Map<string, Map<number, string[]>>(); // path → hunk id → chapter ids
let sawLate = false, sawGenerated = false;
const sel: { path: string; hunks: number[] | null }[][] = []; // per chapter
for (const [i, ch] of chapters.entries()) {
  const where = `chapters[${i}]${ch.id ? ` (${ch.id})` : ''}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ch.id ?? '')) err(`${where}: id must be lower case letters, digits and dashes.`);
  if (ids.has(ch.id)) err(`${where}: id is used twice.`);
  ids.add(ch.id);
  if (!ch.title) err(`${where}: title is missing.`);
  else if (words(ch.title) > 9) warn(`${where}: the title has ${words(ch.title)} words. Name the idea in a few words.`);
  const kind = ch.kind ?? 'core';
  if (!KINDS.includes(kind)) err(`${where}: kind must be one of ${KINDS.join(', ')}.`);
  if (sawGenerated && kind !== 'generated') err(`${where}: generated chapters come last.`);
  if (sawLate && !LATE.has(kind)) err(`${where}: a ${kind} chapter comes after a database, tests or generated chapter. The core change comes first.`);
  if (LATE.has(kind)) sawLate = true;
  if (kind === 'generated') sawGenerated = true;
  const body = paras(ch.body);
  if (!body.length) err(`${where}: body is missing.`);
  const bw = body.reduce((n, p) => n + words(p), 0);
  if (bw > 110) warn(`${where}: the body has ${bw} words. Keep a chapter under 110; split the idea or cut what the code shows.`);
  const files: { path: string; hunks: number[] | null }[] = [];
  for (const entry of ch.files ?? []) {
    const path = typeof entry === 'string' ? entry : entry?.path;
    const f = FILES.get(path);
    if (!f) { err(`${where}: "${path}" is not a file in this pull request.`); continue; }
    let hunks = typeof entry === 'object' && entry.hunks ? entry.hunks : null;
    if (hunks) {
      const bad = hunks.filter((h) => !f.hunks.some((x) => x.id === h));
      if (bad.length) err(`${where}: ${path} has no hunk ${bad.join(', ')} (it has ${f.hunks.length}).`);
      hunks = hunks.filter((h) => !bad.includes(h));
      if (hunks.length === f.hunks.length) hunks = null;
    }
    if (f.kind === 'generated' && kind !== 'generated') warn(`${where}: ${path} looks generated; put it in a generated chapter at the end.`);
    if (!covered.has(path)) covered.set(path, new Map());
    const map = covered.get(path)!;
    if (!f.hunks.length) map.set(0, [...(map.get(0) ?? []), ch.id]);
    for (const h of hunks ?? f.hunks.map((x) => x.id)) map.set(h, [...(map.get(h) ?? []), ch.id]);
    files.push({ path, hunks });
  }
  if (!files.length) err(`${where}: files is empty. A chapter shows the code it explains.`);
  if (files.length > 10) warn(`${where}: ${files.length} files. A chapter is one idea; split it.`);
  sel.push(files);
}
for (const f of diff.files) {
  const map = covered.get(f.path);
  if (!map) { err(`${f.path} is in no chapter. Every file in the pull request belongs to one.`); continue; }
  for (const h of f.hunks) {
    const by = map.get(h.id);
    if (!by) err(`${f.path} hunk ${h.id} (L${h.newStart}, ${h.label || 'top of file'}) is in no chapter.`);
    else if (by.length > 1) warn(`${f.path} hunk ${h.id} is in ${by.length} chapters (${by.join(', ')}). Show it once.`);
  }
}

/** The chapter that shows a line, for the chapter number beside a before / after row. */
function chapterOf(ref: Ref): number | null {
  const f = FILES.get(ref.path)!;
  const hit = f.hunks.find((h) => {
    if (!ref.line) return false;
    const [s, e] = ref.side === 'o' ? [h.oldStart, h.oldStart + h.oldLines - 1] : [h.newStart, h.newStart + h.newLines - 1];
    return ref.line >= s && ref.line <= e;
  });
  const idx = sel.findIndex((files) => files.some((x) => x.path === ref.path && (!hit || !x.hunks || x.hunks.includes(hit.id))));
  return idx < 0 ? null : idx;
}

// ---------------------------------------------------------------- inline text
// Markdown subset: `code`, **bold**, *em*, [text](https://…) and [text](ref:path:line). Code spans are set aside
// first, so bold or italic can wrap one, and `handlers[i](ctx)` is never read as a link.
function inline(s: string) {
  const codes: string[] = [];
  const text = esc(String(s).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`));
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[+i])}</code>`);
}
function md(s: string, where: string) {
  const codes: string[] = [];
  const kept = String(s).replace(/`[^`]+`/g, (c) => `\u0001${codes.push(c) - 1}\u0001`);
  const back = (t: string) => t.replace(/\u0001(\d+)\u0001/g, (_, i: string) => codes[+i]);
  return kept.split(/(\[[^\]]+\]\([^)\s]+\))/).map((p) => {
    const m = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (!m) return inline(back(p));
    const [text, target] = [back(m[1]), back(m[2])];
    if (target.startsWith('ref:')) {
      const r = parseRef(target.slice(4), 'n', where);
      return r ? refLink(r, inline(text), 'ref') : inline(text);
    }
    if (!/^https:\/\//.test(target)) { err(`${where}: link "${target}" must start with https:// or ref:.`); return inline(text); }
    return `<a href="${esc(target)}" target="_blank" rel="noopener">${inline(text)}</a>`;
  }).join('');
}

// ---------------------------------------------------------------- before / after
// The new, changed and removed node styles, in colors that read on both themes.
const FLOW_CLASSES = [
  'classDef new stroke:#22a35a,stroke-width:2px;',
  'classDef changed stroke:#d08700,stroke-width:2px;',
  'classDef removed stroke:#dc3e3e,stroke-width:2px,stroke-dasharray:4 3;',
];
const CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let flows = 0;
function beforeAfter(ba: BeforeAfter | undefined, where: string) {
  if (!ba) return '';
  const lines = ba.lines ?? [];
  if (!lines.length && !ba.flow) { err(`${where}: give lines (pseudocode or a call tree) or a flow.`); return ''; }
  if (lines.length > 32) warn(`${where}: ${lines.length} lines. Keep the before / after under 30; show the path that changed.`);
  let add = 0, del = 0;
  const rows = lines.map((l, i) => {
    const w = `${where}.lines[${i}]`;
    const op = l.op ?? ' ';
    if (![' ', '+', '-'].includes(op)) err(`${w}: op must be " ", "+" or "-".`);
    if (op === '+') add++;
    if (op === '-') del++;
    if (!l.t) err(`${w}: t (the row's text) is missing.`);
    else if (String(l.t).length > 90) warn(`${w}: ${String(l.t).length} characters. Keep a row under 90.`);
    const depth = Math.max(0, Math.min(8, l.d ?? 0));
    let rf = '';
    const ref = l.ref ? parseRef(l.ref, op === '-' ? 'o' : 'n', w) : null;
    if (ref) rf += refLink(ref, `${esc(ref.path.split('/').pop())}${ref.line ? ` ${ref.line}` : ''}`, ref.external ? 'ext' : '');
    let chIdx: number | null = null;
    if (l.ch) { chIdx = chapters.findIndex((c) => c.id === l.ch); if (chIdx < 0) err(`${w}: ch "${l.ch}" is not a chapter id.`); }
    else if (ref && !ref.external) chIdx = chapterOf(ref);
    if (chIdx != null && chIdx >= 0) rf += `<button type="button" class="chn" data-chapter-go="${esc(chapters[chIdx].id)}" title="${esc(chapters[chIdx].title)}">${pad2(chIdx + 1)}</button>`;
    const cls = op === '+' ? 'add' : op === '-' ? 'del' : 'ctx';
    const note = l.note ? `<span class="note">${esc(l.note)}</span>` : '';
    return `<div class="ln ${cls}"><span class="mk">${op === '+' ? '+' : op === '-' ? '−' : ''}</span><span class="tx">${'  '.repeat(depth)}${esc(l.t)}${note}</span><span class="rf">${rf}</span></div>`;
  }).join('');
  let flow = '';
  if (ba.flow) {
    const src = String(ba.flow).trim().split('\n');
    if (!/^(flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/.test(src[0])) err(`${where}.flow: start with "flowchart LR" or "flowchart TD".`);
    flow = `<div class="flow"><pre class="mermaid">${esc([src[0], ...FLOW_CLASSES.map((c) => `  ${c}`), ...src.slice(1)].join('\n'))}</pre></div>`;
    flows++;
  }
  const label = ba.label ? `<span class="lbl">${esc(ba.label)}</span>` : '';
  const stat = lines.length ? `<span class="fstat">${add ? `<span class="add-n">+${add}</span>` : ''}${del ? `<span class="del-n">−${del}</span>` : ''}<span>${lines.length} lines</span></span>` : '';
  return `<div class="gr-card gr-ba"><header><button type="button" class="gr-fold" aria-label="Fold before / after" aria-expanded="true">${CHEV}</button>`
    + `<span class="ttl">Before / after</span>${label}<span class="sp"></span>${stat}</header>`
    + (ba.title ? `<div class="cap">${esc(ba.title)}</div>` : '') + flow + (rows ? `<div class="lines">${rows}</div>` : '') + '</div>';
}

// ---------------------------------------------------------------- state table
function table(t: StateTable | undefined, where: string) {
  if (!t) return '';
  const cols = t.columns ?? [];
  if (!cols.length) { err(`${where}: columns is missing.`); return ''; }
  const rows = (t.rows ?? []).map((r, i) => {
    const cells = Array.isArray(r) ? r : r.cells;
    if (!Array.isArray(cells) || cells.length !== cols.length) err(`${where}.rows[${i}]: give ${cols.length} cells.`);
    const cls = !Array.isArray(r) && r.new ? 'new' : !Array.isArray(r) && r.gone ? 'gone' : '';
    return `<tr class="${cls}">${(cells ?? []).map((c) => `<td>${md(c, where)}</td>`).join('')}</tr>`;
  }).join('');
  let ref = '';
  if (t.ref) {
    const r = parseRef(t.ref, 'n', where);
    if (r) ref = refLink(r, `${esc(r.path.split('/').pop())}${r.line ? ` ${r.line}` : ''}`);
  }
  return `<div class="gr-table"><header><b>${esc(t.title ?? 'State table')}</b>${t.caption ? `<span>${esc(t.caption)}</span>` : ''}${ref}</header>`
    + `<div class="scroll"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
    + (t.note ? `<footer>${md(t.note, where)}</footer>` : '') + '</div>';
}

// ---------------------------------------------------------------- page
const chip = (path: string) => {
  const name = path.split('/').pop()!;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return ext && ext.length <= 4 ? ext : 'txt';
};
const statHtml = (a: number, d: number) => `${a ? `<span class="add-n">+${a}</span>` : ''}${d ? `<span class="del-n">−${d}</span>` : ''}`;
function fileList(files: { path: string; hunks: number[] | null }[]) {
  return `<ul class="gr-filelist">${files.map(({ path, hunks }) => {
    const f = FILES.get(path)!;
    const name = path.split('/').pop()!;
    const dir = path.slice(0, path.length - name.length);
    let a = 0, d = 0;
    for (const h of f.hunks) if (!hunks || hunks.includes(h.id)) for (const l of h.lines) { if (l[0] === '+') a++; else if (l[0] === '-') d++; }
    const part = hunks ? '<span class="part">part</span>' : '';
    return `<li><button type="button" data-goto="${esc(path)}"><span class="gr-lang">${esc(chip(path))}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span><span class="stat">${part}${statHtml(a, d)}</span></button></li>`;
  }).join('')}</ul>`;
}

const total = diff.files.reduce((s, f) => [s[0] + f.add, s[1] + f.del], [0, 0]);
const headShort = diff.head.slice(0, 7);
const n = chapters.length;
const sections: string[] = [];
sections.push(`<section class="gr-sec" id="overview" data-title="Overview"><div class="gr-text"><h2>Overview</h2><div class="gr-body">`
  + paras(ov.summary).map((p) => `<p>${md(p, 'overview.summary')}</p>`).join('')
  + (steps.length ? `<ol>${steps.map((s, i) => `<li>${md(s, `overview.steps[${i}]`)}</li>`).join('')}</ol>` : '')
  + `</div></div><div class="gr-code-col">${beforeAfter(ov.beforeAfter, 'overview.beforeAfter')}</div></section>`);
let labelStarted = false;
chapters.forEach((ch, i) => {
  const kind = ch.kind ?? 'core';
  const where = `chapters[${i}]`;
  const startLabel = LATE.has(kind) && !labelStarted;
  if (startLabel) labelStarted = true;
  sections.push(`<section class="gr-sec${startLabel ? ' label-start' : ''}" id="c-${esc(ch.id)}" data-chapter="${esc(ch.id)}" data-title="${esc(ch.title)}">`
    + `<div class="gr-text"><h2>${esc(ch.title)}</h2><div class="gr-chmeta"><span class="gr-count">${pad2(i + 1)} / ${pad2(n)}</span>`
    + (LABEL[kind] ? `<span class="gr-kind">${LABEL[kind]}</span>` : '')
    + `<label class="gr-check"><input type="checkbox" data-review-chapter="${esc(ch.id)}"> Reviewed</label></div>`
    + `<div class="gr-body">${paras(ch.body).map((p) => `<p>${md(p, `${where}.body`)}</p>`).join('')}</div>`
    + table(ch.table, `${where}.table`) + fileList(sel[i] ?? []) + '</div>'
    + `<div class="gr-code-col">${beforeAfter(ch.beforeAfter, `${where}.beforeAfter`)}<div class="gr-files" data-chapter="${esc(ch.id)}"></div></div></section>`);
});

const links = (guide.links ?? []).map((l, i) => {
  if (!/^https:\/\//.test(l.href ?? '')) { err(`links[${i}]: href must start with https://.`); return ''; }
  return `<a class="gr-btn" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`;
}).join('');
// The links scroll inside their own row when the bar is too narrow for them.
const linkRow = links ? `<span class="gr-links">${links}</span>` : '';
// git log lists the newest commit first; the pull request's author wrote the oldest.
const author = pr.author ?? diff.commits?.at(-1)?.author ?? '';
const baseName = pr.base ?? (diff.baseRef ?? 'main').replace(/^origin\//, '');
const branch = pr.head ?? diff.branch;
const num = pr.number != null ? `#${esc(pr.number)}` : '';
const headLink = repoUrl ? `<a class="mono" href="${esc(repoUrl)}/commit/${diff.head}" target="_blank" rel="noopener">${headShort}</a>` : `<span class="mono">${headShort}</span>`;
const meta = [
  author ? `<span><span class="gr-avatar">${esc(author[0])}</span>${esc(author)}</span>` : '',
  pr.url ? `<a href="${esc(pr.url)}" target="_blank" rel="noopener">${num}</a>` : '',
  branch ? `<span class="mono">${esc(baseName)} ← ${esc(branch)}</span>` : '',
  `<span>${diff.files.length} file${diff.files.length === 1 ? '' : 's'}</span>`,
  `<span>${statHtml(total[0], total[1])}</span>`,
  `<span>written for ${headLink}</span>`,
].filter(Boolean).join('');
const ofWhat = pr.url ? `<a href="${esc(pr.url)}" target="_blank" rel="noopener">${num}</a>` : esc(branch ?? 'the branch');

const PR_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.25 2.25 0 1 0 1.5 0V5.372ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM11.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm.75-1.372V6.25A2.25 2.25 0 0 0 9.75 4H8.56l.97-.97a.75.75 0 0 0-1.06-1.06L6.22 4.22a.75.75 0 0 0 0 1.06l2.25 2.25a.75.75 0 0 0 1.06-1.06l-.97-.97h1.19a.75.75 0 0 1 .75.75v4.378a2.25 2.25 0 1 0 1.5 0Z"/></svg>';
const SOUND_ICON = '<svg class="on" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9"/></svg>'
  + '<svg class="off" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="m10.5 6 4 4M14.5 6l-4 4"/></svg>';

const style = guide.diffStyle ?? 'unified';
const markup = `<div class="gr-wrap gr-crumbs">${PR_ICON}<span>${pr.number != null ? 'Pull requests' : 'Changes'}</span><span>›</span><span class="t">${esc(pr.title)}</span>${statHtml(total[0], total[1])}</div>
<div class="gr-bar"><div class="gr-wrap">
<div class="gr-tabs" role="tablist"><button type="button" class="gr-tab" role="tab" data-view="guide" aria-selected="true">Guide</button><button type="button" class="gr-tab" role="tab" data-view="diff" aria-selected="false">Diff</button></div>
<span class="gr-spacer"></span><span class="gr-progress" id="gr-progress"></span><span class="gr-seg" role="group" aria-label="Diff layout"><button type="button" data-diff-style="unified" aria-pressed="${style === 'unified'}">Unified</button><button type="button" data-diff-style="split" aria-pressed="${style === 'split'}">Split</button></span><button type="button" class="gr-icon" id="gr-sound" aria-label="Sound" aria-pressed="true" title="Sound">${SOUND_ICON}</button>${linkRow}
${pr.url ? `<a class="gr-btn primary" href="${esc(pr.url)}" target="_blank" rel="noopener"><span>Open ${num}<span class="long"> on GitHub</span></span><span aria-hidden="true">↗</span></a>` : ''}
</div></div>
<div class="gr-wrap">
<header class="gr-head"><h1>${esc(pr.title)}</h1><div class="gr-meta">${meta}</div></header>
<main>
<div id="gr-guide" class="gr-view">
${sections.join('\n')}
</div>
<div id="gr-diff" class="gr-view gr-diff" hidden><aside class="gr-tree"><h3>${diff.files.length} files</h3><div class="gr-tree-host" id="gr-tree-host"></div></aside><div class="gr-diff-cards" id="gr-diff-cards"></div></div>
</main>
<footer class="gr-foot"><span>Guided review of ${ofWhat} at ${headShort}, ${diff.base.slice(0, 7)}..${headShort}</span><span><kbd>j</kbd> <kbd>k</kbd> next and previous chapter · <kbd>r</kbd> mark the chapter reviewed · shift-click a fold to open it all</span></footer>
</div>
<nav class="gr-rail" aria-label="Chapters"></nav>`;

// ---------------------------------------------------------------- report
const hunkCount = diff.files.reduce((s, f) => s + f.hunks.length, 0);
console.log(`guide ${num || esc(pr.title)}: ${n} chapters, ${diff.files.length} files, ${hunkCount} hunks, ${flows} flow${flows === 1 ? '' : 's'}`);
chapters.forEach((ch, i) => console.log(`  ${pad2(i + 1)} ${(ch.kind ?? 'core').padEnd(9)} ${String(paras(ch.body).reduce((s, p) => s + words(p), 0)).padStart(3)} words  ${ch.title}`));
for (const w of warns) console.log(`  warn  ${w}`);
for (const e of errors) console.log(`  error ${e}`);
if (errors.length) { console.log(`${errors.length} error(s). Nothing written.`); process.exit(1); }
if (flag('check')) { console.log(`ok    ${warns.length} warning(s)`); process.exit(0); }

// ---------------------------------------------------------------- pack
async function fontFaces() {
  const { faces } = await Bun.file(join(RT, 'fonts', 'fonts.json')).json() as { faces: { family: string; weight: string; range: string; file: string }[] };
  const css = await Promise.all(faces.map(async (f) => {
    const b64 = Buffer.from(await Bun.file(join(RT, 'fonts', f.file)).arrayBuffer()).toString('base64');
    return `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${f.range}}`;
  }));
  return css.join('\n') + '\n';
}
async function runtime() {
  const out = await Bun.build({ entrypoints: [join(RT, 'index.ts')], target: 'browser', format: 'iife', minify: true });
  if (!out.success) { for (const log of out.logs) console.log('  error ' + log); process.exit(1); }
  return (await out.outputs[0].text()).replaceAll('</script', '<\\/script');
}

const hints = ['diffs', 'trees'].flatMap((k) => (libmap[k].modules.length ? libmap[k].modules : [libmap[k].url]))
  .map((m) => `<link rel="modulepreload" href="${m}" crossorigin>`).join('\n');
const { sounds } = await Bun.file(join(RT, 'sounds.json')).json() as { sounds: Record<string, { uri: string; db: number }> };
const data: PageData = {
  // By pull request (or branch), not head: marks carry over when the page is rebuilt for a new head.
  key: `gr:${pr.number ?? branch ?? diff.head}`,
  libs: { diffs: libmap.diffs.url, trees: libmap.trees.url },
  diffStyle: style,
  sounds: Object.fromEntries(['select', 'deselect', 'nav', 'toggle', 'reveal'].map((k) => [k, { uri: sounds[k].uri, db: sounds[k].db }])),
  chapters: chapters.map((c, i) => ({ id: c.id, title: c.title, files: sel[i] ?? [] })),
  files: diff.files,
};
const [css, fonts, js] = await Promise.all([Bun.file(join(RT, 'guide.css')).text(), fontFaces(), runtime()]);
// The title first (the viewer reads it from the first 8 KB), then preloads so the libraries download while the page
// parses; the data and the runtime go after the markup they fill.
const name = guide.name ?? (num ? `Guided review ${num}` : `Review of ${esc(branch ?? headShort)}`);
const page = `<title>${esc(name)}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${hints}\n`
  + `<style>\n${fonts}${css}</style>\n${markup}\n`
  + `<script type="application/json" id="gr-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n`
  + `<script>\n${js}</script>\n`;
await Bun.write(`${stem}.artifact.html`, page);
// The preview has no artifact viewer to draw the flows, so it loads mermaid itself.
const mermaid = flows ? `<script type="module">import mermaid from '${libmap.mermaid.url}';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral', fontFamily: 'JetBrains Mono, monospace' });
await mermaid.run({ querySelector: 'pre.mermaid', suppressErrors: true });</script>\n` : '';
await Bun.write(`${stem}.preview.html`,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  + page + mermaid + '</body></html>\n');
console.log(`ok    ${warns.length} warning(s), ${Math.round(page.length / 1024)} KB\n      publish: ${stem}.artifact.html\n      preview: ${stem}.preview.html`);

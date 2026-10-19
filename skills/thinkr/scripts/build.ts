#!/usr/bin/env bun
/* Check a thinkr page and pack it into one file for the Artifact tool.

     bun scripts/build.ts page.html            # check, then write page.artifact.html and page.preview.html
     bun scripts/build.ts page.html --refresh  # also refresh runtime/libs.json from npm first
     bun scripts/build.ts --refresh [--major]  # refresh libs only

   Libraries resolve to the newest stable release that is at least 14 days old (the artifact rule). A refresh
   runs on its own when libs.json is more than 7 days old, and is skipped quietly when offline.

   Speed: the page carries its fonts inline, math and code highlighting are rendered here (no MathJax or
   highlight.js in the page), and every library the page uses is preloaded from the head, its whole import
   graph at once, so nothing waits on a request chain. Needs `bun install` in this skill's directory. */
import { join } from 'node:path';

const RT = join(import.meta.dir, '..', 'runtime');
const LIBS = join(RT, 'libs.json');
const HOSTS = ['https://cdnjs.cloudflare.com/', 'https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/'];
const ID = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const DAY = 86_400_000;

type Lib = { pkg: string; version: string; url: string; global?: string; deps?: string[]; modules?: string[] };
type LibFile = { note: string; checked: string; libs: Record<string, Lib> };
type LibMap = Record<string, Omit<Lib, 'pkg' | 'version'>>;

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Import a build dependency. A plugin install already ran `bun install`; other installs (npx skills, a
    plain copy) have no node_modules yet, so the first build installs them once, from the pinned lockfile. */
let installed = false;
async function need<T>(spec: string): Promise<T> {
  try { return await import(spec); } catch { /* not installed yet */ }
  const dir = join(import.meta.dir, '..');
  if (!installed) {
    installed = true;
    console.log('  setup installing build dependencies (once)…');
    const r = Bun.spawnSync(['bun', 'install', '--production', '--frozen-lockfile'], { cwd: dir, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode) { console.log(`  error \`bun install\` failed in ${dir}:\n${r.stderr.toString().trim()}`); process.exit(1); }
  }
  try { return await import(spec); } catch { /* resolution may have cached the miss; try the path itself */ }
  try { return await import(Bun.resolveSync(spec, dir)); }
  catch { console.log(`  error ${spec} is missing. Run \`bun install\` in ${dir}.`); process.exit(1); }
}

// ---------------------------------------------------------------- libraries
const semver = (v: string) => v.split('.').map(Number);
const newer = (a: string, b: string) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

async function refresh(major: boolean) {
  const data: LibFile = await Bun.file(LIBS).json();
  const cutoff = Date.now() - 14 * DAY;
  const changed: string[] = [];
  await Promise.all(Object.entries(data.libs).map(async ([name, lib]) => {
    let meta: { time?: Record<string, string> };
    try {
      const r = await fetch(`https://registry.npmjs.org/${lib.pkg}`, { signal: AbortSignal.timeout(8000) });
      meta = await r.json();
    } catch (e) {
      console.log(`  libs: ${name} not checked (${(e as Error).name}); keeping ${lib.version}`);
      return;
    }
    const cur = lib.version.split('.')[0];
    let best: string | null = null;
    for (const [v, t] of Object.entries(meta.time ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(v) || (!major && v.split('.')[0] !== cur) || Date.parse(t) > cutoff) continue;
      if (!best || newer(v, best)) best = v;
    }
    if (best && best !== lib.version) { changed.push(`${name} ${lib.version} -> ${best}`); lib.version = best; }
    if (!lib.global) lib.modules = await graph(lib.url.replace('{v}', lib.version)).catch(() => lib.modules ?? []);
  }));
  data.checked = new Date().toISOString().slice(0, 10);
  await Bun.write(LIBS, JSON.stringify(data, null, 1) + '\n');
  console.log('  libs: ' + (changed.length ? changed.join(', ') : 'up to date'));
}

/** Every module an ESM entry on jsDelivr imports, transitively, so a page can preload them in one round. */
async function graph(entry: string): Promise<string[]> {
  const seen = new Set([entry]), queue = [entry];
  while (queue.length) {
    const src = await (await fetch(queue.shift()!, { signal: AbortSignal.timeout(8000) })).text();
    for (const [, path] of src.matchAll(/(?:from|import)\s*["'](\/npm\/[^"']+)["']/g)) {
      const url = 'https://cdn.jsdelivr.net' + path;
      if (!seen.has(url)) { seen.add(url); queue.push(url); }
    }
  }
  return [...seen];
}

async function libs(force: boolean, major: boolean): Promise<LibMap> {
  let data: LibFile = await Bun.file(LIBS).json();
  const stale = Date.now() - Date.parse(data.checked) > 7 * DAY || Object.values(data.libs).some((l) => !l.global && !l.modules?.length);
  if (force || stale) { await refresh(major); data = await Bun.file(LIBS).json(); }
  return Object.fromEntries(Object.entries(data.libs).map(([k, { pkg: _p, version, url, ...rest }]) => [k, { url: url.replace('{v}', version), ...rest }]));
}

/** The libraries a page needs: motion always (the runtime animates with it), plus what its scripts load. */
function used(scripts: string, libmap: LibMap): string[] {
  const out = new Set(['motion']);
  if (/\.vgpu\s*\(/.test(scripts)) out.add('vgpu');
  for (const [, name] of scripts.matchAll(/load\(\s*['"`]([\w-]+)['"`]/g)) if (libmap[name]) out.add(name);
  for (const name of [...out]) for (const dep of libmap[name].deps ?? []) out.add(dep);
  return [...out];
}

/** Preload hints for the head: each library's file, or its whole module graph, fetched while the page parses. */
const hints = (names: string[], libmap: LibMap) => names.flatMap((n) => {
  const l = libmap[n];
  return l.global ? [`<link rel="preload" as="script" href="${l.url}">`] : (l.modules?.length ? l.modules : [l.url]).map((m) => `<link rel="modulepreload" href="${m}" crossorigin>`);
}).join('\n');

async function fontFaces() {
  const { faces } = await Bun.file(join(RT, 'fonts', 'fonts.json')).json() as { faces: { family: string; weight: string; range: string; file: string }[] };
  const css = await Promise.all(faces.map(async (f) => {
    const b64 = Buffer.from(await Bun.file(join(RT, 'fonts', f.file)).arrayBuffer()).toString('base64');
    return `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${f.range}}`;
  }));
  return css.join('\n') + '\n';
}

// math and code are rendered here, so the page never waits for MathJax (2 MB) or highlight.js
const PROTECT = /(<(pre|code|script|style|svg|textarea)\b[\s\S]*?<\/\2>)/;

async function renderMath(html: string): Promise<{ html: string; css: string }> {
  const re = new RegExp(PROTECT.source + /|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/.source, 'g');
  if (![...html.matchAll(re)].some((m) => !m[1])) return { html, css: '' };
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
    need<any>('mathjax-full/js/mathjax.js'), need<any>('mathjax-full/js/input/tex.js'), need<any>('mathjax-full/js/output/svg.js'),
    need<any>('mathjax-full/js/adaptors/liteAdaptor.js'), need<any>('mathjax-full/js/handlers/html.js'), need<any>('mathjax-full/js/input/tex/AllPackages.js'),
  ]);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({ packages: AllPackages, macros: { col: ['\\class{c#1}{#2}', 2], R: '\\mathbb{R}', N: '\\mathbb{N}', E: '\\mathbb{E}' } });
  const doc = mathjax.document('', { InputJax: tex, OutputJax: new SVG({ fontCache: 'local' }) });
  const out = html.replace(re, (m, prot, _tag, d1, d2, inline) => {
    if (prot) return prot;
    const svg = adaptor.outerHTML(doc.convert(decode(d1 ?? d2 ?? inline).trim(), { display: inline === undefined }));
    if (svg.includes('data-mjx-error')) console.log(`  warn  TeX error in: ${m.slice(0, 60)}`);
    return svg;
  });
  return { html: out, css: adaptor.textContent(doc.outputJax.styleSheet(doc)) };
}

async function highlight(html: string) {
  const re = /(<code\b[^>]*\bclass="[^"]*\blanguage-([\w+-]+)[^"]*"[^>]*>)([\s\S]*?)(<\/code>)/g;
  if (!re.test(html)) return html;
  const hljs = (await need<any>('highlight.js')).default;
  return html.replace(re, (m, open: string, lang: string, code: string, close: string) => {
    if (!hljs.getLanguage(lang)) { console.log(`  warn  no highlighting for language-${lang}`); return m; }
    return open + hljs.highlight(decode(code), { language: lang, ignoreIllegals: true }).value + close;
  });
}

// ---------------------------------------------------------------- a small HTML tree (enough for the checks)
type Node = { tag: string; attrs: Record<string, string>; parents: string[]; line: number; kids: Node[]; words: number };
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function parse(src: string): Node[] {
  const nodes: Node[] = [], stack: Node[] = [];
  const re = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m: RegExpExecArray | null;
  const text = (s: string) => { const n = s.split(/\s+/).filter(Boolean).length; for (const x of stack) x.words += n; };
  while ((m = re.exec(src))) {
    text(src.slice(last, m.index));
    last = re.lastIndex;
    if (!m[3]) continue; // comment, script or style
    const tag = m[3].toLowerCase();
    if (m[2]) { const i = stack.findLastIndex((n) => n.tag === tag); if (i >= 0) stack.length = i; continue; }
    const attrs: Record<string, string> = {};
    for (const a of m[4].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const node: Node = { tag, attrs, parents: stack.map((n) => n.tag), line: src.slice(0, m.index).split('\n').length, kids: [], words: 0 };
    stack.at(-1)?.kids.push(node);
    nodes.push(node);
    if (!VOID.has(tag) && !m[4].trimEnd().endsWith('/')) stack.push(node);
  }
  text(src.slice(last));
  return nodes;
}

// ---------------------------------------------------------------- checks
function check(src: string) {
  const errors: string[] = [], warns: string[] = [];
  const nodes = parse(src);
  const by = (tag: string) => nodes.filter((n) => n.tag === tag);

  const title = /<title>([\s\S]*?)<\/title>/.exec(src.slice(0, 8192));
  if (!title) errors.push('No <title> in the first 8 KB. Put <title>Name</title> at the top.');
  else if (/\s[-–—|]\s|:\s/.test(title[1]) || title[1].trim().split(/\s+/).length > 6)
    warns.push(`Title "${title[1].trim()}" reads like a caption. Use a 2 to 4 word name.`);
  for (const t of ['!doctype', '<html', '<head', '<body'])
    if (new RegExp(t.replace('!', '<!') + '[\\s>]', 'i').test(src)) errors.push(`Remove ${t}: the artifact viewer adds the document shell.`);

  const pages = by('t-page');
  if (pages.length !== 1) { errors.push(`Need exactly one <t-page>, found ${pages.length}.`); return { errors, warns, mode: null }; }
  const mode = pages[0].attrs.mode;
  if (mode !== 'plan' && mode !== 'explain') errors.push('<t-page mode="plan|explain"> is required.');
  if (!/^\d+$/.test(pages[0].attrs.version ?? '')) errors.push('<t-page version="N"> is required. Start at 1; add 1 on each republish.');
  if (!by('h1').length) errors.push('Add a <header> with an <h1> and a <p class="lede">.');

  const ids = new Map<string, number>();
  for (const n of nodes) {
    const id = n.attrs.id;
    if (!id) continue;
    if (ids.has(id)) errors.push(`Duplicate id "${id}" (lines ${ids.get(id)} and ${n.line}).`);
    ids.set(id, n.line);
  }

  const qs = by('t-question');
  for (const q of qs) {
    const { attrs: a, line } = q, qid = a.id, typ = a.type ?? 'single';
    if (!qid || !ID.test(qid)) errors.push(`line ${line}: <t-question> needs a stable id (letters, digits, - _ .).`);
    if (!['single', 'multi', 'text'].includes(typ)) errors.push(`line ${line}: type="${typ}" must be single, multi or text.`);
    const prompt = q.kids.find((k) => k.tag === 'p');
    if (!prompt) errors.push(`line ${line}: <t-question id="${qid}"> needs its question as the first <p>.`);
    else if (prompt.words > 5 && !a.toc) warns.push(`line ${line}: give "${qid}" a short toc="…" label (2 to 4 words) for "On this page".`);
    const opts = q.kids.filter((k) => k.tag === 't-option');
    const vals = opts.map((k) => k.attrs.value);
    if (typ !== 'text') {
      if (vals.length < 2) errors.push(`line ${line}: "${qid}" needs at least 2 <t-option>s.`);
      if (vals.includes(undefined as never) || new Set(vals).size !== vals.length) errors.push(`line ${line}: every <t-option> in "${qid}" needs a unique value.`);
      if (vals.includes('other')) errors.push(`line ${line}: value "other" is reserved for the Other row.`);
    }
    const rec = a.recommended;
    if (rec && !vals.includes(rec)) errors.push(`line ${line}: recommended="${rec}" is not an option value of "${qid}".`);
    const ans = (a.answer ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const v of ans) if (!vals.includes(v)) errors.push(`line ${line}: answer="${v}" is not an option value of "${qid}".`);
    if (typ === 'single' && ans.length > 1) errors.push(`line ${line}: a single-choice check has one answer.`);
    const mx = a.max;
    if (mx && (typ !== 'multi' || !/^\d+$/.test(mx) || +mx < 1 || +mx >= vals.length))
      errors.push(`line ${line}: max="${mx}" works only on type="multi", between 1 and the option count minus 1.`);
    if (mode === 'plan' && !ans.length && typ !== 'text') {
      if (!rec) warns.push(`line ${line}: mark your pick in "${qid}" with recommended="value".`);
      if (opts.some((o) => !o.kids.some((c) => c.tag === 'small'))) warns.push(`line ${line}: give each option of "${qid}" a <small> line with its consequence.`);
    }
  }

  if (mode === 'plan') {
    if (!qs.some((q) => !('answer' in q.attrs))) errors.push('A plan needs at least one <t-question> for the reader to answer.');
    if (qs.length > 7) warns.push(`${qs.length} questions. Ask only about forks that change what you build (2 to 5).`);
  } else if (mode === 'explain') {
    if (!by('t-figure').length) errors.push('An explainer is built on figures. Add at least one <t-figure>.');
    if (qs.some((q) => !('answer' in q.attrs))) warns.push('Explainer questions without answer="..." go nowhere. Use answer= for self-checks, or make it a plan.');
  }

  for (const f of by('t-figure')) {
    if (!f.attrs.alt) errors.push(`line ${f.line}: <t-figure> needs alt="what it shows".`);
    if (!f.kids.some((k) => k.tag === 'figcaption')) errors.push(`line ${f.line}: <t-figure> needs a <figcaption> that says what to notice.`);
  }
  for (const n of by('t-notes'))
    errors.push(`line ${n.line}: remove <t-notes>. The message box in the Send feedback / Approve plan panel replaces it.`);

  // a long run of prose with nothing to look at
  const VISUAL = new Set(['t-figure', 't-question', 'pre', 'table', 't-callout']);
  for (const s of by('section')) {
    const words = s.kids.filter((k) => ['p', 'ul', 'ol', 'blockquote'].includes(k.tag)).reduce((t, k) => t + k.words, 0);
    if (words > 160 && !s.kids.some((k) => VISUAL.has(k.tag))) warns.push(`line ${s.line}: section has ${words} words and nothing to look at. Draw it.`);
  }

  for (const [, url] of src.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
    if (!HOSTS.some((h) => url.startsWith(h))) errors.push(`Script host not allowed: ${url}. Use cdnjs, cdn.jsdelivr.net/npm or unpkg, or thinkr.load().`);
    else if (!/[@/]\d+\.\d+\.\d+/.test(url)) errors.push(`Pin an exact version: ${url}`);
  }
  for (const [, href] of src.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g))
    errors.push(`Remove the stylesheet link ${href}: it blocks the first paint. Geist is built in; put page styles in <style>.`);
  for (const [, name] of src.matchAll(/load\(\s*['"`](hljs|mathjax)['"`]/g))
    errors.push(`load('${name}') is gone: code highlighting and math are rendered at build time. Remove the call.`);
  const banned: [RegExp, string][] = [
    [/\balert\(|\bconfirm\(|\bprompt\(/, 'alert/confirm/prompt do nothing in artifacts. Build the step into the page.'],
    [/<iframe|<object|<embed/, 'Embeds are blocked in artifacts. Link out instead.'],
    [/window\.print\(/, 'print() does nothing in artifacts.'],
    [/fetch\(\s*['"`]https?:/, 'fetch() to other sites is blocked. Put data in the page.'],
    [/<img[^>]+src="https?:/, 'Remote images are blocked. Use inline SVG or a data: URI.'],
  ];
  for (const [re, msg] of banned) if (re.test(src)) errors.push(msg);
  return { errors, warns, mode };
}

// ---------------------------------------------------------------- pack
async function runtime() {
  const out = await Bun.build({ entrypoints: [join(RT, 'index.ts')], target: 'browser', format: 'iife', minify: true });
  if (!out.success) { for (const log of out.logs) console.log('  error ' + log); process.exit(1); }
  return (await out.outputs[0].text()).replaceAll('</script', '<\\/script');
}

/** Page scripts are TypeScript: strip the types, keep the code (imports of types vanish). */
function transpile(scripts: string) {
  const ts = new Bun.Transpiler({ loader: 'ts', target: 'browser' });
  return scripts.replace(/(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/g, (_, open: string, code: string, close: string) => {
    try { return open.replace(/\s(lang|type)="ts"/, (m, a) => (a === 'type' ? ' type="module"' : '')) + '\n' + ts.transformSync(code) + close; }
    catch (e) { console.log('  error page script: ' + (e as Error).message); process.exit(1); }
  });
}

async function pack(src: string, libmap: LibMap) {
  const title = /<title>[\s\S]*?<\/title>/.exec(src)![0];
  const body = src.replace(title, '').trim();
  const at = body.search(/<script\b/);
  const scripts = at >= 0 ? transpile(body.slice(at)) : '';
  const math = await renderMath(await highlight(at >= 0 ? body.slice(0, at) : body));
  const use = used(scripts, libmap);
  const { sounds } = await Bun.file(join(RT, 'sounds.json')).json();
  const cfg = { libs: libmap, use, sounds: Object.fromEntries(Object.entries(sounds as Record<string, { uri: string; db: number }>).map(([k, v]) => [k, { uri: v.uri, db: v.db }])) };
  const [css, fonts, js] = await Promise.all([Bun.file(join(RT, 'thinkr.css')).text(), fontFaces(), runtime()]);
  // title first (the viewer reads it from the first 8 KB), then preloads so libraries download while the page
  // parses; the runtime goes after the content and before page scripts, so they can call thinkr.figure()
  return `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n${hints(use, libmap)}\n`
    + `<style>\n${fonts}${css}${math.css}</style>\n`
    + math.html.trimEnd() + '\n'
    + `<script>window.THINKR = ${JSON.stringify(cfg)};</script>\n<script>\n${js}</script>\n`
    + scripts;
}

const argv = Bun.argv.slice(2);
const libmap = await libs(argv.includes('--refresh'), argv.includes('--major'));
const file = argv.find((a) => !a.startsWith('--'));
if (!file) process.exit(0);

const src = await Bun.file(file).text();
const { errors, warns, mode } = check(src);
for (const w of warns) console.log('  warn  ' + w);
for (const e of errors) console.log('  error ' + e);
if (errors.length) { console.log(`${errors.length} error(s). Nothing written.`); process.exit(1); }

const out = await pack(src, libmap);
const stem = file.replace(/\.html?$/, '');
await Bun.write(`${stem}.artifact.html`, out);
await Bun.write(`${stem}.preview.html`,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  + out + '\n</body></html>\n');
console.log(`ok    ${mode} page, ${warns.length} warning(s), ${Math.round(out.length / 1024)} KB\n      publish: ${stem}.artifact.html\n      preview: ${stem}.preview.html`);

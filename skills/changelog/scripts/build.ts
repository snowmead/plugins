#!/usr/bin/env bun
/* Build the changelog page into one file for the Artifact tool.

     bun scripts/build.ts --out <work>/changelog [--config <path>] [--entries <dir>]

   Writes <out>.artifact.html (publish it; it reads its entries from its own database) and <out>.preview.html (a full
   document to open locally, where a stand-in database serves the <date>.json files in --entries, or none). The page
   carries its fonts, sounds and script inline, so it paints at once and loads nothing. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry, PageConfig, SoundName } from '../runtime/types';
import { loadConfig, opt } from './lib';

const ROOT = join(import.meta.dir, '..');
const RT = join(ROOT, 'runtime');
const argv = Bun.argv.slice(2);
const stem = opt(argv, 'out');
if (!stem || argv.includes('--help')) {
  console.log('usage: bun scripts/build.ts --out <work>/changelog [--config <path>] [--entries <dir>]');
  process.exit(stem ? 0 : 2);
}
const { config, errors } = await loadConfig(opt(argv, 'config'));
if (!config) { for (const e of errors) console.log(`error ${e}`); process.exit(1); }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

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

const kit = await Bun.file(join(RT, 'sounds.json')).json() as { levels: Record<SoundName, number>; master: number; sounds: Record<SoundName, { uri: string }> };
const cfg: PageConfig = {
  name: config.name, url: config.page ?? '', master: kit.master, levels: kit.levels,
  sounds: Object.fromEntries(Object.entries(kit.sounds).map(([k, v]) => [k, { uri: v.uri }])) as PageConfig['sounds'],
};
const [css, fonts, js] = await Promise.all([Bun.file(join(RT, 'changelog.css')).text(), fontFaces(), runtime()]);
const name = esc(config.name);
const SOUND_ON = '<svg class="on" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.4 5.6a3.4 3.4 0 0 1 0 4.8M12.2 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const SOUND_OFF = '<svg class="off" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.5 6l3.5 3.5M14 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

// The title first (the viewer reads it from the first 8 KB, before the inline fonts), then the styles and markup; the
// config and the script go after the markup they fill.
const page = `<title>${name} Changelog</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${fonts}${css}</style>
<header class="bar gutter">
  <div class="bar-in">
    <a class="brand" href="#" data-hover>
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="5" fill="currentColor"/><path d="M6 10.5h3l1.5-4 2 7 1.5-3h0" fill="none" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span data-name>${name}</span><span class="sep">/</span><span class="sub">Changelog</span>
    </a>
    <button id="sound" class="sound" type="button" aria-pressed="true" data-hover title="Sounds play after your first click">${SOUND_ON}${SOUND_OFF}<span id="sound-label">Sound on</span></button>
  </div>
</header>
<main id="app" class="page gutter" aria-live="polite">
  <section class="intro">
    <h1>Changelog</h1>
    <p>What changed in ${name}, one entry for each run, newest first.</p>
  </section>
  <ol class="feed" aria-busy="true">
    <li class="entry">
      <div class="rail"><div class="rail-in"><time>Loading</time><span class="kind">Reading the entries</span></div></div>
      <div class="body skeleton" aria-hidden="true"><i style="width: 70%; height: 28px"></i><i style="width: 40%"></i><i></i><i style="width: 85%"></i></div>
    </li>
  </ol>
</main>
<footer class="gutter"><div>Each entry is written by a changelog run from the repository's merged pull requests. Sounds are made with earshot and play after your first click.</div></footer>
<div id="toast" class="toast" role="status" hidden></div>
<script>window.CHANGELOG = ${json(cfg)};</script>
<script>
${js}</script>
`;

// The preview's stand-in for the artifact database: the entries in --entries, read live like the real one.
const dir = opt(argv, 'entries');
const entries: Entry[] = dir ? await Promise.all(readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => Bun.file(join(dir, f)).json())) : [];
const fake = `<script>window.__ENTRIES = ${json(entries)};
window.claude = { use: async (name) => name !== 'db' ? null : ({ collection: () => { const q = { orderBy: () => q, limit: () => q,
  onSnapshot: (next) => { setTimeout(() => next({ docs: window.__ENTRIES.slice().sort((a, b) => a.date < b.date ? 1 : -1)
    .map((e) => ({ id: e.date, exists: true, data: () => e })) }), 30); return () => {}; } }; return q; } }) };</script>\n`;

await Bun.write(`${stem}.artifact.html`, page);
await Bun.write(`${stem}.preview.html`,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  + fake + page + '</body></html>\n');
console.log(`ok    ${name} Changelog, ${Math.round(page.length / 1024)} KB${config.page ? '' : ' (no page link yet: copied links point at the open page)'}`);
console.log(`      publish: ${stem}.artifact.html\n      preview: ${stem}.preview.html (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);

#!/usr/bin/env bun
/* Build the changelog page into one file for the Artifact tool.

     bun scripts/build.ts --out <work>/changelog [--config <path>] [--entries <dir>]

   Writes <out>.artifact.html (publish it; it reads its entries from its own database) and <out>.preview.html (a full
   document to open locally, where a stand-in database serves the <date>.json files in --entries, or none). The page
   carries its fonts, sounds and script inline, so it paints at once and loads nothing. The fonts, the shared
   stylesheet, the sounds and the speaker button come from the kit (kit/build/). */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry, PageConfig } from '../runtime/types';
import { bundle, esc, json, preview, soundButton, soundScript, styles } from '../kit/build/page';
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

const cfg: PageConfig = { name: config.name, url: config.page ?? '' };
const [css, sounds, js] = await Promise.all([styles(join(RT, 'changelog.css')), soundScript(['nav', 'reveal', 'select', 'toggle', 'hover']), bundle(join(RT, 'index.ts'))]);
const name = esc(config.name);
// The title first (the viewer reads it from the first 8 KB, before the inline fonts), then the styles and markup; the
// config and the script go after the markup they fill.
const page = `<title>${name} Changelog</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}</style>
<header class="k-bar bar">
  <div class="bar-in">
    <a class="brand" href="#" data-hover>
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="5" fill="currentColor"/><path d="M6 10.5h3l1.5-4 2 7 1.5-3h0" fill="none" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span data-name>${name}</span><span class="sep">/</span><span class="sub">Changelog</span>
    </a>
    ${soundButton()}
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
<script>window.CHANGELOG = ${json(cfg)};</script>
${sounds}<script>
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
await Bun.write(`${stem}.preview.html`, preview(page, fake));
console.log(`ok    ${name} Changelog, ${Math.round(page.length / 1024)} KB${config.page ? '' : ' (no page link yet: copied links point at the open page)'}`);
console.log(`      publish: ${stem}.artifact.html\n      preview: ${stem}.preview.html (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);

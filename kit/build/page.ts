/* What every skill's build.ts puts into its page from the kit: the font link, the shared stylesheet under the skill's
   own, the sounds and the bundled runtime as files published beside the page, and the full document the local preview
   opens.

   A page holds only its own content. Anything the Artifact tool hands back when an agent reads a published page (up
   to 50,000 characters) is then that content, not the kit's CSS, scripts, sounds and fonts. */
import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SoundName, Sounds } from '../web/types';

export { ICON, soundButton, themeButton } from '../web/icons';

const KIT = join(import.meta.dir, '..');

export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** JSON to put inside a <script>: no string in it can close the tag. */
export const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** Geist and Geist Mono from Google Fonts, the one stylesheet host artifacts allow. Text shows in the fallback face
    until they arrive (display=swap). */
export const FONTS = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=swap">';

/** Puts the reader's kept theme on the root before the first paint: the runtime loads after the markup, too late to
    stop a flash of the other theme. It goes right after the title. kit/web/theme.ts keeps the choice. */
export const THEME = `<script>try{const t=JSON.parse(localStorage.getItem('kit:theme'));if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>`;

/** The page's stylesheet: the kit's tokens and parts, then each of `files` (the skill's own CSS) on top. */
export async function styles(...files: string[]) {
  const parts = await Promise.all([join(KIT, 'tokens.css'), join(KIT, 'ui.css'), ...files].map((f) => Bun.file(f).text()));
  return parts.join('\n');
}

/** The page's script: the sounds it plays, from kit/sounds.json, handed to kit/web/sound.ts, then its runtime entry
    and what that imports (the kit's included), bundled and minified. */
export async function runtime(entry: string, names: SoundName[]) {
  const { sounds } = await Bun.file(join(KIT, 'sounds.json')).json() as { sounds: Record<string, { uri: string; db: number }> };
  const pick: Sounds = Object.fromEntries(names.map((n) => [n, { uri: sounds[n].uri, db: sounds[n].db }]));
  const out = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife', minify: true });
  if (!out.success) { for (const log of out.logs) console.log('  error ' + log); process.exit(1); }
  return `window.KIT = ${JSON.stringify({ sounds: pick })};\n` + await out.outputs[0].text();
}

/** Writes the files a page publishes beside it into `<stem>.files/`, each named with a hash of its text so a browser
    never runs a stale copy after a republish. Returns `at`, each file's path relative to the page (for the tag that
    loads it), and `files`, the map to pass the Artifact tool when publishing the page. */
export async function assets(stem: string, list: Record<string, string>) {
  const dir = basename(stem) + '.files';
  const abs = resolve(dirname(stem), dir);
  rmSync(abs, { recursive: true, force: true });
  mkdirSync(abs, { recursive: true });
  const at: Record<string, string> = {}, files: Record<string, string> = {};
  for (const [name, text] of Object.entries(list)) {
    const hash = new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 8);
    const path = `${dir}/${name.replace(/(\.\w+)$/, `.${hash}$1`)}`;
    await Bun.write(resolve(dirname(stem), path), text);
    at[name] = path;
    files[path] = resolve(dirname(stem), path);
  }
  return { at, files };
}

/** What a build prints for publishing: the page, and the `files` map to pass with it, as one line of JSON. */
export const publishLines = (stem: string, files: Record<string, string>) =>
  `      publish: ${stem}.artifact.html\n      files:   ${JSON.stringify(files)}`;

/** The local preview: the page as the artifact viewer would hold it, in a full document. `before` and `after` add what
    only the preview needs, such as a stand-in for an artifact capability. It loads the same files as the page, so it
    sits beside `<stem>.files/`. */
export const preview = (page: string, before = '', after = '') =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  + before + page.trimEnd() + '\n' + after + '</body></html>\n';

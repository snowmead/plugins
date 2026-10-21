/* What every skill's build.ts puts into its page from the kit: the fonts, the shared stylesheet under the skill's
   own, the sounds, the bundled runtime, and the full document the local preview opens. */
import { join } from 'node:path';
import type { SoundName, Sounds } from '../web/types';

export { ICON, soundButton } from '../web/icons';

const KIT = join(import.meta.dir, '..');

export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** JSON to put inside a <script>: no string in it can close the tag. */
export const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** Geist and Geist Mono, inline: the page paints at once in its own type, with no stylesheet to wait for. */
async function fontFaces() {
  const { faces } = await Bun.file(join(KIT, 'fonts', 'fonts.json')).json() as { faces: { family: string; weight: string; range: string; file: string }[] };
  const css = await Promise.all(faces.map(async (f) => {
    const b64 = Buffer.from(await Bun.file(join(KIT, 'fonts', f.file)).arrayBuffer()).toString('base64');
    return `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${f.range}}`;
  }));
  return css.join('\n') + '\n';
}

/** The page's stylesheet: the fonts, the kit's tokens and parts, then each of `files` (the skill's own CSS) on top. */
export async function styles(...files: string[]) {
  const parts = await Promise.all([join(KIT, 'tokens.css'), join(KIT, 'ui.css'), ...files].map((f) => Bun.file(f).text()));
  return (await fontFaces()) + parts.join('\n');
}

/** The sounds a page plays, from kit/sounds.json, as the script that hands them to kit/web/sound.ts. It goes before
    the runtime. */
export async function soundScript(names: SoundName[]) {
  const { sounds } = await Bun.file(join(KIT, 'sounds.json')).json() as { sounds: Record<string, { uri: string; db: number }> };
  const pick: Sounds = Object.fromEntries(names.map((n) => [n, { uri: sounds[n].uri, db: sounds[n].db }]));
  return `<script>window.KIT = ${json({ sounds: pick })};</script>\n`;
}

/** Bundle a runtime entry and what it imports (the kit's included) into one minified script to inline. */
export async function bundle(entry: string) {
  const out = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife', minify: true });
  if (!out.success) { for (const log of out.logs) console.log('  error ' + log); process.exit(1); }
  return (await out.outputs[0].text()).replaceAll('</script', '<\\/script');
}

/** The local preview: the page as the artifact viewer would hold it, in a full document. `before` and `after` add what
    only the preview needs, such as a stand-in for an artifact capability. */
export const preview = (page: string, before = '', after = '') =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  + before + page.trimEnd() + '\n' + after + '</body></html>\n';

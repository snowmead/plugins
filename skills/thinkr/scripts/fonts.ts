#!/usr/bin/env bun
/* Download Geist and Geist Mono (Latin, variable weight) from Google Fonts into runtime/fonts/. build.ts inlines
   them, so a page paints at once in its own type: no stylesheet to wait for, no font swap after load.

     bun scripts/fonts.ts      # run again only to pick up a new Geist release */
import { join } from 'node:path';

const OUT = join(import.meta.dir, '..', 'runtime', 'fonts');
const CSS = 'https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=swap';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const css = await (await fetch(CSS, { headers: { 'user-agent': UA } })).text();
const faces: { family: string; weight: string; range: string; file: string }[] = [];
for (const [, subset, body] of css.matchAll(/\/\* ([\w-]+) \*\/\s*@font-face\s*{([^}]*)}/g)) {
  if (subset !== 'latin') continue;
  const family = /font-family:\s*'([^']+)'/.exec(body)![1];
  const weight = /font-weight:\s*([^;]+);/.exec(body)![1].trim();
  const range = /unicode-range:\s*([^;]+);/.exec(body)![1].trim();
  const url = /url\(([^)]+)\)/.exec(body)![1];
  const file = family.toLowerCase().replace(/\s+/g, '-') + '-latin.woff2';
  await Bun.write(join(OUT, file), await (await fetch(url)).arrayBuffer());
  faces.push({ family, weight, range, file });
  console.log(`${family}  ${weight}  ${file}  ${Math.round(Bun.file(join(OUT, file)).size / 1024)} KB`);
}
await Bun.write(join(OUT, 'fonts.json'), JSON.stringify({ source: CSS, faces }, null, 1) + '\n');

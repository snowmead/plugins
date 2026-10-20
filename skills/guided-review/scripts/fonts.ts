#!/usr/bin/env bun
/* Download Inter and JetBrains Mono (Latin, variable weight) from Google Fonts into runtime/fonts/, with each
   family's license. build.ts inlines them, so a guide paints at once in its own type: no stylesheet to wait for,
   no font swap after load.

     bun scripts/fonts.ts      # run again only to pick up a new release */
import { join } from 'node:path';

const OUT = join(import.meta.dir, '..', 'runtime', 'fonts');
const CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400..600&family=JetBrains+Mono:wght@400..500&display=swap';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const LICENSES: Record<string, string> = {
  Inter: 'https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt',
  'JetBrains Mono': 'https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt',
};

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
const license = await Promise.all(Object.values(LICENSES).map(async (url) => (await (await fetch(url)).text()).trim()));
await Bun.write(join(OUT, 'OFL.txt'), license.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n');
await Bun.write(join(OUT, 'fonts.json'), JSON.stringify({ source: CSS, faces }, null, 1) + '\n');

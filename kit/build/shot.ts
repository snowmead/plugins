/* Screenshot a built page with the local Chrome: desktop and phone, light and dark, 2400 px tall. No dependencies.
   A #hash after the file opens the page there and joins the shots' names. */
import { basename, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { findChrome } from './chrome';

/** Each skill's scripts/shot.ts: `bun scripts/shot.ts <page>.preview.html[#place] [out dir]`. */
export async function shotCli(usage: string) {
  const [file, outDir = '.'] = Bun.argv.slice(2);
  if (!file) { console.log('usage: ' + usage); process.exit(1); }
  await shoot(file, outDir);
}

/** Writes <name>[-<hash>]-{desktop,phone}-{light,dark}.png into outDir and prints each path with any console output. */
export async function shoot(file: string, outDir = '.') {
  const chrome = findChrome();
  mkdirSync(outDir, { recursive: true });
  const [path, hash] = file.split('#');
  const url = 'file://' + resolve(path) + (hash ? `#${hash}` : '');
  const name = basename(path).replace(/(\.preview)?\.html$/, '') + (hash ? `-${hash}` : '');
  const profile = resolve(outDir, '.chrome-profile');
  // Headless Chrome keeps windows at least ~500 px wide, so the phone view renders the page in a 390 px iframe
  // (the shot is 500 px wide; the page is the left 390 px).
  const phone = resolve(outDir, `.${name}-phone.html`);
  await Bun.write(phone, `<!doctype html><body style="margin:0;background:#888"><iframe src="${url}" style="width:390px;height:2400px;border:0;display:block"></iframe>`);
  const runs = [['desktop', '1440,2400', url], ['phone', '500,2400', 'file://' + phone]].flatMap(([size, win, src]) =>
    [['light', 1], ['dark', 0]].map(([theme, scheme]) => ({ out: resolve(outDir, `${name}-${size}-${theme}.png`), win, src, scheme })));

  for (const r of runs) {
    const p = Bun.spawnSync([chrome, '--headless=new', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${r.win}`,
      `--blink-settings=preferredColorScheme=${r.scheme}`, '--allow-file-access-from-files', '--virtual-time-budget=6000',
      '--enable-logging=stderr', '--v=0', `--screenshot=${r.out}`, r.src], { stderr: 'pipe' });
    const logs = p.stderr.toString().split('\n').filter((l) => /CONSOLE|Uncaught/.test(l));
    console.log(`${existsSync(r.out) ? 'ok   ' : 'fail '} ${r.out}`);
    for (const l of logs) console.log('      ' + l.replace(/^.*?CONSOLE/, 'console'));
  }
}

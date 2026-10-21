/* Libraries a page imports from a CDN when it is viewed, pinned in the skill's runtime/libs.json:

     { "note": "…", "checked": "2026-10-20", "libs": { "<name>": { "pkg", "version", "url": "…@{v}…", "global"?, "deps"?, "modules"? } } }

   A library is an ES module (its whole static import graph goes in `modules`, so a page preloads it in one parallel
   round) or a single-file build that sets the window global `global`, after the libraries in `deps`. A refresh moves
   each to the newest release that is at least 14 days old (the artifact rule), within its major unless `major`, stable
   only unless the pin is itself a prerelease. It runs on its own when the file is more than 7 days old, and keeps the
   pins quietly when offline. */

const DAY = 86_400_000;

type Lib = { pkg: string; version: string; url: string; global?: string; deps?: string[]; modules?: string[] };
type LibFile = { note: string; checked: string; libs: Record<string, Lib> };
export type LibMap = Record<string, { url: string; global?: string; deps?: string[]; modules: string[] }>;

/** Semver order, prereleases included: 1.0.0-beta.2 < 1.0.0-beta.10 < 1.0.0-rc.1 < 1.0.0 < 1.0.1. */
export function compare(a: string, b: string): number {
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

async function refresh(file: string, major: boolean) {
  const data: LibFile = await Bun.file(file).json();
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
    if (!lib.global) lib.modules = await graph(lib.url.replace('{v}', lib.version)).catch(() => lib.modules ?? []);
  }));
  data.checked = new Date().toISOString().slice(0, 10);
  await Bun.write(file, JSON.stringify(data, null, 1) + '\n');
  console.log('  libs: ' + (changed.length ? changed.join(', ') : 'up to date'));
}

/** Every module an ES module on jsDelivr imports statically, transitively. */
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

/** The pinned libraries, refreshed first when `force`, or when the file is stale. */
export async function libs(file: string, { force = false, major = false } = {}): Promise<LibMap> {
  let data: LibFile = await Bun.file(file).json();
  const stale = Date.now() - Date.parse(data.checked) > 7 * DAY || Object.values(data.libs).some((l) => !l.global && !l.modules?.length);
  if (force || stale) { await refresh(file, major); data = await Bun.file(file).json(); }
  return Object.fromEntries(Object.entries(data.libs).map(([k, { pkg: _p, version, url, modules, ...rest }]) =>
    [k, { url: url.replace('{v}', version), modules: modules ?? [], ...rest }]));
}

/** Preload hints for the head, so the libraries download while the page parses: each global build's file, or each
    module's whole graph. */
export const preloads = (names: string[], map: LibMap) => names.flatMap((n) => {
  const l = map[n];
  return l.global ? [`<link rel="preload" as="script" href="${l.url}">`] : (l.modules.length ? l.modules : [l.url]).map((m) => `<link rel="modulepreload" href="${m}" crossorigin>`);
}).join('\n');

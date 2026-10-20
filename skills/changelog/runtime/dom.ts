/* The page's config and small DOM helpers. */
import type { PageConfig } from './types';

/** When the runtime started, for the boot timing the tests read (performance measure "changelog:boot"). */
export const T0 = performance.now();
export const CFG: PageConfig = window.CHANGELOG ?? { name: 'Changelog', url: '', sounds: {} as PageConfig['sounds'], levels: {} as PageConfig['levels'], master: -6 };

type Kid = Node | string | null | undefined | false | Kid[];
/** Create an element. `class` and `text` are special; `true` sets an empty attribute; null, undefined and false skip. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | null | undefined> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v); else if (k === 'text') el.textContent = String(v); else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...(kids.flat(Infinity as 1) as (Node | string | null | undefined | false)[]).filter((k): k is Node | string => k != null && k !== false));
  return el;
}

/** localStorage that never throws: the page works without it. */
export const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private window, blocked storage */ } },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (d: string) => { const [y, m, day] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${day}, ${y}`; };
export const fmtN = (n: number) => Number(n).toLocaleString('en-US');
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "America/Toronto" as a reader says it: "Toronto time". */
export const tzName = (tz: string) => (tz.includes('/') ? `${tz.split('/').pop()!.replace(/_/g, ' ')} time` : tz);
/** An entry's link: the page's own link when known, else wherever it is open now. */
export const linkFor = (date: string) => (CFG.url.startsWith('https://') ? CFG.url : location.href.split('#')[0]) + '#' + date;

const toast = () => document.getElementById('toast')!;
let toastTimer = 0;
/** A short status line; with a url, a field holding it to copy by hand. */
export function showToast(msg: string, url?: string) {
  const t = toast();
  t.replaceChildren(msg);
  if (url) {
    const inp = h('input', { id: 'copy-url', value: url, readonly: true, 'aria-label': 'Link to this entry' });
    t.append(inp);
    setTimeout(() => inp.select(), 0);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, url ? 6000 : 1800);
}

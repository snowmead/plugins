/* The page's data and small DOM helpers shared by the runtime. */
import type { DiffFile, PageData, ThemeType } from './types';

/** When the runtime started, for the boot timing the tests read (performance measure "gr:boot"). */
export const T0 = performance.now();
export const D: PageData = JSON.parse(document.getElementById('gr-data')!.textContent!);
export const FILES = new Map<string, DiffFile>(D.files.map((f) => [f.path, f]));

export const $ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document) => el.querySelector<T>(s);
export const $$ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document) => [...el.querySelectorAll<T>(s)];
export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** localStorage that never throws: the page works without it, for this visit only. */
export const store = {
  get<T>(k: string): T | null { try { return JSON.parse(localStorage.getItem(k) ?? 'null') as T; } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be blocked */ } },
};

/** The viewer sets data-theme on the root when the reader picks one; otherwise the system decides. */
export const themeType = (): ThemeType => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || t === 'light' ? t : 'system';
};
export function onTheme(cb: () => void) {
  new MutationObserver(cb).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', cb);
}

/** Split a path into its file name and the folder before it. */
export const split = (path: string): [string, string] => { const name = path.split('/').pop()!; return [name, path.slice(0, path.length - name.length)]; };
export const stat = (a: number, d: number) => `${a ? `<span class="add-n">+${a}</span>` : ''}${d ? `<span class="del-n">−${d}</span>` : ''}${!a && !d ? '<span>0</span>' : ''}`;

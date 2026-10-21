/* Small DOM helpers every page's runtime shares. */

export type Kid = Node | string | null | undefined | false | Kid[];
type Attr = string | number | boolean | null | undefined | ((e: Event) => void);

/** Create an element. `class`, `text` and `html` are special; `on…` takes a listener; `true` sets an empty attribute;
    null, undefined and false skip. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, Attr>, ...kids: Kid[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Record<string, Attr>, ...kids: Kid[]): HTMLElement;
export function h(tag: string, attrs: Record<string, Attr> = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...(kids.flat(Infinity as 1) as (Node | string | null | undefined | false)[]).filter((k): k is Node | string => k != null && k !== false));
  return el;
}

export const $ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document) => el.querySelector<T>(s);
export const $$ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document) => [...el.querySelectorAll<T>(s)];
export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';

/** localStorage that never throws: the page works without it, for this visit only. Values are JSON; one stored as
    plain text reads back as that text. */
export const store = {
  get<T>(k: string): T | null {
    let raw: string | null;
    try { raw = localStorage.getItem(k); } catch { return null; }
    if (raw == null) return null;
    try { return JSON.parse(raw) as T; } catch { return raw as T; }
  },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window, blocked storage */ } },
};

/** Scroll work, batched to once per frame: scroll events can fire many times between two frames. */
const scrollCbs: (() => void)[] = [];
let scrollQueued = false;
export function onScroll(cb: () => void) {
  if (!scrollCbs.length) addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; scrollCbs.forEach((f) => f()); });
  }, { passive: true });
  scrollCbs.push(cb);
}

/** The line under a .k-bar shows once the page has scrolled past `past()` pixels. The first check waits a frame, so
    reading the layout never holds up the page's start. */
export function barLine(bar: Element, past: () => number = () => 8) {
  const set = () => bar.classList.toggle('is-scrolled', scrollY > past());
  onScroll(set);
  requestAnimationFrame(set);
}

export function copyText(text: string): Promise<void> {
  try { return navigator.clipboard.writeText(text); } catch (e) { return Promise.reject(e); }
}

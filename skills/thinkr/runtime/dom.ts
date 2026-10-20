/* Small DOM helpers shared by the runtime. */

export type Kid = Node | string | null | undefined | false | Kid[];
type Attr = string | number | boolean | null | undefined | ((e: Event) => void);

/** Create an element. `class` and `html` are special; `on…` takes a listener; `true` sets an empty attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, Attr>, ...kids: Kid[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Record<string, Attr>, ...kids: Kid[]): HTMLElement;
export function h(tag: string, attrs: Record<string, Attr> = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...(kids.flat(Infinity as 1) as (Node | string | null | undefined | false)[]).filter((k): k is Node | string => k != null && k !== false));
  return el;
}

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

export const slug =(s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';

/** localStorage that never throws: the page works without it. */
export const store = {
  get<T>(k: string): T | null { try { return JSON.parse(localStorage.getItem(k) ?? 'null') as T; } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

export function copyText(text: string): Promise<void> {
  try { return navigator.clipboard.writeText(text); } catch (e) { return Promise.reject(e); }
}

let toast: HTMLDivElement | null = null;
let toastTimer = 0;
export function say(msg: string) {
  toast ??= document.body.appendChild(h('div', { class: 't-toast', role: 'status', 'aria-live': 'polite' }));
  toast.textContent = msg;
  toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove('is-on'), 3200);
}

const svg = (body: string, view = 16, extra = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"') =>
  `<svg viewBox="0 0 ${view} ${view}" ${extra}>${body}</svg>`;
export const ICON = {
  left: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  right: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  play: svg('<path d="M5 3.2v9.6a.5.5 0 0 0 .77.42l7.2-4.8a.5.5 0 0 0 0-.84l-7.2-4.8A.5.5 0 0 0 5 3.2Z"/>', 16, 'fill="currentColor"'),
  pause: svg('<rect x="4" y="3" width="3" height="10" rx=".8"/><rect x="9" y="3" width="3" height="10" rx=".8"/>', 16, 'fill="currentColor"'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  minus: svg('<path d="M3.5 8h9"/>'),
  check: svg('<path d="m2.5 6.2 2.3 2.3 4.7-5"/>', 12, 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'),
  sound: svg('<path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9"/>'),
  mute: svg('<path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="m10.5 6 4 4M14.5 6l-4 4"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  note: svg('<circle cx="8" cy="8" r="6"/><path d="M8 5.5v3M8 10.5v.01"/>'),
  tip: svg('<path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.5 8.2V11h5V9.7A4.5 4.5 0 0 0 8 1.5Z"/>'),
  warn: svg('<path d="M7.13 2.5 1.6 12a1 1 0 0 0 .87 1.5h11.06a1 1 0 0 0 .87-1.5L8.87 2.5a1 1 0 0 0-1.74 0Z"/><path d="M8 6.5v2.5M8 11v.01"/>'),
};

/* Light or dark. The system decides, unless data-theme on the root says otherwise: the reader's pick in the page's
   theme menu, or the artifact viewer's own setting, whichever came last. kit/tokens.css follows the same rule. */
import type { ThemeType } from './types';
import { $, $$, store } from './dom';
import { sound } from './sound';

export const themeType = (): ThemeType => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || t === 'light' ? t : 'system';
};

export const isDark = () => {
  const t = themeType();
  return t === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : t === 'dark';
};

const cbs = new Set<() => void>();
let queued = false;
const fire = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; cbs.forEach((cb) => cb()); });
};

/** Call cb on the next frame after the theme changes, whichever side changed it. */
export function onTheme(cb: () => void) {
  if (!cbs.size) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fire);
    new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  }
  cbs.add(cb);
}

/** Set the theme and keep the choice in the browser. The build's THEME script (kit/build/page.ts) puts it back on the
    root before the next load's first paint. */
export function setTheme(t: ThemeType) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  store.set('kit:theme', t);
}

/** Wire a menu made from themeButton() (kit/web/icons.ts). The ones in the page at load are wired already. While it is
    open it keeps every key from the page, whose shortcuts wait until it closes. */
export function bindThemeButton(wrap: HTMLElement) {
  const btn = $('button', wrap)!, menu = $('[role="menu"]', wrap)!, items = $$<HTMLButtonElement>('button', menu);
  const set = (open: boolean, focusBtn = false) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      const now = themeType();
      for (const i of items) i.setAttribute('aria-checked', String(i.value === now));
      items.find((i) => i.value === now)?.focus();
    } else if (focusBtn) btn.focus();
  };
  btn.addEventListener('click', () => { set(!!menu.hidden); sound.play('toggle'); });
  menu.addEventListener('click', (e) => {
    const item = (e.target as Element).closest('button');
    if (!item) return;
    setTheme(item.value as ThemeType);
    set(false, true);
    sound.play('select');
  });
  wrap.addEventListener('keydown', (e) => {
    const arrow = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? items.length - 1 : 0;
    if (menu.hidden) { if (arrow) { e.preventDefault(); set(true); } return; }
    e.stopPropagation();
    if (arrow) { e.preventDefault(); items[(items.indexOf(document.activeElement as HTMLButtonElement) + arrow) % items.length].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') set(false, true);
  });
  addEventListener('pointerdown', (e) => { if (!menu.hidden && !wrap.contains(e.target as Node)) set(false); }, true);
  addEventListener('blur', () => { if (!menu.hidden) set(false); }); // a click outside the frame
}
$$('[data-k-theme]').forEach((el) => bindThemeButton(el));

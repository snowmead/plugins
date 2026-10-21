/* Light or dark. The system decides, unless the viewer sets data-theme on the root (the artifact viewer does when
   the reader picks one). kit/tokens.css follows the same rule. */
import type { ThemeType } from './types';

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

/* A short status line at the bottom of the page, read out to screen readers. */
import { h } from './dom';

let el: HTMLDivElement | null = null;
let timer = 0;

/** Show msg for a few seconds. With `copy`, the toast also holds that text in a field, selected, to copy by hand when
    the clipboard is blocked. */
export function toast(msg: string, copy?: string) {
  el ??= document.body.appendChild(h('div', { class: 'k-toast', id: 'k-toast', role: 'status', 'aria-live': 'polite' }));
  el.replaceChildren(h('span', { text: msg }));
  if (copy) {
    const field = h('input', { id: 'k-copy', value: copy, readonly: true, 'aria-label': msg });
    el.append(field);
    setTimeout(() => field.select(), 0);
  }
  el.classList.add('is-on');
  clearTimeout(timer);
  timer = window.setTimeout(() => el?.classList.remove('is-on'), copy ? 6000 : 3200);
}

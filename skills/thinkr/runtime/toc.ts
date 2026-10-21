/* "On this page": sections, with their questions nested under them. The rail is one SVG line that steps right
   with a short diagonal notch wherever the list goes into a section's questions and back; a darker copy of the
   same line, clipped to the current entry, slides along it as the reader scrolls. Clicking an entry glides there. */
import type { Question } from './questions';
import { h, onScroll, slug } from '../kit/web/dom';
import { sound } from '../kit/web/sound';
import { reduced } from './libs';

const X = [0.5, 12.5]; // the rail's x for sections and for questions
const NOTCH = 6;       // half the height of a diagonal step

/** Glide to an element, landing at its scroll-margin-top (below the sticky bar), then flash it so the reader
    sees where they landed, even when the page could not move. Native smooth scrolling is not reliable inside
    every frame, so this eases scrollTo itself; any wheel, touch or key stops it. Returns the glide's length in ms. */
export function glideTo(el: HTMLElement): number {
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const max = document.documentElement.scrollHeight - innerHeight;
  const from = scrollY, to = Math.max(0, Math.min(max, from + el.getBoundingClientRect().top - margin));
  const ms = reduced || Math.abs(to - from) < 2 ? 0 : Math.min(560, 240 + Math.abs(to - from) * 0.08);
  sound.play('nav'); // a quiet tick: the click registered, even when the page cannot move
  flash(el, ms);
  if (!ms) { scrollTo(0, to); return 0; }
  const start = performance.now();
  let raf = 0;
  const stop = () => { cancelAnimationFrame(raf); for (const ev of ['wheel', 'touchstart', 'keydown']) removeEventListener(ev, stop); };
  for (const ev of ['wheel', 'touchstart', 'keydown']) addEventListener(ev, stop, { passive: true, once: true });
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    scrollTo(0, from + (to - from) * (1 - (1 - t) ** 4)); // ease-out quart: quick start, soft landing
    if (t < 1) raf = requestAnimationFrame(tick); else stop();
  };
  raf = requestAnimationFrame(tick);
  return ms;
}

/** A short pulse on the target, after the glide lands (or at once when the page cannot move). */
function flash(el: HTMLElement, delay: number) {
  window.setTimeout(() => {
    el.classList.remove('t-flash');
    void el.offsetWidth; // restart the animation on a second click
    el.classList.add('t-flash');
    window.setTimeout(() => el.classList.remove('t-flash'), 1400);
  }, delay);
}

interface Entry { el: HTMLElement; depth: 0 | 1; li: HTMLLIElement; link: HTMLAnchorElement; q?: Question }

export function createToc(layout: HTMLElement, page: HTMLElement, questions: Question[], onChange: Set<() => void>) {
  const entries: Entry[] = [];
  let inSection = false;
  let current = -1;
  let pinned = -1;     // an entry the reader clicked; it stays current until they scroll themselves
  let quietUntil = 0;  // scroll events before this come from our own glide
  let pinY = 0;        // where the page rests for the pin; only a real move away from it releases the pin
  for (const el of page.querySelectorAll<HTMLElement>('h2, t-question')) {
    const q = questions.find((x) => x.el === el);
    if (!q) { el.id ||= slug(el.textContent ?? ''); inSection = true; }
    const link = h('a', { href: '#' + el.id, title: q?.report().question ?? null },
      q ? [q.num ? h('span', { class: 't-toc-n' }, q.num) : null, h('span', { class: 't-toc-t' }, q.label), h('i', { class: 't-toc-state' })]
        : h('span', { class: 't-toc-t' }, el.textContent ?? ''));
    const index = entries.length;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      // the clicked entry wins: the marker moves to it now and stays until the reader scrolls on their own
      pinned = index;
      pinY = scrollY;
      setCurrent(index);
      quietUntil = performance.now() + glideTo(el) + 150;
      try { history.replaceState(null, '', '#' + el.id); } catch { /* the viewer may refuse; the scroll is what matters */ }
    });
    const depth = q && inSection ? 1 : 0;
    entries.push({ el, depth, q, link, li: h('li', { class: depth ? 'is-sub' : null }, link) });
  }
  if (entries.length < 2) return;

  const rail = h('div', { class: 't-toc-rail', 'aria-hidden': 'true' });
  const thumb = h('div', { class: 't-toc-thumb', 'aria-hidden': 'true' });
  const list = h('ol', {}, entries.map((e) => e.li));
  layout.append(h('nav', { class: 't-toc', 'aria-label': 'On this page', 'data-uncommentable': '' },
    h('p', {}, 'On this page'), h('div', { class: 't-toc-body' }, rail, thumb, list)));

  // the rail: vertical along each entry, diagonal where the depth changes
  function draw() {
    const H = list.offsetHeight;
    if (!H) return; // hidden on narrow screens; the ResizeObserver draws when it shows
    const pts: string[] = [];
    entries.forEach((e, i) => {
      const x = X[e.depth], top = e.li.offsetTop, bottom = top + e.li.offsetHeight;
      const stepIn = i > 0 && entries[i - 1].depth !== e.depth;
      const stepOut = i < entries.length - 1 && entries[i + 1].depth !== e.depth;
      pts.push(`${x} ${top + (stepIn ? NOTCH : 0)}`, `${x} ${bottom - (stepOut ? NOTCH : 0)}`);
    });
    const svg = `<svg width="14" height="${H}" viewBox="0 0 14 ${H}" fill="none"><path d="M${pts.join(' L')}"/></svg>`;
    rail.innerHTML = svg;
    thumb.innerHTML = svg;
    spy();
  }

  // the current entry: the clicked one while pinned, else the last one whose top has passed under the bar
  // (the last one at the page's end)
  function spy() {
    if (pinned >= 0) return setCurrent(pinned);
    const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    let i = 0;
    entries.forEach((e, j) => { if (e.el.getBoundingClientRect().top < 140) i = j; });
    setCurrent(atEnd ? entries.length - 1 : i);
  }
  function setCurrent(i: number) {
    const li = entries[i].li, H = list.offsetHeight;
    if (H) thumb.style.clipPath = `inset(${li.offsetTop}px 0 ${Math.max(0, H - li.offsetTop - li.offsetHeight)}px 0)`;
    if (i === current) return;
    current = i;
    entries.forEach((e, j) => e.link.classList.toggle('is-on', j === i));
  }
  // the reader scrolling on their own releases a pin; our own glide does not
  const release = () => { if (pinned >= 0) { pinned = -1; spy(); } };
  for (const ev of ['wheel', 'touchmove'] as const) addEventListener(ev, release, { passive: true });
  addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) release();
  });
  onScroll(() => {
    if (pinned < 0) return spy();
    if (performance.now() <= quietUntil) pinY = scrollY; // our glide moving; follow it
    else if (Math.abs(scrollY - pinY) > 24) release();   // e.g. a scrollbar drag
  });

  const paint = () => entries.forEach((e) => { if (e.q) e.li.toggleAttribute('data-done', e.q.done()); });
  onChange.add(paint);
  paint();
  new ResizeObserver(draw).observe(list);
  void document.fonts?.ready.then(draw);
}

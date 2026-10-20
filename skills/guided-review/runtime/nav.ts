/* Moving around: the Guide and Diff views, jumps from a ref to its line, the chapter rail, j and k. */
import { $, $$, D, FILES, esc } from './dom';
import { type CardState, card, cards, findRow, setFold } from './cards';
import { showFile, tree } from './marks';

// ---------------------------------------------------------------- views
export function renderGuide() {
  for (const box of $$('.gr-files[data-chapter]')) {
    const ch = D.chapters.find((c) => c.id === box.dataset.chapter)!;
    for (const s of ch.files) box.append(card(FILES.get(s.path)!, s.hunks, ch.id));
  }
}
let diffDone = false;
export function renderDiff() {
  if (diffDone) return;
  diffDone = true;
  const cardsEl = $('#gr-diff-cards')!;
  for (const f of [...D.files].sort((x, y) => x.path.localeCompare(y.path))) cardsEl.append(card(f, null, null));
  for (const f of D.files) showFile(f.path);
  void tree.build($('#gr-tree-host')!);
}
export type View = 'guide' | 'diff';
export const view = (): View => ($('#gr-diff')!.hidden ? 'guide' : 'diff');
export function show(v: View) {
  for (const t of $$('.gr-tab')) t.setAttribute('aria-selected', String(t.dataset.view === v));
  $('#gr-guide')!.hidden = v !== 'guide';
  $('#gr-diff')!.hidden = v !== 'diff';
  $('.gr-rail')?.toggleAttribute('hidden', v !== 'guide');
  if (v === 'diff') renderDiff();
}

// ---------------------------------------------------------------- jumps
// Cards render as they come near, and each one that does changes height. A jump holds its target in place until the
// page settles or the reader scrolls.
let pinned: { obs: ResizeObserver; stop: () => void; timer: number } | null = null;
const PIN_ENDS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
const parentOf = (n: Element) => n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null);
export function pin(el: Element, block: ScrollLogicalPosition = 'start') {
  unpin();
  // Only the page scrolls: a code block keeps its sideways position.
  const place = () => {
    const xs: [Element, number][] = [];
    for (let n = parentOf(el); n; n = parentOf(n)) xs.push([n, n.scrollLeft]);
    el.scrollIntoView({ block });
    for (const [n, x] of xs) n.scrollLeft = x;
  };
  const obs = new ResizeObserver(place);
  for (const v of $$('.gr-view')) obs.observe(v);
  const stop = () => unpin();
  pinned = { obs, stop, timer: window.setTimeout(stop, 1500) };
  // After this event, which may be the key press that asked for the jump.
  setTimeout(() => { if (pinned?.stop === stop) for (const ev of PIN_ENDS) addEventListener(ev, stop, { passive: true, once: true }); });
  place();
}
function unpin() {
  if (!pinned) return;
  pinned.obs.disconnect();
  clearTimeout(pinned.timer);
  for (const ev of PIN_ENDS) removeEventListener(ev, pinned.stop);
  pinned = null;
}
export function toCard(path: string, scope: Element | null) {
  const c = $$('.gr-file', scope ?? document).find((x) => x.dataset.path === path);
  if (!c) return;
  setFold(c, false);
  pin(c);
}
function flash(st: CardState, row: Element, line: number, side: 'o' | 'n') {
  pin(row, 'center');
  st.inst?.setSelectedLines({ start: line, end: line, side: side === 'o' ? 'deletions' : 'additions' });
  clearTimeout(st.flashTimer);
  st.flashTimer = window.setTimeout(() => st.inst?.setSelectedLines(null), 1800);
}
/** Jump to a line: the guide's card that holds it, else the Diff tab's card of the whole file. */
export async function jump(path: string, line: number, side: 'o' | 'n', chapter: string | null, from: Element | null) {
  const inDiff = !!from?.closest('#gr-diff');
  const of = (scope: string) => $$('.gr-file', $(scope)!).filter((c) => c.dataset.path === path);
  // A card whose hunks hold the line first, then the guide's cards before the Diff tab's, then the chapter's own.
  const holds = (c: Element) => (line && cards.get(c)?.hunks.some((h) => h.lines.some((l) => (side === 'o' ? l[1] : l[2]) === line)) ? 4 : 0);
  const rank = (c: Element) => holds(c) + (c.closest('#gr-guide') ? 2 : 0) + (chapter && c.closest(`[data-chapter="${CSS.escape(chapter)}"]`) ? 1 : 0);
  renderDiff();
  const list = (inDiff ? of('#gr-diff') : [...of('#gr-guide'), ...of('#gr-diff')]).sort((x, y) => rank(y) - rank(x));
  for (const c of list) {
    show(c.closest('#gr-diff') ? 'diff' : 'guide');
    setFold(c, false);
    if (!line) { pin(c); return; }
    const row = await findRow(c, line, side);
    if (row) { flash(cards.get(c)!, row, line, side); return; }
  }
  if (list[0]) { show(list[0].closest('#gr-diff') ? 'diff' : 'guide'); setFold(list[0], false); pin(list[0]); }
}

// ---------------------------------------------------------------- the rail, j and k
const sections = () => $$('#gr-guide .gr-sec');
/** The section at the reading line, 30% down the screen. */
export function current() {
  const y = innerHeight * 0.3;
  const all = sections();
  let cur = all[0];
  for (const s of all) if (s.getBoundingClientRect().top <= y) cur = s;
  return cur;
}
export function buildRail() {
  const rail = $('.gr-rail');
  if (!rail) return;
  for (const s of sections()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.target = s.id;
    if (s.dataset.chapter) b.dataset.chapter = s.dataset.chapter;
    if (s.classList.contains('label-start')) b.classList.add('gap');
    b.innerHTML = `<span>${esc(s.dataset.title || '')}</span>`;
    b.setAttribute('aria-label', s.dataset.title || s.id);
    rail.append(b);
  }
}
let ticking = false;
export function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    $('.gr-bar')?.classList.toggle('stuck', scrollY > 60);
    const cur = current();
    for (const b of $$('.gr-rail button')) b.classList.toggle('on', b.dataset.target === cur?.id);
  });
}
/** Move to the next (1) or previous (-1) section. Returns whether it moved. */
export function go(delta: number) {
  const all = sections();
  const i = all.indexOf(current());
  const next = all[Math.min(all.length - 1, Math.max(0, i + delta))];
  if (!next || next === all[i]) return false;
  pin(next);
  return true;
}

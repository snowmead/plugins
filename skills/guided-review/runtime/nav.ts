/* Moving around: the pull request on screen, its Guide and Diff views and their left columns, jumps from a ref to its
   line, the chapter rail, j and k. */
import { $, $$, esc, store } from '../kit/web/dom';
import { type CardState, card, cards, findRow, setFold } from './cards';
import { type Ctx, active, ctxs, diffOf, guideOf, setActive } from './ctx';
import { buildTree, progress, restoreChapters, showFile } from './marks';

// ---------------------------------------------------------------- views
/** A pull request's guide cards, made the first time it is on screen. */
function renderGuide(c: Ctx) {
  if (c.guideDone) return;
  c.guideDone = true;
  for (const box of $$('.gr-files[data-chapter]', c.root)) {
    const ch = c.pr.chapters.find((x) => x.id === box.dataset.chapter)!;
    for (const s of ch.files) box.append(card(c, c.files.get(s.path)!, s.hunks, ch.id));
  }
  for (const f of c.pr.files) showFile(c, f.path);
  restoreChapters(c);
}
export function renderDiff(c: Ctx) {
  if (c.diffDone) return;
  c.diffDone = true;
  const cardsEl = $('.gr-diff-cards', c.root)!;
  for (const f of [...c.pr.files].sort((x, y) => x.path.localeCompare(y.path))) cardsEl.append(card(c, f, null, null));
  for (const f of c.pr.files) showFile(c, f.path);
  void buildTree(c, $('.gr-tree-host', c.root)!);
}
export type View = 'guide' | 'diff';
let shown: View = 'guide';
export const view = (): View => shown;
/** Guide or Diff, for the pull request on screen; the tab stays when the reader picks another. */
export function show(v: View) {
  shown = v;
  const c = active();
  for (const t of $$('.gr-tab')) t.setAttribute('aria-selected', String(t.dataset.view === v));
  guideOf(c).hidden = v !== 'guide';
  diffOf(c).hidden = v !== 'diff';
  $('.gr-rail')?.toggleAttribute('hidden', v !== 'guide');
  paintPanel();
  if (v === 'diff') renderDiff(c);
  // The comments' margin follows the view on screen.
  document.dispatchEvent(new Event('gr:view'));
}

// ---------------------------------------------------------------- the left column
// Each view's left column, the chapter text or the file tree, opens and closes on its own, and stays as the reader
// left it.
const closed: Record<View, boolean> = { guide: false, diff: false, ...store.get<Record<View, boolean>>('gr:panel-closed') };
function paintPanel() {
  document.body.classList.toggle('gr-guide-panel-closed', closed.guide);
  document.body.classList.toggle('gr-diff-panel-closed', closed.diff);
  const label = `${closed[shown] ? 'Show' : 'Hide'} ${shown === 'guide' ? 'the chapter text' : 'the file tree'}`;
  for (const b of $$('[data-panel-toggle]')) {
    b.setAttribute('aria-expanded', String(!closed[shown]));
    b.setAttribute('aria-label', label);
    b.title = `${label} (b)`;
  }
}
/** Open or close the left column of the view on screen. What is at the reading line stays where it is. */
export function togglePanel(open = closed[shown]) {
  const scope = shown === 'guide' ? guideOf(active()) : diffOf(active());
  const y = innerHeight * 0.3;
  const at = $$('.gr-card', scope).find((x) => { const r = x.getBoundingClientRect(); return r.top <= y && r.bottom > y; })
    ?? (shown === 'guide' ? current() : null);
  const top = at?.getBoundingClientRect().top ?? 0;
  closed[shown] = !open;
  store.set('gr:panel-closed', closed);
  paintPanel();
  if (at) scrollBy(0, at.getBoundingClientRect().top - top);
}
/** Put a pull request on screen: its bar items and panel show, the others hide. */
export function choose(c: Ctx) {
  const was = active();
  setActive(c);
  for (const el of $$('[data-pr]')) el.hidden = el.dataset.pr !== c.pr.id;
  renderGuide(c);
  show(shown);
  buildRail();
  progress(c);
  if (was !== c) scrollTo(0, 0);
  onScroll();
  return was !== c;
}
/** The pull request before (-1) or after (1) the one on screen. */
export function step(delta: number) {
  const i = ctxs.indexOf(active()) + delta;
  return i >= 0 && i < ctxs.length ? choose(ctxs[i]) : false;
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
  for (const v of $$('.gr-view', active().root)) obs.observe(v);
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
export function toCard(c: Ctx, path: string, scope: Element | null) {
  const el = $$('.gr-file', scope ?? c.root).find((x) => x.dataset.path === path);
  if (!el) return;
  if (scope?.classList.contains('gr-diff')) show('diff');
  setFold(el, false);
  pin(el);
}
function flash(st: CardState, row: Element, line: number, side: 'o' | 'n') {
  pin(row, 'center');
  st.inst?.setSelectedLines({ start: line, end: line, side: side === 'o' ? 'deletions' : 'additions' });
  clearTimeout(st.flashTimer);
  st.flashTimer = window.setTimeout(() => st.inst?.setSelectedLines(null), 1800);
}
/** Jump to a line of a pull request: the guide's card that holds it, else the Diff tab's card of the whole file. */
export async function jump(c: Ctx, path: string, line: number, side: 'o' | 'n', chapter: string | null, from: Element | null) {
  const inDiff = !!from?.closest('.gr-diff');
  const of = (scope: Element) => $$('.gr-file', scope).filter((x) => x.dataset.path === path);
  // A card whose hunks hold the line first, then the guide's cards before the Diff tab's, then the chapter's own.
  const holds = (x: Element) => (line && cards.get(x)?.hunks.some((h) => h.lines.some((l) => (side === 'o' ? l[1] : l[2]) === line)) ? 4 : 0);
  const rank = (x: Element) => holds(x) + (x.closest('.gr-guide') ? 2 : 0) + (chapter && x.closest(`[data-chapter="${CSS.escape(chapter)}"]`) ? 1 : 0);
  renderDiff(c);
  const list = (inDiff ? of(diffOf(c)) : [...of(guideOf(c)), ...of(diffOf(c))]).sort((x, y) => rank(y) - rank(x));
  for (const x of list) {
    show(x.closest('.gr-diff') ? 'diff' : 'guide');
    setFold(x, false);
    if (!line) { pin(x); return; }
    const row = await findRow(x, line, side);
    if (row) { flash(cards.get(x)!, row, line, side); return; }
  }
  if (list[0]) { show(list[0].closest('.gr-diff') ? 'diff' : 'guide'); setFold(list[0], false); pin(list[0]); }
}

// ---------------------------------------------------------------- the rail, j and k
const sections = () => $$('.gr-sec', guideOf(active()));
/** The section at the reading line, 30% down the screen. */
export function current() {
  const y = innerHeight * 0.3;
  const all = sections();
  let cur = all[0];
  for (const s of all) if (s.getBoundingClientRect().top <= y) cur = s;
  return cur;
}
/** The rail lists the sections of the pull request on screen. */
function buildRail() {
  const rail = $('.gr-rail');
  if (!rail) return;
  rail.replaceChildren();
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
    $('.gr-bar')?.classList.toggle('is-scrolled', scrollY > 60);
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

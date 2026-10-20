/* The guided review page: code cards, review marks, jumps, the chapter rail and keys. build.ts bundles this into one
   script after the page's markup and its JSON data (#gr-data). Code renders with @pierre/diffs and the Diff tab's
   tree with @pierre/trees, both imported from the pinned jsDelivr URLs in the data. */
import type { DiffStyle } from './types';
import { $, D, T0 } from './dom';
import { cards, setDiffStyle, setFold, startDiffStyle, STEP } from './cards';
import { getMarks, markChapter, markFile, progress, saveMarks, showFile } from './marks';
import { buildRail, current, go, jump, onScroll, pin, renderGuide, show, toCard, view } from './nav';
import { sound } from './sound';

/** Mark a chapter from a click or a key, with its sound; the last chapter reviewed sounds its own. */
function reviewChapter(id: string, on: boolean) {
  markChapter(id, on);
  saveMarks();
  sound.play(on && progress() === D.chapters.length ? 'reveal' : on ? 'select' : 'deselect');
}

document.addEventListener('click', (e) => {
  const t = (e.target as Element).closest<HTMLElement>('button, a');
  if (!t) return;
  if (t.id === 'gr-sound') { sound.toggle(); return; }
  if (t.dataset.diffStyle) { if (setDiffStyle(t.dataset.diffStyle as DiffStyle)) sound.play('toggle'); return; }
  if (t.classList.contains('gr-tab')) {
    if (t.dataset.view !== view()) sound.play('toggle');
    show(t.dataset.view as 'guide' | 'diff');
    return;
  }
  if (t.classList.contains('gr-fold')) { const c = t.closest('.gr-card')!; setFold(c, !c.classList.contains('collapsed')); return; }
  if (t.dataset.expand) {
    const st = cards.get(t.closest('.gr-file')!);
    const all = e.shiftKey || e.altKey;
    st?.inst?.expandHunk(Number(t.dataset.hunk), all ? 'both' : (t.dataset.expand as 'up' | 'down'), all ? Number.POSITIVE_INFINITY : STEP);
    return;
  }
  if (t.closest('.gr-rail')) { const el = document.getElementById(t.dataset.target!); if (el) { pin(el); sound.play('nav'); } return; }
  if (t.dataset.jump) { void jump(t.dataset.jump, Number(t.dataset.line), t.dataset.side as 'o' | 'n', null, t); return; }
  if (t.dataset.diffGo) { void jump(t.closest<HTMLElement>('.gr-file')!.dataset.path!, Number(t.dataset.diffGo), 'n', null, $('#gr-diff')); return; }
  if (t.dataset.chapterGo) { show('guide'); const el = document.getElementById(`c-${t.dataset.chapterGo}`); if (el) pin(el); return; }
  if (t.dataset.ref) {
    e.preventDefault();
    // The chapter a ref belongs to: its before / after row's, or the one it is written in.
    const ch = t.closest('.ln')?.querySelector<HTMLElement>('[data-chapter-go]')?.dataset.chapterGo ?? t.closest<HTMLElement>('.gr-sec')?.dataset.chapter ?? null;
    void jump(t.dataset.ref, Number(t.dataset.line) || 0, (t.dataset.side as 'o' | 'n') || 'n', ch, t);
    return;
  }
  if (t.dataset.goto) toCard(t.dataset.goto, t.dataset.in === 'diff' ? $('#gr-diff') : t.closest('.gr-sec'));
});

document.addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement;
  if (box.dataset.reviewFile) {
    markFile(box.dataset.reviewCh || null, box.dataset.reviewFile, box.checked);
    saveMarks();
    sound.play(box.checked ? 'select' : 'deselect');
  }
  if (box.dataset.reviewChapter) reviewChapter(box.dataset.reviewChapter, box.checked);
});

document.addEventListener('keydown', (e) => {
  // Keys stay with a field that takes text; a ticked box gives them back.
  const t = e.target as HTMLElement;
  const typing = /textarea|select/i.test(t.tagName) || (t.tagName === 'INPUT' && !/checkbox|radio|button/.test((t as HTMLInputElement).type));
  if (e.metaKey || e.ctrlKey || e.altKey || typing || e.composedPath().some((n) => (n as HTMLElement).isContentEditable)) return;
  if (view() !== 'guide') return;
  if (e.key === 'j' || e.key === 'k') { if (go(e.key === 'j' ? 1 : -1)) sound.play('nav'); }
  else if (e.key === 'r') {
    const id = current()?.dataset.chapter;
    if (id) reviewChapter(id, !getMarks().c[id]);
  }
});
addEventListener('scroll', onScroll, { passive: true });

// ---------------------------------------------------------------- start
function start() {
  renderGuide();
  buildRail();
  for (const f of D.files) showFile(f.path);
  for (const id of Object.keys(getMarks().c)) { const box = $<HTMLInputElement>(`input[data-review-chapter="${CSS.escape(id)}"]`); if (box) box.checked = true; }
  progress();
  sound.show();
  startDiffStyle();
  const hash = location.hash.slice(1);
  if (hash === 'diff') show('diff');
  else if (hash && document.getElementById(hash)) pin(document.getElementById(hash)!);
  onScroll();
  performance.measure('gr:boot', { start: T0, end: performance.now() });
}
start();

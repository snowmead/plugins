/* Markdown cards: the file as it reads (Preview) or its source diff (Source), as GitHub shows a Markdown file. A card
   opens in Preview, rendered when the guide was built (scripts/markdown.ts), so the page draws it as it is.

   With Changes on, Preview shows the document with its change marked: added and removed blocks, and the words that
   changed inside a block. A chapter card that holds some of a file's hunks shows the blocks of its own hunks, each
   with one unchanged block around it, and folds the rest, as its source does; the Diff tab's card shows every change.
   With Changes off, it shows the whole document as it is now, unmarked. The switches belong to each card: flipping
   one changes no other.

   Each block keeps its source lines, so a jump to a line lands on the block that holds it, and a comment on a block
   is a comment on its lines (comments.ts). */
import type { DiffFile, MdPreview, MdRow, PageChapter, PierreLineRange, Side } from './types';
import { esc } from '../kit/web/dom';
import { COMMENT } from './icons';

/** One block either side of a change shows with it. */
const AROUND = 1;

export interface Prose {
  p: MdPreview;
  mode: 'preview' | 'source';
  changes: boolean;
  /** The card's .gr-prose. */
  el: HTMLElement;
  /** The hunks the card holds, or null for every hunk. */
  hunks: Set<number> | null;
  /** The chapters holding each hunk, to name where the changes a fold hides are. */
  chapters: Map<number, PageChapter[]>;
  /** The first row of each fold the reader opened. */
  open: Set<number>;
  painted: boolean;
  lit: Element[];
}

export const proseOf = (f: DiffFile, hunks: number[] | null, chapters: PageChapter[]): Prose | null => {
  if (!f.preview) return null;
  const el = document.createElement('div');
  el.className = 'gr-prose';
  const byHunk = new Map<number, PageChapter[]>();
  for (const h of f.hunks) byHunk.set(h.id, chapters.filter((c) => c.files.some((x) => x.path === f.path && (!x.hunks || x.hunks.includes(h.id)))));
  return { p: f.preview, mode: 'preview', changes: true, el, hunks: hunks && new Set(hunks), chapters: byHunk, open: new Set(), painted: false, lit: [] };
};

/** The header's switches: Source or Preview, and Changes, which shows in Preview only. */
export const switches = (name: string) =>
  `<span class="k-seg is-sm gr-md-seg" role="group" aria-label="Show ${esc(name)} as"><button type="button" data-md-mode="source" aria-pressed="false" title="The source diff">Source</button>`
  + `<button type="button" data-md-mode="preview" aria-pressed="true" title="The file as it reads">Preview</button></span>`
  + '<button type="button" class="gr-md-changes" data-md-changes aria-pressed="true" title="Mark what changed, or show the document as it is">Changes</button>';

/** Paint the header's switches from the card's state. */
export function showSwitches(card: Element, pr: Prose) {
  for (const b of card.querySelectorAll<HTMLElement>(':scope > header [data-md-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mdMode === pr.mode));
  const ch = card.querySelector<HTMLElement>(':scope > header [data-md-changes]');
  if (ch) { ch.setAttribute('aria-pressed', String(pr.changes)); ch.hidden = pr.mode !== 'preview'; }
  card.classList.toggle('is-prose', pr.mode === 'preview');
}

// ---------------------------------------------------------------- rows
/** A row's lines, on the side they count on. */
function linesOf(p: MdPreview, r: MdRow): { a: number; b: number; side: Side } {
  if (r.n != null) return { a: p.blocks[r.n].a, b: p.blocks[r.n].b, side: p.side };
  return { a: r.o![0], b: r.o![1], side: 'o' };
}
const MARK_WORD: Record<MdRow['mark'], string> = { same: '', changed: 'Changed', added: 'Added', removed: 'Removed' };
function blockHtml(a: number, b: number, side: Side, mark: MdRow['mark'], html: string) {
  const word = MARK_WORD[mark];
  const label = `line${a === b ? ` ${a}` : `s ${a}–${b}`}${side === 'o' ? ' (old)' : ''}`;
  return `<div class="gr-md-b${mark === 'same' ? '' : ` is-${mark}`}" data-a="${a}" data-b="${b}" data-side="${side}"${word ? ` title="${word}"` : ''}>`
    + `<button type="button" class="gr-md-plus" data-md-note aria-label="Comment on ${label}" title="Comment on ${label}">${COMMENT}</button>`
    + `${word ? `<span class="gr-md-mark">${word}</span>` : ''}${html}</div>`;
}

/** Whether a row is one of the card's changes: a row of its own hunks; on a card of every hunk, any row that changed. */
const mine = (pr: Prose, r: MdRow) => (pr.hunks ? r.hunks.some((h) => pr.hunks!.has(h)) : r.mark !== 'same' || r.hunks.length > 0);

/** Which rows show with Changes on: the card's changes, a block around each, and the folds the reader opened. */
function shownRows(pr: Prose) {
  const rows = pr.p.rows;
  const show = rows.map(() => false);
  rows.forEach((r, i) => {
    if (!mine(pr, r)) return;
    for (let k = Math.max(0, i - AROUND); k <= Math.min(rows.length - 1, i + AROUND); k++) {
      // Another chapter's change is not context; it stays folded, under its chapter's name.
      if (k === i || !rows[k].hunks.length || !pr.hunks || rows[k].hunks.some((h) => pr.hunks!.has(h))) show[k] = true;
    }
  });
  // A fold the reader opened stays open; it is known by its first row.
  for (let i = 0; i < rows.length; i++) {
    if (show[i] || !pr.open.has(i)) continue;
    for (let k = i; k < rows.length && !show[k] && !other(pr, rows[k]); k++) show[k] = true;
  }
  return show;
}
/** A change of another chapter's, on a chapter card. */
const other = (pr: Prose, r: MdRow) => !!pr.hunks && r.mark !== 'same' && !r.hunks.some((h) => pr.hunks!.has(h));

function foldHtml(pr: Prose, from: number, to: number) {
  const run = pr.p.rows.slice(from, to);
  const hunks = new Set(run.filter((r) => other(pr, r)).flatMap((r) => r.hunks));
  const n = run.length;
  if (hunks.size) {
    const chs = [...new Map([...hunks].flatMap((h) => pr.chapters.get(h) ?? []).map((c) => [c.id, c])).values()];
    const name = chs.length === 1 ? `“${esc(chs[0].title)}”` : `${chs.length} other chapters`;
    return `<div class="gr-md-fold"><span class="ar">↕</span><span class="lb">${n} block${n === 1 ? '' : 's'}, with changes in <button type="button" data-chapter-go="${esc(chs[0]?.id ?? '')}">${name}</button></span></div>`;
  }
  return `<div class="gr-md-fold open"><button type="button" class="ar" data-md-open="${from}" aria-label="Show ${n} unchanged block${n === 1 ? '' : 's'}">↕</button>`
    + `<span class="lb"><button type="button" data-md-open="${from}">${n} unchanged block${n === 1 ? '' : 's'}</button></span></div>`;
}

/** Draw the preview: the marked rows and their folds with Changes on, the whole document with it off. */
export function paint(pr: Prose) {
  const p = pr.p;
  let html = '';
  if (!pr.changes) html = p.blocks.map((b) => blockHtml(b.a, b.b, p.side, 'same', b.html)).join('');
  else {
    const show = shownRows(pr);
    if (!show.some(Boolean)) {
      html = '<div class="gr-md-none">This change does not show in the preview: it changes only spacing, line breaks or a link’s target. <button type="button" data-md-mode="source">Show the source</button></div>';
    }
    for (let i = 0; i < p.rows.length;) {
      if (show[i]) {
        const r = p.rows[i++];
        const { a, b, side } = linesOf(p, r);
        html += blockHtml(a, b, side, r.mark, r.html ?? p.blocks[r.n!].html);
        continue;
      }
      let j = i;
      while (j < p.rows.length && !show[j]) j++;
      if (show.some(Boolean)) html += foldHtml(pr, i, j);
      i = j;
    }
  }
  pr.el.innerHTML = `<div class="gr-prose-body">${html}</div>`;
  pr.painted = true;
  pr.lit = [];
}

/** Open a fold: its rows show unmarked, as they are. */
export function openFold(pr: Prose, from: number) {
  pr.open.add(from);
  paint(pr);
}

// ---------------------------------------------------------------- lines
const blocks = (pr: Prose) => [...pr.el.querySelectorAll<HTMLElement>('.gr-md-b')];
const holds = (el: HTMLElement, line: number, side: Side) => el.dataset.side === side && +el.dataset.a! <= line && line <= +el.dataset.b!;
/** The block that holds a line, as drawn: on its side, or for a changed block, on its old side too. */
export function blockAt(pr: Prose, line: number, side: Side): HTMLElement | null {
  const list = blocks(pr);
  const at = list.find((el) => holds(el, line, side));
  if (at || side !== 'o' || !pr.changes) return at ?? null;
  const i = pr.p.rows.findIndex((r) => r.mark === 'changed' && r.o![0] <= line && line <= r.o![1]);
  if (i < 0) return null;
  const { a } = linesOf(pr.p, pr.p.rows[i]);
  return list.find((el) => el.dataset.side === pr.p.side && +el.dataset.a! === a) ?? null;
}
/** Bring a folded line into the preview: open the fold that holds it. Returns whether any row holds it. */
export function reveal(pr: Prose, line: number, side: Side) {
  if (!pr.changes) return false;
  const rows = pr.p.rows;
  const i = rows.findIndex((r) => { const l = linesOf(pr.p, r); return (l.side === side && l.a <= line && line <= l.b) || (side === 'o' && r.o && r.o[0] <= line && line <= r.o[1]); });
  if (i < 0) return false;
  if (other(pr, rows[i])) return false;
  // The fold that holds the row starts at the first hidden row before it.
  const show = shownRows(pr);
  let from = i;
  while (from > 0 && !show[from - 1]) from--;
  if (!show[i]) openFold(pr, from);
  return true;
}
/** Light the blocks a range of lines covers, or none. */
export function light(pr: Prose, range: PierreLineRange | null) {
  for (const el of pr.lit) el.classList.remove('is-lit');
  pr.lit = [];
  if (!range) return;
  const side = (s?: string): Side => (s === 'deletions' ? 'o' : 'n');
  const a = { line: range.start, side: side(range.side) }, b = { line: range.end, side: side(range.endSide ?? range.side) };
  const list = blocks(pr);
  const first = list.findIndex((el) => holds(el, a.line, a.side)), last = list.findIndex((el) => holds(el, b.line, b.side));
  const lo = Math.min(first, last), hi = Math.max(first, last);
  if (lo < 0) { const one = blockAt(pr, a.line, a.side); if (one) pr.lit = [one]; }
  else pr.lit = list.slice(lo, hi + 1);
  for (const el of pr.lit) el.classList.add('is-lit');
}
/** The lines a block's comment is on. */
export function rangeOfBlock(el: HTMLElement): PierreLineRange {
  const side = el.dataset.side === 'o' ? 'deletions' : 'additions';
  return { start: +el.dataset.a!, end: +el.dataset.b!, side, endSide: side };
}
/** A link to a heading of the same file: the heading, in this card's preview. */
export const headingIn = (pr: Prose, id: string) => pr.el.querySelector<HTMLElement>(`[data-md-id="${CSS.escape(id)}"]`);

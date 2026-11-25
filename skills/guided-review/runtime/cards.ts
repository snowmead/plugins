/* Code cards. @pierre/diffs draws each card's code in its own shadow root: syntax highlighting, the words that
   changed within a line, light and dark themes. The folds between hunks, the moved-code chips and the review comments
   are ours, slotted in. A card renders when it comes near the screen, so a long guide opens at once. */
import type { DiffFile, DiffStyle, Hunk, Line, Move, PageChapter, PageSnippet, PierreAnnotation, PierreFileDiff, PierreFileDiffMeta, PierreHunkSeparator, PierreLineRange } from './types';
import { $, $$, esc, store } from '../kit/web/dom';
import { ICON } from '../kit/web/icons';
import { onTheme, themeType } from '../kit/web/theme';
import { D, split, stat } from './dom';
import { libs } from './libs';
import { COMMENT } from './icons';
import { type Note, commentNotes, fileNotes, noteEl, noteMounted, openLine, reflow } from './comments';
import { codeOptions, codeReady, onCodeTheme } from './codetheme';
import type { Ctx } from './ctx';
import { firstNew, firstOld, rebuildOld } from './hunks';
import { type Prose, blockAt, light, paint, proseOf, reveal, showSwitches, switches } from './prose';

/** Lines a click on a fold opens. */
export const STEP = 20;

/** A git patch of some of a file's hunks, as git printed them. */
function patchOf(f: DiffFile, hunks: Hunk[]) {
  const from = f.oldPath ?? f.path;
  let p = `diff --git a/${from} b/${f.path}\n`;
  if (f.status === 'added') p += 'new file mode 100644\n';
  if (f.status === 'deleted') p += 'deleted file mode 100644\n';
  if (f.oldPath) p += `rename from ${f.oldPath}\nrename to ${f.path}\n`;
  p += `--- ${f.status === 'added' ? '/dev/null' : `a/${from}`}\n+++ ${f.status === 'deleted' ? '/dev/null' : `b/${f.path}`}\n`;
  for (const h of hunks) {
    p += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.label ? ` ${h.label}` : ''}\n`;
    for (const l of h.lines) p += `${l[0]}${l[3]}\n`;
  }
  return p;
}

// ---------------------------------------------------------------- card state
export interface CardState {
  el: Element;
  ctx: Ctx;
  f: DiffFile;
  hunks: Hunk[];
  whole: boolean;
  /** For a card holding part of a file: the chapters that hold the hunks each fold leaves out. */
  elsewhere: PageChapter[][];
  mounting?: Promise<void>;
  /** The options the card was drawn with, so a change of layout or theme can redraw it. */
  opts?: Record<string, unknown>;
  inst?: PierreFileDiff;
  fd?: PierreFileDiffMeta;
  host?: Element | null;
  flashTimer?: number;
  /** A Markdown file's preview and its switches (prose.ts). */
  prose?: Prose | null;
  /** A Condensed card: its code is cut by hand, so its rows are numbered in the cut code. `hunks` holds the real line
      numbers, which the comments and jumps use; `f.hunks` the cut ones, which the library draws. */
  snip?: Snip;
  /** A code example: highlighted code, with no change and no comments. */
  example?: boolean;
  /** Styles of a Condensed card's own: its page notes. */
  css?: string;
}
interface Snip {
  /** "o12" or "n12" (a real line at the base or the head) → its line in the cut code, on the same side. */
  toCut: Map<string, number>;
  /** The rows, with each cut line number and real line number. */
  rows: { op: Line[0]; o: number | null; n: number | null; ro: number | null; rn: number | null }[];
}
export const cards = new WeakMap<Element, CardState>();
const mounted = new Set<CardState>();
onTheme(() => { for (const st of mounted) st.inst!.setThemeType(themeType()); });

// ---------------------------------------------------------------- unified or split
// The guide sets the layout cards open in; the reader's own choice, from the bar, wins and is remembered. Old and
// new side by side need room, so a narrow screen always shows one column.
const narrow = matchMedia('(max-width: 860px)');
let chosen: DiffStyle = store.get<DiffStyle>('gr:diff-style') ?? D.diffStyle;
const diffStyle = (): DiffStyle => (narrow.matches ? 'unified' : chosen);
function showStyle() {
  for (const b of $$('[data-diff-style]')) b.setAttribute('aria-pressed', String(b.dataset.diffStyle === chosen));
}
// A switch shows on the toggle in the click's own frame. The cards on screen redraw in the next frame, and the rest
// in idle time, or when they open or a jump needs them, so no frame waits on every card of a long guide.
const stale = new Set<CardState>();
const idle = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 8 }), 1));
function redraw(st: CardState) {
  stale.delete(st);
  // The theme type too: a change of theme reaches the card through setThemeType, not its options.
  st.opts = { ...st.opts, diffStyle: diffStyle(), themeType: themeType(), ...codeOptions() };
  if (st.css) st.opts.unsafeCSS = `${codeOptions().unsafeCSS ?? ''}\n${st.css}`;
  st.inst!.setOptions(st.opts);
  st.inst!.rerender();
}
/** Bring a card drawn in the old layout up to date before it is shown or searched. */
function fresh(el: Element) {
  const st = cards.get(el);
  if (st && stale.has(st)) redraw(st);
}
function drain(deadline: IdleDeadline) {
  for (const st of stale) {
    if (deadline.timeRemaining() < 4) break;
    redraw(st);
  }
  if (stale.size) idle(drain);
}
function restyle() {
  const t0 = performance.now();
  const near = (el: Element) => {
    if (el.closest('.collapsed, [hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  };
  for (const st of mounted) { if (near(st.el)) redraw(st); else stale.add(st); }
  if (stale.size) idle(drain);
  performance.measure('gr:restyle', { start: t0, end: performance.now() });
}
export function setDiffStyle(s: DiffStyle) {
  if (s === chosen) return false;
  chosen = s;
  store.set('gr:diff-style', s);
  showStyle();
  requestAnimationFrame(() => setTimeout(restyle));
  return true;
}
export function startDiffStyle() {
  showStyle();
  narrow.addEventListener('change', restyle);
  // A new code theme redraws the cards the same way: those on screen first, the rest in idle time.
  onCodeTheme(() => requestAnimationFrame(restyle));
}

const chaptersOf = (ctx: Ctx, f: DiffFile, hunks: Hunk[]) => ctx.pr.chapters.filter((c) => c.files.some((x) => x.path === f.path && (!x.hunks || x.hunks.some((id) => hunks.some((h) => h.id === id)))));

/** Keyed by the index of the shown hunk below the fold (the last fold: hunks.length). */
function elsewhereOf(ctx: Ctx, f: DiffFile, hunks: Hunk[]) {
  const out: PageChapter[][] = [];
  if (hunks.length === f.hunks.length) return out;
  const at = hunks.map((h) => f.hunks.indexOf(h));
  for (let i = 0; i <= hunks.length; i++) {
    const lo = i === 0 ? -1 : at[i - 1];
    const hi = i === hunks.length ? f.hunks.length : at[i];
    const left = f.hunks.slice(lo + 1, hi);
    if (left.length) out[i] = chaptersOf(ctx, f, left);
  }
  return out;
}

// ---------------------------------------------------------------- folds and moved code
function separator(st: CardState, h: PierreHunkSeparator) {
  const i = h.hunkIndex;
  const where = i === 0 ? 'top' : i >= st.hunks.length ? 'end' : 'mid';
  const el = document.createElement('div');
  el.className = `gr-sep ${where}`;
  const other = st.elsewhere[i];
  const n = h.lineCountKnown ? h.lines : null;
  const label = st.hunks[i]?.label ?? '';
  let text: string;
  if (other) {
    const chs = other.filter((c) => c.title);
    const name = chs.length === 1 ? `“${esc(chs[0].title)}”` : `${chs.length} other chapters`;
    text = `${n ?? 'More'} lines, with changes in <button type="button" data-chapter-go="${esc(chs[0]?.id ?? '')}">${name}</button>`;
  } else text = n == null ? 'More unmodified lines' : `${n} unmodified line${n === 1 ? '' : 's'}`;
  const open = !!h.expandable && !other;
  // A card holding part of a file cannot open its folds; the Diff tab's card of the whole file can.
  if (!open && !other && !st.whole && st.f.new) {
    const next = st.hunks[i], last = st.hunks[st.hunks.length - 1];
    const line = next ? next.newStart - 1 : last.newStart + last.newLines;
    text += `, <button type="button" data-diff-go="${line}">open on the Diff tab</button>`;
  }
  const arrow = where === 'top' ? '↑' : where === 'end' ? '↓' : '↕';
  // Slotted into the gutter, so the row is laid over the whole width without widening it.
  el.innerHTML = '<div class="in">'
    + `<span class="ar">${open ? `<button type="button" data-expand="${where === 'end' ? 'up' : 'down'}" data-hunk="${i}" aria-label="Show ${STEP} more lines">${arrow}</button>` : arrow}</span>`
    + `<span class="lb">${text}</span>${label && where !== 'end' ? `<span class="sc">${esc(label)}</span>` : ''}</div>`;
  if (open) el.classList.add('open');
  return el;
}

function noSeparator() {
  const el = document.createElement('div');
  el.className = 'gr-sep none';
  return el;
}

function moveChip(f: DiffFile, mv: Move) {
  const el = document.createElement('div');
  el.className = `gr-move ${mv.side === '-' ? 'del' : 'add'}`;
  const place = (mv.other === f.path ? '' : `${esc(mv.other)} `) + `line ${mv.otherFrom}`;
  el.innerHTML = `<button type="button" data-jump="${esc(mv.other)}" data-line="${mv.otherFrom}" data-side="${mv.side === '-' ? 'n' : 'o'}">↑ ${mv.lines} lines moved ${mv.side === '-' ? 'to' : 'from'} ${place}</button>`;
  return el;
}
// The library keeps a slotted element across redraws while its note is the same object, so each move keeps one.
const moveNotes = new WeakMap<Move, Note>();
const moveNote = (mv: Move) => { let n = moveNotes.get(mv); if (!n) moveNotes.set(mv, n = { kind: 'move', mv }); return n; };
/** A chip under the last line of each block of moved code the card shows. */
function movesIn(f: DiffFile, hunks: Hunk[]): PierreAnnotation<Note>[] {
  const shown = { '-': new Set<number>(), '+': new Set<number>() };
  for (const h of hunks) for (const [op, o, n] of h.lines) if (op !== ' ') shown[op].add((op === '-' ? o : n)!);
  return f.moves.filter((mv) => shown[mv.side].has(mv.to))
    .map((mv) => ({ side: mv.side === '-' ? 'deletions' : 'additions', lineNumber: mv.to, metadata: moveNote(mv) }));
}
/** What the card draws under its lines: moved-code chips, then review comments and an open composer. */
const notesOf = (st: CardState) => {
  if (st.example) return [];
  if (!st.snip) return [...movesIn(st.f, st.hunks), ...commentNotes(st)];
  return commentNotes(st).flatMap((a) => {
    const line = toCut(st, a.lineNumber, a.side === 'deletions' ? 'o' : 'n');
    return line == null ? [] : [{ ...a, lineNumber: line }];
  });
};

/** Without the library: the hunks as plain text. */
function plain(hunks: Hunk[]) {
  const lines = hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.label ?? ''}`, ...h.lines.map((l) => `${l[0]}${l[3]}`)]);
  return `<pre class="gr-plain">${esc(lines.join('\n'))}</pre>`;
}

// ---------------------------------------------------------------- mount

export function mount(card: Element): Promise<void> | undefined {
  const st = cards.get(card);
  if (!st || st.mounting) return st?.mounting;
  st.mounting = (async () => {
    const { diffs } = await libs;
    await codeReady;
    const host = $('.gr-code', card)!;
    const { f } = st;
    const hunks = st.snip || st.example ? f.hunks : st.hunks;
    const fallback = () => { host.innerHTML = plain(hunks); host.style.minHeight = ''; };
    if (!diffs) return fallback();
    let fd: PierreFileDiffMeta;
    try {
      fd = diffs.parsePatchFiles(patchOf(f, hunks))[0].files[0];
      // A card with every hunk and both full texts can open its folds.
      if (st.whole && f.new && (f.status === 'modified' || f.status === 'renamed')) {
        const old = rebuildOld(f);
        if (old) diffs.hydratePartialDiff('mutate', fd, { oldFile: { name: f.oldPath ?? f.path, contents: `${old.join('\n')}\n` }, newFile: { name: f.path, contents: `${f.new.join('\n')}\n` } });
      }
    } catch (e) {
      console.warn(`guide: ${f.path}: ${(e as Error).message}`);
      return fallback();
    }
    st.fd = fd;
    st.opts = {
      ...codeOptions(),
      themeType: themeType(),
      diffStyle: diffStyle(),
      disableFileHeader: true,
      // Cut code is short and read in full, so its long lines wrap, as Markdown's do.
      overflow: f.lang === 'markdown' || st.snip || st.example ? 'wrap' : 'scroll',
      hunkSeparators: (h: PierreHunkSeparator) => (st.snip || st.example ? noSeparator() : separator(st, h)),
      expansionLineCount: STEP,
      collapsedContextThreshold: fd.isPartial ? 0 : 3,
      renderAnnotation: (a: PierreAnnotation<Note>) => (a.metadata.kind === 'move' ? moveChip(f, a.metadata.mv) : noteEl(a.metadata)),
      // The "+" beside the line under the pointer starts a comment; dragging it takes a block of lines. A click on a
      // line number selects the line, a Shift-click selects the lines up to another, and the "+" then sits on the
      // last of them and takes them all.
      enableGutterUtility: !st.example,
      enableLineSelection: !st.example,
      // Cut code has no real line numbers to show; its rows hold them for comments and jumps.
      ...(st.snip || st.example ? { disableLineNumbers: true } : {}),
      ...(st.css ? { unsafeCSS: `${codeOptions().unsafeCSS ?? ''}\n${st.css}` } : {}),
      onGutterUtilityClick: (range: PierreLineRange) => openLine(st, range),
      // A selection the reader starts outlives a jump's highlight of its line.
      onLineSelectionStart: () => clearTimeout(st.flashTimer),
    };
    st.inst = new diffs.FileDiff(st.opts);
    st.inst.render({ fileDiff: fd, containerWrapper: host, lineAnnotations: notesOf(st) });
    st.host = $('diffs-container', host);
    host.style.minHeight = '';
    mounted.add(st);
    noteMounted(st);
  })();
  return st.mounting;
}

/** The drawn cards of a pull request. */
export const allDrawn = (ctx: Ctx) => [...mounted].filter((st) => st.ctx === ctx);
/** Draw a card's notes again, after a comment on its file is added, changed or removed. */
export function redrawNotes(st: CardState) {
  st.inst!.setLineAnnotations(notesOf(st));
  st.inst!.rerender();
}

const mounter = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting || e.target.classList.contains('collapsed')) continue;
    mounter!.unobserve(e.target);
    wake(e.target);
  }
}, { rootMargin: '900px 0px' }) : null;

// ---------------------------------------------------------------- the card
const LANG_CHIP: Record<string, string> = { rust: 'rs', typescript: 'ts', javascript: 'js', markdown: 'md', python: 'py', makefile: 'mk', dockerfile: 'dk', plaintext: 'txt', ini: 'toml', xml: 'html', bash: 'sh' };
export const chipOf = (f: DiffFile) => {
  const ext = f.path.includes('.') ? f.path.split('.').pop()!.toLowerCase() : '';
  return ext && ext.length <= 4 ? ext : LANG_CHIP[f.lang] ?? f.lang.slice(0, 4);
};
const WORD: Partial<Record<DiffFile['status'], string>> = { added: 'added', deleted: 'deleted', renamed: 'renamed', copied: 'copied' };

/** A file's card: every hunk (the Diff tab), or some of them in a chapter. */
export function card(ctx: Ctx, f: DiffFile, hunkIds: number[] | null, chapter: string | null) {
  const hunks = hunkIds ? f.hunks.filter((h) => hunkIds.includes(h.id)) : f.hunks;
  let a = 0, d = 0;
  for (const h of hunks) for (const l of h.lines) { if (l[0] === '+') a++; else if (l[0] === '-') d++; }
  const [name, dir] = split(f.path);
  const word = WORD[f.status] ?? '';
  const whole = hunks.length === f.hunks.length;
  const part = whole ? '' : `<span class="st">${hunks.length} of ${f.hunks.length} hunks</span>`;
  const el = document.createElement('article');
  el.className = 'gr-card gr-file';
  el.dataset.path = f.path;
  let body: string;
  if (f.binary) body = '<div class="gr-empty">Binary file. Open it on GitHub to see it.</div>';
  else if (!hunks.length) body = `<div class="gr-empty">${f.status === 'renamed' ? 'Renamed with no line changes.' : 'No line changes.'}</div>`;
  else {
    // Room for the rows until the code renders, so jumps land where they aim.
    const rows = hunks.reduce((s, h) => s + h.lines.length + 1, 1);
    body = `<div class="gr-code" style="min-height:${rows * 20}px"></div>`;
  }
  const gen = f.kind === 'generated' ? '<div class="gen-note">Generated file. It starts folded; the change comes from the source files in this pull request.</div>' : '';
  const prose = hunks.length && !f.binary ? proseOf(f, hunkIds && !whole ? hunkIds : null, ctx.pr.chapters) : null;
  el.innerHTML =
    `<header><button type="button" class="gr-fold" aria-label="Fold ${esc(name)}" aria-expanded="true">${ICON.down}</button>`
    + `<span class="gr-lang">${esc(chipOf(f))}</span><span class="fname">${esc(name)}</span>`
    + `<span class="fdir" title="${esc(f.path)}">${esc(dir)}${f.oldPath ? ` ← ${esc(f.oldPath)}` : ''}</span>`
    + `<span class="fstat">${part}${word ? `<span class="st">${word}</span>` : ''}${stat(a, d)}</span>`
    + (prose ? switches(name) : '')
    + `<button type="button" class="gr-note-btn" data-note-file aria-label="Comment on ${esc(name)}" title="Comment on this file">${COMMENT}</button>`
    + `<label class="gr-check"><input type="checkbox" data-review-file="${esc(f.path)}"${chapter ? ` data-review-ch="${esc(chapter)}"` : ''}><span class="rv">Reviewed</span></label></header>`
    + '<div class="gr-notes" hidden></div>' + gen + body;
  if (prose) { el.classList.add('has-md'); el.append(prose.el); showSwitches(el, prose); }
  if (hunks.length && !f.binary) {
    cards.set(el, { el, ctx, f, hunks, whole, elsewhere: elsewhereOf(ctx, f, hunks), prose });
    if (mounter) mounter.observe(el); else wake(el);
  }
  fileNotes(ctx, el);
  if (f.kind === 'generated') setFold(el, true);
  watcher?.observe(el);
  return el;
}

// ---------------------------------------------------------------- stuck headers
// A file's header sticks under the pinned header while its code scrolls (guide.css). Only the cards on screen can
// have one stuck, so only they are measured as the page scrolls.
const onScreen = new Set<Element>();
const watcher = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) onScreen.add(e.target);
    else { onScreen.delete(e.target); e.target.firstElementChild?.classList.remove('is-stuck'); }
  }
  markStuck();
}) : null;
/** Mark each header on screen that is stuck: its card's top has scrolled above the line it sticks to, and the card
    still runs on below it. */
export function markStuck() {
  let line: number | null = null;
  for (const el of onScreen) {
    const head = el.firstElementChild as HTMLElement;
    line ??= parseFloat(getComputedStyle(head).top) || 0;
    const r = el.getBoundingClientRect();
    head.classList.toggle('is-stuck', r.top < line - 0.5 && r.bottom > line + head.offsetHeight + 0.5);
  }
}

export function setFold(el: Element | null, folded: boolean) {
  if (!el) return;
  el.classList.toggle('collapsed', folded);
  $('.gr-fold', el)?.setAttribute('aria-expanded', String(!folded));
  if (!folded && cards.has(el)) { fresh(el); wake(el); }
}

// ---------------------------------------------------------------- Markdown: Preview or Source
/** Whether a card shows a Markdown file as it reads. */
export const previewOn = (st: CardState) => st.prose?.mode === 'preview';
/** Draw what a card shows: its preview, or its code. */
function wake(el: Element) {
  const st = cards.get(el);
  if (!st) return;
  if (!previewOn(st)) { void mount(el); return; }
  if (!st.prose!.painted) { paint(st.prose!); reflow(st); }
}
/** Flip a Markdown card between Preview and Source, or its Changes on or off. Returns whether anything changed. */
export function setProse(el: Element, o: { mode?: Prose['mode']; changes?: boolean }) {
  const st = cards.get(el), pr = st?.prose;
  if (!st || !pr || ((o.mode ?? pr.mode) === pr.mode && (o.changes ?? pr.changes) === pr.changes)) return false;
  const repaint = o.changes != null && o.changes !== pr.changes;
  select(st, null);
  pr.mode = o.mode ?? pr.mode;
  pr.changes = o.changes ?? pr.changes;
  showSwitches(el, pr);
  if (repaint) pr.painted = false;
  setFold(el, false);
  wake(el);
  reflow(st);
  return true;
}
/** Open a fold of a card's preview. */
export function openProseFold(el: Element, from: number) {
  const st = cards.get(el);
  if (!st?.prose) return;
  st.prose.open.add(from);
  paint(st.prose);
  reflow(st);
}
/** Select lines in a card: in its code, or the blocks that hold them in its preview. */
export function select(st: CardState, real: PierreLineRange | null) {
  const range = real && st.snip ? rangeToCut(st, real) : real;
  if (st.prose) light(st.prose, previewOn(st) ? range : null);
  if (!previewOn(st) || !range) st.inst?.setSelectedLines(range);
}
/** The "+" on a block of a preview: a comment on the block's lines. */
export function commentBlock(block: HTMLElement) {
  const st = cards.get(block.closest('.gr-file')!);
  if (!st) return;
  const side = block.dataset.side === 'o' ? 'deletions' : 'additions';
  openLine(st, { start: +block.dataset.a!, end: +block.dataset.b!, side, endSide: side }, 'the block');
}

// ---------------------------------------------------------------- rows
/** The row of a line in a rendered card: a removed line by its old number, any other by its new one. Split cards
    number each column by its own side, so the line is looked up in the deletions or the additions column. */
export function rowOf(st: CardState, real: number, side: 'o' | 'n') {
  const line = toCut(st, real, side);
  if (line == null) return null;
  if (previewOn(st)) return st.prose!.painted ? blockAt(st.prose!, line, side) : null;
  const root = st.host?.shadowRoot;
  if (!root) return null;
  if (root.querySelector('[data-diff-type="split"]')) return root.querySelector(`[data-${side === 'o' ? 'deletions' : 'additions'}] [data-line="${line}"]`);
  return side === 'o'
    ? root.querySelector(`[data-line-type="change-deletion"][data-line="${line}"], [data-alt-line="${line}"]`)
    : root.querySelector(`[data-line="${line}"]:not([data-line-type="change-deletion"])`);
}
/** The row of a line, opening the fold that hides it when the card holds the whole file. */
export async function findRow(cardEl: Element, line: number, side: 'o' | 'n') {
  const st = cards.get(cardEl);
  if (!st) return null;
  // A preview shows the block that holds the line, opening its fold. A line it cannot show (an old line, with Changes
  // off) is in the source.
  if (previewOn(st)) {
    wake(cardEl);
    const at = blockAt(st.prose!, line, side) ?? (reveal(st.prose!, line, side) ? blockAt(st.prose!, line, side) : null);
    if (at) { reflow(st); return at; }
    // A line of another chapter's hunk is not this card's to show.
    if (!st.whole && !st.hunks.some((h) => h.lines.some((l) => (side === 'o' ? l[1] : l[2]) === line))) return null;
    setProse(cardEl, { mode: 'source' });
  }
  await mount(cardEl);
  fresh(cardEl);
  const row = rowOf(st, line, side);
  if (row || !st.inst || st.fd?.isPartial) return row;
  const at = side === 'o' ? firstOld : firstNew;
  let i = st.hunks.findIndex((h) => at(h) > line);
  if (i < 0) i = st.hunks.length;
  st.inst.expandHunk(i, 'both', Number.POSITIVE_INFINITY);
  return rowOf(st, line, side);
}

// ---------------------------------------------------------------- Condensed cards
/** A real line's row in a card, by its number in the card's code: the same number, but in cut code its cut one. */
export function toCut(st: CardState, line: number, side: 'o' | 'n') {
  return st.snip ? st.snip.toCut.get(`${side}${line}`) ?? null : line;
}
function rangeToCut(st: CardState, r: PierreLineRange): PierreLineRange | null {
  const side = (x?: string) => (x === 'deletions' ? 'o' : 'n');
  const a = toCut(st, r.start, side(r.side)), b = toCut(st, r.end, side(r.endSide ?? r.side));
  if (a == null && b == null) return null;
  return { ...r, start: a ?? b!, end: b ?? a! };
}
/** Lines picked in cut code, as real lines. A pick that starts or ends on a line only on the page (a `// ...`, a
    note) takes the nearest real line inside it; one with no real line returns null. */
export function rangeToReal(st: CardState, r: PierreLineRange): PierreLineRange | null {
  const rows = st.snip!.rows;
  const find = (line: number, s?: string) => rows.findIndex((x) => (s === 'deletions' ? x.op === '-' || x.op === ' ' ? x.o === line : false : x.n === line && x.op !== '-'));
  let i = find(r.start, r.side), j = find(r.end, r.endSide ?? r.side);
  if (i < 0 || j < 0) return null;
  if (i > j) [i, j] = [j, i];
  const realOf = (x: Snip['rows'][number]) => (x.op === '-' ? (x.ro != null ? { line: x.ro, side: 'deletions' as const } : null) : x.rn != null ? { line: x.rn, side: 'additions' as const } : x.ro != null ? { line: x.ro, side: 'deletions' as const } : null);
  let a = null, b = null;
  for (let k = i; k <= j && !a; k++) a = realOf(rows[k]);
  for (let k = j; k >= i && !b; k--) b = realOf(rows[k]);
  if (!a || !b) return null;
  return { start: a.line, side: a.side, end: b.line, endSide: b.side };
}

/** A page note (`//> text`) is the page's voice, not the code's: it draws in the accent color, in italics, on no
    change color, wherever it sits. The library numbers rows in the cut code, so each note is styled by its row. */
const NOTE = /^\s*(?:\/\/|#|--)>(?:\s|$)/;
function noteCss(rows: Line[]) {
  const sel = rows.filter((l) => NOTE.test(l[3])).flatMap(([op, o, n]) => (op === '-'
    ? [`[data-line-type="change-deletion"][data-line="${o}"]`, `[data-deletions] [data-line="${o}"]`]
    : [`[data-line="${n}"]:not([data-line-type="change-deletion"])`, `[data-additions] [data-line="${n}"]`, ...(op === ' ' ? [`[data-deletions] [data-line="${o}"]`] : [])]));
  if (!sel.length) return '';
  const all = sel.join(', ');
  return `:is(${all}) { background: transparent !important; }\n:is(${all}) span { color: var(--c1) !important; font-style: italic; }`;
}
const count = (rows: Line[], op: '-' | '+') => rows.filter((l) => l[0] === ' ' || l[0] === op).length;
/** One hunk of cut code: numbered from 1 on each side, or from 0 on a side it has not. */
function cutHunk(rows: Line[]): Hunk {
  const oldLines = count(rows, '-'), newLines = count(rows, '+');
  return { id: 1, oldStart: oldLines ? 1 : 0, oldLines, newStart: newLines ? 1 : 0, newLines, header: '', label: '', scope: [], lines: rows };
}
function cutCard(ctx: Ctx, f: DiffFile, title: string, dir: string, stats: string, extra: string, cls: string) {
  const el = document.createElement('article');
  el.className = `gr-card gr-file ${cls}`;
  el.dataset.path = f.path;
  const rows = f.hunks[0].lines.length;
  el.innerHTML =
    `<header><button type="button" class="gr-fold" aria-label="Fold ${esc(title)}" aria-expanded="true">${ICON.down}</button>`
    + `<span class="gr-lang">${esc(chipOf(f))}</span><span class="fname">${esc(title)}</span>`
    + `<span class="fdir" title="${esc(f.path)}">${esc(dir)}</span><span class="fstat">${stats}</span>${extra}</header>`
    + `<div class="gr-notes" hidden></div><div class="gr-code" style="min-height:${rows * 20}px"></div>`;
  return el;
}
/** A Condensed card: a file's code, cut by hand, with its change. */
export function snippetCard(ctx: Ctx, sn: PageSnippet, section: string) {
  const real = ctx.files.get(sn.path)!;
  const rows = sn.rows;
  const hasOld = rows.some((l) => l[0] !== '+'), hasNew = rows.some((l) => l[0] !== '-');
  const f: DiffFile = {
    ...real, oldPath: null, status: !hasOld ? 'added' : !hasNew ? 'deleted' : 'modified',
    old: null, new: null, moves: [], preview: undefined, hunks: [cutHunk(rows)],
  };
  const snip: Snip = { toCut: new Map(), rows: rows.map((l, i) => ({ op: l[0], o: l[1], n: l[2], ro: sn.at[i][0], rn: sn.at[i][1] })) };
  for (const x of snip.rows) {
    if (x.o != null && x.ro != null) snip.toCut.set(`o${x.ro}`, x.o);
    if (x.n != null && x.rn != null) snip.toCut.set(`n${x.rn}`, x.n);
  }
  // The real line numbers, for the comments and jumps that look a line up in a card's hunks.
  const realHunk: Hunk = { ...f.hunks[0], lines: snip.rows.map((x) => [x.op, x.op === '+' ? null : x.ro, x.op === '-' ? null : x.rn, '']) as Line[] };
  let a = 0, d = 0;
  // Only code counts: a `// ...`, a note or a blank line is not a line the pull request changes.
  for (const x of snip.rows) { if (x.op === '+' && x.rn != null) a++; else if (x.op === '-' && x.ro != null) d++; }
  const [name, dir] = split(sn.path);
  const first = snip.rows.find((x) => x.op === '+' && x.rn != null)?.rn ?? snip.rows.find((x) => x.rn != null)?.rn;
  const el = cutCard(ctx, f, sn.name ?? name, sn.name ? sn.path : dir, stat(a, d),
    `<button type="button" class="gr-note-btn" data-note-file aria-label="Comment on ${esc(name)}" title="Comment on this file">${COMMENT}</button>`
    + (first != null && real.status !== 'deleted' ? `<button type="button" class="gr-to-diff" data-diff-go="${first}" title="The whole change to this file, on the Diff tab">Full diff</button>` : ''),
    'gr-cut');
  el.dataset.section = section;
  cards.set(el, { el, ctx, f, hunks: [realHunk], whole: false, elsewhere: [], prose: null, snip, css: noteCss(rows) });
  if (mounter) mounter.observe(el); else wake(el);
  fileNotes(ctx, el);
  watcher?.observe(el);
  return el;
}
const EXT: Record<string, string> = { typescript: 'ts', javascript: 'js', rust: 'rs', python: 'py', go: 'go', bash: 'sh', shell: 'sh', sql: 'sql', json: 'json', yaml: 'yaml', toml: 'toml', markdown: 'md', tsx: 'tsx', jsx: 'jsx', ruby: 'rb', java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', css: 'css', html: 'html' };
/** A code example: code that is not in the pull request, highlighted, with no change. */
export function exampleCard(ctx: Ctx, ex: { lang: string; code: string; title?: string }) {
  const ext = EXT[ex.lang.toLowerCase()] ?? ex.lang.toLowerCase();
  const lines = ex.code.split('\n');
  const rows: Line[] = lines.map((t, i) => [' ', i + 1, i + 1, t]);
  const f: DiffFile = {
    path: `example.${ext}`, oldPath: null, status: 'modified', kind: 'core', lang: ex.lang, binary: false, add: 0, del: 0,
    old: null, new: null, oldCount: null, newCount: null, moves: [], hunks: [cutHunk(rows)],
  };
  const el = cutCard(ctx, f, ex.title ?? 'Example', '', '<span class="st">not in the pull request</span>', '', 'gr-example-card');
  el.removeAttribute('data-path');
  cards.set(el, { el, ctx, f, hunks: [], whole: false, elsewhere: [], prose: null, example: true });
  if (mounter) mounter.observe(el); else wake(el);
  return el;
}

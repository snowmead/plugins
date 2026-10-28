/* Review comments. The reader writes comments for Claude on a line or a block of lines, on a file, or on the pull
   request as a whole, reads them in a sidebar, and sends them all at once, as a thinkr plan page sends its answers.

   - A line comment starts from the "+" @pierre/diffs shows beside the line under the pointer (drag it to take a block
     of lines), or beside the last of the lines the reader selected by their numbers (a click, then a Shift-click on
     another to take the lines between), and sits under its last line, in every card that shows that line.
   - A file comment starts from the speech bubble in a card's header and sits under the header.
   - A general comment is written at the top of the sidebar.

   Comments stay in the reader's browser, per pull request like the review marks, until they are sent. Send writes the
   batch to the page database at comments/<user id>/sends/<send id> (Claude reads it with ArtifactData) and posts a
   summary with Send to Claude, which wakes the session that published the page: one thread per send, anchored at the
   pull request's title, since the shell cannot anchor inside a card's shadow root. Where the reader cannot send, the
   summary is copied for the chat. */
import type { CanSendToClaude, CapabilityMap, CommentsCap, DbCap, DiffFile, DocRef, Move, PierreAnnotation, PierreLineRange, ReviewComment, Side } from './types';
import { $, $$, copyText, h, store } from '../kit/web/dom';
import { ICON } from '../kit/web/icons';
import { sound } from '../kit/web/sound';
import { toast } from '../kit/web/toast';
import { split } from './dom';
import { type CardState, drawnCards, rebuildOld, redrawNotes, setFold } from './cards';
import { type Ctx, active, ctxOf, ctxs, diffOf, guideOf } from './ctx';
import { choose, jump, toCard, view } from './nav';

const MAX_BYTES = 3900; // a comment holds 4 KiB
const MAX_CODE = 30; // lines of code kept with a line comment
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Under this width the sidebar lies over the page instead of beside it. */
const overlay = matchMedia('(max-width: 1199px)');

/** What a card draws under a line (cards.ts): a moved-code chip, a comment, or the composer of a new one. */
export type Note = { kind: 'move'; mv: Move } | { kind: 'comment'; cm: ReviewComment } | { kind: 'draft'; form: HTMLFormElement };
type Target = Pick<ReviewComment, 'kind' | 'path' | 'start' | 'side' | 'end' | 'endSide'>;

// ---------------------------------------------------------------- the comments
const keyOf = (c: Ctx) => `${c.pr.key}:comments`;
const lists = new Map<Ctx, ReviewComment[]>();
function listOf(c: Ctx) {
  let l = lists.get(c);
  if (!l) {
    const got = store.get<ReviewComment[]>(keyOf(c));
    lists.set(c, l = Array.isArray(got) ? got : []);
  }
  return l;
}
const total = () => ctxs.reduce((n, c) => n + listOf(c).length, 0);
function find(id: string) {
  for (const c of ctxs) { const cm = listOf(c).find((x) => x.id === id); if (cm) return { c, cm }; }
  return null;
}
/** A pull request's comments in reading order: general ones, then by file in the diff's order, each file's own
    comments before its line comments, and those by line. A file the head no longer has comes last. */
function ordered(c: Ctx) {
  const rank = new Map(c.pr.files.map((f, i) => [f.path, i]));
  const at = (cm: ReviewComment) => (cm.kind === 'general' ? -1 : rank.get(cm.path!) ?? c.pr.files.length);
  return [...listOf(c)].sort((a, b) => at(a) - at(b) || (a.kind === 'file' ? -1 : 0) - (b.kind === 'file' ? -1 : 0) || (a.start ?? 0) - (b.start ?? 0));
}

const old = (s?: Side) => (s === 'o' ? ' (old)' : '');
/** "Line 31", "Lines 31–33", "Line 12 (old)", "Lines 30 (old) to 32". */
function lineLabel(t: Target) {
  if (t.side === t.endSide) return t.start === t.end ? `Line ${t.start}${old(t.side)}` : `Lines ${t.start}–${t.end}${old(t.side)}`;
  return `Lines ${t.start}${old(t.side)} to ${t.end}${old(t.endSide)}`;
}
/** Where a comment is, for Claude: "src/a.ts:31-33", "src/a.ts:12 (old)", "src/a.ts (the file)", "General". */
function where(cm: ReviewComment) {
  if (cm.kind === 'general') return 'General';
  if (cm.kind === 'file') return `${cm.path} (the file)`;
  if (cm.side === cm.endSide) return `${cm.path}:${cm.start}${cm.end !== cm.start ? `-${cm.end}` : ''}${old(cm.side)}`;
  return `${cm.path}:${cm.start}${old(cm.side)} to ${cm.end}${old(cm.endSide)}`;
}

/** Every line of a file's hunks, in order, and the index of one line by its number on a side. */
const rowsOf = (f: DiffFile) => f.hunks.flatMap((hk) => hk.lines);
const rowAt = (rows: DiffFile['hunks'][number]['lines'], line: number, s: Side) => rows.findIndex((l) => (s === 'o' ? l[1] : l[2]) === line);
/** The lines a comment is on, as the page shows them. */
function codeOf(f: DiffFile, t: Target): ReviewComment['code'] {
  const rows = rowsOf(f);
  const i = rowAt(rows, t.start!, t.side!), j = rowAt(rows, t.end!, t.endSide!);
  if (i >= 0 && j >= 0) return rows.slice(i, j + 1).slice(0, MAX_CODE).map((l) => [l[0], l[3]]);
  // A line outside the hunks, in a fold the reader opened on the Diff tab: unchanged, so its side's text has it.
  const text = t.side === 'o' ? (f.old ?? rebuildOld(f)) : f.new;
  return text ? text.slice(t.start! - 1, t.end).slice(0, MAX_CODE).map((s) => [' ', s]) : [];
}

/** Store a pull request's comments, show them wherever a file's are drawn, and count them. */
function changed(c: Ctx, paths: (string | undefined)[]) {
  store.set(keyOf(c), listOf(c));
  for (const path of new Set(paths)) {
    if (!path) continue;
    for (const st of drawnCards(c, path)) redrawNotes(st);
    for (const el of $$('.gr-file', c.root)) if (el.dataset.path === path) fileNotes(c, el);
  }
  paintCount();
  paintSide();
}
function add(c: Ctx, t: Target, text: string) {
  const f = t.path ? c.files.get(t.path) : undefined;
  const cm: ReviewComment = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...t, text, head: c.pr.head, at: new Date().toISOString() };
  if (t.kind === 'line' && f) cm.code = codeOf(f, t);
  listOf(c).push(cm);
  changed(c, [t.path]);
  sound.play('select');
}
function remove(id: string) {
  const hit = find(id);
  if (!hit) return;
  lists.set(hit.c, listOf(hit.c).filter((x) => x !== hit.cm));
  changed(hit.c, [hit.cm.path]);
  sound.play('deselect');
}

// ---------------------------------------------------------------- composers
const hint = () => h('span', { class: 'gr-composer-hint' }, h('kbd', {}, MAC ? '⌘' : 'Ctrl'), h('kbd', {}, '↵'));
/** A comment box: Cancel and a submit button, ⌘↵ submits and Escape cancels. */
function composer(o: { label: string; text?: string; submit: string; save(text: string): void; cancel(): void }) {
  const box = h('textarea', { class: 'gr-field', rows: 3, maxlength: 2000, placeholder: 'Leave a comment for Claude', 'aria-label': o.label });
  box.value = o.text ?? '';
  const cancel = h('button', { class: 'k-btn is-ghost is-sm', type: 'button' }, 'Cancel');
  const form = h('form', { class: 'gr-composer', 'data-uncommentable': '' },
    h('div', { class: 'gr-composer-where', text: o.label }), box,
    h('div', { class: 'gr-composer-foot' }, hint(), cancel, h('button', { class: 'k-btn is-primary is-sm', type: 'submit' }, o.submit)));
  form.addEventListener('submit', (e) => { e.preventDefault(); const t = box.value.trim(); if (t) o.save(t); else box.focus(); });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); o.cancel(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  cancel.addEventListener('click', () => o.cancel());
  return form;
}
/** Focus a composer's box at once, so no key typed straight after the click is lost; a box the code has not placed
    yet is focused in the next frame. */
function focusIn(el: Element) {
  const box = () => el.querySelector<HTMLTextAreaElement>('textarea');
  if (el.isConnected) box()?.focus();
  else requestAnimationFrame(() => box()?.focus());
}

// One new line or file comment is open at a time: a line comment's composer is a note of its card, a file comment's
// sits in the card's notes under the header.
let draft: { c: Ctx; form: HTMLFormElement; st?: CardState; note?: PierreAnnotation<Note>; card?: HTMLElement } | null = null;
/** Close the open composer, unless it holds text: then point at it and keep it. Returns whether it is closed. */
function takeDraft() {
  const box = draft?.form.querySelector('textarea');
  if (box?.value.trim()) { box.focus(); toast('Add or cancel the open comment first.'); return false; }
  closeDraft();
  return true;
}
function closeDraft() {
  const d = draft;
  if (!d) return;
  draft = null;
  if (d.st) { d.st.inst?.setSelectedLines(null); redrawNotes(d.st); }
  if (d.card) fileNotes(d.c, d.card);
}

/** The gutter's "+": a composer under the last line picked. */
export function openLine(st: CardState, range: PierreLineRange) {
  if (!takeDraft()) return;
  const toSide = (s?: string): Side => (s === 'deletions' ? 'o' : 'n');
  let a = { line: range.start, side: toSide(range.side) }, b = { line: range.end, side: toSide(range.endSide ?? range.side) };
  // The gutter reports the lines in the order they were dragged; a comment runs down the page.
  const rows = rowsOf(st.f);
  const ia = rowAt(rows, a.line, a.side), ib = rowAt(rows, b.line, b.side);
  if (ia >= 0 && ib >= 0 ? ia > ib : a.side === b.side && a.line > b.line) [a, b] = [b, a];
  const t: Target = { kind: 'line', path: st.f.path, start: a.line, side: a.side, end: b.line, endSide: b.side };
  const c = st.ctx;
  const form = composer({
    label: `Comment on ${lineLabel(t).toLowerCase()}`, submit: 'Add comment',
    save: (text) => { const d = draft; draft = null; d?.st?.inst?.setSelectedLines(null); add(c, t, text); },
    cancel: closeDraft,
  });
  draft = { c, form, st, note: { side: b.side === 'o' ? 'deletions' : 'additions', lineNumber: b.line, metadata: { kind: 'draft', form } } };
  redrawNotes(st);
  // The lines stay highlighted while the comment is written, even where closing an empty composer cleared them.
  st.inst?.setSelectedLines(range);
  focusIn(form);
  sound.play('reveal');
}

/** The speech bubble in a card's header: a composer for the file as a whole. */
function openFile(card: HTMLElement) {
  const c = ctxOf(card);
  const path = card.dataset.path!;
  if (!c || !takeDraft()) return;
  setFold(card, false);
  const t: Target = { kind: 'file', path };
  const form = composer({
    label: `Comment on ${split(path)[0]} as a whole`, submit: 'Add comment',
    save: (text) => { draft = null; add(c, t, text); },
    cancel: closeDraft,
  });
  draft = { c, form, card };
  fileNotes(c, card);
  focusIn(form);
  sound.play('reveal');
}

/** Edit a comment where it is drawn: in a card or in the sidebar. */
function edit(el: HTMLElement, id: string) {
  const hit = find(id);
  if (!hit) return;
  const { c, cm } = hit;
  const inSide = !!el.closest('.gr-side');
  el.replaceChildren(composer({
    label: 'Edit comment', text: cm.text, submit: 'Save',
    save: (text) => {
      cm.text = text;
      cm.at = new Date().toISOString();
      store.set(keyOf(c), listOf(c));
      for (const x of $$(`.gr-note[data-note-id="${id}"]`)) if (x === el || !x.querySelector('form')) paintNote(x, cm);
      paintSide();
    },
    cancel: () => { if (inSide) paintSide(); else paintNote(el, cm); },
  }));
  focusIn(el);
}

// ---------------------------------------------------------------- notes in cards
const notes = new WeakMap<ReviewComment, Note>();
const noteOf = (cm: ReviewComment) => { let n = notes.get(cm); if (!n) notes.set(cm, n = { kind: 'comment', cm }); return n; };
/** The line comments a card shows, under their last line, and the open composer when it is the card's. Only comments
    written on the guide's head: another head's line numbers may name other lines. */
export function commentNotes(st: CardState): PierreAnnotation<Note>[] {
  const out: PierreAnnotation<Note>[] = [];
  const rows = st.whole ? null : st.hunks.flatMap((hk) => hk.lines);
  for (const cm of listOf(st.ctx)) {
    if (cm.kind !== 'line' || cm.path !== st.f.path || cm.head !== st.ctx.pr.head) continue;
    if (rows && rowAt(rows, cm.end!, cm.endSide!) < 0) continue;
    out.push({ side: cm.endSide === 'o' ? 'deletions' : 'additions', lineNumber: cm.end!, metadata: noteOf(cm) });
  }
  if (draft?.st === st && draft.note) out.push(draft.note);
  return out;
}
export const noteEl = (n: Exclude<Note, { kind: 'move' }>) => (n.kind === 'draft' ? n.form : noteCard(n.cm));

function noteCard(cm: ReviewComment) {
  const el = h('div', { class: 'gr-note', 'data-note-id': cm.id });
  paintNote(el, cm);
  return el;
}
function paintNote(el: HTMLElement, cm: ReviewComment) {
  el.replaceChildren(
    h('div', { class: 'gr-note-head' },
      h('span', { class: 'gr-note-what', text: cm.kind === 'line' ? lineLabel(cm) : 'The whole file' }),
      h('span', { class: 'gr-note-pending', text: 'Pending' }),
      h('button', { class: 'k-btn is-ghost is-sm', type: 'button', 'data-note-edit': cm.id }, 'Edit'),
      h('button', { class: 'k-btn is-ghost is-sm is-icon', type: 'button', 'data-note-del': cm.id, 'aria-label': 'Delete comment', title: 'Delete', html: ICON.x })),
    h('p', { class: 'gr-note-text', text: cm.text }));
}
/** A card's file comments, under its header, with the open file composer when it is the card's. */
export function fileNotes(c: Ctx, card: HTMLElement) {
  const box = $('.gr-notes', card);
  if (!box) return;
  const path = card.dataset.path;
  const kids: HTMLElement[] = listOf(c).filter((cm) => cm.kind === 'file' && cm.path === path).map(noteCard);
  if (draft?.card === card) kids.push(draft.form);
  if (!kids.length && box.hidden) return;
  box.replaceChildren(...kids);
  box.hidden = !kids.length;
}

// ---------------------------------------------------------------- the sidebar
const side = () => document.getElementById('gr-side');
export const sideOpen = () => document.body.classList.contains('gr-side-open');
let parts: { list: HTMLElement; general: HTMLTextAreaElement; meta: HTMLElement; send: HTMLButtonElement; why: HTMLElement } | null = null;

function build(aside: HTMLElement) {
  const general = h('textarea', { class: 'gr-field', rows: 2, maxlength: 2000, 'aria-label': 'A general comment' });
  general.value = store.get<string>('gr:comments-general') ?? '';
  general.placeholder = ctxs.length > 1 ? 'Comment on the pull request on screen as a whole' : 'Comment on the pull request as a whole';
  general.addEventListener('input', () => store.set('gr:comments-general', general.value));
  const form = h('form', { class: 'gr-side-general' }, general,
    h('div', { class: 'gr-composer-foot' }, hint(), h('button', { class: 'k-btn is-sm', type: 'submit' }, 'Add')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = general.value.trim();
    if (!text) { general.focus(); return; }
    general.value = '';
    store.set('gr:comments-general', '');
    add(active(), { kind: 'general' }, text);
  });
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } });
  parts = {
    list: h('div', { class: 'gr-side-list' }), general, meta: h('span', { class: 'gr-side-meta' }),
    send: h('button', { class: 'k-btn is-primary', type: 'button', 'data-note-send': '' }), why: h('p', { class: 'gr-side-why', hidden: true }),
  };
  aside.append(
    h('header', { class: 'gr-side-head' }, h('b', {}, 'Comments'), parts.meta,
      h('button', { class: 'k-btn is-ghost is-icon is-sm', type: 'button', 'data-side-close': '', 'aria-label': 'Close comments', title: 'Close', html: ICON.x })),
    h('div', { class: 'gr-side-body' }, form, parts.list),
    h('footer', { class: 'gr-side-foot' }, parts.why, parts.send));
}

/** Open or close the sidebar. Returns whether the page has one. */
export function toggleSide(open = !sideOpen()) {
  const aside = side();
  if (!aside) return false;
  if (open && !parts) build(aside);
  document.body.classList.toggle('gr-side-open', open);
  aside.hidden = !open;
  for (const b of $$('[data-side-toggle]')) b.setAttribute('aria-expanded', String(open));
  store.set('gr:comments-open', open);
  if (open) { paintSide(); void refreshCanSend(); }
  return true;
}

function sideItem(c: Ctx, cm: ReviewComment) {
  const stale = cm.head !== c.pr.head;
  const go = cm.kind === 'general' ? null : h('button', { class: 'gr-side-go', type: 'button', 'data-note-go': cm.id, title: 'Show it in the code' }, cm.kind === 'line' ? lineLabel(cm) : 'The whole file');
  return h('article', { class: 'gr-side-item', 'data-note-id': cm.id },
    go || stale ? h('div', { class: 'gr-side-where' }, go, stale ? h('span', { class: 'gr-side-stale', text: `on ${cm.head.slice(0, 7)}, an older commit` }) : null) : null,
    cm.code?.length ? h('pre', { class: 'gr-side-code' }, ...cm.code.slice(0, 4).map(([op, s]) => h('span', { class: op === '+' ? 'add' : op === '-' ? 'del' : '', text: `${op === ' ' ? ' ' : op === '-' ? '−' : '+'} ${s}` })),
      cm.code.length > 4 ? h('span', { class: 'more', text: `${cm.code.length - 4} more lines` }) : null) : null,
    h('p', { class: 'gr-note-text', text: cm.text }),
    h('div', { class: 'gr-side-acts' },
      h('button', { class: 'k-btn is-ghost is-sm', type: 'button', 'data-note-edit': cm.id }, 'Edit'),
      h('button', { class: 'k-btn is-ghost is-sm', type: 'button', 'data-note-del': cm.id }, 'Delete')));
}
interface Sent { at: string; items: { key: string; list: ReviewComment[] }[] }
function paintSide() {
  if (!parts || !sideOpen()) return;
  const n = total();
  const groups: HTMLElement[] = [];
  for (const c of ctxs) {
    const list = ordered(c);
    if (!list.length) continue;
    if (ctxs.length > 1) groups.push(h('h3', { class: 'gr-side-pr' }, c.pr.number != null ? h('span', { class: 'n', text: `#${c.pr.number}` }) : null, ` ${c.pr.title}`));
    let at: string | null | undefined;
    for (const cm of list) {
      const key = cm.kind === 'general' ? null : cm.path;
      if (key !== at) {
        at = key;
        const [name, dir] = key ? split(key) : ['General', ''];
        groups.push(h('h4', { class: 'gr-side-file', title: key ?? '' }, h('span', { class: 'name', text: name }), dir ? h('span', { class: 'dir', text: dir }) : null));
      }
      groups.push(sideItem(c, cm));
    }
  }
  if (!groups.length) {
    const last = store.get<Sent>('gr:comments-sent');
    const k = last?.items.reduce((s, x) => s + x.list.length, 0) ?? 0;
    groups.push(h('div', { class: 'gr-side-empty' },
      h('p', { class: 'lead', text: 'No comments yet.' }),
      h('p', {}, 'Hover a line and press ', h('b', {}, '+'), '. For a block of lines, click a line number, Shift-click another, and press ', h('b', {}, '+'), ', or drag the ', h('b', {}, '+'), ' over them. The speech bubble in a file’s header comments on the whole file; the box above, on the whole pull request. Send them to Claude together when you are done.'),
      k ? h('button', { class: 'k-btn is-sm', type: 'button', 'data-note-restore': '' }, `Bring back the ${k} sent at ${new Date(last!.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`) : null));
  }
  parts.list.replaceChildren(...groups);
  parts.meta.textContent = n ? `${n} pending` : '';
  parts.send.textContent = n ? `Send ${plural(n)} to Claude` : 'Send to Claude';
  parts.send.disabled = !n;
  paintWhy();
}
function paintWhy() {
  if (!parts) return;
  parts.why.hidden = canSend === 'available' || !total();
  parts.why.textContent = canSend === 'writers_only' ? 'Only the page’s editors can send to Claude, so Send copies your comments to paste in your chat.'
    : canSend === 'no_session' ? 'No Claude session is watching this page, so Send copies your comments to paste in your chat.'
    : 'Send copies your comments, to paste in your chat with Claude.';
}
/** The count on the bar's Comments button. */
function paintCount() {
  const n = total();
  for (const b of $$('[data-side-toggle]')) {
    const badge = $('.gr-note-count', b);
    if (badge) { badge.textContent = String(n); badge.hidden = !n; }
    b.setAttribute('aria-label', n ? `Comments, ${n} pending` : 'Comments');
  }
}

/** A comment's place in the code: its line in a card, or its file's card, on the tab the reader is on. */
function go(id: string) {
  const hit = find(id);
  if (!hit) return;
  const { c, cm } = hit;
  if (c !== active()) choose(c);
  if (overlay.matches) toggleSide(false);
  const inDiff = view() === 'diff';
  if (cm.kind === 'line' && cm.head === c.pr.head) void jump(c, cm.path!, cm.end!, cm.endSide!, null, inDiff ? diffOf(c) : null);
  else toCard(c, cm.path!, inDiff ? diffOf(c) : guideOf(c));
  sound.play('nav');
}

/** Put the last batch sent back on the page. */
function restore() {
  const last = store.get<Sent>('gr:comments-sent');
  store.set('gr:comments-sent', null);
  for (const it of last?.items ?? []) {
    const c = ctxs.find((x) => x.pr.key === it.key);
    if (!c) continue;
    const have = new Set(listOf(c).map((x) => x.id));
    listOf(c).push(...it.list.filter((x) => !have.has(x.id)));
    changed(c, it.list.map((x) => x.path));
  }
  sound.play('reveal');
}

// ---------------------------------------------------------------- send
let comments: CommentsCap | null = null, db: DbCap | null = null, uid: string | null = null, canSend: CanSendToClaude = 'off';
const use = <K extends keyof CapabilityMap>(n: K) => window.claude?.use(n).catch(() => null) ?? Promise.resolve(null);
async function refreshCanSend() {
  canSend = comments ? await comments.canSendToClaude().catch(() => 'off' as const) : 'off';
  paintWhy();
}

type Batch = { c: Ctx; list: ReviewComment[] }[];
const plural = (n: number) => `${n} comment${n === 1 ? '' : 's'}`;
const prName = (c: Ctx) => `${c.pr.number != null ? `#${c.pr.number} ` : ''}${c.pr.title}, at ${c.pr.head.slice(0, 7)}`;
/** The text Claude is sent: each comment's place, a few of its lines of code, and its words, numbered in reading
    order. Within `limit` bytes it drops the code first, then the comments that do not fit, and says where the rest
    are: in the page database at `ref`, or still on the page. Returns the comments it holds. */
function summary(batch: Batch, limit: number, ref: string | null) {
  const n = batch.reduce((s, b) => s + b.list.length, 0);
  const enc = new TextEncoder();
  const size = (s: string) => enc.encode(s).length;
  const top = batch.length === 1 ? `Review comments on ${prName(batch[0].c)}: ${plural(n)}` : `Review comments on ${batch.length} pull requests: ${plural(n)}`;
  const item = (c: Ctx, cm: ReviewComment, i: number, code: boolean) => {
    const lines = [`${i}. ${where(cm)}${cm.head !== c.pr.head ? `, written on ${cm.head.slice(0, 7)}` : ''}`];
    if (code) for (const [op, s] of cm.code?.slice(0, 3) ?? []) lines.push(`   | ${op} ${s}`);
    for (const t of cm.text.split('\n')) lines.push(`   ${t}`);
    return lines.join('\n');
  };
  const foot = (rest: number) => rest
    ? (ref ? `\n\n${plural(rest)} more did not fit here. Every comment, with its code: ${ref} in the page database.` : `\n\n${plural(rest)} more did not fit, and stay on the page.`)
    : (ref ? `\n\nEvery comment, with its code: ${ref} in the page database.` : '');
  const compose = (code: boolean, room: number) => {
    let text = top, i = 0;
    const held = new Set<ReviewComment>();
    for (const { c, list } of batch) {
      let head = batch.length > 1 ? `\n\n${prName(c)}` : '';
      for (const cm of list) {
        const block = `${head}\n\n${item(c, cm, i + 1, code)}`;
        if (size(text + block) > room) return { text, held };
        text += block;
        head = '';
        i++;
        held.add(cm);
      }
    }
    return { text, held };
  };
  for (const code of [true, false]) {
    const all = compose(code, Infinity);
    if (size(all.text + foot(0)) <= limit) return { text: all.text + foot(0), held: all.held };
  }
  const some = compose(false, limit - size(foot(n)));
  return { text: some.text + foot(n - some.held.size), held: some.held };
}

/** Take the comments sent off the page, and keep the batch to bring back. */
function sent(batch: Batch, held: Set<ReviewComment> | null, msg: string) {
  const items: Sent['items'] = batch.map(({ c, list }) => ({ key: c.pr.key, list: held ? list.filter((cm) => held.has(cm)) : list }));
  store.set('gr:comments-sent', { at: new Date().toISOString(), items });
  for (const [i, { c }] of batch.entries()) {
    const gone = items[i].list;
    lists.set(c, listOf(c).filter((cm) => !gone.includes(cm)));
    changed(c, gone.map((cm) => cm.path));
  }
  sound.play('send');
  toast(msg);
}

// Send never makes the reader wait on the page: the database write and the send run together, and a failure keeps
// every comment where it was. The button stays off while a send is out (the first may wait on a consent prompt), so
// one batch never opens two threads.
let sending = false;
async function send() {
  const batch: Batch = ctxs.map((c) => ({ c, list: ordered(c) })).filter((b) => b.list.length);
  const n = batch.reduce((s, b) => s + b.list.length, 0);
  if (!n || sending) return;
  if (canSend === 'available' && comments) {
    sending = true;
    if (parts) parts.send.disabled = true;
    try { await sendToClaude(batch, n, comments); } finally { sending = false; paintSide(); }
    return;
  }
  // Still inside the click, so the clipboard allows it.
  const { text } = summary(batch, Infinity, null);
  copyText('# ' + text).then(
    () => sent(batch, null, 'Copied. Paste it in your chat with Claude.'),
    () => toast('Copy failed. Your comments are still here; try again.'),
  );
}
async function sendToClaude(batch: Batch, n: number, cap: CommentsCap) {
  let doc: DocRef | null = null;
  try { if (db && uid) doc = db.doc(`comments/${uid}/sends/s${Date.now().toString(36)}`); } catch { /* a path the database refuses: send the text alone */ }
  const { text, held } = summary(batch, MAX_BYTES, doc?.path ?? null);
  const data = { sentAt: new Date().toISOString(), prs: batch.map(({ c, list }) => ({ number: c.pr.number, title: c.pr.title, head: c.pr.head, comments: list })) };
  toast('Sending…');
  const anchor = $('.gr-head h1', active().root) ?? document.body;
  const [wrote, posted] = await Promise.allSettled([
    doc ? doc.set(data) : Promise.reject(new Error('no database')),
    cap.anchorFor(anchor).then((a) => cap.sendToClaude({ anchor: a, text })),
  ]);
  if (posted.status === 'rejected') {
    const code = (posted.reason as { code?: string })?.code;
    if (code === 'consent_required') return toast('Not sent. Allow comments from this page to send them to Claude.');
    if (code === 'rate_limited') return toast('Too many sends. Wait a moment and try again.');
    canSend = 'off';
    paintWhy();
    return toast('Could not reach Claude. Press Send again to copy your comments instead.');
  }
  // Without the database, the comments that did not fit in the text stay on the page for the next send.
  const all = wrote.status === 'fulfilled' || held.size === n;
  sent(batch, all ? null : held, all ? 'Sent. Claude will reply in the comment thread.' : `Sent ${held.size} of ${n}. Send again for the rest.`);
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const t = (e.target as Element).closest<HTMLElement>('button');
  if (!t) return;
  if (t.hasAttribute('data-side-toggle')) { if (toggleSide()) sound.play('toggle'); }
  else if (t.hasAttribute('data-side-close')) { toggleSide(false); $('[data-side-toggle]')?.focus(); }
  else if (t.hasAttribute('data-note-file')) openFile(t.closest<HTMLElement>('.gr-file')!);
  else if (t.dataset.noteEdit) edit(t.closest<HTMLElement>('[data-note-id]')!, t.dataset.noteEdit);
  else if (t.dataset.noteDel) remove(t.dataset.noteDel);
  else if (t.dataset.noteGo) go(t.dataset.noteGo);
  else if (t.hasAttribute('data-note-send')) void send();
  else if (t.hasAttribute('data-note-restore')) restore();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !sideOpen() || !side()?.contains(document.activeElement)) return;
  toggleSide(false);
  $('[data-side-toggle]')?.focus();
});

/** At start: the count, the sidebar as the reader left it, and the capabilities that send. */
export function startComments() {
  paintCount();
  if (store.get<boolean>('gr:comments-open')) toggleSide(true);
  if (!window.claude) return;
  void (async () => {
    const [d, user, c] = await Promise.all([use('db'), use('user'), use('comments')]);
    comments = c;
    await refreshCanSend();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshCanSend(); });
    if (!d || !user || (await user.can('data.write')) === false) return;
    uid = await user.id();
    if (uid) db = d;
  })();
}

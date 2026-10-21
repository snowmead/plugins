/* Review marks and the Diff tab's file tree, for each pull request on the page. Ticking a chapter or a file folds it
   and counts toward "3 of 6 chapters reviewed". Marks stay in the reader's browser, kept per pull request, so they
   carry over to a rebuilt guide and to every page that shows the same pull request.

   A card's mark is kept by chapter and path, so ticking one chapter leaves the same file's other hunks unread in
   another. The Diff tab's card stands for the whole file: it reads and writes the marks of every chapter that holds
   part of it. */
import { $$, esc, store } from '../kit/web/dom';
import { split, stat } from './dom';
import { type Ctx, active, diffOf } from './ctx';
import { chipOf, setFold } from './cards';
import { libs } from './libs';
import { toCard } from './nav';

export const saveMarks = (c: Ctx) => store.set(c.pr.key, c.marks);
const markOf = (chapter: string | null, path: string) => (chapter ? `${chapter}:${path}` : path);
const cardChapters = (c: Ctx, chapter: string | null, path: string): (string | null)[] => (chapter ? [chapter] : c.holders.get(path) ?? [null]);
export const fileDone = (c: Ctx, path: string, chapter: string | null = null) => cardChapters(c, chapter, path).every((id) => c.marks.f[markOf(id, path)]);

/** A file's marks on its cards, file lists and tree. A card folds when its mark turns on and opens when it turns off. */
export function showFile(c: Ctx, path: string) {
  for (const box of $$<HTMLInputElement>('input[data-review-file]', c.root)) {
    if (box.dataset.reviewFile !== path) continue;
    const on = fileDone(c, path, box.dataset.reviewCh || null);
    box.checked = on;
    if ((box.dataset.on === '1') !== on) setFold(box.closest('.gr-card'), on);
    box.dataset.on = on ? '1' : '';
  }
  for (const b of $$('.gr-filelist [data-goto]', c.root)) {
    if (b.dataset.goto === path) b.parentElement!.classList.toggle('done', fileDone(c, path, b.closest<HTMLElement>('.gr-sec')?.dataset.chapter ?? null));
  }
  refreshTree(c);
}
export function markFile(c: Ctx, chapter: string | null, path: string, on: boolean) {
  for (const id of cardChapters(c, chapter, path)) {
    if (on) c.marks.f[markOf(id, path)] = 1;
    else {
      delete c.marks.f[markOf(id, path)];
      // A chapter is no longer reviewed once one of its files is unticked.
      if (id && c.marks.c[id]) chapterBox(c, id, false);
    }
  }
  showFile(c, path);
}
function chapterBox(c: Ctx, id: string, on: boolean) {
  if (on) c.marks.c[id] = 1; else delete c.marks.c[id];
  const box = c.root.querySelector<HTMLInputElement>(`input[data-review-chapter="${CSS.escape(id)}"]`);
  if (box) box.checked = on;
  progress(c);
}
export function markChapter(c: Ctx, id: string, on: boolean) {
  chapterBox(c, id, on);
  for (const f of c.pr.chapters.find((ch) => ch.id === id)?.files ?? []) markFile(c, id, f.path, on);
}
/** The chapter boxes, ticked from the stored marks (once the guide's cards exist). */
export function restoreChapters(c: Ctx) {
  for (const id of Object.keys(c.marks.c)) { const box = c.root.querySelector<HTMLInputElement>(`input[data-review-chapter="${CSS.escape(id)}"]`); if (box) box.checked = true; }
}
/** How many of a pull request's chapters are reviewed: in the bar, in every picker, and on the rail when it is on
    screen. Returns the count. */
export function progress(c: Ctx) {
  const done = c.pr.chapters.filter((ch) => c.marks.c[ch.id]).length;
  const total = c.pr.chapters.length;
  for (const el of $$(`.gr-progress[data-pr="${c.pr.id}"]`)) el.innerHTML = `<b>${done}</b> of ${total} chapters reviewed`;
  for (const el of $$(`[data-progress-of="${c.pr.id}"]`)) { el.textContent = `${done}/${total}`; el.classList.toggle('all', done === total); }
  if (c === active()) for (const b of $$('.gr-rail button')) b.classList.toggle('done', !!c.marks.c[b.dataset.chapter ?? '']);
  return done;
}

// ---------------------------------------------------------------- the Diff tab's tree
const STATUS: Record<string, string> = { added: 'added', deleted: 'deleted', renamed: 'renamed', copied: 'added', modified: 'modified' };
export async function buildTree(c: Ctx, host: HTMLElement) {
  const { trees } = await libs;
  if (!trees) { host.replaceWith(fallbackList(c)); return; }
  const goto = (path?: string) => { if (path && c.files.has(path)) toCard(c, path, diffOf(c)); };
  c.tree = new trees.FileTree({
    paths: c.pr.files.map((f) => f.path).sort((x, y) => x.localeCompare(y)),
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    density: 'compact',
    gitStatus: c.pr.files.map((f) => ({ path: f.path, status: STATUS[f.status] ?? 'modified' })),
    renderRowDecoration: ({ item }) => {
      const f = c.files.get(item.path);
      if (!f) return null;
      // A flex row drops a part's leading space, so the gaps are no-break spaces.
      const parts: { text: string; color: string }[] = [];
      if (fileDone(c, f.path)) parts.push({ text: '✓', color: 'var(--accent)' });
      if (f.add) parts.push({ text: `+${f.add}`, color: 'var(--add-fg)' });
      if (f.del) parts.push({ text: `−${f.del}`, color: 'var(--del-fg)' });
      parts.forEach((p, i) => { if (i) p.text = ` ${p.text}`; });
      return { text: parts.map((p) => p.text).join(''), title: `${fileDone(c, f.path) ? 'Reviewed. ' : ''}${f.add} added, ${f.del} removed lines`, parts };
    },
    onSelectionChange: (paths) => goto(paths[paths.length - 1]),
    // The counts stay whole; a long name gives way first.
    unsafeCSS: '[data-item-section="decoration"] { flex: 1 0 auto; font-size: 11.5px; font-variant-numeric: tabular-nums; }',
  });
  c.tree.render({ fileTreeContainer: host });
  // A click on the row already selected still goes to its file.
  host.addEventListener('click', (e) => goto(e.composedPath().map((n) => (n as HTMLElement).dataset?.itemPath).find(Boolean)));
}
/** Redraws the rows so their review marks follow. setGitStatus skips a status that has not changed, and the tree
    takes no composition, so setting none again is the plain redraw. */
const refreshTree = (c: Ctx) => c.tree?.setComposition(undefined);
function fallbackList(c: Ctx) {
  const list = document.createElement('ul');
  list.className = 'gr-filelist';
  for (const f of [...c.pr.files].sort((x, y) => x.path.localeCompare(y.path))) {
    const [name, dir] = split(f.path);
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" data-goto="${esc(f.path)}" data-in="diff"><span class="gr-lang">${esc(chipOf(f))}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span><span class="stat">${stat(f.add, f.del)}</span></button>`;
    li.classList.toggle('done', fileDone(c, f.path));
    list.append(li);
  }
  return list;
}

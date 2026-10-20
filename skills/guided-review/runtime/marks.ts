/* Review marks and the Diff tab's file tree. Ticking a chapter or a file folds it and counts toward "3 of 6 chapters
   reviewed". Marks stay in the reader's browser, kept per pull request, so they carry over to a rebuilt guide.

   A card's mark is kept by chapter and path, so ticking one chapter leaves the same file's other hunks unread in
   another. The Diff tab's card stands for the whole file: it reads and writes the marks of every chapter that holds
   part of it. */
import type { PierreFileTree } from './types';
import { $, $$, D, FILES, esc, split, stat, store } from './dom';
import { chipOf, setFold } from './cards';
import { libs } from './libs';
import { toCard } from './nav';

type Marks = { c: Record<string, 1>; f: Record<string, 1> };
const marks: Marks = { c: {}, f: {}, ...store.get<Marks>(D.key) };
export const getMarks = () => marks;
export const saveMarks = () => store.set(D.key, marks);

const markOf = (chapter: string | null, path: string) => (chapter ? `${chapter}:${path}` : path);
const holders = new Map<string, string[]>();
for (const c of D.chapters) for (const f of c.files) holders.set(f.path, [...(holders.get(f.path) ?? []), c.id]);
const cardChapters = (chapter: string | null, path: string): (string | null)[] => (chapter ? [chapter] : holders.get(path) ?? [null]);
export const fileDone = (path: string, chapter: string | null = null) => cardChapters(chapter, path).every((id) => marks.f[markOf(id, path)]);

/** A file's marks on its cards, file lists and tree. A card folds when its mark turns on and opens when it turns off. */
export function showFile(path: string) {
  for (const box of $$<HTMLInputElement>('input[data-review-file]')) {
    if (box.dataset.reviewFile !== path) continue;
    const on = fileDone(path, box.dataset.reviewCh || null);
    box.checked = on;
    if ((box.dataset.on === '1') !== on) setFold(box.closest('.gr-card'), on);
    box.dataset.on = on ? '1' : '';
  }
  for (const b of $$('.gr-filelist [data-goto]')) {
    if (b.dataset.goto === path) b.parentElement!.classList.toggle('done', fileDone(path, b.closest<HTMLElement>('.gr-sec')?.dataset.chapter ?? null));
  }
  tree.refresh();
}
export function markFile(chapter: string | null, path: string, on: boolean) {
  for (const id of cardChapters(chapter, path)) {
    if (on) marks.f[markOf(id, path)] = 1;
    else {
      delete marks.f[markOf(id, path)];
      // A chapter is no longer reviewed once one of its files is unticked.
      if (id && marks.c[id]) chapterBox(id, false);
    }
  }
  showFile(path);
}
function chapterBox(id: string, on: boolean) {
  if (on) marks.c[id] = 1; else delete marks.c[id];
  const box = $<HTMLInputElement>(`input[data-review-chapter="${CSS.escape(id)}"]`);
  if (box) box.checked = on;
  progress();
}
export function markChapter(id: string, on: boolean) {
  chapterBox(id, on);
  for (const f of D.chapters.find((c) => c.id === id)?.files ?? []) markFile(id, f.path, on);
}
/** How many chapters are reviewed, on the bar and the rail. */
export function progress() {
  const done = D.chapters.filter((c) => marks.c[c.id]).length;
  const el = $('#gr-progress');
  if (el) el.innerHTML = `<b>${done}</b> of ${D.chapters.length} chapters reviewed`;
  for (const b of $$('.gr-rail button')) b.classList.toggle('done', !!marks.c[b.dataset.chapter ?? '']);
  return done;
}

// ---------------------------------------------------------------- the Diff tab's tree
const STATUS: Record<string, string> = { added: 'added', deleted: 'deleted', renamed: 'renamed', copied: 'added', modified: 'modified' };
export const tree = {
  model: null as PierreFileTree | null,
  async build(host: HTMLElement) {
    const { trees } = await libs;
    if (!trees) { host.replaceWith(fallbackList()); return; }
    const goto = (path?: string) => { if (path && FILES.has(path)) toCard(path, $('#gr-diff')); };
    this.model = new trees.FileTree({
      paths: D.files.map((f) => f.path).sort((x, y) => x.localeCompare(y)),
      initialExpansion: 'open',
      flattenEmptyDirectories: true,
      density: 'compact',
      gitStatus: D.files.map((f) => ({ path: f.path, status: STATUS[f.status] ?? 'modified' })),
      renderRowDecoration: ({ item }) => {
        const f = FILES.get(item.path);
        if (!f) return null;
        // A flex row drops a part's leading space, so the gaps are no-break spaces.
        const parts: { text: string; color: string }[] = [];
        if (fileDone(f.path)) parts.push({ text: '✓', color: 'var(--accent)' });
        if (f.add) parts.push({ text: `+${f.add}`, color: 'var(--add-fg)' });
        if (f.del) parts.push({ text: `−${f.del}`, color: 'var(--del-fg)' });
        parts.forEach((p, i) => { if (i) p.text = ` ${p.text}`; });
        return { text: parts.map((p) => p.text).join(''), title: `${fileDone(f.path) ? 'Reviewed. ' : ''}${f.add} added, ${f.del} removed lines`, parts };
      },
      onSelectionChange: (paths) => goto(paths[paths.length - 1]),
      // The counts stay whole; a long name gives way first.
      unsafeCSS: '[data-item-section="decoration"] { flex: 1 0 auto; font-size: 11.5px; font-variant-numeric: tabular-nums; }',
    });
    this.model.render({ fileTreeContainer: host });
    // A click on the row already selected still goes to its file.
    host.addEventListener('click', (e) => goto(e.composedPath().map((n) => (n as HTMLElement).dataset?.itemPath).find(Boolean)));
  },
  /** Redraws the rows so their review marks follow. setGitStatus skips a status that has not changed, and the tree
      takes no composition, so setting none again is the plain redraw. */
  refresh() { this.model?.setComposition(undefined); },
};
function fallbackList() {
  const list = document.createElement('ul');
  list.className = 'gr-filelist';
  for (const f of [...D.files].sort((x, y) => x.path.localeCompare(y.path))) {
    const [name, dir] = split(f.path);
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" data-goto="${esc(f.path)}" data-in="diff"><span class="gr-lang">${esc(chipOf(f))}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span><span class="stat">${stat(f.add, f.del)}</span></button>`;
    li.classList.toggle('done', fileDone(f.path));
    list.append(li);
  }
  return list;
}

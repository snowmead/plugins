/* Hunk arithmetic, with no page state: the runtime draws cards with it, and build.ts rebuilds a Markdown file's old
   text with it to render the file as it was. */
import type { DiffFile, Hunk } from './types';

// "+N,0" names the line after which nothing is added.
export const nextNew = (h: Hunk) => (h.newLines === 0 ? h.newStart + 1 : h.newStart + h.newLines);
export const firstNew = (h: Hunk) => (h.newLines === 0 ? h.newStart + 1 : h.newStart);
export const firstOld = (h: Hunk) => (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart);

/** The old text of a changed file: the new text with each hunk put back. */
export function rebuildOld(f: DiffFile): string[] | null {
  if (!f.new) return null;
  const out: string[] = [];
  let pos = 1;
  for (const h of f.hunks) {
    while (pos < firstNew(h)) out.push(f.new[pos++ - 1]);
    for (const l of h.lines) if (l[0] !== '+') out.push(l[3]);
    pos = nextNew(h);
  }
  while (pos <= f.new.length) out.push(f.new[pos++ - 1]);
  return f.oldCount == null || out.length === f.oldCount ? out : null;
}

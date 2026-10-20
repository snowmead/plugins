/* One pull request's slice of the page. A page holds one or several; the reader looks at one at a time, picked in the
   title's menu. Each keeps its own panel (header, guide, diff, footer), its files, its review marks and its file tree,
   and every element id inside its panel starts with its prefix ("pr42-"), so two guides' chapter ids never meet. */
import type { DiffFile, PagePr, PierreFileTree } from './types';
import { D, store } from './dom';

export type Marks = { c: Record<string, 1>; f: Record<string, 1> };
export interface Ctx {
  pr: PagePr;
  /** The PR's panel, .gr-pr[data-pr]. */
  root: HTMLElement;
  files: Map<string, DiffFile>;
  /** The chapters that hold part of each file. */
  holders: Map<string, string[]>;
  marks: Marks;
  tree: PierreFileTree | null;
  guideDone: boolean;
  diffDone: boolean;
}

export const ctxs: Ctx[] = D.prs.map((pr) => {
  const holders = new Map<string, string[]>();
  for (const c of pr.chapters) for (const f of c.files) holders.set(f.path, [...(holders.get(f.path) ?? []), c.id]);
  return {
    pr, root: document.querySelector<HTMLElement>(`.gr-pr[data-pr="${pr.id}"]`)!,
    files: new Map(pr.files.map((f) => [f.path, f])), holders,
    marks: { c: {}, f: {}, ...store.get<Marks>(pr.key) }, tree: null, guideDone: false, diffDone: false,
  };
});

let current = ctxs[0];
/** The pull request on screen. */
export const active = () => current;
export const setActive = (c: Ctx) => { current = c; };
/** The pull request an element belongs to: the one whose panel holds it. */
export const ctxOf = (el: Element | null) => {
  const root = el?.closest('.gr-pr');
  return root ? ctxs.find((c) => c.root === root) ?? null : null;
};
export const byId = (id: string) => ctxs.find((c) => c.pr.id === id) ?? null;
/** An element of a pull request by its id inside the panel, the prefix added. */
export const byOwnId = (c: Ctx, id: string) => document.getElementById(c.pr.prefix + id);
export const guideOf = (c: Ctx) => c.root.querySelector<HTMLElement>('.gr-guide')!;
export const diffOf = (c: Ctx) => c.root.querySelector<HTMLElement>('.gr-diff')!;

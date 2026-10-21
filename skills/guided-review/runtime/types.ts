/* Shared types: diff.json (gather.ts writes it), guide.json (the agent writes it), the data build.ts embeds in the
   page, and the slice of @pierre/diffs, @pierre/trees and mermaid the runtime calls. */
import type { ThemeType } from '../kit/web/types';

// ---------------------------------------------------------------- diff.json
export type Kind = 'core' | 'docs' | 'database' | 'tests' | 'generated';
export type Status = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
/** One diff line: op, old line number, new line number, text. */
export type Line = [op: ' ' | '-' | '+', old: number | null, new: number | null, text: string];
export interface Hunk {
  id: number;
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  header: string;
  /** The function, type or section the hunk sits in. */
  label: string;
  /** Lines that open the scopes above the hunk, outermost first. */
  scope: number[];
  lines: Line[];
}
/** A block of removed lines that comes back as added lines elsewhere, seen from one end. */
export interface Move { side: '-' | '+'; from: number; to: number; other: string; otherFrom: number; otherTo: number; lines: number }
export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: Status;
  kind: Kind;
  lang: string;
  binary: boolean;
  add: number;
  del: number;
  /** Full old text, kept only for a deleted file (the page rebuilds it otherwise). */
  old: string[] | null;
  /** Full new text, when small enough and not generated. */
  new: string[] | null;
  oldCount: number | null;
  newCount: number | null;
  hunks: Hunk[];
  moves: Move[];
}
export interface Commit { sha: string; author: string; subject: string }
export interface Diff {
  version: 1;
  repo: string;
  base: string;
  head: string;
  baseRef: string;
  branch: string | null;
  commits: Commit[];
  files: DiffFile[];
}

// ---------------------------------------------------------------- guide.json
export type Text = string | string[];
export interface BeforeAfterLine { t: string; op?: ' ' | '-' | '+'; d?: number; note?: string; ref?: string; ch?: string }
export interface BeforeAfter { label?: string; title?: string; lines?: BeforeAfterLine[]; flow?: string }
export interface StateTable {
  title?: string;
  caption?: string;
  ref?: string;
  columns: string[];
  rows: (string[] | { cells: string[]; new?: boolean; gone?: boolean })[];
  note?: string;
}
export type FileSel = string | { path: string; hunks?: number[] };
export interface Chapter {
  id: string;
  title: string;
  kind?: Kind;
  body: Text;
  files: FileSel[];
  table?: StateTable;
  beforeAfter?: BeforeAfter;
}
export type DiffStyle = 'unified' | 'split';
export interface Guide {
  pr: { number?: number; title: string; url?: string; author?: string; base?: string; head?: string };
  /** The page's name in the browser tab and the artifact gallery, 2 to 4 words. */
  name?: string;
  /** How code cards show a change at first: one column, or old and new side by side. Each reader can switch. */
  diffStyle?: DiffStyle;
  links?: { label: string; href: string }[];
  overview: { summary: Text; steps?: string[]; beforeAfter: BeforeAfter };
  chapters: Chapter[];
}

// ---------------------------------------------------------------- stack.json
/** Several pull requests on one page, in the order the picker lists them: a stack from its base up. Paths are
    relative to this file. */
export interface Stack {
  /** The page's name in the browser tab and the artifact gallery, 2 to 4 words. */
  name?: string;
  diffStyle?: DiffStyle;
  prs: { guide: string; diff: string }[];
}

// ---------------------------------------------------------------- the page's data (window.GR_DATA)
export interface PageChapter { id: string; title: string; files: { path: string; hunks: number[] | null }[] }
export interface PagePr {
  /** The PR's panel id ("pr42"), and the prefix of every element id inside it: "pr42-", or "" on a page with one PR. */
  id: string;
  prefix: string;
  /** Where review marks are kept: by pull request, not head, so they carry over to a rebuilt guide. */
  key: string;
  number: number | null;
  title: string;
  chapters: PageChapter[];
  files: DiffFile[];
}
export interface PageData {
  libs: Record<'diffs' | 'trees', string>;
  diffStyle: DiffStyle;
  prs: PagePr[];
}

declare global {
  interface Window {
    /** Set by the page's data file, which loads before the runtime. */
    GR_DATA?: PageData;
  }
}

// ---------------------------------------------------------------- the library slices the runtime uses
export interface PierreHunkSeparator { hunkIndex: number; lines: number; lineCountKnown?: boolean; expandable?: boolean }
export interface PierreAnnotation<T> { side: 'additions' | 'deletions'; lineNumber: number; metadata: T }
export interface PierreFileDiffMeta { isPartial: boolean }
export interface PierreFileDiff {
  setOptions(o: Record<string, unknown>): void;
  rerender(): void;
  render(o: { fileDiff: PierreFileDiffMeta; containerWrapper: HTMLElement; lineAnnotations?: PierreAnnotation<Move>[] }): void;
  setThemeType(t: ThemeType): void;
  expandHunk(index: number, direction: 'up' | 'down' | 'both', lines?: number): void;
  setSelectedLines(range: { start: number; end: number; side: 'additions' | 'deletions' } | null): void;
}
export interface PierreDiffs {
  parsePatchFiles(patch: string): { files: PierreFileDiffMeta[] }[];
  hydratePartialDiff(mode: 'mutate', fd: PierreFileDiffMeta, files: { oldFile: { name: string; contents: string }; newFile: { name: string; contents: string } }): void;
  setCustomExtension(ext: string, lang: string): void;
  FileDiff: new (o: Record<string, unknown>) => PierreFileDiff;
}
export interface TreeDecoration { text: string; title?: string; parts?: { text: string; color?: string }[] }
export interface PierreFileTree {
  render(o: { fileTreeContainer: HTMLElement }): void;
  setComposition(c?: unknown): void;
}
export interface PierreTrees {
  FileTree: new (o: {
    paths: string[];
    initialExpansion?: 'open' | 'closed';
    flattenEmptyDirectories?: boolean;
    density?: string;
    gitStatus?: { path: string; status: string }[];
    renderRowDecoration?: (row: { item: { path: string } }) => TreeDecoration | null;
    onSelectionChange?: (paths: string[]) => void;
    unsafeCSS?: string;
  }) => PierreFileTree;
}

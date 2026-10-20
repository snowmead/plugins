/* Shared types: the repository's config (.claude/changelog.json), what gather.ts counts (stats.json), the entry a
   run writes (entry.ts turns it into the database document), and what build.ts gives the page. */

// ---------------------------------------------------------------- .claude/changelog.json
export interface Config {
  /** The product's name, as the page and the Slack post call it: "Relay". */
  name: string;
  /** owner/name on GitHub. */
  repo: string;
  /** IANA time zone the entries are dated and labelled in: "America/Toronto". */
  timezone: string;
  /** The changelog page, once published: https://claude.ai/artifact/… */
  page?: string;
  /** Where each entry is posted; null or absent for no post. */
  slack?: { channel: string; label?: string } | null;
  /** Workflow files whose runs are counted per pull request; leave one out to skip it. */
  workflows?: { ci?: string; review?: string };
}

// ---------------------------------------------------------------- stats.json
export interface PrStats {
  title: string;
  url: string;
  author: string;
  created_at: string;
  merged_at: string;
  add: number;
  del: number;
  files: number;
  /** Opening to merge. */
  hours: number;
  ci_runs: number | null;
  ci_failed: number | null;
  review_runs: number | null;
}
export interface Stats {
  repo: string;
  window: {
    since: string;
    until: string;
    ci_runs: number | null;
    ci_failed: number | null;
    ci_in_progress: number | null;
    ci_median_min: number | null;
  };
  /** By pull request number. */
  prs: Record<string, PrStats>;
}

// ---------------------------------------------------------------- the entry a run writes
export interface Scene { svg: string; caption: string }
export interface ThemeInput {
  /** Lower case, unique in the entry: the theme's anchor. */
  key: string;
  /** The area, one or two words: "Images". */
  kicker: string;
  title: string;
  /** The one line under the title in the feed. */
  sum: string;
  prs: number[];
  paras: string[];
  scene: Scene;
}
export interface EntryInput {
  title: string;
  summary: string;
  themes: ThemeInput[];
  /** Things to check after pulling. */
  watch: string[];
  /** Optional: a review score out of 5 and its verdict, by PR, when the repository's reviews give one. */
  scores?: Record<number, [number, string]>;
  /** Optional: shorter titles for the PR table. */
  titles?: Record<number, string>;
  slack: { intro: string; lines: [emoji: string, text: string][]; watch: string };
}

// ---------------------------------------------------------------- the database document
export interface PrRow {
  n: number;
  title: string;
  merged: string;
  add: number;
  del: number;
  files: number;
  hours: number;
  review_runs: number | null;
  conf: number | null;
  conf_note: string;
  ci_failed: number | null;
  ci_runs: number | null;
}
export interface Entry {
  /** The window's end, as a date in the config's time zone: the document's id and its link (#2026-10-17). */
  date: string;
  /** "Oct 15, 10:10 pm to Oct 16, 7:27 pm" in the time zone, and how long it is: "21 hours". */
  window: string;
  span: string;
  timezone: string;
  window_start: string;
  window_end: string;
  title: string;
  summary: string;
  numbers: { prs: number; add: number; del: number; ci_median_min: number | null; ci_runs: number | null; ci_failed: number | null };
  themes: ThemeInput[];
  watch: string[];
  prs: PrRow[];
  /** The pull request link prefix: https://github.com/owner/name/pull/ */
  repo: string;
  source: string;
}

// ---------------------------------------------------------------- what build.ts gives the page
export interface PageConfig {
  name: string;
  /** The page's own link, for copied entry links; empty before the first publish. */
  url: string;
  sounds: Record<SoundName, { uri: string }>;
  levels: Record<SoundName, number>;
  master: number;
}
export type SoundName = 'open' | 'close' | 'hover' | 'switch' | 'copy' | 'new';

/** The slice of the artifact runtime the page uses: its database, read live. */
export interface Doc { id: string; exists: boolean; data(): unknown }
export interface Query {
  orderBy(field: string, dir: 'asc' | 'desc'): Query;
  limit(n: number): Query;
  onSnapshot(next: (snap: { docs: Doc[] }) => void, error?: (e: unknown) => void): () => void;
}
export interface Db { collection(name: string): Query }

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    CHANGELOG?: PageConfig;
    claude?: { use?(name: string): Promise<unknown> };
  }
}

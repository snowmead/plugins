/* What the scripts share: the repository's config, dates in its time zone, and the counting rules. Pure functions,
   so test.ts can check them without git, gh or the network. */
import { join } from 'node:path';
import type { Config, PrStats } from '../runtime/types';

// ---------------------------------------------------------------- arguments
/** --name=value or --name value. */
export function opt(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].slice(name.length + 3) : argv[i + 1];
}

// ---------------------------------------------------------------- config
/** The checkout's top folder, or the current one outside git. */
export function top(): string {
  const p = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' });
  return p.exitCode === 0 ? p.stdout.toString().trim() : process.cwd();
}
export const configPath = (path?: string) => path ?? join(top(), '.claude', 'changelog.json');

/** Reads and checks the config; returns the problems instead of throwing, so a run can report them all. */
export async function loadConfig(path?: string): Promise<{ config: Config | null; path: string; errors: string[] }> {
  const at = configPath(path);
  const file = Bun.file(at);
  if (!(await file.exists())) return { config: null, path: at, errors: [`no config at ${at}: set the changelog up first (SKILL.md, "Set up")`] };
  let c: Config;
  try { c = await file.json(); } catch (e) { return { config: null, path: at, errors: [`${at} is not JSON: ${(e as Error).message}`] }; }
  const errors: string[] = [];
  if (!c.name?.trim()) errors.push('config: name is missing (the product name, such as "Relay")');
  if (!/^[\w.-]+\/[\w.-]+$/.test(c.repo ?? '')) errors.push('config: repo must be owner/name');
  try { new Intl.DateTimeFormat('en-US', { timeZone: c.timezone }); } catch { errors.push(`config: timezone "${c.timezone}" is not an IANA time zone`); }
  if (c.page != null && !/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(c.page)) errors.push('config: page must be a claude.ai artifact link');
  if (c.slack && !c.slack.channel?.trim()) errors.push('config: slack.channel is missing; set slack to null for no post');
  return { config: errors.length ? null : c, path: at, errors };
}

// ---------------------------------------------------------------- time
export const P = (s: string) => new Date(s);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A moment's calendar fields in a time zone. */
export function zoned(d: Date, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute };
}
/** "2026-10-16": the date in the time zone. */
export function dateIn(d: Date, tz: string) {
  const z = zoned(d, tz);
  return `${z.y}-${String(z.m).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
}
/** "Oct 16, 7:27 pm". */
export function label(d: Date, tz: string) {
  const z = zoned(d, tz);
  return `${MONTHS[z.m - 1]} ${z.d}, ${z.h % 12 || 12}:${String(z.min).padStart(2, '0')} ${z.h < 12 ? 'am' : 'pm'}`;
}
/** "Oct 17", for the Slack title. */
export const shortDate = (date: string) => `${MONTHS[+date.slice(5, 7) - 1]} ${+date.slice(8, 10)}`;
/** "21 hours", "3 days": how long a window is, rounded. */
export function span(ms: number) {
  const h = ms / 3_600_000;
  if (h < 36) { const n = Math.max(1, Math.round(h)); return `${n} hour${n === 1 ? '' : 's'}`; }
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- counting
export interface RawPr {
  number: number; title: string; url: string; author: string | null; createdAt: string; updatedAt: string; mergedAt: string | null;
  headRefName: string; additions: number; deletions: number; changedFiles: number;
}
export interface Run {
  id: number; event: string; head_branch: string; created_at: string; updated_at: string; run_started_at?: string;
  status: string; conclusion: string | null; head_sha: string; display_title: string;
}

/** The pull requests merged after the window's start and up to its end, oldest first. Two runs never count one PR. */
export const inWindow = (prs: RawPr[], since: Date, until: Date) =>
  prs.filter((p) => p.mergedAt && P(p.mergedAt) > since && P(p.mergedAt) <= until).sort((a, b) => P(a.mergedAt!).getTime() - P(b.mergedAt!).getTime());

/** A PR's runs: pull_request runs on its head branch, created between its opening and its merge. */
export const runsOf = (p: RawPr, runs: Run[]) =>
  runs.filter((r) => r.event === 'pull_request' && r.head_branch === p.headRefName && P(r.created_at) >= P(p.createdAt) && P(r.created_at) <= P(p.mergedAt!));

export function prStats(p: RawPr, ci: Run[] | null, review: Run[] | null): PrStats {
  const cr = ci && runsOf(p, ci), rr = review && runsOf(p, review);
  return {
    title: p.title, url: p.url, author: p.author ?? 'ghost', created_at: p.createdAt, merged_at: p.mergedAt!,
    add: p.additions, del: p.deletions, files: p.changedFiles,
    hours: Math.round((P(p.mergedAt!).getTime() - P(p.createdAt).getTime()) / 36_000) / 100,
    ci_runs: cr ? cr.length : null, ci_failed: cr ? cr.filter((r) => r.conclusion === 'failure').length : null,
    review_runs: rr ? rr.length : null,
  };
}

/** The window's CI: runs created in it, failures, and the median minutes of the successful ones. */
export function windowCi(ci: Run[] | null, since: Date, until: Date) {
  if (!ci) return { ci_runs: null, ci_failed: null, ci_in_progress: null, ci_median_min: null };
  const win = ci.filter((r) => P(r.created_at) > since && P(r.created_at) <= until);
  const mins = win.filter((r) => r.status === 'completed' && r.conclusion === 'success' && r.run_started_at)
    .map((r) => (P(r.updated_at).getTime() - P(r.run_started_at!).getTime()) / 60_000).sort((a, b) => a - b);
  const mid = mins.length >> 1;
  const median = !mins.length ? null : mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
  return {
    ci_runs: win.length, ci_failed: win.filter((r) => r.conclusion === 'failure').length,
    ci_in_progress: win.filter((r) => r.status !== 'completed').length, ci_median_min: median == null ? null : Math.round(median * 10) / 10,
  };
}

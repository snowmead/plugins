#!/usr/bin/env bun
/* Gather the pull requests merged in a window, for one changelog entry.

     bun scripts/gather.ts --since <ISO> [--until <ISO>] --out <work dir> [--config <path>]
     bun scripts/gather.ts --days <N>    [--until <ISO>] --out <work dir> [--config <path>]

   --since is the last entry's window_end; --days N looks back N days from --until instead. --until defaults to now:
   a PR that merges during the run waits for the next one. Reads GitHub with `gh` (logged in, read only).

   Writes <work>/stats.json (each PR's size, hours open and CI and review runs, and the window's CI numbers) and
   <work>/prs/<n>.md (each PR's description, comments and reviews: what the digest workers read). Prints one line
   per PR and the base branch's push runs in the window, so a red one can go in "Things to check". */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Stats } from '../runtime/types';
import { type RawPr, type Run, P, inWindow, loadConfig, opt, prStats, windowCi } from './lib';

const argv = Bun.argv.slice(2);
if (argv.includes('--help') || !opt(argv, 'out') || (!opt(argv, 'since') && !opt(argv, 'days'))) {
  console.log('usage: bun scripts/gather.ts (--since <ISO> | --days <N>) [--until <ISO>] --out <work dir> [--config <path>]');
  process.exit(argv.includes('--help') ? 0 : 2);
}
const { config, errors } = await loadConfig(opt(argv, 'config'));
if (!config) { for (const e of errors) console.log(`error ${e}`); process.exit(1); }

const until = opt(argv, 'until') ? P(opt(argv, 'until')!) : new Date();
const days = opt(argv, 'days');
const since = days ? new Date(until.getTime() - Number(days) * 86_400_000) : P(opt(argv, 'since')!);
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
  console.log(`error the window ${opt(argv, 'since') ?? `${days} days`} to ${until.toISOString()} is not a window`);
  process.exit(1);
}
const out = opt(argv, 'out')!;
mkdirSync(join(out, 'prs'), { recursive: true });
const [owner, name] = config.repo.split('/');

function gh(args: string[]): string {
  const p = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode) { console.log(`error gh ${args[0]} ${args[1] ?? ''}: ${p.stderr.toString().trim()}`); process.exit(1); }
  return p.stdout.toString();
}

// ---------------------------------------------------------------- pull requests
// Merged PRs by last update, newest first: once a page reaches back past the window's start, every PR merged in the
// window has been seen (a merge is an update). The connection reads the repository directly, with no search lag.
type Node = RawPr & { author: { login: string } | null; body: string; baseRefName: string; labels: { nodes: { name: string }[] };
  comments: { nodes: { author: { login: string } | null; body: string; createdAt: string }[] };
  reviews: { nodes: { author: { login: string } | null; state: string; body: string; submittedAt: string | null }[] } };
const QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: 30, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url createdAt updatedAt mergedAt headRefName baseRefName additions deletions changedFiles body
        author { login }
        labels(first: 10) { nodes { name } }
        comments(last: 30) { nodes { author { login } body createdAt } }
        reviews(last: 15) { nodes { author { login } state body submittedAt } }
      }
    }
  }
}`;
const nodes: Node[] = [];
for (let cursor: string | null = null; ;) {
  const res = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, ...(cursor ? ['-F', `cursor=${cursor}`] : [])]));
  const page = res.data.repository.pullRequests;
  nodes.push(...page.nodes);
  const oldest = page.nodes.at(-1)?.updatedAt;
  if (!page.pageInfo.hasNextPage || !oldest || P(oldest) <= since) break;
  cursor = page.pageInfo.endCursor;
}
const merged = inWindow(nodes.map((n) => ({ ...n, author: n.author?.login ?? null })), since, until);
const byNumber = new Map(nodes.map((n) => [n.number, n]));

// ---------------------------------------------------------------- workflow runs
// Every run created since the oldest PR in the window opened, so each PR's runs are all there.
const oldest = new Date(Math.min(since.getTime(), ...merged.map((p) => P(p.createdAt).getTime())));
function runs(workflow: string | undefined): Run[] | null {
  if (!workflow) return null;
  const created = encodeURIComponent(`>=${oldest.toISOString()}`);
  const lines = gh(['api', '--paginate', `repos/${config!.repo}/actions/workflows/${workflow}/runs?per_page=100&created=${created}`,
    '--jq', '.workflow_runs[] | {id, event, head_branch, created_at, updated_at, run_started_at, status, conclusion, head_sha, display_title}']);
  const seen = new Map<number, Run>();
  for (const l of lines.split('\n')) if (l.trim()) { const r: Run = JSON.parse(l); seen.set(r.id, r); }
  return [...seen.values()];
}
const ci = runs(config.workflows?.ci);
const review = runs(config.workflows?.review);

// ---------------------------------------------------------------- write
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n\n[… ${s.length - n} more characters]` : s);
const stats: Stats = { repo: config.repo, window: { since: since.toISOString(), until: until.toISOString(), ...windowCi(ci, since, until) }, prs: {} };
for (const p of merged) {
  const s = prStats(p, ci, review);
  stats.prs[p.number] = s;
  const n = byNumber.get(p.number)!;
  const talk = [
    ...n.comments.nodes.map((c) => ({ at: c.createdAt, head: `Comment by ${c.author?.login ?? 'ghost'}`, body: c.body })),
    ...n.reviews.nodes.filter((r) => r.body.trim()).map((r) => ({ at: r.submittedAt ?? '', head: `Review by ${r.author?.login ?? 'ghost'} (${r.state.toLowerCase()})`, body: r.body })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  await Bun.write(join(out, 'prs', `${p.number}.md`), [
    `# #${p.number} ${p.title}`, '',
    `- Link: ${p.url}`, `- Author: ${s.author}`, `- Branch: ${p.headRefName} into ${n.baseRefName}`,
    `- Opened ${p.createdAt}, merged ${p.mergedAt} (${s.hours} hours)`, `- Size: +${s.add} −${s.del} in ${s.files} files`,
    ...(n.labels.nodes.length ? [`- Labels: ${n.labels.nodes.map((l) => l.name).join(', ')}`] : []), '',
    '## Description', '', n.body.trim() || '(empty)', '',
    ...(talk.length ? ['## Comments and reviews', '', ...talk.flatMap((t) => [`### ${t.head}, ${t.at}`, '', clip(t.body.trim()), ''])] : []),
  ].join('\n'));
  console.log(`#${p.number}  merged ${p.mergedAt}  +${s.add} -${s.del}  ${s.files} files  ${s.hours} h${s.ci_runs != null ? `  ci ${s.ci_failed}/${s.ci_runs} failed` : ''}${s.review_runs != null ? `  reviews ${s.review_runs}` : ''}  ${p.title}`);
}
await Bun.write(join(out, 'stats.json'), JSON.stringify(stats, null, 1) + '\n');

const w = stats.window;
console.log(`window ${w.since} to ${w.until}: ${merged.length} PR${merged.length === 1 ? '' : 's'} merged${w.ci_runs != null ? `, CI ${w.ci_runs} runs, ${w.ci_failed} failed, median ${w.ci_median_min ?? '-'} min` : ''}`);
for (const r of ci ?? []) {
  if (r.event === 'push' && P(r.created_at) > since && P(r.created_at) <= until && r.head_branch === (merged.length ? byNumber.get(merged[0].number)!.baseRefName : 'main'))
    console.log(`push ${r.created_at} ${r.status} ${r.conclusion ?? ''} ${r.head_sha.slice(0, 7)} ${r.display_title.slice(0, 70)}`);
}
console.log(`wrote ${join(out, 'stats.json')} and ${merged.length} file${merged.length === 1 ? '' : 's'} in ${join(out, 'prs')}`);

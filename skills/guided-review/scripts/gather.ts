#!/usr/bin/env bun
/* Read a pull request's diff from git into diff.json, the data a guided review is built from.

     bun scripts/gather.ts --base=origin/main --head=HEAD --out=<work>/diff.json [--quiet]

   The diff is the one GitHub shows for the pull request: merge-base(base, head) to head. Writes diff.json (files,
   hunks, file text, scope lines, moves) and prints an outline of every file and hunk, numbered, which is what the
   guide's chapters are written from. Run it anywhere inside the checkout. */
import type { Diff, DiffFile, Hunk, Kind, Line, Status } from '../runtime/types';

const argv = Bun.argv.slice(2);
/** --name=value or --name value. */
const opt = (name: string, fallback: string) => {
  const i = argv.findIndex((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  return argv[i].includes('=') ? argv[i].slice(name.length + 3) : (argv[i + 1] ?? fallback);
};
if (argv.includes('--help')) {
  console.log('usage: bun scripts/gather.ts [--base=origin/main] [--head=HEAD] [--out=diff.json] [--quiet]');
  process.exit(0);
}
const quiet = argv.includes('--quiet');

const MAX_TEXT_LINES = 4000; // larger files keep their hunks but no full text
const MAX_TEXT_BYTES = 400_000;
const MOVE_MIN_LINES = 3; // a moved block has at least this many non-blank lines
const MOVE_MIN_CHARS = 60; // and this much text, so a few braces never count as a move

// Paths from git are relative to the top of the checkout, so every call runs there, with paths taken literally,
// wherever the script is run from.
function git(args: string[], quietFail = false): string | null {
  const p = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode === 0) return p.stdout.toString();
  if (quietFail) return null;
  console.log(`error git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  process.exit(1);
}
const TOP = git(['rev-parse', '--show-toplevel'])!.trim();
const run = (args: string[]) => git(['-C', TOP, '--literal-pathspecs', '-c', 'core.quotePath=false', ...args])!;
const tryRun = (args: string[]) => git(['-C', TOP, '--literal-pathspecs', '-c', 'core.quotePath=false', ...args], true);

const headRef = opt('head', 'HEAD');
const baseRef = opt('base', 'origin/main');
const head = run(['rev-parse', '--verify', `${headRef}^{commit}`]).trim();
const baseTip = run(['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
const base = run(['merge-base', baseTip, head]).trim();
// The head's branch name, without the remote's prefix that a ref like origin/<branch> carries.
const remotes = (tryRun(['remote']) ?? '').split('\n').filter(Boolean);
const abbrev = tryRun(['rev-parse', '--abbrev-ref', headRef])?.trim() ?? null;
const branch = remotes.reduce<string | null>((name, r) => (name?.startsWith(`${r}/`) ? name.slice(r.length + 1) : name), abbrev);
const remote = tryRun(['remote', 'get-url', 'origin'])?.trim() ?? '';
const repoUrl = remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').replace(/^https:\/\/[^@/]+@/, 'https://');

// ---------------------------------------------------------------- classify
const LANGS: Record<string, string> = {
  rs: 'rust', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', mdx: 'markdown', sql: 'sql', toml: 'ini', yml: 'yaml',
  yaml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml',
  py: 'python', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp',
  hpp: 'cpp', cs: 'csharp', php: 'php', lock: 'ini', dockerfile: 'dockerfile', just: 'makefile', mk: 'makefile',
};
function langOf(path: string) {
  const name = path.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'justfile' || name === 'makefile') return 'makefile';
  return LANGS[name.includes('.') ? name.split('.').pop()! : ''] ?? 'plaintext';
}
const GENERATED = [
  /(^|\/)(Cargo|Gemfile|composer|poetry|uv|flake|yarn|pnpm-lock|bun)\.lock$/, /(^|\/)(package-lock|npm-shrinkwrap|composer)\.json$/,
  /(^|\/)pnpm-lock\.yaml$/, /(^|\/)bun\.lockb$/, /(^|\/)go\.sum$/, /\.lock$/,
  /\.(gen|generated)\.\w+$/, /(^|\/)generated\.\w+$/, /_pb2(_grpc)?\.pyi?$/, /\.pb(\.gw)?\.go$/, /\.min\.(js|css)$/,
];
function kindOf(path: string, firstLines: string): Kind {
  if (GENERATED.some((r) => r.test(path)) || /@generated|DO NOT EDIT|Code generated/.test(firstLines)) return 'generated';
  if (/(^|\/)migrations?\/|\.sql$/.test(path)) return 'database';
  if (/(^|\/)(tests?|spec|e2e|__tests__|__snapshots__|fixtures)\/|[._-](test|spec)\.[a-z]+$|_test\.\w+$|(^|\/)tests\.rs$|(^|\/)test_[^/]+\.py$|\.snap$/.test(path)) return 'tests';
  if (/\.mdx?$|\.rst$|\.adoc$/.test(path) || /^docs?\//.test(path)) return 'docs';
  return 'core';
}

// ---------------------------------------------------------------- files
const ns = run(['diff', '--name-status', '-z', '-M', base, head]).split('\0').filter((x) => x !== '');
const entries: { code: string; oldPath: string; path: string }[] = [];
for (let i = 0; i < ns.length;) {
  const code = ns[i++];
  if (code[0] === 'R' || code[0] === 'C') entries.push({ code: code[0], oldPath: ns[i++], path: ns[i++] });
  else entries.push({ code: code[0], oldPath: ns[i], path: ns[i++] });
}

/** A file's lines at a commit, kept only when small enough, and its line count either way, so refs into a large
    or generated file are still checked. */
function textAt(rev: string, path: string) {
  const t = tryRun(['show', `${rev}:${path}`]);
  if (t == null || t.includes('\0')) return { lines: null, count: null };
  const lines = t.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const small = Buffer.byteLength(t) <= MAX_TEXT_BYTES && lines.length <= MAX_TEXT_LINES;
  return { lines: small ? lines : null, count: lines.length };
}

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let h: Hunk | null = null, o = 0, n = 0;
  for (const line of patch.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (m) {
      h = { id: hunks.length + 1, oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], header: m[5].trim(), label: '', scope: [], lines: [] };
      hunks.push(h);
      o = h.oldStart; n = h.newStart;
      continue;
    }
    if (!h) continue;
    const op = line[0];
    if (op === ' ') h.lines.push([' ', o++, n++, line.slice(1)]);
    else if (op === '-') h.lines.push(['-', o++, null, line.slice(1)]);
    else if (op === '+') h.lines.push(['+', null, n++, line.slice(1)]);
  }
  return hunks;
}

// A line that names a function, type, block or section: the label a hunk is listed under.
const DECL = new RegExp([
  /^\s*(pub(\([^)]*\))?\s+)?((async|const|unsafe|default|static|extern\s+"[^"]*")\s+)*(fn|impl|struct|enum|trait|mod|type|union|macro_rules!)\b/,
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace)\b/,
  /^\s*(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s*)?(\(|function\b|[\w$]+\s*=>)/,
  /^\s*(async\s+)?(def|class)\s/, /^\s*func\s/, /^#{1,6}\s/, /^\s*\[[^\]]+\]\s*$/, /^\s*(describe|it|test)\(/, /^\s*create\s+/i,
].map((r) => r.source).join('|'), 'i');

const indentOf = (s: string) => s.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length;
const CLOSER = /^\s*[}\])]/;

/** The lines that open the scopes around a line, outermost first, like an editor's sticky scroll: each line above
    with less indentation than the last one found. A line that starts with a closer (`) -> T {`, `} else {`) brings
    its opener too. `ind` is the changed line's indentation when that line is gone from `lines`. */
function scopeChain(lines: string[], idx: number, lang: string, ind?: number): number[] {
  const chain: number[] = [];
  if (idx < 0) return chain; // a hunk that empties the file
  if (lang === 'markdown') {
    // Headings above the line, outside fenced code blocks.
    const heads: [number, number][] = [];
    let fence = '';
    for (let j = 0; j < Math.min(idx, lines.length); j++) {
      const f = lines[j].match(/^\s*(`{3,}|~{3,})/);
      if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = ''; continue; }
      const m = !fence && lines[j].match(/^(#{1,6})\s/);
      if (m) heads.push([j + 1, m[1].length]);
    }
    let level = 7;
    for (let i = heads.length - 1; i >= 0 && level > 1; i--) {
      if (heads[i][1] < level) { chain.unshift(heads[i][0]); level = heads[i][1]; }
    }
    return chain;
  }
  if (lang === 'ini') {
    for (let j = idx - 1; j >= 0; j--) if (/^\s*\[/.test(lines[j])) return [j + 1];
    return chain;
  }
  if (ind === undefined) {
    let k = idx;
    while (k < lines.length && !lines[k].trim()) k++;
    if (k >= lines.length) return chain;
    ind = indentOf(lines[k]);
  }
  for (let j = Math.min(idx, lines.length) - 1; j >= 0 && ind > 0 && chain.length < 6; j--) {
    const l = lines[j];
    if (!l.trim() || indentOf(l) >= ind) continue;
    chain.unshift(j + 1);
    ind = indentOf(l);
    if (CLOSER.test(l)) {
      for (let q = j - 1; q >= 0; q--) {
        const lq = lines[q];
        if (lq.trim() && indentOf(lq) <= ind && !CLOSER.test(lq)) { chain.unshift(q + 1); ind = indentOf(lq); j = q; break; }
      }
    }
  }
  return chain;
}

const STATUS: Record<string, Status> = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };
const files: DiffFile[] = [];
for (const e of entries) {
  const status = STATUS[e.code] ?? 'modified';
  const paths = e.oldPath !== e.path ? [e.oldPath, e.path] : [e.path];
  const patch = run(['diff', '--no-color', '--no-ext-diff', '-M', '-U3', base, head, '--', ...paths]);
  const binary = /^Binary files /m.test(patch);
  const oldAt = status === 'added' || binary ? null : textAt(base, e.oldPath);
  const newAt = status === 'deleted' || binary ? null : textAt(head, e.path);
  const oldText = oldAt?.lines ?? null, newText = newAt?.lines ?? null;
  const hunks = binary ? [] : parseHunks(patch);
  const lang = langOf(e.path);
  const kind = kindOf(e.path, (newText ?? oldText ?? []).slice(0, 5).join('\n'));
  const side = status === 'deleted' ? oldText : newText;
  for (const h of hunks) {
    let label = h.header;
    if (side && kind !== 'generated') {
      // Scopes of the first changed line; the ones above the hunk are shown with it.
      const deleted = status === 'deleted';
      const start = deleted ? h.oldStart : h.newStart;
      let at = start;
      for (const l of h.lines) {
        if (l[0] !== ' ') break;
        at = (deleted ? l[1]! : l[2]!) + 1;
      }
      // A change that opens with removed lines takes its scope from them: the line now at their place may sit
      // outside it, as the closing brace after a method's removed tail does.
      const first = h.lines.find((l) => l[0] !== ' ');
      const gone = !deleted && first?.[0] === '-' ? h.lines.find((l) => l[0] === '-' && l[3].trim()) : undefined;
      const chain = scopeChain(side, at - 1, lang, gone ? indentOf(gone[3]) : undefined);
      h.scope = chain.filter((no) => no < start);
      const decl = [...chain].reverse().find((no) => DECL.test(side[no - 1]));
      if (decl || chain.length) label = side[(decl ?? chain[chain.length - 1]) - 1].trim();
    }
    h.label = (label || '').slice(0, 90);
  }
  let add = 0, del = 0;
  for (const h of hunks) for (const l of h.lines) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
  // The page rebuilds the old text from the new text and the hunks, so only a deleted file keeps it. Generated
  // files keep only their hunks.
  const keepText = kind !== 'generated';
  files.push({
    path: e.path, oldPath: e.oldPath !== e.path ? e.oldPath : null, status, kind, lang, binary, add, del,
    old: keepText && status === 'deleted' ? oldText : null, new: keepText ? newText : null,
    oldCount: oldAt?.count ?? null, newCount: newAt?.count ?? null, hunks, moves: [],
  });
}

// ---------------------------------------------------------------- moves
// A run of removed lines that appears again as added lines somewhere else in the pull request (another file, or
// another hunk) is a move, not a change.
type Block = { fi: number; hunk: number; lines: { no: number; text: string }[] };
function blocks(op: Line[0]): Block[] {
  const out: Block[] = [];
  files.forEach((f, fi) => {
    if (f.kind === 'generated') return;
    for (const h of f.hunks) {
      let cur: Block | null = null;
      for (const l of h.lines) {
        if (l[0] === op) {
          if (!cur) { cur = { fi, hunk: h.id, lines: [] }; out.push(cur); }
          cur.lines.push({ no: (op === '-' ? l[1] : l[2])!, text: l[3].trim() });
        } else cur = null;
      }
    }
  });
  return out;
}
const removed = blocks('-');
const added = blocks('+');
const index = new Map<string, [number, number][]>();
added.forEach((b, bi) => b.lines.forEach((l, li) => {
  if (l.text.length < 8) return;
  if (!index.has(l.text)) index.set(l.text, []);
  index.get(l.text)!.push([bi, li]);
}));
const usedAdd = added.map((b) => new Array<boolean>(b.lines.length).fill(false));
for (const r of removed) {
  for (let i = 0; i < r.lines.length;) {
    let best: { bi: number; li: number; len: number } | null = null;
    for (const [bi, li] of index.get(r.lines[i].text) ?? []) {
      const a = added[bi];
      if (a.fi === r.fi && a.hunk === r.hunk) continue;
      let len = 0;
      while (i + len < r.lines.length && li + len < a.lines.length && !usedAdd[bi][li + len] && r.lines[i + len].text === a.lines[li + len].text) len++;
      if (!best || len > best.len) best = { bi, li, len };
    }
    const span = best ? r.lines.slice(i, i + best.len) : [];
    const solid = span.filter((l) => l.text).length;
    const chars = span.reduce((s, l) => s + l.text.length, 0);
    if (best && solid >= MOVE_MIN_LINES && chars >= MOVE_MIN_CHARS) {
      const a = added[best.bi];
      for (let k = 0; k < best.len; k++) usedAdd[best.bi][best.li + k] = true;
      const from = files[r.fi], to = files[a.fi];
      const fromLines = [span[0].no, span[span.length - 1].no];
      const toLines = [a.lines[best.li].no, a.lines[best.li + best.len - 1].no];
      from.moves.push({ side: '-', from: fromLines[0], to: fromLines[1], other: to.path, otherFrom: toLines[0], otherTo: toLines[1], lines: best.len });
      to.moves.push({ side: '+', from: toLines[0], to: toLines[1], other: from.path, otherFrom: fromLines[0], otherTo: fromLines[1], lines: best.len });
      i += best.len;
    } else i++;
  }
}

// ---------------------------------------------------------------- write
const out = opt('out', 'diff.json');
const commits = (tryRun(['log', '--format=%h%x09%an%x09%s', `${base}..${head}`]) ?? '').trim().split('\n').filter(Boolean)
  .map((l) => { const [sha, author, subject] = l.split('\t'); return { sha, author, subject }; });
const data: Diff = { version: 1, repo: repoUrl, base, head, baseRef, branch: branch && branch !== 'HEAD' ? branch : null, commits, files };
await Bun.write(out, JSON.stringify(data));

if (!quiet) {
  const sum = files.reduce((s, f) => [s[0] + f.add, s[1] + f.del], [0, 0]);
  console.log(`${files.length} files  +${sum[0]} -${sum[1]}  ${base.slice(0, 7)}..${head.slice(0, 7)}  ${commits.length} commits → ${out}`);
  for (const kind of ['core', 'docs', 'database', 'tests', 'generated'] as Kind[]) {
    const group = files.filter((f) => f.kind === kind);
    if (!group.length) continue;
    console.log(`\n${kind}`);
    for (const f of group) {
      const from = f.oldPath ? ` (from ${f.oldPath})` : '';
      console.log(`  ${f.path}${from}  ${f.status}  +${f.add} -${f.del}${f.binary ? '  binary' : ''}${f.new || f.old ? '' : '  (no full text)'}`);
      if (kind === 'generated') continue;
      for (const h of f.hunks) {
        const a = h.lines.filter((l) => l[0] === '+').length, d = h.lines.filter((l) => l[0] === '-').length;
        console.log(`    hunk ${h.id}  L${h.newStart}-${h.newStart + Math.max(h.newLines, 1) - 1}  +${a} -${d}${h.label ? `  in ${h.label}` : ''}`);
      }
      for (const m of f.moves.filter((x) => x.side === '-')) console.log(`    moved L${m.from}-${m.to} (${m.lines} lines) to ${m.other}:${m.otherFrom}`);
    }
  }
}

/* Shortened code: a snippet is the code a chapter shows, cut by hand to what the reviewer needs. This file reads a
   snippet's two sides, finds each line in the real file at the base and at the head, and diffs the two sides into the
   rows the page draws.

   A line of a side is one of:
     - an elision: `// ...` (or `# ...`, `-- ...`, `<!-- ... -->`, `…`) stands for statements left out;
     - a note: `//> text` (or `#> text`, `-->` text) is on the page only, never in the code;
     - a blank line, for reading;
     - code: a line of the real file, or several joined, where `/* ... *\/` or `…` stands for a part left out.

   Each code line must be in the real file, in order, so the page shows no code the pull request does not have. A line
   the diff marks as added must be added in the pull request, and a removed one removed: the page must not show
   unchanged code as new. The real line numbers ride along, so a comment on a shown line is a comment on its real
   line. */
import type { Line } from '../runtime/types';

export type Kind = 'elide' | 'note' | 'blank' | 'code';
export interface ShownLine { text: string; kind: Kind }

const ELIDE = /^\s*(?:(?:\/\/|#|--|;;|%)\s*(?:\.\.\.|…)|<!--\s*(?:\.\.\.|…)\s*-->|\/\*\s*(?:\.\.\.|…)\s*\*\/|\.\.\.|…)\s*$/;
const NOTE = /^\s*(?:\/\/|#|--)>(?:\s|$)/;
/** A part of a line left out: `/* ... *\/` or `…`. */
const WILD = /\/\*\s*(?:\.\.\.|…)\s*\*\/|…/;

export function readSide(text: string | undefined): ShownLine[] {
  if (text == null) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.map((t) => ({ text: t, kind: !t.trim() ? 'blank' : ELIDE.test(t) ? 'elide' : NOTE.test(t) ? 'note' : 'code' }));
}

/** The note's own text, without its marker. */
export const noteText = (t: string) => t.replace(/^\s*(?:\/\/|#|--)>\s?/, '');

// ---------------------------------------------------------------- the diff of the two sides
/** Line-level LCS of the shown old and new lines. Leading and trailing white space does not count, so a line that only
    moves in or out a level is unchanged, as with "Hide whitespace" on GitHub. `pairs` can refuse two lines of the same
    text: the closing brace of one block is not the closing brace of another. Returns rows of [op, old index, new
    index]. */
export function diffSides(a: ShownLine[], b: ShownLine[], pairs: (i: number, j: number) => boolean = () => true): [op: ' ' | '-' | '+', i: number | null, j: number | null][] {
  const key = (l: ShownLine) => (l.kind === 'blank' ? '' : l.text.trim());
  const ka = a.map(key), kb = b.map(key);
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = ka[i] === kb[j] && pairs(i, j) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: [' ' | '-' | '+', number | null, number | null][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j] && pairs(i, j) && t[i][j] === t[i + 1][j + 1] + 1) out.push([' ', i++, j++]);
    else if (t[i + 1][j] >= t[i][j + 1]) out.push(['-', i++, null]);
    else out.push(['+', null, j++]);
  }
  while (i < n) out.push(['-', i++, null]);
  while (j < m) out.push(['+', null, j++]);
  return out;
}

// ---------------------------------------------------------------- finding shown lines in the real file
const squash = (s: string) => s.replace(/\s+/g, '');
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The longest run of real lines one shown line may stand for, as when `call(/* ... *\/)` stands for a call over
    many lines. */
const MAX_RUN = 60;

interface Cand { a: number; b: number }
/** Where a code line can be in the real file: each run of lines, 1-based and inclusive, whose text it matches. */
function candidates(line: string, real: string[], sq: string[], byText: Map<string, number[]>): Cand[] {
  const parts = line.trim().split(WILD).map(squash);
  if (parts.length === 1) return (byText.get(parts[0]) ?? []).map((i) => ({ a: i + 1, b: i + 1 }));
  const re = new RegExp(`^${parts.map(reEsc).join('[\\s\\S]*?')}$`);
  const [first, last] = [parts[0], parts.at(-1)!];
  const out: Cand[] = [];
  for (let s = 0; s < real.length; s++) {
    if (first && !(sq[s].startsWith(first) || first.startsWith(sq[s]) && sq[s])) continue;
    let joined = '';
    for (let e = s; e < Math.min(real.length, s + MAX_RUN); e++) {
      joined += sq[e];
      if (first && !joined.startsWith(first) && !first.startsWith(joined)) break;
      if ((!last || joined.endsWith(last)) && re.test(joined)) { out.push({ a: s + 1, b: e + 1 }); break; }
    }
  }
  return out;
}

export interface SideMap {
  /** The real run of each shown line, by its index in the side; null for an elision, a note, a blank line, or a code
      line not found. */
  at: (Cand | null)[];
  /** Indexes of code lines not found in the real file. */
  missing: number[];
  /** Code lines that leave out real code with no `// ...` before them: [index, lines left out]. */
  skips: [number, number][];
}

/** Find a side's code lines in the real file, in order. Of all the ways to place them, take the one that leaves out
    the least real code without an elision, that does not show unchanged code as changed (`changed` holds the real
    lines the pull request adds, or removes, on this side), and that stays close together. */
export function mapSide(shown: ShownLine[], real: string[], changed: Set<number>, ops: (' ' | '-' | '+' | null)[]): SideMap {
  const sq = real.map(squash);
  const byText = new Map<string, number[]>();
  sq.forEach((t, i) => { if (t) byText.set(t, [...(byText.get(t) ?? []), i]); });
  // Real lines with code, counted to here: the code a jump between two shown lines leaves out.
  const codeUpTo = new Int32Array(real.length + 1);
  // A comment left out is not code left out: a cut needs a `// ...` only where statements go.
  const comment = /^(?:\/\/|\/\*|\*|#(?![[!])|--|<!--)/;
  for (let i = 0; i < real.length; i++) codeUpTo[i + 1] = codeUpTo[i] + (sq[i] && !comment.test(sq[i]) ? 1 : 0);
  const codeIn = (a: number, b: number) => (b < a ? 0 : codeUpTo[b] - codeUpTo[a - 1]);

  const at: (Cand | null)[] = shown.map(() => null);
  const missing: number[] = [];
  const steps: { i: number; cands: Cand[]; elided: boolean }[] = [];
  let elided = false;
  shown.forEach((l, i) => {
    if (l.kind === 'elide') { elided = true; return; }
    if (l.kind !== 'code') return;
    const cands = candidates(l.text, real, sq, byText);
    if (!cands.length) { missing.push(i); return; }
    steps.push({ i, cands, elided });
    elided = false;
  });
  if (!steps.length) return { at, missing, skips: [] };

  // Dynamic programming over the code lines found: cost[k][c] is the least cost to place lines 0..k with line k at its
  // candidate c.
  const kindCost = (k: number, c: Cand) => {
    const op = ops[steps[k].i];
    if (op !== '+' && op !== '-') return 0;
    for (let x = c.a; x <= c.b; x++) if (changed.has(x)) return 0;
    return 1000;
  };
  const cost: Float64Array[] = [];
  const from: Int32Array[] = [];
  steps.forEach((st, k) => {
    cost.push(new Float64Array(st.cands.length).fill(Infinity));
    from.push(new Int32Array(st.cands.length).fill(-1));
    st.cands.forEach((c, ci) => {
      const own = kindCost(k, c);
      if (k === 0) { cost[0][ci] = own; return; }
      const prev = steps[k - 1];
      prev.cands.forEach((p, pi) => {
        if (p.b >= c.a || cost[k - 1][pi] === Infinity) return;
        const gap = codeIn(p.b + 1, c.a - 1);
        // Left out with `// ...`: free, and a hair for distance so the code stays together. Left out silently: dear.
        const step = st.elided ? (gap ? 0 : 0.5) + (c.a - p.b) * 1e-4 : gap * 50 + (c.a - p.b - 1) * 1e-3;
        const v = cost[k - 1][pi] + step + own;
        if (v < cost[k][ci]) { cost[k][ci] = v; from[k][ci] = pi; }
      });
    });
    // No order works from the line before: start again here, as if that line were left out with `// ...`.
    if (k > 0 && cost[k].every((v) => v === Infinity)) {
      st.cands.forEach((c, ci) => { cost[k][ci] = kindCost(k, c) + 1e6; from[k][ci] = -1; });
    }
  });
  let ci = 0;
  cost.at(-1)!.forEach((v, i) => { if (v < cost.at(-1)![ci]) ci = i; });
  for (let k = steps.length - 1; k >= 0; k--) {
    at[steps[k].i] = steps[k].cands[ci];
    if (k > 0) ci = from[k][ci] >= 0 ? from[k][ci] : bestOf(cost[k - 1]);
  }
  const skips: [number, number][] = [];
  for (let k = 1; k < steps.length; k++) {
    const p = at[steps[k - 1].i]!, c = at[steps[k].i]!;
    const gap = c.a > p.b ? codeIn(p.b + 1, c.a - 1) : 0;
    if (!steps[k].elided && gap) skips.push([steps[k].i, gap]);
  }
  return { at, missing, skips };
}
const bestOf = (a: Float64Array) => { let b = 0; a.forEach((v, i) => { if (v < a[b]) b = i; }); return b; };

// ---------------------------------------------------------------- one snippet
export interface Mapped {
  rows: Line[];
  at: [number | null, number | null][];
  /** Changed rows of code, the page's count of what it shows. */
  add: number;
  del: number;
  errors: string[];
  warns: string[];
  /** The first real line the snippet changes, at the head (or at the base for only old code). */
  first: { line: number; side: 'o' | 'n' } | null;
}

/** Map a snippet: `oldReal` and `newReal` are the real files (null for a side the file has not), `removed` and `added`
    the real lines the pull request removes at the base and adds at the head. */
export function mapSnippet(
  sides: { old?: string; new?: string },
  oldReal: string[] | null,
  newReal: string[] | null,
  removed: Set<number>,
  added: Set<number>,
  /** The head line a base line stays as, or null when the pull request removes or changes it. */
  sameAs?: (old: number) => number | null,
): Mapped {
  const errors: string[] = [], warns: string[] = [];
  const a = readSide(sides.old), b = readSide(sides.new);
  if (!a.length && !b.length) errors.push('has no code: give it "old", "new", or both.');
  if (a.length && !oldReal) errors.push('has "old" code, but the file is not at the base. Leave "old" out of a new file.');
  if (b.length && !newReal) errors.push('has "new" code, but the file is not at the head. Leave "new" out of a deleted file.');
  // Place each side once to learn its real lines, diff the sides with those, then place them again knowing which
  // lines show as changed.
  const place = (opsA: (' ' | '-' | null)[], opsB: (' ' | '+' | null)[]) => [
    a.length && oldReal ? mapSide(a, oldReal, removed, opsA) : null,
    b.length && newReal ? mapSide(b, newReal, added, opsB) : null,
  ] as const;
  const pairsOf = (pa: SideMap | null, pb: SideMap | null) => (i: number, j: number) => {
    const x = pa?.at[i], y = pb?.at[j];
    if (!x || !y || !sameAs) return true;
    const kept = sameAs(x.a);
    return kept == null || kept === y.a;
  };
  const [pa, pb] = place(a.map(() => null), b.map(() => null));
  let diff = diffSides(a, b, pairsOf(pa, pb));
  const opsA: (' ' | '-' | null)[] = a.map(() => null), opsB: (' ' | '+' | null)[] = b.map(() => null);
  for (const [op, i, j] of diff) { if (i != null) opsA[i] = op as ' ' | '-'; if (j != null) opsB[j] = op as ' ' | '+'; }
  const [ma, mb] = place(opsA, opsB);
  diff = diffSides(a, b, pairsOf(ma, mb));

  const quote = (l: ShownLine) => { const t = l.text.trim(); return `"${t.length > 60 ? `${t.slice(0, 57)}…` : t}"`; };
  for (const [side, lines, m] of [['old', a, ma], ['new', b, mb]] as const) {
    if (!m) continue;
    const where = side === 'old' ? 'the base' : 'the head';
    for (const i of m.missing) errors.push(`${side} line ${i + 1}, ${quote(lines[i])}, is not in the file at ${where}. Copy it from the code; cut a part with /* ... */, or write a page note as //> text.`);
    for (const [i, n] of m.skips) warns.push(`${side} line ${i + 1}, ${quote(lines[i])}, follows a gap of ${n} line${n === 1 ? '' : 's'} of code with no // ... before it. Mark each cut, so the reader knows code is left out.`);
  }
  // The diff of the shown code must agree with the pull request.
  for (const [op, i, j] of diff) {
    if (op === '+' && mb && b[j!].kind === 'code') {
      const c = mb.at[j!];
      if (c && ![...range(c.a, c.b)].some((x) => added.has(x))) errors.push(`new line ${j! + 1}, ${quote(b[j!])}, shows as added, but the pull request does not add it (head line ${c.a}). Show it on both sides, cut the same way.`);
    }
    if (op === '-' && ma && a[i!].kind === 'code') {
      const c = ma.at[i!];
      if (c && ![...range(c.a, c.b)].some((x) => removed.has(x))) errors.push(`old line ${i! + 1}, ${quote(a[i!])}, shows as removed, but the pull request does not remove it (base line ${c.a}). Show it on both sides, cut the same way.`);
    }
  }
  for (const [op, i, j] of diff) {
    const l = op === '-' ? a[i!] : op === '+' ? b[j!] : null;
    if (l?.kind === 'note' && a.length && b.length) warns.push(`${op === '-' ? 'old' : 'new'} line ${(op === '-' ? i! : j!) + 1}, the note ${quote(l)}, is on one side only, so it shows as ${op === '-' ? 'removed' : 'added'}. Write it on both sides.`);
  }
  for (const [side, lines] of [['old', a], ['new', b]] as const) lines.forEach((l, i) => {
    if (l.kind === 'code' && /^\s*(import\s|use\s|from\s+\S+\s+import\s|#include\s)|^\s*export\s.*\sfrom\s/.test(l.text)) warns.push(`${side} line ${i + 1} is an import. Leave imports out: they say nothing about the change.`);
  });

  const rows: Line[] = [];
  const at: [number | null, number | null][] = [];
  let o = 0, n = 0, add = 0, del = 0;
  let firstAdd: number | null = null, firstDel: number | null = null;
  for (const [op, i, j] of diff) {
    const lo = i != null ? a[i] : null, ln = j != null ? b[j] : null;
    const ro = i != null && ma?.at[i] ? ma.at[i]!.a : null, rn = j != null && mb?.at[j] ? mb.at[j]!.a : null;
    if (op === ' ') rows.push([' ', ++o, ++n, ln!.text]);
    else if (op === '-') rows.push(['-', ++o, null, lo!.text]);
    else rows.push(['+', null, ++n, ln!.text]);
    at.push([ro, rn]);
    const code = (op === '-' ? lo : ln)!.kind === 'code';
    if (op === '+' && code) { add++; firstAdd ??= rn; }
    if (op === '-' && code) { del++; firstDel ??= ro; }
  }
  let first: Mapped['first'] = firstAdd != null ? { line: firstAdd, side: 'n' } : firstDel != null ? { line: firstDel, side: 'o' } : null;
  // A snippet with only unchanged rows (a hunk changed inside a cut) still links to where it is.
  if (!first) {
    const k = at.findIndex(([x, y]) => y != null || x != null);
    if (k >= 0) first = at[k][1] != null ? { line: at[k][1]!, side: 'n' } : { line: at[k][0]!, side: 'o' };
  }
  return { rows, at, add, del, errors, warns, first };
}

function* range(a: number, b: number) { for (let x = a; x <= b; x++) yield x; }
/** Columns a line takes, a tab as 2. */
export const width = (s: string) => s.replace(/\t/g, '  ').length;

/* A small HTML tree, enough for build.ts's checks and for changes.ts to find, compare and rewrite blocks. Each node
   keeps where it sits in the source: `start` at its `<`, `open` after its start tag, `close` at its end tag, `end`
   after it. Script, style and comments are skipped. */

export type Node = {
  tag: string; attrs: Record<string, string>; parents: string[]; up: Node | null; line: number; kids: Node[]; words: number;
  start: number; open: number; close: number; end: number;
};
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export function parse(src: string): Node[] {
  const nodes: Node[] = [], stack: Node[] = [];
  const re = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m: RegExpExecArray | null;
  const text = (s: string) => { const n = s.split(/\s+/).filter(Boolean).length; for (const x of stack) x.words += n; };
  const shut = (n: Node, close: number, end: number) => { n.close = close; n.end = end; };
  while ((m = re.exec(src))) {
    text(src.slice(last, m.index));
    last = re.lastIndex;
    if (!m[3]) continue; // comment, script or style
    const tag = m[3].toLowerCase();
    if (m[2]) {
      const i = stack.findLastIndex((n) => n.tag === tag);
      if (i < 0) continue;
      for (const n of stack.slice(i + 1)) shut(n, m.index, m.index); // left open: ends where its parent does
      shut(stack[i], m.index, re.lastIndex);
      stack.length = i;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[4].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const node: Node = {
      tag, attrs, parents: stack.map((n) => n.tag), up: stack.at(-1) ?? null, line: src.slice(0, m.index).split('\n').length, kids: [], words: 0,
      start: m.index, open: re.lastIndex, close: re.lastIndex, end: re.lastIndex,
    };
    stack.at(-1)?.kids.push(node);
    nodes.push(node);
    if (!VOID.has(tag) && !m[4].trimEnd().endsWith('/')) stack.push(node);
  }
  text(src.slice(last));
  for (const n of stack) shut(n, src.length, src.length);
  return nodes;
}

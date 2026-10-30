/* Mermaid diagrams, drawn here at build with pele (https://pele.run) into SVG. The SVG takes its colors and type from
   the kit's tokens (ui.css, "diagrams"), so it follows the page's light and dark, and the page loads no diagram
   library. The artifact viewer draws a <pre class="mermaid"> itself, so a page never keeps one.

   Each diagram is drawn twice: as written, and for a column 340 px wide, where pele turns a wide flow top to bottom.
   ui.css shows the second when the diagram's box is under 480 px wide (a phone). A drawing shrinks to fit its box
   down to three quarters of its size (--w, its width), and scrolls sideways past that, so its labels stay readable.
   Pele sizes each box from a table of letter widths, close enough to Geist's that the labels fit without a browser
   to measure them.

   A skill that draws diagrams lists pele in its package.json dependencies, at a release at least 14 days old (the
   artifact rule); `need` installs it on a fresh copy. */
import { need } from './deps';

/** The width the narrow drawing is laid out for: a phone's column, less a card's padding. */
const NARROW = 340;
/** The classes a node can take (`A:::new`) that ui.css colors: what a change added, changed or removed. */
export const MARKS = ['new', 'changed', 'removed'] as const;

export interface Drawn {
  /** The .k-dia box with its drawings, to put in the page. */
  html: string;
  /** What goes inside the box: the drawing as written, and the narrow one when it differs. */
  body: string;
  /** The diagram type, as pele names it: flowchart, sequence, state… */
  type: string;
  /** Its width as written, in pixels, with the page's 13 px labels. */
  width: number;
  /** Each node's id, as the source names it, with the MARK it takes, if any. */
  nodes: Map<string, string | null>;
  /** The MARKS its nodes use. */
  marks: string[];
}

/** The slice of pele this calls. */
interface Pele {
  render(source: string, options: object): { svg: string; width: number; height: number; type: string };
}

/** A drawer for the skill in `dir`: draw(source, id) draws one diagram, or says why it cannot (with the line of the
    source, when pele knows it). `id` is unique in the page: letters, digits, - and _. */
export async function diagrams(dir: string) {
  const pele = await need<Pele>('pele', dir);
  const options = { fontFamily: 'Geist', fontFamilyMono: 'Geist Mono', fontSize: 13, responsive: false };
  return (source: string, id: string): Drawn | { error: string } => {
    let wide, narrow;
    try {
      wide = pele.render(source, { ...options, idPrefix: id });
      narrow = pele.render(source, { ...options, idPrefix: `${id}-n`, maxWidth: NARROW });
    } catch (e) {
      // pele's message repeats the source line with a caret under it; the line number says where.
      const lines = String((e as Error).message).split('\n').filter((l) => l.trim() && !/^\s*-*\^\s*$/.test(l));
      return { error: lines.join(' ') };
    }
    const nodes = new Map<string, string | null>();
    for (const [, cls, node] of wide.svg.matchAll(/<g class="pele-node([^"]*)" data-id="([^"]*)"/g))
      nodes.set(node, MARKS.find((m) => cls.split(/\s+/).includes(m)) ?? null);
    const one = (cls: string, d: { svg: string; width: number }) => `<div class="${cls}" style="--w:${Math.ceil(d.width)}px">${d.svg}</div>`;
    const same = narrow.width === wide.width && narrow.height === wide.height;
    const body = one('k-dia-wide', wide) + (same ? '' : one('k-dia-narrow', narrow));
    return {
      html: `<div class="k-dia">${body}</div>`, body, type: wide.type, width: wide.width, nodes,
      marks: MARKS.filter((m) => [...nodes.values()].includes(m)),
    };
  };
}

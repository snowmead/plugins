/* Build a theme's animated scene: an SVG 540 wide that the changelog page styles and plays.

   The page owns the look (classes sc-node, sc-text, sc-sub, sc-edge, sc-dot s1..s3, sc-chip, sc-cross) and the motion
   (sc-in, sc-fade, sc-pop, sc-hop, each delayed by --t seconds). Keep scenes to these classes: the page drops scripts,
   foreignObject, images, links and on* attributes.

     const g = new Svg('search', 240, 'Alt text that says what the scene shows');
     g.node(14, 32, 150, 44, 'Title', 'subtitle', 0.2);
     g.edge('M164 54 L196 54', 0.5); g.hop(164, 54, 32, 0, 0.6);
     const scene = g.scene('Caption under the scene.');   // { svg, caption } */
import type { Scene } from '../runtime/types';

const E = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]!);

export class Svg {
  private parts: string[] = [];
  /** `key` names the scene's arrow marker: one key per scene in an entry (entry.ts adds the entry's date). */
  constructor(private key: string, private h: number, private alt: string) {}

  text(x: number, y: number, s: string, t: number, cls = 'sc-sub', anchor: 'start' | 'middle' | 'end' = 'start') {
    this.parts.push(`<text class="sc-in ${cls}" style="--t:${t}" x="${x}" y="${y}" text-anchor="${anchor}">${E(s)}</text>`);
  }
  node(x: number, y: number, w: number, h: number, s: string, sub: string | null = null, t = 0, hl = false) {
    const cx = x + w / 2;
    const inner = sub
      ? `<text class="sc-text" x="${cx}" y="${y + h / 2 - 2.5}" text-anchor="middle">${E(s)}</text><text class="sc-sub" x="${cx}" y="${y + h / 2 + 12.5}" text-anchor="middle">${E(sub)}</text>`
      : `<text class="sc-text" x="${cx}" y="${y + h / 2 + 4.5}" text-anchor="middle">${E(s)}</text>`;
    this.parts.push(`<g class="sc-in sc-node${hl ? ' hl' : ''}" style="--t:${t}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>${inner}</g>`);
  }
  edge(d: string, t: number, dash = false, arrow = true) {
    this.parts.push(`<path class="sc-fade sc-edge${dash ? ' dash' : ''}" style="--t:${t}" d="${d}"${arrow ? ` marker-end="url(#arr-${this.key})"` : ''}/>`);
  }
  /** A dot that travels (dx, dy) from (cx, cy), then fades. */
  hop(cx: number, cy: number, dx: number, dy: number, t: number, s = 's1', dur = 0.5) {
    this.parts.push(`<g class="sc-hop" style="--t:${t};--dx:${dx}px;--dy:${dy}px;--dur:${dur}s"><circle class="sc-dot ${s}" cx="${cx}" cy="${cy}" r="5"/></g>`);
  }
  cross(x: number, y: number, t: number, r = 8) {
    this.parts.push(`<path class="sc-in sc-cross" style="--t:${t}" d="M${x - r} ${y - r} L${x + r} ${y + r} M${x + r} ${y - r} L${x - r} ${y + r}"/>`);
  }
  chip(x: number, y: number, w: number, h: number, s: string, t: number) {
    this.parts.push(`<g class="sc-pop sc-chip" style="--t:${t}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/><text class="sc-sub" x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${E(s)}</text></g>`);
  }
  /** A dot in shade s1 (strongest), s2 or s3. */
  dot(cx: number, cy: number, s: string, t: number, r = 6) {
    this.parts.push(`<circle class="sc-pop sc-dot ${s}" style="--t:${t}" cx="${cx}" cy="${cy}" r="${r}"/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, t: number, cls = 'sc-edge') {
    this.parts.push(`<path class="sc-fade ${cls}" style="--t:${t}" d="M${x1} ${y1} L${x2} ${y2}"/>`);
  }
  svg() {
    const defs = `<defs><marker id="arr-${this.key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 L9 5 L1 9 z" fill="currentColor"/></marker></defs>`;
    return `<svg viewBox="0 0 540 ${this.h}" role="img" aria-label="${E(this.alt)}" xmlns="http://www.w3.org/2000/svg">${defs}${this.parts.join('')}</svg>`;
  }
  scene(caption: string): Scene { return { svg: this.svg(), caption }; }
}

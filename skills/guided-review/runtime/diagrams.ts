/* The diagrams. build.ts draws each section's Mermaid diagram with pele (kit/build/diagram.ts) and puts the SVG in
   the data file; its box in the page fills as the section comes near, like the code cards, or when its card unfolds.
   A node with a ref leads to its code: a click, or Enter on the focused node, jumps to the line in the chapter that
   shows it, or opens GitHub for a file the pull request does not change. */
import { ctxOf } from './ctx';
import { jump } from './nav';

const SVG = 'http://www.w3.org/2000/svg';

function fill(box: HTMLElement) {
  const d = ctxOf(box)?.pr.diagrams[box.dataset.dia!];
  if (!d) return;
  box.innerHTML = d.html;
  for (const [id, r] of Object.entries(d.refs ?? {})) {
    for (const node of box.querySelectorAll<SVGGElement>(`.pele-node[data-id="${CSS.escape(id)}"]`)) {
      node.classList.add('is-ref');
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'link');
      const tip = document.createElementNS(SVG, 'title');
      tip.textContent = r.title;
      node.prepend(tip);
    }
  }
}

const filler = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    filler!.unobserve(e.target);
    fill(e.target as HTMLElement);
  }
}, { rootMargin: '900px 0px' }) : null;

/** Watch every diagram box, to fill it when it comes near. */
export function startDiagrams() {
  for (const box of document.querySelectorAll<HTMLElement>('.k-dia[data-dia]')) {
    if (filler) filler.observe(box);
    else fill(box);
  }
}

/** Follow the ref of the diagram node `el` is in. False when it is in none. */
export function followNode(el: Element): boolean {
  const node = el.closest<SVGGElement>('.pele-node.is-ref');
  const box = node?.closest<HTMLElement>('.k-dia[data-dia]');
  const c = box ? ctxOf(box) : null;
  const r = c?.pr.diagrams[box!.dataset.dia!]?.refs?.[node!.dataset.id!];
  if (!c || !r) return false;
  if (r.url) open(r.url, '_blank', 'noopener');
  else void jump(c, r.path, r.line, r.side ?? 'n', r.ch ?? box!.closest<HTMLElement>('.gr-sec')?.dataset.chapter ?? null, node);
  return true;
}

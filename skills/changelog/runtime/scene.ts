/* Scenes are SVG drawn by changelog runs. The page keeps only drawing markup, and plays each scene when it scrolls
   into view; one already on screen when a view opens stays at rest, the finished picture. */
import type { Scene } from './types';
import { h } from './dom';

/** Drops scripts, foreign content, images, links, on* attributes and outside references. */
export function cleanSvg(markup: string): SVGSVGElement | null {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  const svg = tpl.content.querySelector('svg');
  if (!svg) return null;
  svg.querySelectorAll('script, foreignObject, iframe, image, a, use[href^="http"]').forEach((n) => n.remove());
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      const v = a.value.trim().toLowerCase();
      if (a.name.startsWith('on') || ((a.name === 'href' || a.name === 'xlink:href') && !v.startsWith('#'))) el.removeAttribute(a.name);
    }
  }
  return document.importNode(svg, true);
}

let renderedAt = 0;
/** A new view opens: scenes on screen in its first 600 ms stay at rest. */
export function viewOpened() {
  renderedAt = performance.now();
  observer?.disconnect(); // the old view's scenes leave with it
}
const observer = 'IntersectionObserver' in window ? new IntersectionObserver((items) => {
  const atRest = performance.now() - renderedAt < 600;
  for (const it of items) {
    if (!it.isIntersecting) continue;
    if (!atRest) it.target.classList.add('play');
    observer!.unobserve(it.target);
  }
}, { threshold: 0.35 }) : null;

export function scene(sc: Scene | undefined) {
  if (!sc?.svg) return null;
  const svg = cleanSvg(sc.svg);
  if (!svg) return null;
  const replay = h('button', { class: 'replay', type: 'button', text: 'Replay' });
  const fig = h('figure', { class: 'scene' }, svg, h('figcaption', {}, h('span', { text: sc.caption || '' }), replay));
  replay.addEventListener('click', () => { fig.classList.remove('play'); void fig.getBoundingClientRect(); fig.classList.add('play'); });
  observer?.observe(fig);
  return fig;
}

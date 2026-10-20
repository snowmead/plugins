/* The figure viewport. Every figure can be resized from its edges; a static SVG stage can also be panned and
   zoomed. The SVG's viewBox is grown to fit everything drawn in it, so a label past the edge is never cut off.

     zoom   ⌘/Ctrl + wheel, trackpad pinch, two-finger pinch, double-click (Shift: out), + and -
     pan    drag with the left or middle button or a finger (vertical page scroll wins until zoomed in), wheel once
           zoomed in, arrow keys
     reset  0, or the reset button; double-click an edge to restore the figure's size */
import { h, ICON } from './dom';

interface Box { x: number; y: number; w: number; h: number }
const MIN_K = 0.5, MAX_K = 8, PAD = 12;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const interactive = (t: EventTarget | null) => t instanceof Element && !!t.closest('a, button, input, select, textarea, label, [contenteditable]');

/** Pan and zoom for a stage whose only drawing is an inline SVG with a viewBox. */
export function panZoom(el: HTMLElement, stage: HTMLElement) {
  const svg = stage.querySelector<SVGSVGElement>(':scope > svg');
  const vb = svg?.viewBox.baseVal;
  if (!svg || !vb || !vb.width || el.hasAttribute('fixed')) return;

  let fit: Box = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
  let view = { ...fit }, touched = false;
  const k = () => fit.w / view.w;
  const live = () => stage.querySelector(':scope > svg') === svg; // a script may replace the drawing

  /** Grow the authored viewBox to cover every part, the hidden ones included, plus a small margin. */
  const measure = () => {
    let b: DOMRect;
    try { b = svg.getBBox(); } catch { return; }
    if (!b.width || !b.height) return;
    const x0 = Math.min(vb.x, b.x - PAD), y0 = Math.min(vb.y, b.y - PAD);
    const x1 = Math.max(vb.x + vb.width, b.x + b.width + PAD), y1 = Math.max(vb.y + vb.height, b.y + b.height + PAD);
    fit = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (!touched) { view = { ...fit }; draw(); }
  };

  const zoomOut = h('button', { class: 't-btn is-icon is-sm', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (−)', html: ICON.minus, onclick: () => zoomBy(1 / 1.5) });
  const zoomIn = h('button', { class: 't-btn is-icon is-sm', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (+)', html: ICON.plus, onclick: () => zoomBy(1.5) });
  const level = h('button', { class: 't-btn is-sm t-zoom-level', type: 'button', 'aria-label': 'Reset view', title: 'Reset view (0)', onclick: () => reset() }, '100%');
  stage.append(h('div', { class: 't-zoombar', 'data-uncommentable': '' }, zoomOut, level, zoomIn));

  function draw() {
    svg!.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const z = k();
    level.textContent = Math.round(z * 100) + '%';
    stage.classList.toggle('is-zoomed', z > 1.001 || Math.abs(view.x - fit.x) > 0.5 || Math.abs(view.y - fit.y) > 0.5);
    zoomOut.disabled = z <= MIN_K + 1e-6;
    zoomIn.disabled = z >= MAX_K - 1e-6;
  }
  /** Keep the view's center over the drawing, so it cannot be lost off screen. */
  function settle() {
    const cx = clamp(view.x + view.w / 2, fit.x, fit.x + fit.w), cy = clamp(view.y + view.h / 2, fit.y, fit.y + fit.h);
    view.x = cx - view.w / 2; view.y = cy - view.h / 2;
    touched = true;
    draw();
  }
  /** A client point in viewBox units (the SVG keeps its aspect, so this goes through the screen matrix). */
  function toSvg(cx: number, cy: number) {
    const m = svg!.getScreenCTM();
    if (!m) return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  const unitsPerPx = () => 1 / (svg!.getScreenCTM()?.a || 1);

  function zoomBy(f: number, at?: { x: number; y: number }) {
    const nk = clamp(k() * f, MIN_K, MAX_K), s = k() / nk;
    const p = at ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    view = { x: p.x - (p.x - view.x) * s, y: p.y - (p.y - view.y) * s, w: view.w * s, h: view.h * s };
    settle();
  }
  function panBy(dxPx: number, dyPx: number) {
    const u = unitsPerPx();
    view.x -= dxPx * u; view.y -= dyPx * u;
    settle();
  }
  function reset() { view = { ...fit }; touched = false; draw(); }

  // wheel: ⌘/Ctrl or a pinch zooms; a plain wheel pans only once zoomed in, otherwise the page scrolls
  stage.addEventListener('wheel', (e) => {
    if (!live()) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomBy(Math.exp(clamp(-d, -100, 100) * 0.01), toSvg(e.clientX, e.clientY));
    } else if (stage.classList.contains('is-zoomed')) {
      e.preventDefault();
      const m = e.deltaMode === 1 ? 16 : 1;
      panBy(-e.deltaX * m, -e.deltaY * m);
    }
  }, { passive: false });

  // pointers: one drags, two pinch
  const pts = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (!live() || interactive(e.target) || (e.target as Element).closest('.t-edge')) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    e.preventDefault(); // no text selection, no middle-button autoscroll
    stage.focus({ preventScroll: true }); // so the keys work after a click
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* the drag still works while the pointer stays over the stage */ }
    stage.classList.add('is-panning');
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (e.pointerType === 'mouse' && !e.buttons) return up(e); // released outside the stage
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      p.x = e.clientX; p.y = e.clientY;
      const [c, d] = [...pts.values()];
      const after = Math.hypot(c.x - d.x, c.y - d.y);
      const nmid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
      if (pinch && before) zoomBy(after / before, toSvg(nmid.x, nmid.y));
      panBy(nmid.x - mid.x, nmid.y - mid.y);
      pinch = 1;
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    panBy(dx, dy);
  });
  function up(e: PointerEvent) {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = 0;
    if (!pts.size) stage.classList.remove('is-panning');
  }
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('dblclick', (e) => {
    if (!live() || interactive(e.target) || (e.target as Element).closest('.t-edge')) return;
    e.preventDefault();
    zoomBy(e.shiftKey ? 1 / 2 : 2, toSvg(e.clientX, e.clientY));
  });

  // keys, when the stage has focus
  stage.tabIndex = 0;
  stage.setAttribute('aria-roledescription', 'zoomable figure');
  stage.setAttribute('aria-keyshortcuts', '+ - 0 ArrowUp ArrowDown ArrowLeft ArrowRight');
  stage.addEventListener('keydown', (e) => {
    if (e.target !== stage || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? 120 : 40;
    const act: Record<string, () => void> = {
      '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(1 / 1.25), '_': () => zoomBy(1 / 1.25), '0': reset,
      ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0), ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
    };
    const f = act[e.key];
    if (f) { e.preventDefault(); f(); }
  });

  // measure once laid out (getBBox forces layout, so never during boot); a figure laid out while hidden waits
  // for its first real size
  new ResizeObserver((_, ro) => { if (stage.clientWidth) { ro.disconnect(); measure(); } }).observe(stage);
  document.fonts?.ready.then(() => { if (stage.clientWidth) measure(); }); // text widths change once the web font lands
}

/** Edge handles: drag the top or bottom to change the height, a side to change the width (it grows on both
    sides, up to the window). Double-click an edge to restore the original size. */
export function resizable(el: HTMLElement, stage: HTMLElement) {
  if (el.hasAttribute('fixed')) return;
  const start = { x: 0, y: 0, w: 0, hgt: 0, id: -1 };
  const edges = (['n', 's', 'w', 'e'] as const).map((side) => {
    const edge = h('div', { class: `t-edge is-${side}`, 'aria-hidden': 'true', 'data-uncommentable': '' });
    const vertical = side === 'n' || side === 's';
    edge.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try { edge.setPointerCapture(e.pointerId); } catch { /* best effort */ }
      start.id = e.pointerId;
      start.x = e.clientX; start.y = e.clientY;
      start.w = el.getBoundingClientRect().width; start.hgt = stage.getBoundingClientRect().height;
      el.classList.add('is-resizing');
    });
    edge.addEventListener('pointermove', (e) => {
      if (e.pointerId !== start.id) return;
      if (vertical) {
        const dy = (e.clientY - start.y) * (side === 's' ? 1 : -1);
        stage.style.height = Math.max(120, start.hgt + dy) + 'px';
        stage.classList.add('is-sized');
      } else {
        const dx = (e.clientX - start.x) * (side === 'e' ? 1 : -1);
        const max = Math.max(320, document.documentElement.clientWidth || innerWidth) - 32;
        const w = clamp(start.w + 2 * dx, 280, max);
        el.style.setProperty('--fig-w', w + 'px');
        el.classList.add('is-widened');
      }
    });
    const end = () => { start.id = -1; el.classList.remove('is-resizing'); };
    edge.addEventListener('pointerup', end);
    edge.addEventListener('pointercancel', end);
    edge.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (vertical) { stage.style.height = ''; stage.classList.remove('is-sized'); }
      else { el.style.removeProperty('--fig-w'); el.classList.remove('is-widened'); }
    });
    return edge;
  });
  el.classList.add('is-resizable');
  el.append(...edges);
}

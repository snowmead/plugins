/* <t-figure>: a stage, optional <t-control>s and <t-step>s, a caption. Static SVG follows the steps through
   data-show / data-focus; data-in and data-draw parts build in with motion the first time the figure is seen.
   Scripted figures register with thinkr.figure() and set up lazily, when the figure nears the screen. */
import type { Controls, Fig, RGBA, Size, Tokens } from './types';
import { h } from '../kit/web/dom';
import { ICON } from '../kit/web/icons';
import { sound } from '../kit/web/sound';
import { isDark, onTheme } from '../kit/web/theme';
import { anim, config, hasMotion, load, motionReady, reduced } from './libs';
import { panZoom, resizable } from './view';

type Setup = (fig: Fig) => void | Promise<void>;
interface FigState extends Fig {
  step: number; visible: boolean;
  /** set up (a screen ahead) */ seen: boolean;
  /** built in (the first time on screen) */ built: boolean;
  resize: Set<(s: Size) => void>; control: Set<(c: Controls, n: string) => void>;
  stepCbs: Set<(n: number, p: number) => void>; vis: Set<(v: boolean) => void>;
}

// ---------------------------------------------------------------- theme
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
const themeCbs = new Set<(t: Tokens) => void>();
const TOKENS = ['bg', 'fg', 'card', 'muted', 'muted-fg', 'border', 'primary', 'ok', 'bad', 'c1', 'c2', 'c3', 'c4', 'c5'] as const;
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();

/** Any CSS color (oklch included) as 0..1 floats, through a 1×1 canvas. */
export function rgba(css: string): RGBA {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
}

export function tokens(): Tokens {
  const out: Record<string, string> = {};
  for (const t of TOKENS) {
    const [r, g, b, a] = rgba(cssVar(t));
    out[t === 'muted-fg' ? 'mutedFg' : t] = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${+a.toFixed(3)})`;
  }
  return { ...(out as Omit<Tokens, 'dark' | 'font' | 'mono'>), dark: isDark(), font: 'Geist, system-ui, sans-serif', mono: '"Geist Mono", ui-monospace, monospace' };
}

onTheme(() => { const t = tokens(); themeCbs.forEach((cb) => cb(t)); });

// ---------------------------------------------------------------- motion
/** "2", "2-4", "2+" or "1,3": is step n in it? */
const inSpec = (spec: string, n: number) => spec.split(',').some((part) => {
  const p = part.trim();
  if (!p) return false;
  if (p.endsWith('+')) return n >= +p.slice(0, -1);
  const [a, b] = p.split('-').map(Number);
  return b ? n >= a && n <= b : n === a;
});

// Entrances move parts and never fade them from 0, so a frame frozen mid-animation (a thumbnail) still shows
// everything. Opacity belongs to the step classes (is-off, is-dim); inline transforms are cleared after.
function enter(p: Element, delay = 0) {
  if (!hasMotion()) return;
  if (p.hasAttribute('data-draw')) { anim(p, { pathLength: [0, 1] }, { type: 'tween', duration: 0.42, ease: [0.2, 0.8, 0.2, 1], delay }); return; }
  anim(p, { transform: ['translateY(10px) scale(0.98)', 'translateY(0px) scale(1)'] }, { delay })
    ?.finished.then(() => { (p as HTMLElement).style.transform = ''; }).catch(() => {});
}

// ---------------------------------------------------------------- WebGPU
// one device for every figure, requested at load when the page uses vgpu, so a shader figure never waits for it.
// vgpu takes only prepared shaders, which its .wgsl imports make at build; a figure writes its WGSL as a string at
// run time, so effect, compute and draw prepare a string first (prepareShader, also handed to figures as `prepare`).
let gpu: Promise<any> | null = null;
export const startGpu = () => (gpu ??= Promise.all([load('vgpu'), load('vgpu-prepare')]).then(async ([v, { prepareShader }]) => {
  const prep = (s: unknown) => (typeof s === 'string' ? prepareShader(s) : s);
  return {
    ...v, gpu: await v.init(), vgpu: v, prepare: prepareShader,
    effect: (g: unknown, s: unknown, o?: unknown) => v.effect(g, prep(s), o),
    compute: (g: unknown, s: unknown, o?: unknown) => v.compute(g, prep(s), o),
    draw: (g: unknown, o: { shader: unknown }) => v.draw(g, { ...o, shader: prep(o.shader) }),
  };
}));

// ---------------------------------------------------------------- figures
export function createFigures(page: HTMLElement) {
  if (config.use.includes('vgpu')) startGpu().catch(() => {});
  const figs = new Map<string, FigState>();
  const setups = new Map<string, Setup>();
  const run = (fig: FigState, setup: Setup) => Promise.resolve().then(() => setup(fig)).catch((err) => fig.fail(err));

  page.querySelectorAll<HTMLElement>('t-figure').forEach((el, i) => {
    const fig = build(el, el.id || `fig-${i + 1}`);
    figs.set(fig.id, fig);
  });

  // setup runs a full screen ahead, so a figure is drawn before it scrolls in
  const ahead = new IntersectionObserver((entries) => entries.forEach((e) => {
    const fig = figs.get(e.target.id);
    if (!fig || !e.isIntersecting || fig.seen) return;
    fig.seen = true;
    ahead.unobserve(fig.el);
    const setup = setups.get(fig.id);
    if (setup) void run(fig, setup);
  }), { rootMargin: '100% 0px' });
  // visible means on screen: loops run only then, and a figure builds in the first time it shows
  const onScreen = new IntersectionObserver((entries) => entries.forEach((e) => {
    const fig = figs.get(e.target.id);
    if (!fig) return;
    const first = e.isIntersecting && !fig.built;
    fig.visible = e.isIntersecting;
    fig.vis.forEach((cb) => cb(fig.visible));
    if (!first) return;
    fig.built = true;
    // build in only when motion is ready now: a build that starts late would move a figure the reader already sees
    const shownAt = performance.now();
    void motionReady.then(() => {
      if (performance.now() - shownAt > 120) return;
      fig.stage.querySelectorAll('[data-in],[data-draw]').forEach((p, j) => { if (!p.classList.contains('is-off')) enter(p, Math.min(0.03 * j, 0.24)); });
    });
  }));
  figs.forEach((f) => { ahead.observe(f.el); onScreen.observe(f.el); });

  return {
    register(sel: string | Element, setup: Setup) {
      const el = typeof sel === 'string' ? page.querySelector(sel) : sel;
      const fig = el && figs.get(el.id);
      if (!fig) { console.warn('thinkr.figure: no <t-figure> for', sel); return; }
      setups.set(fig.id, setup);
      if (fig.seen) void run(fig, setup);
    },
  };
}

function build(el: HTMLElement, id: string): FigState {
  el.id = id;
  const caption = el.querySelector(':scope > figcaption');
  const steps = [...el.querySelectorAll(':scope > t-step')];
  const ctrlEls = [...el.querySelectorAll(':scope > t-control')];
  const stage = h('div', { class: 't-stage' });
  for (const n of [...el.childNodes]) if (n !== caption && !steps.includes(n as Element) && !ctrlEls.includes(n as Element)) stage.append(n);
  const attr = (n: string) => el.getAttribute(n);
  if (attr('ratio')) { stage.classList.add('has-ratio'); stage.style.aspectRatio = attr('ratio')!; }
  if (attr('height')) { stage.classList.add('has-ratio'); stage.style.height = attr('height')!; }
  if (attr('min-width')) { stage.classList.add('is-wide'); stage.style.setProperty('--min', parseInt(attr('min-width')!, 10) + 'px'); }
  el.setAttribute('data-comment-target', '');
  el.setAttribute('role', 'figure');
  if (attr('alt')) el.setAttribute('aria-label', attr('alt')!);

  const fig: FigState = {
    el, id, stage, steps: steps.length, step: 1, controls: {}, reducedMotion: reduced, visible: false, seen: false, built: false,
    resize: new Set(), control: new Set(), stepCbs: new Set(), vis: new Set(),
    get size() { return { width: stage.clientWidth, height: stage.clientHeight }; },
    canvas() { return stage.querySelector<HTMLCanvasElement>(':scope > canvas') ?? stage.insertBefore(h('canvas'), stage.firstChild); },
    onResize: (cb) => void fig.resize.add(cb),
    onControl: (cb) => void fig.control.add(cb),
    onStep: (cb) => void fig.stepCbs.add(cb),
    onVisible: (cb) => void fig.vis.add(cb),
    onTheme: (cb) => void themeCbs.add(cb),
    tokens,
    color: (name) => rgba(cssVar(name) || name),
    load, anim,
    motion: () => motionReady,
    vgpu: startGpu,
    loop(fn) {
      let raf = 0, last = performance.now(), stopped = false;
      const tick = (now: number) => {
        if (stopped) return;
        raf = requestAnimationFrame(tick);
        if (fig.visible && !document.hidden) fn(now / 1000, Math.min(0.1, (now - last) / 1000));
        last = now;
      };
      raf = requestAnimationFrame(tick);
      return () => { stopped = true; cancelAnimationFrame(raf); };
    },
    goTo: (n) => setStep(Math.max(1, Math.min(steps.length, n))),
    fail(err) {
      console.error(err);
      stage.replaceChildren(h('div', { class: 't-error' }, 'This figure could not load. ' + ((err as Error)?.message ?? '')));
    },
  };

  const foot = h('div', { class: 't-figfoot', 'data-uncommentable': '' });

  // controls: range, select, toggle
  for (const c of ctrlEls) {
    const name = c.getAttribute('name') ?? 'value', type = c.getAttribute('type') ?? 'range', cid = `${id}--${name}`;
    const unit = c.getAttribute('unit') ?? '';
    let input: HTMLInputElement | HTMLSelectElement, read: () => number | string | boolean, out: HTMLOutputElement | null = null;
    if (type === 'select') {
      const sel = h('select', { id: cid }, (c.getAttribute('options') ?? '').split('|').map((o) => h('option', { value: o }, o)));
      sel.value = c.getAttribute('value') ?? sel.options[0]?.value ?? '';
      input = sel; read = () => sel.value;
    } else if (type === 'toggle') {
      const box = h('input', { id: cid, type: 'checkbox', class: 't-switch', checked: c.hasAttribute('checked') });
      input = box; read = () => box.checked;
    } else {
      const range = h('input', { id: cid, type: 'range', min: c.getAttribute('min') ?? 0, max: c.getAttribute('max') ?? 1, step: c.getAttribute('step') ?? 0.01, value: c.getAttribute('value') ?? 0.5 });
      input = range; read = () => +range.value;
      out = h('output', { for: cid });
    }
    const show = () => { if (out) out.textContent = (+input.value).toLocaleString(undefined, { maximumFractionDigits: 3 }) + unit; };
    fig.controls[name] = read();
    show();
    input.addEventListener('input', () => { fig.controls[name] = read(); show(); fig.control.forEach((cb) => cb(fig.controls, name)); });
    if (type !== 'range') input.addEventListener('change', () => sound.play('toggle'));
    foot.append(h('label', { class: 't-control', for: cid }, h('span', {}, c.getAttribute('label') ?? name), input, out));
    c.remove();
  }

  // steps: Back, Play, Next, the step text and dots
  let playing = 0;
  const stepText = h('div', { class: 't-steptext', 'aria-live': 'polite' });
  const dots = h('div', { class: 't-dots', 'aria-hidden': 'true' }, steps.map(() => h('i')));
  const stop = () => { clearInterval(playing); playing = 0; play.innerHTML = ICON.play; };
  const back = h('button', { class: 'k-btn is-icon is-sm', type: 'button', 'aria-label': 'Previous step', html: ICON.left, onclick: () => { stop(); fig.goTo(fig.step - 1); } });
  const next = h('button', { class: 'k-btn is-icon is-sm', type: 'button', 'aria-label': 'Next step', html: ICON.right, onclick: () => { stop(); fig.goTo(fig.step + 1); } });
  const play = h('button', { class: 'k-btn is-icon is-sm', type: 'button', 'aria-label': 'Play steps', html: ICON.play });
  play.addEventListener('click', () => {
    if (playing) return stop();
    if (fig.step === steps.length) fig.goTo(1);
    play.innerHTML = ICON.pause;
    playing = window.setInterval(() => (fig.step >= steps.length ? stop() : fig.goTo(fig.step + 1)), +(attr('interval') ?? 0) || 2600);
  });

  function setStep(n: number, first = false) {
    const prev = fig.step;
    fig.step = n;
    if (steps.length) {
      stepText.replaceChildren(h('span', {}, `${n}/${steps.length}`), ...[...steps[n - 1].childNodes].map((x) => x.cloneNode(true)));
      [...dots.children].forEach((d, i) => d.classList.toggle('is-on', i === n - 1));
      back.disabled = n === 1;
      next.disabled = n === steps.length;
    }
    for (const p of stage.querySelectorAll<HTMLElement | SVGElement>('[data-show],[data-focus]')) {
      const wasOff = p.classList.contains('is-off');
      if (p.dataset.show) p.classList.toggle('is-off', !inSpec(p.dataset.show, n));
      if (p.dataset.focus) p.classList.toggle('is-dim', !inSpec(p.dataset.focus, n));
      if (!first && wasOff && !p.classList.contains('is-off')) enter(p);
    }
    if (!first && prev !== n) { sound.play('step'); fig.stepCbs.forEach((cb) => cb(n, prev)); }
  }
  if (steps.length) {
    foot.prepend(h('div', { class: 't-stepper' }, h('div', { class: 't-stepbtns' }, back, play, next), stepText));
    foot.append(dots);
    steps.forEach((s) => s.remove());
    setStep(1, true);
  }

  el.append(stage);
  if (foot.childNodes.length) el.append(foot);
  if (caption) el.append(caption);
  if (!stage.classList.contains('has-ratio')) panZoom(el, stage);
  resizable(el, stage);
  new ResizeObserver(() => fig.resize.forEach((cb) => cb(fig.size))).observe(stage);
  return fig;
}

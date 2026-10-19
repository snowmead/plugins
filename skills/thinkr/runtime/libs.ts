/* Libraries load from the pinned URLs build.ts injects (runtime/libs.json). build.ts also preloads the ones a page
   uses from its head, so by the time a figure asks, the bytes are usually here already; warm() evaluates them at
   startup so a figure's setup never waits. motion drives every animation; without it (reduced motion, offline)
   the page still works, only without the movement. */
import type { AnimOpts, Config, Keyframes, Motion, MotionAnimation } from './types';
import { h } from './dom';

export const config: Config = window.THINKR ?? { libs: {}, use: [], sounds: {} };
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const loaded = new Map<string, Promise<any>>();

const script = (url: string, name: string) => new Promise<void>((ok, no) => {
  document.head.append(h('script', { src: url, onload: () => ok(), onerror: () => no(new Error('could not load ' + name)) }));
});

/** A name from libs.json (motion, vgpu, d3, plot) or `npm:pkg@x.y.z[/path]`. */
export function load<T = any>(name: string): Promise<T> {
  const hit = loaded.get(name);
  if (hit) return hit;
  const lib = config.libs[name];
  let p: Promise<T>;
  if (lib?.global) {
    const g = lib.global;
    p = Promise.all((lib.deps ?? []).map((d) => load(d)))
      .then(() => ((window as any)[g] ?? script(lib.url, name).then(() => (window as any)[g])) as T);
  } else if (lib) {
    p = import(lib.url) as Promise<T>;
  } else if (/^npm:@?[^@\s]+@\d+\.\d+\.\d+/.test(name)) {
    const path = name.slice(4);
    p = import('https://cdn.jsdelivr.net/npm/' + path + (/\.m?js$|\+esm$/.test(path) ? '' : '/+esm')) as Promise<T>;
  } else {
    return Promise.reject(new Error(`thinkr.load: unknown "${name}". Use ${Object.keys(config.libs).join(', ')} or npm:pkg@x.y.z`));
  }
  loaded.set(name, p);
  return p;
}

/** Start every library the page uses now, in parallel, instead of when its figure scrolls near. */
export const warm = () => config.use.forEach((n) => { if (n !== 'motion') load(n).catch(() => {}); });

let M: Motion | null = null;
export const motionReady: Promise<Motion | null> = reduced
  ? Promise.resolve(null)
  : load<Motion>('motion').then((m) => (M = m)).catch(() => null);
export const hasMotion = () => M !== null;

/** motion's animate() with the page's spring: short and crisp. Returns null until motion loads. */
export function anim(el: Element | null | undefined, keyframes: Keyframes, opts: AnimOpts = {}): MotionAnimation | null {
  return M && el ? M.animate(el, keyframes, { type: 'spring', bounce: 0.1, duration: 0.28, ...opts }) : null;
}

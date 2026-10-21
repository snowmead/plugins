/* The kit's UI sounds (kit/sounds.json, rendered with earshot by kit/scripts/sounds.py), which the build hands over as
   window.KIT. The promises every page keeps:

   - No sound plays before the reader's first click or key press. One button mutes, and the choice stays in the
     browser. Sounds pause while the tab is hidden, and one playing stops when the reader mutes.
   - A sound confirms what the reader just did; it never alarms. Scrolling, loading and plain links stay silent.
   - Hover ticks play only for a mouse or trackpad, at most one each 80 ms, far under the other sounds.

   They decode in the background right after load (an OfflineAudioContext needs no gesture). The AudioContext may start
   only after a gesture, and opening the audio device can take 100 ms, so it starts just after the first gesture's frame
   has painted: that interaction never waits, and only its own sound is skipped. */
import type { SoundName } from './types';
import { store } from './dom';

const KEY = 'kit:sound';
const HOVER_GAP_MS = 80;
const kit = window.KIT?.sounds ?? {};
const bufs = new Map<string, AudioBuffer>();
const playing = new Set<AudioBufferSourceNode>();
const buttons = new Set<HTMLElement>();
let ctx: AudioContext | null = null;
let lastHover = 0;

function decode() {
  const Offline = window.OfflineAudioContext;
  if (!Offline) return;
  const off = new Offline(1, 1, 32000);
  for (const [name, s] of Object.entries(kit)) {
    const bin = atob(s.uri.split(',')[1]);
    off.decodeAudioData(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer).then((b) => bufs.set(name, b), () => {});
  }
}
(window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1)))(decode);

function start() {
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (ctx || !AC) return;
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch { ctx = null; }
}

function show() {
  for (const b of buttons) {
    b.setAttribute('aria-pressed', String(sound.on));
    b.title = sound.on ? 'Mute sounds' : 'Turn sounds on';
  }
}

export const sound = {
  on: store.get<boolean>(KEY) !== false,
  /** Plays at once: no await between the click and the sound. */
  play(name: SoundName) {
    const buf = bufs.get(name), level = kit[name]?.db;
    if (!this.on || !ctx || !buf || level == null || document.hidden) return;
    if (name === 'hover') {
      const now = performance.now();
      if (now - lastHover < HOVER_GAP_MS) return;
      lastHover = now;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.value = 10 ** (level / 20);
    src.connect(gain).connect(ctx.destination);
    src.addEventListener('ended', () => playing.delete(src));
    playing.add(src);
    src.start();
    dispatchEvent(new CustomEvent('kit:sound', { detail: name })); // the tests listen for these
  },
  toggle() {
    this.on = !this.on;
    store.set(KEY, this.on);
    if (this.on) { start(); this.play('toggle'); }
    else { for (const src of playing) { try { src.stop(); } catch { /* already ended */ } } playing.clear(); }
    show();
  },
};

/** Wire a speaker button made from soundButton() (kit/web/icons.ts). The ones in the page at load are wired already. */
export function bindSoundButton(btn: HTMLElement) {
  if (buttons.has(btn)) return;
  buttons.add(btn);
  btn.addEventListener('click', () => sound.toggle());
  show();
}
document.querySelectorAll<HTMLElement>('[data-k-sound]').forEach(bindSoundButton);

/** Hover ticks for the controls under `scope` that carry data-hover, with a mouse or trackpad only. */
export function hoverTicks(scope: ParentNode = document) {
  scope.addEventListener('pointerover', (e) => {
    const ev = e as PointerEvent;
    if (ev.pointerType !== 'mouse') return;
    const t = (ev.target as Element).closest('[data-hover]');
    if (!t || (ev.relatedTarget && t.contains(ev.relatedTarget as Node))) return;
    sound.play('hover');
  });
}

// The first click or key press (Escape and Tab do not count as one: they start no audio) starts the audio after its
// frame. Then the callbacks of afterFirstGesture run, once the audio device is open or there is none to wait for.
const after: (() => void)[] = [];
let gestured = false, ready = false;
function first(e: Event) {
  if (gestured || (e instanceof KeyboardEvent && (e.key === 'Escape' || e.key === 'Tab'))) return;
  gestured = true;
  requestAnimationFrame(() => setTimeout(() => {
    if (sound.on) start();
    const run = () => { ready = true; after.splice(0).forEach((cb) => cb()); };
    if (ctx) ctx.resume().then(run, run); else run();
  }));
}
addEventListener('pointerdown', first, { capture: true });
addEventListener('keydown', first, { capture: true });
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) void ctx.suspend(); else if (sound.on) void ctx.resume();
});

/** Run cb once, after the reader's first gesture has started the audio (or would have, when muted). */
export function afterFirstGesture(cb: () => void) {
  if (ready) cb(); else after.push(cb);
}

/* UI sounds rendered with earshot (scripts/sounds.py), embedded by build.ts. They are decoded in the background
   right after load (an OfflineAudioContext needs no gesture), so the first click already has its buffer ready;
   the AudioContext itself starts on the first gesture, as browsers require, in its lowest-latency mode. The
   speaker button in the bar mutes it, and the choice is remembered. */
import type { SoundName } from './types';
import { config } from './libs';
import { store } from './dom';

let ctx: AudioContext | null = null;
const bufs = new Map<string, AudioBuffer>();

function decode() {
  const Offline = window.OfflineAudioContext;
  if (!Offline) return;
  const off = new Offline(1, 1, 32000);
  for (const [name, s] of Object.entries(config.sounds)) {
    const bin = atob(s.uri.split(',')[1]);
    off.decodeAudioData(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer).then((b) => bufs.set(name, b), () => {});
  }
}
(window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1)))(decode);

export const sound = {
  on: store.get<boolean>('thinkr:sound') !== false,
  start() {
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (ctx || !AC) return;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { ctx = null; }
  },
  /** Plays at once: no await between the click and the sound. */
  play(name: SoundName) {
    const buf = bufs.get(name);
    if (!this.on || !ctx || !buf) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.value = 10 ** ((config.sounds[name]?.db ?? -24) / 20); // levels are set in scripts/sounds.py
    src.connect(gain).connect(ctx.destination);
    src.start();
  },
  toggle() {
    this.on = !this.on;
    store.set('thinkr:sound', this.on);
    this.start();
    this.play('toggle');
  },
};

addEventListener('pointerdown', () => sound.start(), { once: true, capture: true });
addEventListener('keydown', () => sound.start(), { once: true, capture: true });

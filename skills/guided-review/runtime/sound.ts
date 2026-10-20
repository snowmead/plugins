/* Quiet UI sounds, the same earshot kit as thinkr (rendered by thinkr's scripts/sounds.py), embedded by build.ts.
   They decode in the background right after load (an OfflineAudioContext needs no gesture). The AudioContext may
   start only after a gesture, and opening the audio device can take 100 ms, so it starts just after the first
   gesture's frame has painted: that interaction never waits, and only its own sound is skipped. The speaker button
   in the bar mutes it, and the choice is remembered. Sound confirms; it never alarms. */
import type { SoundName } from './types';
import { $, D, store } from './dom';

let ctx: AudioContext | null = null;
const bufs = new Map<string, AudioBuffer>();

function decode() {
  const Offline = window.OfflineAudioContext;
  if (!Offline) return;
  const off = new Offline(1, 1, 32000);
  for (const [name, s] of Object.entries(D.sounds)) {
    const bin = atob(s.uri.split(',')[1]);
    off.decodeAudioData(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer).then((b) => bufs.set(name, b), () => {});
  }
}
(window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1)))(decode);

export const sound = {
  on: store.get<boolean>('gr:sound') !== false,
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
    gain.gain.value = 10 ** ((D.sounds[name]?.db ?? -24) / 20);
    src.connect(gain).connect(ctx.destination);
    src.start();
  },
  show() {
    const b = $('#gr-sound');
    b?.setAttribute('aria-pressed', String(this.on));
    b?.setAttribute('title', this.on ? 'Mute sounds' : 'Turn sounds on');
  },
  toggle() {
    this.on = !this.on;
    store.set('gr:sound', this.on);
    this.show();
    this.play('toggle');
  },
};

const later = () => requestAnimationFrame(() => setTimeout(() => sound.start()));
addEventListener('pointerdown', later, { once: true, capture: true });
addEventListener('keydown', later, { once: true, capture: true });

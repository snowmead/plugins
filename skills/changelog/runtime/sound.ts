/* Six quiet sounds from earshot, embedded by build.ts: open an entry, go back, hover, the switch, copy a link, and a new
   entry. The promises the page keeps:

   - No sound plays before the reader's first click or key press. One switch mutes; the choice stays in the browser.
     Sounds pause while the tab is hidden.
   - Opening an entry, going back, the switch, copying a link, and once an entry newer than the last one this browser
     saw. Scrolling, loading and plain links stay silent.
   - Hover ticks play only with a mouse or trackpad, at most one every 80 ms, 12 dB under the others.

   The sounds decode in the background right after load (an OfflineAudioContext needs no gesture). The AudioContext may
   start only after a gesture, and opening the audio device can take 100 ms, so it starts just after the first
   gesture's frame has painted: that interaction never waits, and only its own sound is skipped. */
import type { SoundName } from './types';
import { CFG, store } from './dom';

const MUTED_KEY = 'changelog-muted';
const HOVER_GAP_MS = 80;
const bufs = new Map<string, AudioBuffer>();

function decode() {
  const Offline = window.OfflineAudioContext;
  if (!Offline) return;
  const off = new Offline(1, 1, 32000);
  for (const [name, s] of Object.entries(CFG.sounds)) {
    const bin = atob(s.uri.split(',')[1]);
    off.decodeAudioData(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer).then((b) => bufs.set(name, b), () => {});
  }
}
(window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1)))(decode);

type State = 'silent' | 'ready' | 'muted' | 'paused';
const gain = (db: number) => 10 ** (db / 20);

export const sound = {
  state: 'silent' as State,
  muted: store.get(MUTED_KEY) === '1',
  ctx: null as AudioContext | null,
  master: null as GainNode | null,
  playing: new Set<AudioBufferSourceNode>(),
  lastHover: 0,
  /** Called from the first gesture's next task: the AudioContext and the master gain. */
  start() {
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC || !Object.keys(CFG.sounds).length) { this.state = 'muted'; return; }
    try {
      if (!this.ctx) {
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.master.gain.value = gain(CFG.master);
        this.master.connect(this.ctx.destination);
      }
      void this.ctx.resume();
      this.state = document.hidden ? 'paused' : 'ready';
    } catch { this.state = 'muted'; }
  },
  play(name: SoundName) {
    const buf = bufs.get(name);
    if (this.state !== 'ready' || !this.ctx || !buf) return;
    if (name === 'hover') {
      const now = performance.now();
      if (now - this.lastHover < HOVER_GAP_MS) return;
      this.lastHover = now;
    }
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = buf;
    g.gain.value = gain(CFG.levels[name] ?? 0);
    src.connect(g).connect(this.master!);
    src.addEventListener('ended', () => this.playing.delete(src));
    this.playing.add(src);
    src.start();
    window.dispatchEvent(new CustomEvent('changelog-sound', { detail: name }));
  },
  toggle() {
    if (this.muted) {
      this.muted = false;
      store.set(MUTED_KEY, '0');
      this.start();
      this.play('switch');
    } else {
      this.muted = true;
      store.set(MUTED_KEY, '1');
      this.state = 'muted';
      // A sound already playing stops with the switch.
      for (const src of this.playing) { try { src.stop(); } catch { /* already ended */ } }
      this.playing.clear();
    }
    renderSwitch();
  },
  visibility() {
    if (!this.ctx) return;
    if (document.hidden && this.state === 'ready') { void this.ctx.suspend(); this.state = 'paused'; }
    else if (!document.hidden && this.state === 'paused') { void this.ctx.resume(); this.state = 'ready'; }
  },
};

export function renderSwitch() {
  const btn = document.getElementById('sound')!, lbl = document.getElementById('sound-label')!;
  const on = !sound.muted;
  btn.setAttribute('aria-pressed', String(on));
  lbl.textContent = on ? 'Sound on' : 'Sound off';
  btn.title = on ? (sound.state === 'silent' ? 'Sounds play after your first click. Press to mute.' : 'Press to mute sounds') : 'Press to turn sounds on';
}

/** The first click or key press: start the audio after this frame, then let the new-entry sound check. */
export function onFirstGesture(after: () => void) {
  let done = false;
  const first = () => {
    if (done) return;
    done = true;
    requestAnimationFrame(() => setTimeout(() => {
      if (sound.muted) sound.state = 'muted'; else sound.start();
      renderSwitch();
      setTimeout(after, 140);
    }));
  };
  addEventListener('pointerdown', first, { capture: true });
  addEventListener('keydown', (e: KeyboardEvent) => { if (e.key !== 'Escape' && e.key !== 'Tab') first(); }, { capture: true });
  document.addEventListener('visibilitychange', () => sound.visibility());
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = (e.target as Element).closest('[data-hover]');
    if (!t || (e.relatedTarget && t.contains(e.relatedTarget as Node))) return;
    sound.play('hover');
  });
}

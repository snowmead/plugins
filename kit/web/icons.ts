/* The kit's icons: 16 px line icons in the stroke of shadcn/ui's (lucide's) set, as SVG markup. Plain strings, so a
   build script can write them into a page as well as a runtime can. */

const svg = (body: string, view = 16, extra = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"') =>
  `<svg viewBox="0 0 ${view} ${view}" ${extra} aria-hidden="true">${body}</svg>`;

export const ICON = {
  left: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  right: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  down: svg('<path d="M3 4.5 6 7.5 9 4.5"/>', 12, 'width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'),
  play: svg('<path d="M5 3.2v9.6a.5.5 0 0 0 .77.42l7.2-4.8a.5.5 0 0 0 0-.84l-7.2-4.8A.5.5 0 0 0 5 3.2Z"/>', 16, 'fill="currentColor"'),
  pause: svg('<rect x="4" y="3" width="3" height="10" rx=".8"/><rect x="9" y="3" width="3" height="10" rx=".8"/>', 16, 'fill="currentColor"'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  minus: svg('<path d="M3.5 8h9"/>'),
  check: svg('<path d="m2.5 6.2 2.3 2.3 4.7-5"/>', 12, 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'),
  sound: svg('<path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9"/>'),
  mute: svg('<path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="m10.5 6 4 4M14.5 6l-4 4"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  link: svg('<path d="M6.5 9.5a2.5 2.5 0 0 0 3.54 0l2.5-2.5a2.5 2.5 0 0 0-3.54-3.54l-.75.75"/><path d="M9.5 6.5a2.5 2.5 0 0 0-3.54 0l-2.5 2.5a2.5 2.5 0 0 0 3.54 3.54l.75-.75"/>'),
  note: svg('<circle cx="8" cy="8" r="6"/><path d="M8 5.5v3M8 10.5v.01"/>'),
  tip: svg('<path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.5 8.2V11h5V9.7A4.5 4.5 0 0 0 8 1.5Z"/>'),
  warn: svg('<path d="M7.13 2.5 1.6 12a1 1 0 0 0 .87 1.5h11.06a1 1 0 0 0 .87-1.5L8.87 2.5a1 1 0 0 0-1.74 0Z"/><path d="M8 6.5v2.5M8 11v.01"/>'),
};

/** The speaker button every page puts at the end of its bar. kit/web/sound.ts wires each one on the page at load
    (and any made later, through bindSoundButton) and keeps aria-pressed and the title in step with the sound. */
export const soundButton = (cls = 'k-btn is-ghost is-icon') =>
  `<button type="button" class="${cls} k-sound" data-k-sound aria-label="Sound" aria-pressed="true" title="Mute sounds">`
  + ICON.sound.replace('<svg ', '<svg class="is-on" ') + ICON.mute.replace('<svg ', '<svg class="is-off" ') + '</button>';

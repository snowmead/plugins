/* Terms: a word the guide defines is marked in the text (build.ts marks it), and its meaning opens in one shared
   tooltip on hover, on focus, or on a tap, which focuses it. The meaning lives in a hidden element the term names
   with aria-describedby, so a screen reader reads it too. */
let tip: HTMLElement | null = null;
let on: HTMLElement | null = null;
const GAP = 6, PAD = 8;

/** Above the term when it fits, below it otherwise, and always inside the window. */
function place(t: HTMLElement) {
  const r = t.getBoundingClientRect();
  const w = tip!.offsetWidth, h = tip!.offsetHeight;
  const left = Math.min(Math.max(PAD, r.left + r.width / 2 - w / 2), innerWidth - w - PAD);
  const top = r.top - GAP - h >= PAD ? r.top - GAP - h : r.bottom + GAP;
  tip!.style.left = `${Math.max(PAD, left)}px`;
  tip!.style.top = `${top}px`;
}

function open(t: HTMLElement) {
  const def = document.getElementById(t.getAttribute('aria-describedby') ?? '');
  if (!def) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'gr-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  tip.innerHTML = def.innerHTML;
  tip.hidden = false;
  on = t;
  place(t);
}

function close() {
  if (tip) tip.hidden = true;
  on = null;
}

const termOf = (e: Event) => (e.target as Element | null)?.closest?.<HTMLElement>('.gr-term') ?? null;

export function startTerms() {
  document.addEventListener('pointerover', (e) => { const t = termOf(e); if (t && t !== on) open(t); });
  document.addEventListener('pointerout', (e) => {
    const t = termOf(e);
    if (t && !t.contains(e.relatedTarget as Node | null) && document.activeElement !== t) close();
  });
  document.addEventListener('focusin', (e) => { const t = termOf(e); if (t) open(t); else if (on) close(); });
  document.addEventListener('focusout', (e) => { if (termOf(e)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && on) close(); });
  addEventListener('scroll', () => { if (on) place(on); }, { passive: true });
  addEventListener('resize', close);
}

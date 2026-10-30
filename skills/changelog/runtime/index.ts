/* The changelog page. It reads its entries live from its own database (collection "entries", one document per date),
   so a run adds an entry without republishing the page, and open views show it at once. The hash picks the view:
   empty for the feed, a date for that entry. build.ts bundles this after the page's markup and its config.

   Like thinkr and guided-review, it plays a sound only to answer what the reader just did: a view changing, a link
   copied, the theme menu, the speaker button. Hovering, the first click and a new entry stay silent. */
import type { Db, Entry } from './types';
import { barLine, h } from '../kit/web/dom';
import { sound } from '../kit/web/sound';
import '../kit/web/theme';
import { CFG, T0 } from './dom';
import { viewOpened } from './scene';
import { entryView, feedView } from './views';

const app = document.getElementById('app')!;
let entries: Entry[] | null = null;
let view: string | null = null;
let feedScroll = 0;

function route(fromHashChange: boolean) {
  if (!entries) return;
  let date = location.hash.slice(1);
  try { date = decodeURIComponent(date); } catch { /* a malformed link shows as written, which finds no entry */ }
  const next = date ? 'entry:' + date : 'feed';
  if (next === view) return;
  const prev = view, t = performance.now();
  if (prev === 'feed') feedScroll = scrollY;
  view = next;
  viewOpened();
  app.replaceChildren(...(date ? entryView(entries, date) : feedView(entries)));
  performance.measure('changelog:route', { start: t, end: performance.now() });
  if (date) {
    scrollTo(0, 0);
    if (fromHashChange) sound.play('nav');
  } else {
    const from = prev?.startsWith('entry:') ? document.getElementById('e-' + prev.slice(6)) : null;
    scrollTo(0, from ? Math.max(0, from.offsetTop - 80) : feedScroll);
    if (fromHashChange && prev) sound.play('nav');
  }
}
addEventListener('hashchange', () => route(true));

function unavailable() {
  app.replaceChildren(h('section', { class: 'intro' }, h('h1', { text: 'Changelog' }),
    h('p', { text: 'The entries could not be loaded in this view. Open the changelog on claude.ai, signed in with an account it is shared with.' })));
}
const valid = (d: unknown): d is Entry => !!d && typeof (d as Entry).date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test((d as Entry).date);

barLine(document.querySelector('.k-bar')!);
document.querySelectorAll('[data-name]').forEach((el) => { el.textContent = CFG.name; });
performance.measure('changelog:boot', { start: T0, end: performance.now() });

(async () => {
  let db: Db | null = null;
  try { db = (await window.claude?.use?.('db')) as Db | null ?? null; } catch { db = null; }
  if (!db) { unavailable(); return; }
  db.collection('entries').orderBy('date', 'desc').limit(500).onSnapshot((snap) => {
    entries = snap.docs.map((d) => d.data()).filter(valid);
    const first = view === null;
    const y = scrollY, t = performance.now();
    view = null;
    route(false);
    if (first) performance.measure('changelog:render', { start: t, end: performance.now() });
    if (!first) scrollTo(0, y);
  },() => { if (!entries) unavailable(); });
})();

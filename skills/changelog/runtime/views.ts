/* The two views: the feed of every entry, newest first, and one entry in full. */
import type { Entry, PrRow } from './types';
import { CFG, fmtDate, fmtN, h, linkFor, plural, showToast, tzName } from './dom';
import { scene } from './scene';
import { sound } from './sound';

const LINK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

function numsLine(e: Entry) {
  const n = e.numbers ?? ({} as Entry['numbers']);
  const parts: (Node | string)[] = [h('b', { text: plural(n.prs || 0, 'PR', 'PRs') }), ' · ', `+${fmtN(n.add || 0)} −${fmtN(n.del || 0)}`];
  if (typeof n.ci_median_min === 'number') parts.push(' · ', `CI ${Math.round(n.ci_median_min)} min`);
  return h('p', { class: 'nums' }, parts);
}

function rail(e: Entry, newest: boolean, full: boolean) {
  return h('div', { class: 'rail' }, h('div', { class: 'rail-in' },
    h('time', { datetime: e.date }, newest ? h('span', { class: 'dot', title: 'Newest entry' }) : null, fmtDate(e.date)),
    h('span', { class: 'kind', text: e.span ? `Last ${e.span}` : 'Entry' }),
    full && e.window ? h('span', { class: 'window', text: `Covers ${e.window}, ${tzName(e.timezone ?? '')}` }) : null));
}

function copyButton(date: string) {
  const b = h('button', { class: 'btn', type: 'button', 'data-hover': true });
  b.innerHTML = LINK_ICON + 'Copy link';
  b.addEventListener('click', () => {
    const url = linkFor(date);
    const done = () => { sound.play('copy'); showToast('Link copied'); };
    try { navigator.clipboard.writeText(url).then(done, () => showToast('Copy this link:', url)); } catch { showToast('Copy this link:', url); }
  });
  return b;
}

const intro = () => h('section', { class: 'intro' }, h('h1', { text: 'Changelog' }),
  h('p', { text: `What changed in ${CFG.name}, one entry for each run, newest first.` }));

export function feedView(entries: Entry[]): Node[] {
  if (!entries.length) return [intro(), h('p', { class: 'note', text: 'No entries yet. Each changelog run adds one here, and the newest shows first.' })];
  const list = h('ol', { class: 'feed' });
  entries.forEach((e, i) => {
    const themes = e.themes ?? [];
    const lead = themes.find((t) => t.scene?.svg);
    const shipped = h('ul', { class: 'shipped' }, themes.map((t) =>
      h('li', {}, h('span', { class: 'k', text: t.kicker || '' }), h('div', {}, h('b', { text: t.title || '' }), t.sum ? h('span', { class: 's', text: t.sum }) : null))));
    list.append(h('li', { class: 'entry', id: 'e-' + e.date },
      rail(e, i === 0, false),
      h('article', { class: 'body' },
        h('h2', { class: 'title' }, h('a', { href: '#' + e.date, 'data-hover': true, text: e.title || fmtDate(e.date) })),
        numsLine(e),
        h('p', { class: 'summary', text: e.summary || '' }),
        lead ? scene(lead.scene) : null,
        themes.length ? h('p', { class: 'label shipped-h', text: 'Shipped' }) : null,
        themes.length ? shipped : null,
        h('div', { class: 'actions' },
          h('a', { class: 'more', href: '#' + e.date, 'data-hover': true }, 'Read the entry', h('span', { 'aria-hidden': 'true', text: '→' })),
          copyButton(e.date)))));
  });
  return [intro(), list];
}

/** The PR table's columns: CI, reviews and scores only when the repository counts them. */
function prTable(e: Entry) {
  const any = (f: (p: PrRow) => unknown) => e.prs.some((p) => f(p) != null);
  const cols: [string, boolean, (p: PrRow) => Node | string][] = [
    ['PR', false, (p) => h('a', { href: (e.repo || '') + p.n, target: '_blank', rel: 'noopener', text: '#' + p.n })],
    ['Title', false, (p) => p.title],
    ['Merged', false, (p) => p.merged || ''],
    ['Size', true, (p) => `+${fmtN(p.add)} −${fmtN(p.del)} · ${plural(p.files, 'file', 'files')}`],
    ['Open to merge', true, (p) => `${Number(p.hours).toFixed(1)} h`],
  ];
  if (any((p) => p.review_runs)) cols.push(['Reviews', true, (p) => (p.review_runs == null ? '' : String(p.review_runs))]);
  if (any((p) => p.conf)) cols.push(['Score', true, (p) => (p.conf == null ? '' : `${p.conf}/5`)]);
  if (any((p) => p.ci_runs)) cols.push(['CI failed', true, (p) => (p.ci_runs == null ? '' : `${p.ci_failed} of ${p.ci_runs}`)]);
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map(([t, num]) => h('th', { class: num ? 'num' : null, text: t })))),
    h('tbody', {}, e.prs.map((p) => h('tr', {}, cols.map(([t, num, cell]) =>
      h('td', { class: num ? 'num' : t === 'Merged' ? 'mono' : t === 'Title' ? 't' : null, title: t === 'Score' ? p.conf_note || null : null }, cell(p))))))));
}

export function entryView(entries: Entry[], date: string): Node[] {
  const i = entries.findIndex((e) => e.date === date);
  const back = h('nav', { class: 'crumbs' }, h('a', { class: 'back', href: '#', 'data-hover': true }, h('span', { 'aria-hidden': 'true', text: '←' }), 'Changelog'));
  if (i < 0) return [back, h('p', { class: 'note', text: `There is no entry for ${date} in the changelog.` })];
  const e = entries[i];
  const body = h('article', { class: 'body' },
    h('h1', { class: 'title', text: e.title || fmtDate(e.date) }),
    numsLine(e),
    h('div', { class: 'actions' }, copyButton(e.date)),
    h('p', { class: 'summary', text: e.summary || '' }));
  for (const t of e.themes ?? []) {
    body.append(h('section', { class: 'theme', id: `${e.date}-${t.key}` },
      h('p', { class: 'label', text: t.kicker || '' }),
      h('h2', { text: t.title || '' }),
      t.prs?.length ? h('ul', { class: 'prlinks' }, t.prs.map((n) => h('li', {}, h('a', { href: (e.repo || '') + n, target: '_blank', rel: 'noopener', text: '#' + n })))) : null,
      (t.paras ?? []).map((p) => h('p', { class: 'para', text: p })),
      scene(t.scene)));
  }
  if (e.watch?.length) body.append(h('section', { class: 'watch' }, h('h2', { text: 'Things to check' }), h('ul', {}, e.watch.map((w) => h('li', { text: w })))));
  if (e.prs?.length) body.append(h('section', { class: 'prs' }, h('h2', { text: 'Pull requests' }), prTable(e)));
  const older = entries[i + 1], newer = entries[i - 1];
  if (older || newer) {
    body.append(h('nav', { class: 'pager', 'aria-label': 'Other entries' },
      older ? h('a', { href: '#' + older.date, class: 'prev', 'data-hover': true }, h('span', { class: 'label', text: '← Older · ' + fmtDate(older.date) }), h('span', { class: 't', text: older.title })) : null,
      newer ? h('a', { href: '#' + newer.date, class: 'next', 'data-hover': true }, h('span', { class: 'label', text: 'Newer · ' + fmtDate(newer.date) + ' →' }), h('span', { class: 't', text: newer.title })) : null));
  }
  return [back, h('div', { class: 'entry single' }, rail(e, i === 0, true), body)];
}

/* thinkr runtime entry. build.ts bundles this folder with Bun.build and inlines it after
   window.THINKR = { libs, sounds }. It turns the authored <t-page> into the finished page. */
import type { Mode, Thinkr } from './types';
import { copyText, h, ICON, onScroll, say, slug } from './dom';
import { load, motionReady, warm } from './libs';
import { sound } from './sound';
import { createFigures, tokens } from './figure';
import { createQuestions } from './questions';
import { createDock } from './feedback';
import { createToc, glideTo } from './toc';

const page = document.querySelector<HTMLElement>('t-page');
if (page) boot(page);

function boot(page: HTMLElement) {
  performance.mark('thinkr:start');
  const mode: Mode = page.getAttribute('mode') === 'plan' ? 'plan' : 'explain';
  const version = +(page.getAttribute('version') ?? 1) || 1;
  const h1 = page.querySelector('h1');
  const title = h1?.textContent?.trim() || document.title;
  const kind = mode === 'plan' ? 'Plan' : 'Explainer';

  // ---------------------------------------------------------------- frame: bar, layout, eyebrow
  const soundBtn = h('button', { class: 't-btn is-ghost is-icon', type: 'button', 'aria-label': 'Sound', 'aria-pressed': String(sound.on), html: sound.on ? ICON.sound : ICON.mute });
  soundBtn.addEventListener('click', () => {
    sound.toggle();
    soundBtn.innerHTML = sound.on ? ICON.sound : ICON.mute;
    soundBtn.setAttribute('aria-pressed', String(sound.on));
  });
  const bar = h('div', { class: 't-bar', 'data-uncommentable': '' },
    h('div', { class: 't-bar-title' }, h('span', { class: 't-badge is-muted' }, kind), h('span', {}, title)),
    h('div', { class: 't-bar-end' }, soundBtn));
  const layout = h('div', { class: 't-layout' });
  page.before(bar, layout);
  layout.append(page);
  onScroll(() => bar.classList.toggle('is-scrolled', scrollY > (h1 ? h1.offsetTop + h1.offsetHeight - 52 : 8)));

  const header = page.querySelector('header');
  if (header && !header.querySelector('.t-eyebrow'))
    header.prepend(h('div', { class: 't-eyebrow' }, h('span', { class: 't-badge' }, kind), h('span', {}, 'Version ' + version)));

  // ---------------------------------------------------------------- content: callouts, tables, code, links
  // (code is highlighted and math rendered by build.ts, so nothing here waits on a library)
  page.querySelectorAll('t-callout').forEach((el) => {
    const kind = el.getAttribute('kind') ?? 'note';
    const label = el.getAttribute('label');
    const body = h('div', { class: 't-callout-body' }, label ? h('b', { class: 't-callout-label' }, label) : null, [...el.childNodes]);
    el.append(h('span', { class: 't-callout-icon', html: ICON[kind as keyof typeof ICON] ?? ICON.note }), body);
  });
  page.querySelectorAll('table').forEach((t) => {
    if (t.parentElement?.classList.contains('t-scroll')) return;
    const wrap = h('div', { class: 't-scroll' });
    t.before(wrap);
    wrap.append(t);
  });
  const codes = [...page.querySelectorAll<HTMLElement>('pre > code')];
  for (const code of codes) {
    const pre = code.parentElement!;
    const wrap = h('div', { class: 't-code' });
    pre.before(wrap);
    const copy = h('button', { class: 't-btn is-ghost is-icon is-sm t-copy', type: 'button', 'aria-label': 'Copy code', html: ICON.copy, 'data-uncommentable': '' });
    copy.addEventListener('click', () => copyText(code.textContent ?? '').then(() => { say('Copied'); sound.play('select'); }, () => say('Copy failed. Select the code instead.')));
    const name = pre.dataset.title, src = pre.dataset.href;
    if (name) wrap.append(h('div', { class: 't-code-head' }, src ? h('a', { href: src, class: 't-ext' }, name) : name, copy));
    else wrap.append(copy);
    wrap.append(pre);
  }
  // links out (docs, code, sources) get an arrow; a <t-refs> list also shows each link's site
  for (const a of page.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')) {
    a.classList.add('t-ext');
    a.rel = 'noopener';
    a.target = '_blank';
    if (a.closest('t-refs') && !a.querySelector('.t-host'))
      a.append(h('span', { class: 't-host' }, new URL(a.href).hostname.replace(/^www\./, '')));
  }

  // ---------------------------------------------------------------- figures, questions, plan dock
  warm();
  const figures = createFigures(page);
  const key = `thinkr:${page.getAttribute('key') ?? slug(title)}:${mode}`;
  const { questions, onChange } = createQuestions(page, mode, key);
  createToc(layout, page, questions, onChange);
  if (mode === 'plan') createDock({ page, version, key, questions, onChange, jump: glideTo });

  const api: Thinkr = {
    figure: (sel, setup) => figures.register(sel, setup),
    load, tokens,
    sound: (name) => sound.play(name),
    motion: () => motionReady,
  };
  window.thinkr = api;
  performance.measure('thinkr:boot', 'thinkr:start'); // scripts/test.ts holds this to a budget
}

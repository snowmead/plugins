#!/usr/bin/env bun
/* Runtime regression test: builds the two templates, drives them in headless Chrome, and checks what the
   reader would see after each action. Run it after changing anything in runtime/ or scripts/changes.ts.

     bun scripts/test.ts        # needs Chrome; set CHROME when it is not in a usual place */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browser, findChrome } from '../kit/build/chrome';

const ROOT = join(import.meta.dir, '..');
findChrome();

// The plan is tested at version 2: built once as the template, then changed as below and built again, so the build
// has a version to compare with and the page has Changes to pick.
const PLAN_V2: [string | RegExp, string][] = [
  ['version="1"', 'version="2"'],
  ['  </header>\n', `  </header>
  <t-amends>
    <t-amend version="2" kind="answer" label="Requests pass when Redis is down" re="When Redis does not answer within 20 ms, what should the gateway do?" answer="Let the request through" at="flow">
      The check now says what it costs when Redis is down.
    </t-amend>
    <t-amend version="2" kind="comment" label="Two weeks of shadow mode" re="Is one week of shadow mode enough?" at="rollout references">
      Shadow mode runs two weeks, and the Retry-After reference went with the old timeline.
    </t-amend>
  </t-amends>
`],
  ['It costs one Redis round trip per request.', 'It costs one Redis round trip per request, and lets the request through when Redis is slow.'],
  ['so we can set the numbers from real', 'so we can tune the numbers from two weeks of real'],
  ['    <t-question id="exceptions"', '    <p>Two weeks covers a month-end billing run.</p>\n\n    <t-question id="exceptions"'],
  [/ *<li><a href="https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/HTTP\/Headers\/Retry-After">[\s\S]*?<\/li>\n/, ''],
];

// Each case runs in the page; `r` collects facts, `expect` lists what they must be, and `budget` caps timings
// in ms: t(fn) times the synchronous work a click or input does before the browser can paint the result. An
// interaction must fit well inside one 60 Hz frame (16.7 ms), so the next frame already shows its result.
const BUDGET = { boot: 30, interaction: 12 };
// `prime` runs on a first load and the page is opened again, as a reader coming back would open it. `viewer` runs
// before the page's own scripts on every load.
const cases: Record<string, { viewer?: string; prime?: string; run: string; expect: Record<string, unknown>; budget: Record<string, number> }> = {
  plan: {
    // A stand-in for the claude.ai viewer: the page database in memory, a reader "u_me", and a comments capability
    // that records each send's text, or fails once with rate_limited when __fail is set.
    viewer: `(() => {
      const docs = new Map();
      window.__sent = [];
      const db = { doc: (path) => ({ path, get: async () => ({ exists: docs.has(path) }), set: async (d) => { docs.set(path, d); } }) };
      const comments = {
        canSendToClaude: async () => 'available',
        anchorFor: async () => ({}),
        sendToClaude: async ({ text }) => {
          if (window.__fail) { window.__fail = false; throw { code: 'rate_limited' }; }
          window.__sent.push(text);
          return { threadId: 't' + window.__sent.length };
        },
      };
      const user = { id: async () => 'u_me', can: async () => true };
      window.claude = { use: async (name) => ({ db, comments, user })[name] ?? null };
    })();`,
    prime:`localStorage.setItem('thinkr:api-rate-limits:plan:seen', '1')`, // this reader last saw version 1
    budget: { boot: BUDGET.boot, select: BUDGET.interaction, step: BUDGET.interaction, panel: BUDGET.interaction, toc: BUDGET.interaction, change: BUDGET.interaction },
    run: `
      ms.select = t(() => $('#algorithm--bucket').click());
      r.badge = $('#algorithm .t-qstate').textContent;
      r.count = $('.t-progress b').textContent;
      $('#scopes--key').click(); $('#scopes--org').click();
      r.maxDisabled = $('#scopes--ip').disabled;
      $('#redis-down--other').click();
      r.otherShown = !$('#redis-down--other-text').hidden;
      $('#redis-down--open').click();
      r.otherHidden = $('#redis-down--other-text').hidden;
      const part = $('#flow-fig [data-show="2+"]');
      r.offAtStep1 = part.classList.contains('is-off');
      ms.step = t(() => $('#flow-fig [aria-label="Next step"]').click());
      r.onAtStep2 = !part.classList.contains('is-off');
      r.saved = Object.keys(JSON.parse(localStorage.getItem('thinkr:api-rate-limits:plan')).answers).length;
      r.refHost = $('t-refs .t-host').textContent;

      // the figure viewport: zoom, reset, resize from an edge
      const stage = $('#flow-fig .t-stage'), fsvg = stage.querySelector('svg');
      await new Promise((ok) => setTimeout(ok, 100));
      const vb = fsvg.viewBox.baseVal, bb = fsvg.getBBox();
      r.fitsContent = vb.x <= bb.x && vb.y <= bb.y && vb.x + vb.width >= bb.x + bb.width && vb.y + vb.height >= bb.y + bb.height;
      $('#flow-fig [aria-label="Zoom in"]').click();
      r.zoomed = $('#flow-fig .t-zoom-level').textContent;
      stage.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
      r.reset = $('#flow-fig .t-zoom-level').textContent;
      const edge = $('#flow-fig .t-edge.is-s'), er = edge.getBoundingClientRect(), h0 = stage.offsetHeight;
      const drag = (type, y) => edge.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, button: 0, buttons: 1, clientX: er.x + 20, clientY: y }));
      drag('pointerdown', er.y); drag('pointermove', er.y + 100); drag('pointerup', er.y + 100);
      r.taller = stage.offsetHeight > h0;

      // the send panel
      const form = $('#t-composer');
      ms.panel = t(() => $('.t-dock > .k-btn.is-primary').click());
      r.panel = form.classList.contains('is-open') && $('.t-composer-head b').textContent;
      r.panelWarn = !$('.t-composer-warn').hidden && $('.t-composer-warn span').textContent;
      const box = $('#t-composer-text');
      box.value = 'Ship it after the load test.'; box.dispatchEvent(new Event('input'));
      r.draft = JSON.parse(localStorage.getItem('thinkr:api-rate-limits:plan:message'));
      form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      r.escCloses = !form.classList.contains('is-open');
      $('.t-dock > .k-btn:not(.is-primary)').click();
      r.sendPanel = form.classList.contains('is-open') && $('.t-composer-head b').textContent;
      r.sendNoWarn = $('.t-composer-warn').hidden;
      r.draftKept = box.value;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      r.outsideCloses = !form.classList.contains('is-open');

      // "On this page": sections with their questions one notch in, answered dots, the stepped rail
      await new Promise((ok) => setTimeout(ok, 300));
      r.tocEntries = document.querySelectorAll('.t-toc li').length;
      r.tocSub = document.querySelectorAll('.t-toc li.is-sub').length;
      r.tocDone = document.querySelectorAll('.t-toc li[data-done]').length;
      const d = $('.t-toc-rail path')?.getAttribute('d') ?? '';
      r.railNotches = d.includes('M0.5') && d.includes('L12.5');

      scrollTo(0, 0);
      await new Promise((ok) => setTimeout(ok, 100));
      ms.toc = t(() => $('.t-toc li:last-child a').click());
      await new Promise((ok) => setTimeout(ok, 150));
      r.tocMidGlide = scrollY > 0 && $('#references').getBoundingClientRect().top > 90;
      await new Promise((ok) => setTimeout(ok, 1500));
      r.tocLands = Math.abs($('#references').getBoundingClientRect().top - 84) < 4 || scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
      r.tocHash = location.hash;
      // at the end of the page, a click on an entry already on screen still moves the marker and flashes the target
      const rollout = [...document.querySelectorAll('.t-toc a')].find((a) => a.textContent === 'Rollout');
      rollout.click();
      r.pinOn = $('.t-toc a.is-on')?.textContent;
      await new Promise((ok) => setTimeout(ok, 1000));
      r.pinHeld = $('.t-toc a.is-on')?.textContent;
      r.flashed = $('#rollout').classList.contains('t-flash');
      dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
      r.wheelReleases = $('.t-toc a.is-on')?.textContent !== 'Rollout' || $('#rollout').getBoundingClientRect().top < 140;
      $('.t-progress').click();
      await new Promise((ok) => setTimeout(ok, 1500));
      const top = $('#exceptions').getBoundingClientRect().top;
      r.nextOpen = Math.abs(top - 84) < 4 || (top > 84 && top < innerHeight && scrollY + innerHeight >= document.documentElement.scrollHeight - 2);

      // Changes: one-line rows (new ones dotted), the marks the build wrote (hidden until a row opens), opening a
      // row (its question and answer, its marks, the stepper), switching, closing, folding a version
      const rows = [...document.querySelectorAll('.t-chg-row')];
      r.chgEntries = rows.length;
      r.chgNew = document.querySelectorAll('.t-chg-dot').length + ' ' + $('.t-changes-btn .t-count')?.textContent;
      r.chgRail = getComputedStyle($('.t-changes')).position;
      r.chgMarked = document.querySelectorAll('t-page [data-amend]').length;
      r.chgQuiet = getComputedStyle($('del[data-t]')).display === 'none' && $('[data-removed]').hidden && !$('.is-lit')
        && getComputedStyle($('.t-chg-detail')).display === 'none';
      r.chgHeading = $('#flow').textContent;
      ms.change = t(() => rows[1].click());
      r.chgPos = $('.t-chgnav-pos').textContent;
      r.chgLit = document.querySelectorAll('.is-lit').length;
      r.chgShown = !$('[data-removed]').hidden && getComputedStyle($('.is-lit del[data-t]')).display === 'inline';
      r.chgBar = $('.t-bar').classList.contains('is-stepping') && $('.t-chgnav-label').textContent;
      $('[aria-label="Next change"]').click();
      r.chgNext = $('.t-chgnav-pos').textContent;
      rows[0].click();
      r.chgSwitch = $('.t-chgnav-pos').textContent + ' ' + document.querySelectorAll('.t-chg.is-on').length;
      r.chgQA = [...document.querySelectorAll('.t-chg.is-on .t-chg-qa dd')].map((d) => d.textContent).join(' | ');
      rows[0].click();
      r.chgReclick = !$('.t-chg.is-on') && !$('.is-lit');
      rows[1].click();
      dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      r.chgCleared = !$('.is-lit') && !$('.t-chg.is-on') && $('[data-removed]').hidden && !$('.t-bar').classList.contains('is-stepping');
      $('.t-chg-vbtn').click();
      r.chgFold = $('.t-chg-items').hidden;
      $('.t-chg-vbtn').click();
      r.chgUnfold = !$('.t-chg-items').hidden;
      r.chgSeen = JSON.parse(localStorage.getItem('thinkr:api-rate-limits:plan:seen'));

      // sends: each lists the answers that changed since the last send that reached Claude, and names the rest
      const submit = async (approve) => {
        if (!$('#t-composer').classList.contains('is-open')) $(approve ? '.t-dock > .k-btn.is-primary' : '.t-dock > .k-btn:not(.is-primary)').click();
        $('#t-composer').requestSubmit();
        await new Promise((ok) => setTimeout(ok, 100));
        return window.__sent.at(-1).split('\\n\\n').map((b) => b.split('\\n')[0]).join(' | ');
      };
      r.sendFirst = await submit(false);
      r.sendApprove = await submit(true);
      $('#algorithm--sliding').click();
      r.sendChanged = await submit(false);
      $('#redis-down--closed').click();
      window.__fail = true;
      r.sendFailed = (await submit(false)) === r.sendChanged && $('#t-composer').classList.contains('is-open');
      r.sendRetry = await submit(false);`,
    expect: {
      badge: 'Answered', count: '1/4', maxDisabled: true, otherShown: true, otherHidden: true, offAtStep1: true, onAtStep2: true, saved: 4, refHost: 'redis.io', fitsContent: true, zoomed: '150%', reset: '100%', taller: true,
      panel: 'Approve plan', panelWarn: '1 question is still open.', draft: 'Ship it after the load test.', escCloses: true,
      sendPanel: 'Send feedback', sendNoWarn: true, draftKept: 'Ship it after the load test.', outsideCloses: true,
      tocEntries: 7, tocSub: 4, tocDone: 3, railNotches: true, tocMidGlide: true, tocLands: true, tocHash: '#references', pinOn: 'Rollout', pinHeld: 'Rollout', flashed: true, wheelReleases: true, nextOpen: true,
      chgEntries: 2, chgNew: '2 2', chgRail: 'sticky', chgMarked: 4, chgQuiet: true, chgHeading: 'How a request is checked', chgPos: '1 / 3', chgLit: 3, chgShown: true,
      chgBar: 'Two weeks of shadow mode', chgNext: '2 / 3', chgSwitch: '1 / 1 1', chgQA: 'When Redis does not answer within 20 ms, what should the gateway do? | Let the request through',
      chgReclick: true, chgCleared: true, chgFold: true, chgUnfold: true, chgSeen: 2,
      sendFirst: 'Feedback on: API Rate Limits (v2) | Q1 Which algorithm should count requests? | Q2 What should each limit be counted against? | Q3 When Redis does not answer within 20 ms, what should the gateway do? | Q4 Which customers need a higher limit from day one? | Message: | Full answers: responses/u_me in the page database.',
      sendApprove: 'Approved: API Rate Limits (v2) | Q4 Which customers need a higher limit from day one? | Answers unchanged since the last send: Q1, Q2, Q3. | Full answers: responses/u_me in the page database.',
      sendChanged: 'Feedback on: API Rate Limits (v2) | Q1 Which algorithm should count requests? | Q4 Which customers need a higher limit from day one? | Answers unchanged since the last send: Q2, Q3. | Full answers: responses/u_me in the page database.',
      sendFailed: true,
      sendRetry: 'Feedback on: API Rate Limits (v2) | Q3 When Redis does not answer within 20 ms, what should the gateway do? | Q4 Which customers need a higher limit from day one? | Answers unchanged since the last send: Q1, Q2. | Full answers: responses/u_me in the page database.',
    },
  },
  explain: {
    budget: { boot: BUDGET.boot, check: BUDGET.interaction, slider: BUDGET.interaction },
    run: `
      r.checkDisabled = $('#steep-axis .t-qfoot button').disabled;
      r.explainHidden = $('#steep-axis t-explain').hidden;
      $('#steep-axis--faster').click();
      ms.check = t(() => $('#steep-axis .t-qfoot button').click());
      r.wrong = !!$('#steep-axis .t-opt.is-wrong') && !!$('#steep-axis .t-opt.is-right');
      r.explainShown = !$('#steep-axis t-explain').hidden;
      $('#steep-axis--bounce').click();
      $('#steep-axis .t-qfoot button').click();
      r.verdict = $('#steep-axis .t-verdict').textContent;
      r.noOther = !$('#steep-axis--other');
      const range = $('#landscape input[type=range]');
      ms.slider = t(() => { range.value = '0.24'; range.dispatchEvent(new Event('input')); });
      r.output = $('#landscape output').textContent;
      r.math = !!$('mjx-container');
      r.code = !!$('.hljs-keyword');
      r.motion = !!(await thinkr.motion());`,
    expect: { checkDisabled: true, explainHidden: true, wrong: true, explainShown: true, verdict: 'Correct', noOther: true, output: '0.24', math: true, code: true, motion: true },
  },
};

const tmp = mkdtempSync(join(tmpdir(), 'thinkr-test-'));
let failed = 0;
try {
  const build = (file: string) => {
    const b = Bun.spawnSync(['bun', join(ROOT, 'scripts/build.ts'), file]);
    if (b.exitCode || / warn /.test(b.stdout.toString())) { console.log(b.stdout.toString()); process.exit(1); }
  };
  for (const [name, c] of Object.entries(cases)) {
    // built in the temp folder, so the history file the build keeps for a plan never lands in templates/
    const file = join(tmp, `${name}.html`);
    await Bun.write(file, Bun.file(join(ROOT, `templates/${name}.html`)));
    build(file);
    if (name === 'plan') {
      let src = await Bun.file(file).text();
      for (const [from, to] of PLAN_V2) {
        const hit = typeof from === 'string' ? from : from.exec(src)?.[0];
        if (!hit || !src.includes(hit)) { console.log(`fail  plan: the template no longer has ${from}; update PLAN_V2`); process.exit(1); }
        src = src.replace(hit, to);
      }
      await Bun.write(file, src);
      build(file);
    }
    const chromeTab = await browser(join(tmp, 'profile-' + name));
    try {
      const url = 'file://' + join(tmp, `${name}.preview.html`);
      if (c.viewer) await chromeTab.send('Page.addScriptToEvaluateOnNewDocument', { source: c.viewer });
      await chromeTab.open(url);
      if (c.prime) { await chromeTab.run(c.prime); await chromeTab.open(url); }
      const raw = await chromeTab.run(`(async () => {
        const r = {}, ms = {}, $ = (s) => document.querySelector(s);
        const t = (fn) => { const s = performance.now(); fn(); return +(performance.now() - s).toFixed(2); };
        await new Promise((ok) => setTimeout(ok, 600));
        ms.boot = +performance.getEntriesByName('thinkr:boot')[0].duration.toFixed(2);
        ${c.run}
        return JSON.stringify({ r, ms });
      })()`);
      if (typeof raw !== 'string' || !raw.startsWith('{')) { console.log(`fail  ${name}: ${raw}`); failed++; continue; }
      const { r: got, ms } = JSON.parse(raw) as { r: Record<string, unknown>; ms: Record<string, number> };
      const bad = Object.entries(c.expect).filter(([k, v]) => got[k] !== v);
      for (const [k, v] of bad) console.log(`fail  ${name}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
      const slow = Object.entries(c.budget).filter(([k, max]) => !(ms[k] <= max));
      for (const [k, max] of slow) console.log(`slow  ${name}.${k}: ${ms[k]} ms, budget ${max} ms`);
      for (const err of chromeTab.errors) console.log(`error ${name}: ${err.split('\n')[0]}`);
      if (!bad.length && !slow.length && !chromeTab.errors.length)
        console.log(`ok    ${name} (${Object.keys(c.expect).length} checks, no errors; ${Object.entries(ms).map(([k, v]) => `${k} ${v}ms`).join(', ')})`);
      failed += bad.length + slow.length + chromeTab.errors.length;
    } finally {
      chromeTab.close();
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

#!/usr/bin/env bun
/* Runtime regression test: builds the two templates, drives them in headless Chrome, and checks what the
   reader would see after each action. Run it after changing anything in runtime/.

     bun scripts/test.ts        # needs Chrome; set CHROME when it is not in a usual place */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '..');
const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', Bun.which('google-chrome'), Bun.which('chromium')]
  .find((p) => p && existsSync(p));
if (!chrome) { console.log('No Chrome found. Set CHROME=/path/to/chrome.'); process.exit(1); }

// Each case runs in the page; `r` collects facts, `expect` lists what they must be, and `budget` caps timings
// in ms: t(fn) times the synchronous work a click or input does before the browser can paint the result. An
// interaction must fit well inside one 60 Hz frame (16.7 ms), so the next frame already shows its result.
const BUDGET = { boot: 30, interaction: 12 };
const cases: Record<string, { run: string; expect: Record<string, unknown>; budget: Record<string, number> }> = {
  plan: {
    budget: { boot: BUDGET.boot, select: BUDGET.interaction, step: BUDGET.interaction, panel: BUDGET.interaction, toc: BUDGET.interaction },
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
      ms.panel = t(() => $('.t-dock > .t-btn.is-primary').click());
      r.panel = form.classList.contains('is-open') && $('.t-composer-head b').textContent;
      r.panelWarn = !$('.t-composer-warn').hidden && $('.t-composer-warn span').textContent;
      const box = $('#t-composer-text');
      box.value = 'Ship it after the load test.'; box.dispatchEvent(new Event('input'));
      r.draft = JSON.parse(localStorage.getItem('thinkr:api-rate-limits:plan:message'));
      form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      r.escCloses = !form.classList.contains('is-open');
      $('.t-dock > .t-btn:not(.is-primary)').click();
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
      r.nextOpen = Math.abs(top - 84) < 4 || (top > 84 && top < innerHeight && scrollY + innerHeight >= document.documentElement.scrollHeight - 2);`,
    expect: {
      badge: 'Answered', count: '1/4', maxDisabled: true, otherShown: true, otherHidden: true, offAtStep1: true, onAtStep2: true, saved: 4, refHost: 'redis.io', fitsContent: true, zoomed: '150%', reset: '100%', taller: true,
      panel: 'Approve plan', panelWarn: '1 question is still open.', draft: 'Ship it after the load test.', escCloses: true,
      sendPanel: 'Send feedback', sendNoWarn: true, draftKept: 'Ship it after the load test.', outsideCloses: true,
      tocEntries: 7, tocSub: 4, tocDone: 3, railNotches: true, tocMidGlide: true, tocLands: true, tocHash: '#references', pinOn: 'Rollout', pinHeld: 'Rollout', flashed: true, wheelReleases: true, nextOpen: true,
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

// ---------------------------------------------------------------- a minimal DevTools protocol driver
// Real time, not --virtual-time-budget: under virtual time the clock stops during synchronous code (timings read
// 0) and animation frames never fire.
async function browser(profile: string) {
  const proc = Bun.spawn([chrome!, '--headless=new', '--remote-debugging-port=0', '--window-size=1440,900', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], { stderr: 'ignore', stdout: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(50);
  const port = (await Bun.file(portFile).text()).split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
  let id = 0;
  const waiting = new Map<number, (v: any) => void>();
  const events = new Map<string, () => void>();
  const errors: string[] = []; // any exception or console.error on the page fails the test
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id) return waiting.get(msg.id)?.(msg);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a: any) => a.value ?? a.description).join(' '));
    events.get(msg.method)?.();
  });
  const send = (method: string, params: object = {}) => new Promise<any>((ok) => { waiting.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  await Promise.all([send('Page.enable'), send('Runtime.enable')]);
  return {
    errors,
    async open(url: string) {
      const loaded = new Promise<void>((ok) => events.set('Page.loadEventFired', ok));
      await send('Page.navigate', { url });
      await loaded;
    },
    async run(code: string) {
      const res = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true });
      return res.result?.exceptionDetails ? 'ERR ' + (res.result.exceptionDetails.exception?.description ?? 'error') : res.result?.result?.value;
    },
    close() { ws.close(); proc.kill(); },
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'thinkr-test-'));
let failed = 0;
try {
  for (const [name, c] of Object.entries(cases)) {
    const b = Bun.spawnSync(['bun', join(ROOT, 'scripts/build.ts'), join(ROOT, `templates/${name}.html`)]);
    if (b.exitCode) { console.log(b.stdout.toString()); process.exit(1); }
    const chromeTab = await browser(join(tmp, 'profile-' + name));
    try {
      await chromeTab.open('file://' + join(ROOT, `templates/${name}.preview.html`));
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

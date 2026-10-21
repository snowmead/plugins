/* The local Chrome, for screenshots and the runtime tests: where it is, and a minimal DevTools protocol driver. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The Chrome binary: $CHROME, else the usual places. Exits with a hint when there is none. */
export function findChrome(): string {
  const found = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    Bun.which('google-chrome'), Bun.which('chromium'), Bun.which('chromium-browser'),
  ].find((p) => p && existsSync(p));
  if (!found) { console.log('No Chrome found. Set CHROME=/path/to/chrome.'); process.exit(1); }
  return found;
}

/** A headless Chrome with one tab, driven over DevTools. Real time, not --virtual-time-budget: under virtual time the
    clock stops during synchronous code (timings read 0) and animation frames never fire. Any exception or
    console.error on the page lands in `errors`, and console.warn too with `warnings`, so a test can fail on them. */
export async function browser(profile: string, { warnings = false } = {}) {
  const proc = Bun.spawn([findChrome(), '--headless=new', '--remote-debugging-port=0', '--window-size=1440,900', '--no-first-run',
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
  const errors: string[] = [];
  const logged = warnings ? ['error', 'warning'] : ['error'];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id) return waiting.get(msg.id)?.(msg);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && logged.includes(msg.params.type)) errors.push(msg.params.args.map((a: any) => a.value ?? a.description).join(' '));
    events.get(msg.method)?.();
  });
  const send = (method: string, params: object = {}) => new Promise<any>((ok) => { waiting.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  await Promise.all([send('Page.enable'), send('Runtime.enable')]);
  return {
    errors, send,
    async open(url: string) {
      const loaded = new Promise<void>((ok) => events.set('Page.loadEventFired', ok));
      await send('Page.navigate', { url });
      await loaded;
    },
    /** Evaluate code in the page, as a user gesture, and return its value (or "ERR …"). */
    async run(code: string) {
      const res = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true });
      return res.result?.exceptionDetails ? 'ERR ' + (res.result.exceptionDetails.exception?.description ?? 'error') : res.result?.result?.value;
    },
    close() { ws.close(); proc.kill(); },
  };
}

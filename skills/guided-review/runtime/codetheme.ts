/* The code theme: the colors code cards draw in, picked from the palette button in the bar.

   @pierre/diffs draws any theme in @pierre/theming's catalog by name, and loads it from jsDelivr the first time:
   Pierre's own themes, then Shiki's, which the Shiki project keeps from VS Code themes. The menu lists the catalog,
   so it follows each release of @pierre/diffs with no list here to keep.

   The page keeps one pick for light and one for dark, and the menu lists the themes of the mode the page shows.
   Moving through the menu shows each theme on the cards; Enter or a click keeps it, and Escape, Tab or a click
   outside goes back. The picks stay in this browser (gr:code-theme), on this page only.

   A theme colors the code only: its syntax and its plain text. Every theme draws on the page's code background, and
   added, removed and changed lines keep the default pair's green, red and blue (CODE_CSS), so a change reads the
   same in every theme. */
import type { ThemeCatalog, ThemeDescriptor } from './types';
import { $, $$, h, store } from '../kit/web/dom';
import { sound } from '../kit/web/sound';
import { isDark, onTheme } from '../kit/web/theme';
import { toast } from '../kit/web/toast';
import { ICON } from '../kit/web/icons';
import { libs } from './libs';

type Mode = 'light' | 'dark';
type Picks = Record<Mode, string>;
const DEFAULT: Picks = { light: 'pierre-light', dark: 'pierre-dark' };
const KEY = 'gr:code-theme';

let catalog: ThemeCatalog | null = null;
/** What the reader kept. */
let kept: Picks = { ...DEFAULT };
/** What the cards draw: `kept`, or the theme under the pointer or the focus while the menu is open. */
let shown: Picks = { ...DEFAULT };
const cbs = new Set<() => void>();
const mode = (): Mode => (isDark() ? 'dark' : 'light');

/** What every card draws with, whatever its theme: the page's code background, and the default pair's colors for
    added, removed and changed lines. @pierre/diffs takes each from the theme in use, and mixes the line colors into
    the background; these win over it (the unsafe layer). The line colors are added once codeReady has read them. */
let CODE_CSS = ':host { --diffs-light-bg: var(--surface); --diffs-dark-bg: var(--surface); }';
/** The colors @pierre/diffs reads from a theme for a line's change, in its own order of preference. */
const GIT = { addition: ['gitDecoration.addedResourceForeground', 'terminal.ansiGreen'], deletion: ['gitDecoration.deletedResourceForeground', 'terminal.ansiRed'], modified: ['gitDecoration.modifiedResourceForeground', 'terminal.ansiBlue'] };

/** Settles once the stored picks are checked against the catalog, and the default pair's line colors are read. A
    card waits for it before it draws, since a name the catalog does not have leaves a card empty. */
export const codeReady = libs.then(async ({ diffs, themes }) => {
  catalog = themes;
  const saved = store.get<Partial<Picks>>(KEY);
  for (const m of ['light', 'dark'] as Mode[]) {
    const name = saved?.[m];
    if (typeof name === 'string' && themes?.getTheme(name)?.colorScheme === m) kept[m] = name;
  }
  shown = { ...kept };
  // The default pair loads for the first card anyway; if it does not, each theme keeps its own line colors.
  const vars: string[] = [];
  for (const m of ['light', 'dark'] as Mode[]) {
    try {
      const { colors = {} } = (await diffs?.resolveTheme(DEFAULT[m])) as { colors?: Record<string, string> } ?? {};
      for (const [kind, keys] of Object.entries(GIT)) {
        const color = keys.map((k) => colors[k]).find(Boolean);
        if (color) vars.push(`--diffs-${m}-${kind}-color: ${color};`);
      }
    } catch { /* the theme's own */ }
  }
  if (vars.length) CODE_CSS = CODE_CSS.replace(' }', ` ${vars.join(' ')} }`);
});

/** The options a card draws with. */
export const codeOptions = () => ({ theme: { ...shown }, unsafeCSS: CODE_CSS });

/** Call cb when the cards must draw in other colors. */
export const onCodeTheme = (cb: () => void) => { cbs.add(cb); };

function show(next: Picks) {
  if (next.light === shown.light && next.dark === shown.dark) return;
  shown = next;
  cbs.forEach((cb) => cb());
}

/** Shiki's themes have no display name; their ids read well with a few fixes. */
const NAMES: Record<string, string> = {
  'dark-plus': 'Dark+', 'light-plus': 'Light+', 'synthwave-84': "Synthwave '84",
  'rose-pine': 'Rosé Pine', 'rose-pine-dawn': 'Rosé Pine Dawn', 'rose-pine-moon': 'Rosé Pine Moon',
};
const label = (t: ThemeDescriptor) => t.displayName ?? NAMES[t.name]
  ?? t.name.split('-').map((w) => (w === 'github' ? 'GitHub' : w[0].toUpperCase() + w.slice(1))).join(' ');

// ---------------------------------------------------------------- the menu
// The menu is a kit menu (.k-menu) under the button, with a heading for each collection. While it is open it keeps
// every key from the page, whose shortcuts wait until it closes, as the kit's theme menu does.
export function startCodeTheme() {
  const wrap = $('[data-code-theme]');
  if (!wrap) return;
  const btn = $<HTMLButtonElement>('button', wrap)!, menu = $('[role="menu"]', wrap)!;
  const items = () => $$<HTMLButtonElement>('button', menu);
  let want = '';
  /** The mode the open menu lists. */
  let listed: Mode = mode();
  void codeReady.then(() => { if (!catalog) wrap.hidden = true; });

  /** Show `name` on the cards once it has loaded, unless the reader has moved on by then. */
  async function preview(name: string) {
    want = name;
    const { diffs } = await libs;
    try { await diffs?.resolveTheme(name); } catch { return; }
    if (want === name && !menu.hidden) show({ ...kept, [mode()]: name });
  }
  async function keep(name: string) {
    want = '';
    const m = mode();
    const { diffs } = await libs;
    try { await diffs?.resolveTheme(name); } catch {
      toast(`${label(catalog?.getTheme(name) ?? { name })} did not load. Check the connection and pick it again.`);
      show({ ...kept });
      return;
    }
    kept = { ...kept, [m]: name };
    store.set(KEY, kept);
    show({ ...kept });
  }
  function fill() {
    const m = mode(), now = kept[m];
    const list = catalog?.getThemes({ colorScheme: m }) ?? [];
    let group = '';
    const kids: HTMLElement[] = [h('div', { class: 'gr-ct-head', role: 'presentation' }, `Code theme for ${m} mode`)];
    for (const t of list) {
      if (t.collection && t.collection !== group) {
        group = t.collection;
        kids.push(h('div', { class: 'gr-ct-group', role: 'presentation' }, group === 'shiki' ? 'Shiki' : group === 'pierre' ? 'Pierre' : group));
      }
      const item = h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(t.name === now), value: t.name }, label(t));
      item.insertAdjacentHTML('beforeend', ICON.check);
      kids.push(item);
    }
    menu.replaceChildren(...kids);
  }
  async function set(open: boolean, focusBtn = false) {
    if (open) {
      await codeReady;
      if (!catalog) return;
      listed = mode();
      fill();
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      // The kept theme sits mid-list, and only the menu scrolls to it: the bar stays where it is.
      const on = items().find((i) => i.getAttribute('aria-checked') === 'true') ?? items()[0];
      if (on) menu.scrollTop = on.offsetTop - (menu.clientHeight - on.offsetHeight) / 2;
      on?.focus({ preventScroll: true });
      return;
    }
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    want = '';
    show({ ...kept });
    if (focusBtn) btn.focus();
  }

  btn.addEventListener('click', () => { void set(!!menu.hidden); sound.play('toggle'); });
  /** Move to an item: focus it and show its theme. Each move calls preview itself, as focus events wait while the
      window has no focus. */
  const go = (item: HTMLButtonElement | undefined, scroll = true) => {
    if (!item) return;
    item.focus({ preventScroll: !scroll });
    void preview(item.value);
  };
  menu.addEventListener('pointermove', (e) => {
    const item = (e.target as Element).closest<HTMLButtonElement>('button');
    if (item && item !== document.activeElement) go(item, false);
  });
  menu.addEventListener('click', (e) => {
    const item = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!item) return;
    void keep(item.value);
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.focus();
    sound.play('select');
  });
  wrap.addEventListener('keydown', (e) => {
    const all = items();
    if (menu.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); void set(true); }
      return;
    }
    e.stopPropagation();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const to = (i: number) => { e.preventDefault(); go(all[(i + all.length) % all.length]); };
    if (e.key === 'ArrowDown') to(at + 1);
    else if (e.key === 'ArrowUp') to(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') to(0);
    else if (e.key === 'End') to(-1);
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); void set(false, true); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type to jump: the next theme whose name starts with the letter.
      const k = e.key.toLowerCase();
      const next = all.map((_, i) => (at + 1 + i) % all.length).find((i) => all[i].textContent!.toLowerCase().startsWith(k));
      if (next != null) to(next);
    }
  });
  addEventListener('pointerdown', (e) => { if (!menu.hidden && !wrap.contains(e.target as Node)) void set(false); }, true);
  addEventListener('blur', () => { void set(false); }); // a click outside the frame
  // The other mode has its own pick: a change of mode closes the menu and shows that pick.
  onTheme(() => { if (mode() !== listed) void set(false); });
}

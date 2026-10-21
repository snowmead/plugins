# kit

What the Artifact skills share, so their pages look, sound and behave as one family: thinkr, guided-review and
changelog. The look is shadcn/ui's neutral theme in Geist, light and dark, as thinkr has always had it.

The kit is not a skill. Each skill that uses it has a symlink to it, `skills/<skill>/kit -> ../../kit`, and imports
from `kit/` as if it were its own folder, so a skill also works on its own. The plugin `snowmead` is the whole
repository, so Claude Code's copy holds the kit and the links resolve inside it; `npx skills add` copies the linked
folder into each skill by its contents. A checkout of this repository needs git with symlinks on (the default on
macOS and Linux; on Windows, Developer Mode and `core.symlinks=true`).

## What is in it

| Path | What it is |
|---|---|
| `tokens.css` | The tokens every page builds on, light and dark, and the base rules (box sizing, focus ring, selection, reduced motion). |
| `ui.css` | The shared parts: the sticky bar (`.k-bar`), buttons (`.k-btn` with `is-primary`, `is-ghost`, `is-icon`, `is-sm`), the segmented control (`.k-seg`), badges (`.k-badge`), the toast (`.k-toast`) and the speaker button (`.k-sound`). |
| `sounds.json` | One earshot kit: `nav`, `step`, `select`, `deselect`, `reveal`, `toggle`, `send` and `hover`. |
| `web/` | Browser code each page's runtime bundles: `dom.ts` (`h`, `$`, `$$`, `esc`, `slug`, `store`, `onScroll`, `barLine`, `copyText`), `icons.ts` (`ICON`, `soundButton`), `theme.ts`, `sound.ts`, `toast.ts`, `types.ts`. |
| `build/` | Helpers for each skill's scripts: `page.ts` (the Google Fonts link for Geist, the stylesheet, the runtime with its sounds, the files a page publishes beside it, the preview document), `libs.ts` (libraries pinned in `runtime/libs.json`, refreshed under the artifact rule), `chrome.ts` (find Chrome, drive it over DevTools for tests), `shot.ts` (screenshots). |
| `scripts/` | Maintenance: `sounds.py` re-renders the sounds. |

## Tokens

`--bg`, `--fg`, `--fg-2` (body text a step back), `--muted-fg`, `--faint` (the quietest text), `--card`, `--muted`,
`--border`, `--border-strong`, `--input`, `--ring`, `--primary`, `--primary-fg`, `--ok`, `--bad`, `--c1`…`--c5`
(blue, amber, green, pink, violet), `--font`, `--mono`, `--radius`, `--shadow`, `--bar-h`. A page adds only what is
its own, such as guided-review's colors for added and removed lines, and never writes a literal color where a token
fits.

## Sounds

A sound names what the reader did, so the same act sounds the same on every page: `nav` moves to another place or
view, `step` moves a figure one step, `select` and `deselect` pick or clear, `reveal` opens a panel or shows something
new, `toggle` flips a switch or a tab, `send` sends, and `hover` ticks under a mouse, far below the rest. No sound
plays before the reader's first click or key press; the speaker button mutes them all, and the choice stays in the
browser. A page lists the ones it plays when it builds (`runtime`).

## How a skill uses it

- **Build:** `FONTS` for the font link, `styles(<own.css>)` for the stylesheet, `runtime(<runtime/index.ts>, [...])`
  for the script and its sounds, `assets(stem, {...})` to write them (and any page data) into `<stem>.files/` with the
  `files` map to publish them with, `publishLines()` to print that map, `preview(page)` for the local preview, and
  `libs(<runtime/libs.json>)` with `preloads()` when the page loads libraries from a CDN. The page itself keeps only
  its own content: an agent that reads a published page back gets up to 50,000 characters of it.
- **Runtime:** import from `../kit/web/…`. The speaker button comes from `soundButton()`; `sound.ts` wires every one
  on the page.
- **Tests and shots:** `browser()` and `findChrome()` from `kit/build/chrome.ts`; `scripts/shot.ts` calls `shotCli()`.
  Both open the preview, which loads Geist from Google Fonts, so they need the network for the real type.
- **tsconfig.json** includes `kit/**/*.ts`, so `bun run typecheck` covers the kit.

## Changing it

Keep it to what more than one page uses, or what every page should share; nothing here names a skill. After a
change, run `bun run test` and `bun run typecheck` in every skill that links the kit, look at their screenshots, and
bump `version` in `.claude-plugin/plugin.json`: an installed copy updates only when it changes.

| Command (from the repository root) | Does |
|---|---|
| `uv run --no-project --python 3.13 --with numpy --with scipy --with soundfile --with soxr python -I kit/scripts/sounds.py` | Re-renders the sounds from earshot's newest commit into `kit/sounds.json`; `--no-pull` renders from the commit already cached |

Geist loads from Google Fonts, under the SIL Open Font License 1.1; the sounds are rendered with
[earshot](https://github.com/Leonxlnx/earshot) (MIT).

# thinkr

A skill for Claude that turns a plan or an explanation into a clean, interactive page, published as a Claude
Artifact.

- **Plan pages** lay out what Claude is about to build: a stepped diagram of how it works, then 2 to 5 single or
  multiple choice questions about the real forks. You answer them, press **Send feedback** or **Approve plan**, add
  an optional message, and Claude picks up your answers in the session.
- **Explainer pages** teach one idea: diagrams you step through, WebGPU figures you can move, quick self-checks, and
  links to the sources behind every claim.

It looks like shadcn/ui's default theme in Geist: one reading column, an "On this page" rail that lists the
questions, motion that stays out of the way, and quiet UI sounds made with
[earshot](https://github.com/Leonxlnx/earshot). Pages open instantly: fonts are built in, math and code are
rendered ahead of time, and libraries are preloaded.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install thinkr --marketplace snowmead/plugins
```

On older versions: `/plugin marketplace add snowmead/plugins`, then `/plugin install thinkr@plugins`. For other
agents, or as a plain skill: `npx skills add snowmead/plugins --skill thinkr` (add `-g` for every project).

### Requirements

- [Bun](https://bun.sh) 1.2 or newer on your `PATH`. The first build installs the two packages the build uses
  (MathJax and highlight.js), once, from the pinned lockfile.
- Publishing uses Claude's Artifact tool, so pages are made in Claude Code or another Claude client that can publish
  Artifacts. claude.ai uploads are best effort: they need code execution with network access to install Bun.
- Optional: Google Chrome, for the screenshot check (`scripts/shot.ts`).

## Use

Ask in plain words. The skill triggers on planning and explaining:

- "Plan the rate limiter as a thinkr page and ask me about the open questions."
- "Explain how our sync engine resolves conflicts, with a diagram I can step through."

Claude writes the page, checks it, publishes it, and gives you the link. On a plan page, answer the questions and
submit; Claude reads your answers and messages, updates the page, and asks for a go before it builds.

## Maintain

Run these in this folder, after `bun install`:

| Command | Does |
|---|---|
| `bun run test` | Builds both templates and drives them in headless Chrome over DevTools: behavior, no console errors, and timing budgets (startup ≤ 30 ms, each interaction ≤ 12 ms) |
| `bun run typecheck` | `tsc` over the runtime and the scripts |
| `bun run examples` | Builds `templates/plan.html` and `templates/explain.html` |
| `bun scripts/build.ts --refresh` | Moves motion, vgpu, d3 and Plot to their newest release that is at least 14 days old (the artifact rule); `--major` crosses a major version |
| `bun scripts/fonts.ts` | Re-downloads Geist and Geist Mono (Latin) into `runtime/fonts/` |
| `uv run --no-project --python 3.13 --with numpy --with scipy --with soundfile --with soxr python -I scripts/sounds.py` | Re-renders the UI sounds from earshot's newest commit into `runtime/sounds.json` |

Sounds stay in one family: short, crisp ticks and clicks under 100 ms, matched in loudness and played within ±2 dB of
the contents tick. UI sound should confirm, never alarm.

```
.claude-plugin/plugin.json        name, version, metadata
SKILL.md                          what Claude reads first
references/                       authoring.md, figures.md, loop.md
templates/                        plan.html, explain.html (working examples)
runtime/                          TypeScript runtime, CSS, fonts, library pins, sound kit
scripts/                          build.ts, shot.ts (used by the skill); test.ts, fonts.ts, sounds.py (maintenance)
package.json, bun.lock            build dependencies; Claude Code installs them with the plugin
```

Licensed under Apache-2.0 (`LICENSE.txt`). Third-party parts keep their own licenses, listed in `NOTICE`: Geist fonts
(SIL OFL 1.1) and earshot (MIT).

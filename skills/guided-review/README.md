# guided-review

A skill for Claude that turns a pull request (or any branch) into a guided code review, published as a Claude
Artifact.

A big diff shown in file order makes the reviewer work out what the change does. A guided review does that work for
them:

- **Overview** with a **before / after** card: the path through the code that changed, drawn like a diff of the
  behavior, each row linked to its line and its chapter, or a mermaid flow.
- **Chapters**, one idea each, in reading order: text on the left, its code on the right. Core change first; docs,
  then database, tests and generated files last, with a label. State tables lay out the cases a change decides.
- **Code** drawn by [`@pierre/diffs`](https://diffs.com): syntax highlighting, changed words within a line, folds
  that name the function they hide, moved code marked at both ends. A **Diff** tab lists every file in a
  [`@pierre/trees`](https://trees.software) tree. Unified or split: the guide sets where it starts (`diffStyle`),
  and each reader can switch from the bar.
- **Review marks**: tick a chapter or a file to fold it and count it toward "3 of 6 chapters reviewed". `j` and `k`
  move between chapters, `r` marks one. Marks stay in the reader's browser and survive a rebuild for a new head.
- **Stacks**: one page can hold several pull requests, a stack or any set to review together. The title becomes a
  menu of them, a stack drawn from its base up, each with its branches, size and review progress; `[` and `]` move
  between them.

The page opens at once: Inter and JetBrains Mono are inline, the runtime is one small bundled script, and the
libraries are preloaded with their whole import graphs. Quiet UI sounds (the same earshot kit as
[thinkr](../thinkr)) confirm a mark; the speaker button mutes them.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install snowmead --marketplace snowmead/plugins
```

This installs the plugin snowmead, which holds all four of these skills; run this one as `/snowmead:guided-review`.
On older versions: `/plugin marketplace add snowmead/plugins`, then `/plugin install snowmead@plugins`. For other
agents, or as a plain skill: `npx skills add snowmead/plugins --skill guided-review` (add `-g` for every
project).

### Requirements

- [Bun](https://bun.sh) 1.2 or newer and git on your `PATH`. The build needs no packages.
- Publishing uses Claude's Artifact tool, so guides are made in Claude Code or another Claude client that can publish
  Artifacts. Without it, Claude hands you the preview file, a full HTML document.
- Optional: Google Chrome, for the screenshot check (`scripts/shot.ts`).

## Use

Ask in plain words:

- "Write a guided review of PR 214."
- "Walk me through what the `retry-webhooks` branch changes."
- "Review the stack #140 to #142 as one guide."

Claude gathers the diff, reads the change, writes the chapters, checks and builds the page, publishes it, and gives
you the link. Comment on any line with the comment button; Claude answers in the thread.

## Maintain

Run these in this folder, after `bun install`:

| Command | Does |
|---|---|
| `bun run test` | gather and build against a scratch repository (kinds, scopes, moves, refs, escaping, every refusal), then the demo in headless Chrome over DevTools: behavior, no console errors, and timing budgets (boot ≤ 30 ms, each interaction ≤ 12 ms) |
| `bun run typecheck` | `tsc` over the runtime and the scripts |
| `bun run example` | Builds the demo into `examples/demo.preview.html`, and the two stacked demo pull requests into `examples/stack.preview.html` |
| `bun scripts/build.ts --refresh` | Moves @pierre/diffs, @pierre/trees and mermaid (for the preview) to their newest release that is at least 14 days old (the artifact rule); `--major` crosses a major version |
| `bun scripts/fonts.ts` | Re-downloads Inter and JetBrains Mono (Latin) and their license into `runtime/fonts/` |

```
SKILL.md                          what Claude reads first
references/                       guide-format.md, writing.md
examples/                         demo.guide.json, demo-43.guide.json, and demo/ (the demo's base, its head and the PR stacked on it)
runtime/                          TypeScript runtime, CSS, fonts, library pins, sound kit
scripts/                          gather.ts, build.ts, shot.ts (used by the skill); test.ts, demo.ts, fonts.ts (maintenance)
package.json, bun.lock            dev dependencies (TypeScript, Bun's types)
```

The page layout comes from the guided review in [haaku-co/corpus-christi](https://github.com/haaku-co/corpus-christi).
Licensed under Apache-2.0 (`LICENSE.txt`). Third-party parts keep their own licenses, listed in `NOTICE`: Inter and
JetBrains Mono (SIL OFL 1.1) and earshot (MIT).

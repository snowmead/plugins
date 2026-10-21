# changelog

A skill for Claude that keeps a team changelog for a repository, published as a Claude Artifact.

Each run reads the pull requests merged since the last entry, or in the last N days, and writes one entry:

- **A title and a summary** of what changed, then **one to five themes**, one per feature, each with a few plain
  paragraphs, its PR links and a small **animated scene** that shows the change with its real numbers.
- **Things to check** after pulling (migrations, resets, a red build), and a **PR table**: size, hours open, CI and
  review runs, review scores.
- The entry goes into the changelog page's own database, so open pages show it at once, and a short **Slack post**
  links it.

It runs the same when you ask and when a routine or cron fires it: no questions mid-run, and the options are how you
narrow a run.

```
/snowmead:changelog            # since the last entry
/snowmead:changelog 7          # the last 7 days
/snowmead:changelog 3 no-slack # save it, but post nothing
/snowmead:changelog dry-run    # write it and show me; save and post nothing
```

The page is a quiet feed of entries on a date rail, in Geist, with soft UI sounds (earshot) that wait for your first
click. It shares its look, its sounds and its bar with [thinkr](../thinkr) and [guided-review](../guided-review)
through the [kit](../../kit), publishes its styles and script beside a small page, loads
Geist from Google Fonts, and reads its entries live.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install snowmead --marketplace snowmead/plugins
```

This installs the plugin snowmead, which holds all four of these skills; run this one as `/snowmead:changelog`. On
older versions: `/plugin marketplace add snowmead/plugins`, then `/plugin install snowmead@plugins`. For other
agents, or as a plain skill: `npx skills add snowmead/plugins --skill changelog`.

### Requirements

- [Bun](https://bun.sh) 1.2 or newer, [jq](https://jqlang.org), and the [GitHub CLI](https://cli.github.com) logged in
  (`gh auth status`).
- Claude's Artifact tool and its database, so runs happen in Claude Code or another Claude client that has them.
- A Slack connector in the session, to post. Without one, a run saves the entry and says it did not post.
- Optional: Google Chrome, for the screenshot check (`scripts/shot.ts`).

## Set up

Ask Claude to set the changelog up in your repository. It writes `.claude/changelog.json` (product name, repository,
time zone, Slack channel, which CI and review workflows to count), publishes the page, and asks you to commit the
config, so every run and every teammate uses the same page.

## Maintain

Run these in this folder, after `bun install`:

| Command | Does |
|---|---|
| `bun run test` | Dates and windows, CI counting, the config's checks and every entry rule; then the page in headless Chrome over DevTools: behavior, stripped scene markup, no sideways scroll at phone width, no console errors, and timing budgets |
| `bun scripts/test.ts --live` | Also runs `gather.ts` against a busy public repository (needs `gh` and the network) |
| `bun run typecheck` | `tsc` over the runtime, the scripts and the example |
| `bun run example` | Builds the example entry into `examples/changelog.preview.html` |

```
SKILL.md                          what Claude reads first
references/                       writing.md, format.md, page.md
examples/                         entry.ts, stats.json, changelog.json (a made-up "Relay" day)
runtime/                          TypeScript runtime, CSS
kit/                              link to the shared kit: tokens, sounds, UI parts, build helpers
scripts/                          gather.ts, entry.ts, scenes.ts, build.ts, shot.ts (used by the skill); test.ts
package.json, bun.lock            dev dependencies (TypeScript, Bun's types)
```

Licensed under Apache-2.0 (`LICENSE.txt`). Third-party parts keep their own licenses, listed in `NOTICE`: earshot
(MIT).

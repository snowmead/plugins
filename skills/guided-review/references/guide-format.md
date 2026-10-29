# guide.json

The guide is the part you write. `gather.ts` writes the diff; `build.ts` joins the two and checks the guide against
the diff. [`../examples/demo.guide.json`](../examples/demo.guide.json) uses every common field, and
[`../runtime/types.ts`](../runtime/types.ts) types every one (`Guide`).

## Top level

| Field | Required | What it holds |
|---|---|---|
| `pr` | yes | `title`; `number` and `url` together, or neither for a branch with no pull request; optional `author` (GitHub login), `base` (branch name), `head` (branch name). Copy them from GitHub. |
| `name` | no | The page's name in the browser tab and the artifact gallery, 2 to 4 words, such as "Webhook retries review". Defaults to "Guided review #<number>", or "Review of <branch>" with no pull request. |
| `diffStyle` | no | `"unified"` (default) to show each change in one column, or `"split"` to show old and new side by side. It is where cards start: each reader can switch with the Unified / Split control in the bar, and the page remembers their choice. Screens under 860 px wide always show one column. Pick `split` when most changes rewrite lines in place rather than add or remove whole blocks. |
| `links` | no | Buttons in the top bar, `[{ "label": "Video", "href": "https://…" }]`. Link the pull request's video and anything else the reader checks the change with. `https://` only. |
| `overview` | yes | The opening section. See below. |
| `chapters` | yes | The chapters, in reading order. See below. |

## `overview`

| Field | Required | What it holds |
|---|---|---|
| `summary` | yes | What the pull request changes and why, in 2 to 4 sentences: the state before, then what is different. A string, or an array of paragraphs. |
| `steps` | no | 2 to 5 one-line items: the main moves of the change, in the order the chapters take them. |
| `beforeAfter` | yes | The before / after card beside the summary. See below. |

## `beforeAfter`

The card that shows how the system behaved before and how it behaves now, like a diff of the behavior. Give
`lines`, a `flow`, or both. A chapter can have its own `beforeAfter` too, when its idea needs one.

| Field | What it holds |
|---|---|
| `label` | A muted word after "Before / after": `call tree`, `pseudocode`, `flow`, `what stops`, `data`. |
| `title` | One line above the card's body that names the path shown, such as "The worker posts a batch of deliveries". |
| `lines` | The rows. Each row is an object, below. |
| `flow` | [Mermaid](https://mermaid.js.org/syntax/flowchart.html) source that starts with `flowchart LR` or `flowchart TD`. Add `:::new`, `:::changed` or `:::removed` to a node to draw its border green, amber or dashed red. The artifact viewer draws it. |

Each row of `lines`:

| Field | What it holds |
|---|---|
| `t` | The row's text: a call, a step, a state, a rule. Under 90 characters. Plain text, shown in the code font. |
| `op` | `" "` (default) for a row that stays, `"-"` for a row that goes, `"+"` for a row that is new. Put the `-` row just before the `+` row that replaces it. |
| `d` | Indent depth, 0 to 8. Nest a callee one deeper than its caller. |
| `note` | A short muted aside after the text, such as "one per row" or "was always". |
| `ref` | `path:line`, the code the row stands for. Shows as `file.ts 120` at the right and jumps to that line in its chapter. A `-` row's line is on the old side; every other row's is on the new side. A file the pull request does not change links to GitHub at the head commit. |
| `ch` | A chapter id. Shows the chapter's number at the right. Without it, a row with a `ref` shows the number of the chapter that holds that line. |

## `chapters`

| Field | Required | What it holds |
|---|---|---|
| `id` | yes | Lower case letters, digits and dashes. It becomes the anchor `#c-<id>` and the key for review marks, so keep it when you rebuild. |
| `title` | yes | The idea, in a few words: "Merge gate on the board", not "Changes to merge-gate.tsx". |
| `kind` | no | `core` (default), `docs`, `database`, `tests` or `generated`. Every kind but core shows a label. Database, tests and generated chapters come after every core and docs chapter, and generated ones come last. |
| `body` | yes | One or two short paragraphs, a string or an array. |
| `files` | yes | The code the chapter shows, in the order to read it: a path for the whole file, or `{ "path": "…", "hunks": [2, 3] }` for some of its hunks. Hunk numbers are the ones `gather.ts` prints. |
| `table` | no | A boxed state table under the body, below. |
| `beforeAfter` | no | A before / after for this chapter, above its files. |

Every hunk of every file belongs to a chapter, and `build.ts` stops when one is missing. Split a file by hunks
when its parts belong to different ideas; show a hunk once.

A Markdown file (`.md`, `.markdown`) needs nothing more: `build.ts` renders it, and its card opens in Preview with
the change marked, showing the blocks of the chapter's own hunks. A ref to one of its lines lands on the block that
holds it. A file gather.ts keeps without its text (over 4,000 lines or 400 KB) shows only its source.

## `table`

A state table lays out the cases a change decides between, one row per case, with the new cases marked.

| Field | What it holds |
|---|---|
| `title` | Defaults to "State table". |
| `caption` | A muted line after the title, such as "which delivery completes". |
| `ref` | `path:line` of the code that decides. |
| `columns` | The column names. |
| `rows` | Each row is `{ "cells": […], "new": true }`, or `"gone": true` for a case that no longer exists, or a plain array of cells. |
| `note` | A line under the table, such as "2 of 4 cases are new". |

## Text

`summary`, `steps`, `body`, table cells and `note` take a small Markdown subset: `` `code` ``, `**bold**`, `*em*`,
`[text](https://…)`, and `[text](ref:path:line)` for a link that jumps to a line of the diff (or to GitHub, for an
unchanged file). Name functions, types and fields in backticks.

## stack.json

Several pull requests on one page: a stack, or any set to review together. `build.ts --stack=<path>` reads it.

| Field | Required | What it holds |
|---|---|---|
| `name` | no | The page's name in the browser tab and the artifact gallery, 2 to 4 words, such as "Webhook retries stack". Defaults to "Guided review #140–#142". |
| `diffStyle` | no | `"unified"` or `"split"` for every pull request on the page; without it, the first guide's. |
| `prs` | yes | The pull requests in the order the menu lists them, a stack from its base up: `[{ "guide": "pr-140/guide.json", "diff": "pr-140/diff.json" }, …]`. Paths are relative to the stack file. Each pull request appears once. |

Each guide is checked on its own, as above, and its errors start with its number. Its `name` and `diffStyle` give
way to the stack's. Every element id on the page starts with the pull request's own (`pr140-`), so two guides may use
the same chapter ids. A link's anchor picks the pull request: `#pr140`, `#pr140-c-<id>` or `#pr140-diff`. The menu
draws the pull requests as a stack when each one's base (`pr.base`, or the branch `gather.ts` read) is the branch of
the one before it.


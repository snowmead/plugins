# Formats

The config the repository keeps, what `gather.ts` writes, the entry a run writes, the document `entry.ts` saves, and
the scene builder. [`../runtime/types.ts`](../runtime/types.ts) types each of them.

## Config

`.claude/changelog.json` at the top of the repository's checkout. [`../examples/changelog.json`](../examples/changelog.json)
is a complete one.

| Field | Required | What it holds |
|---|---|---|
| `name` | yes | The product's name, as the page and the post call it: `"Relay"`. The page is titled "Relay Changelog". |
| `repo` | yes | `owner/name` on GitHub. |
| `timezone` | yes | The IANA zone entries are dated and labelled in: `"America/Toronto"`. An entry's date is its window's end in this zone. |
| `page` | after setup | The changelog page's link, `https://claude.ai/artifact/…`. |
| `slack` | no | `{ "channel": "C0123ABCD", "label": "#relay" }`: where each entry is posted. `null` or absent for no post. |
| `workflows` | no | `{ "ci": "ci.yml", "review": "claude-review.yml" }`: workflow files whose runs are counted per PR. Leave one out to skip it, and its column leaves the PR table. |

## stats.json

| Field | What it holds |
|---|---|
| `repo` | `owner/name`. |
| `window` | `since` and `until` (ISO, UTC); with a CI workflow, `ci_runs`, `ci_failed`, `ci_in_progress` and `ci_median_min` (the median minutes of successful runs created in the window); `null` without one. |
| `prs.<n>` | `title`, `url`, `author`, `created_at`, `merged_at`, `add`, `del`, `files`, `hours` (opening to merge), and `ci_runs`, `ci_failed`, `review_runs` (`null` without the workflow). |

A window holds the PRs merged after its start and up to its end, so two runs never count one PR. A PR's runs are
`pull_request` runs on its head branch, created between its opening and its merge.

## The entry

The run's `entry.ts` default-exports a function that takes `{ Svg }` and returns:

| Field | What it holds |
|---|---|
| `title`, `summary` | The headline and two to four sentences. |
| `themes` | One to five: `key` (lower case, unique: the theme's anchor), `kicker`, `title`, `sum`, `prs` (numbers), `paras`, `scene` (`{ svg, caption }`, from `Svg.scene`). |
| `watch` | Things to check after pulling. |
| `scores` | Optional. `{ 42: [5, "verdict"] }`: a review score out of 5 and its verdict, verbatim, when the PRs give one. Its column shows only when set. |
| `titles` | Optional. Shorter titles for the PR table. |
| `slack` | `intro`, `lines` (`[emoji, text]` pairs) and `watch`. |

## The document

What `entry.ts` writes to `<date>.json` and the run saves in the page's database, collection `entries`, id `date`.
One document holds at most 256 KiB; an entry with five scenes is about 40 KiB.

| Field | What it holds |
|---|---|
| `date` | The window's end as a date in the config's zone: the id and the link (`#2026-10-20`). |
| `window`, `span`, `timezone` | "Oct 19, 6:05 pm to Oct 20, 9:40 am" in the zone, its length ("16 hours"), and the zone. |
| `window_start`, `window_end` | Both ends in UTC. The next run starts at `window_end`. |
| `title`, `summary`, `themes`, `watch` | From the entry. Scene marker ids carry the date, so two entries never share one. |
| `numbers` | `prs`, `add`, `del`, `ci_median_min`, `ci_runs`, `ci_failed`: the numbers line. |
| `prs` | One row per PR: `n`, `title`, `merged` (a label in the zone), `add`, `del`, `files`, `hours`, `review_runs`, `conf`, `conf_note`, `ci_failed`, `ci_runs`. |
| `repo`, `source` | The PR link prefix, and `changelog run`. |

## Scenes

`new Svg(key, height, alt)` draws a scene 540 wide. `t` is the second it appears at. Coordinates are SVG units.

| Method | Draws |
|---|---|
| `text(x, y, s, t, cls = 'sc-sub', anchor = 'start')` | A line of text; `sc-text` for the strong style. |
| `node(x, y, w, h, title, sub = null, t = 0, hl = false)` | A box with a title and an optional second line; `hl` outlines the new one. |
| `edge(d, t, dash = false, arrow = true)` | A path, such as `'M164 54 L196 54'`, with an arrow. |
| `hop(cx, cy, dx, dy, t, s = 's1', dur = 0.5)` | A dot that travels by (dx, dy), then fades: a message in flight. |
| `dot(cx, cy, s, t, r = 6)` | A dot in shade `s1`, `s2` or `s3`. |
| `chip(x, y, w, h, s, t)` | A small label on a grey ground. |
| `cross(x, y, t, r = 8)` | An X: something that stopped or failed. |
| `line(x1, y1, x2, y2, t, cls = 'sc-edge')` | A straight line. |
| `scene(caption)` | Returns `{ svg, caption }` for the theme. |

The page plays `sc-in` (rise in), `sc-fade`, `sc-pop` and `sc-hop`, each after `--t` seconds, and drops scripts,
`foreignObject`, images, links, `on*` attributes and outside references from every scene.

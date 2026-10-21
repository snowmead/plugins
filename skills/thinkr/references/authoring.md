# Authoring a thinkr page

```html
<title>API Rate Limits</title>            <!-- a name of 2 to 4 words, first thing in the file -->
<style> /* optional page styles, using the tokens below */ </style>
<t-page mode="plan" version="1">
  <header>
    <h1>API Rate Limits</h1>
    <p class="lede">One paragraph: what this is and why it matters.</p>
  </header>
  <section> <h2 id="flow">…</h2> … </section>
</t-page>
<script type="ts"> /* figure code, see figures.md */ </script>
```

`build.ts` adds the fonts, CSS, runtime, sounds and library URLs. Each `h2` becomes an entry in "On this page".

## The page

| Attribute | Use |
|---|---|
| `mode="plan\|explain"` | Required. `plan` adds the dock (progress, Send feedback, Approve plan) and saves answers for Claude. |
| `version="N"` | Required. Start at 1; add 1 on each republish. The header shows it and every send names it. |
| `key="…"` | Optional storage key. Defaults to a slug of the `h1`. |

## Text

Plain HTML: `section`, `h2`–`h4`, `p`, `ul`, `ol`, `blockquote`, `table`, `pre`, `code`, `kbd`, `strong`, `em`, `a`.

| Element | Use |
|---|---|
| `<p class="lede">` | The summary under the `h1`. |
| `<a href="https://…">` | A link out. The runtime adds a small ↗ and opens it in a new tab. Link the first mention of every library, API, spec, file or source. |
| `<t-callout kind="note\|tip\|warn" label="…">` | A boxed aside with an icon. Use rarely. |
| `<t-refs><ul><li><a href>Title</a><small>Why open it</small></li></ul></t-refs>` | The sources list, at the end of the page. Each row shows the link's site. |
| `<pre data-title="file.ts" data-href="https://…#L10-L20"><code class="language-ts">` | Code with a header, a copy button and highlighting (done at build, any highlight.js language). `data-href` links the header to the real file. Escape `<` and `&`. |
| `<table>` | Scrolls sideways on phones. `class="num"` on a cell right-aligns a number in mono. |
| `$$ … $$`, `\[ … \]`, `\( … \)` | TeX, rendered to SVG at build (the page loads no math library). `\col{1}{x}` colors a term with `c1`; `\R`, `\N`, `\E` are defined. The build warns on a TeX error. |
| `<pre class="mermaid">` | A static diagram the artifact viewer draws. Prefer a stepped SVG figure when order matters. |

### Color

Five semantic colors: `c1` blue, `c2` amber, `c3` green, `c4` pink, `c5` violet. Use them for recurring things, the
same meaning everywhere: `<span class="c1">learning rate</span>` in text, `var(--c1)` in SVG, `\col{1}{\eta}` in math,
`fig.color('c1')` in a shader. Never let color be the only signal.

Tokens for page styles and SVG: `--bg`, `--fg`, `--fg-2`, `--muted-fg`, `--faint`, `--card`, `--muted`, `--border`,
`--border-strong`, `--primary`, `--primary-fg`, `--ok`, `--bad`, `--c1`…`--c5`, `--font`, `--mono`, `--radius`. Both
themes are handled; never write a literal color.

## Questions

```html
<t-question id="algorithm" type="single" recommended="bucket">
  <p>Which algorithm should count requests?</p>
  <t-option value="bucket">Token bucket<small>Allows short bursts, then a steady rate.</small></t-option>
  <t-option value="fixed">Fixed window<small>Simplest. Lets a client double the limit at a minute boundary.</small></t-option>
</t-question>
```

| Attribute | Use |
|---|---|
| `id` | Required, stable across versions. Letters, digits, `-`, `_`, `.`. |
| `type="single"` | One answer (radio). The default. |
| `type="multi"` | Any number of answers (checkboxes). Add `max="2"` to cap it; the hint reads "Choose up to 2". |
| `type="text"` | A free answer. `placeholder` sets the hint. |
| `recommended="value"` | Your pick, shown with a badge. Always set it in a plan. |
| `toc="Counting algorithm"` | The question's 2 to 4 word label under its section in "On this page". Without it the question text is cut to fit. |
| `answer="value"` or `answer="a,c"` | Makes it a self-check (explainers): **Check** marks right and wrong options and opens the `<t-explain>`. No Other row. |
| `no-other` | Removes the Other row (plans get Other with a text field by default). |

- The first `<p>` is the question: one sentence that names the decision.
- Each `<t-option value>` keeps its `value` across versions. `value="other"` is reserved.
- In a plan, each choice question has **Add a note** for the reader's reason.
- `<t-explain>` inside a self-check holds the explanation shown after **Check**.

## Changes (plans, from version 2)

Each republish of a plan says what changed and why, so the reader sees what their answers and comments did without
rereading the page. Put one `<t-amends>` right after the `<header>`, add the new version's entries at the top, and
keep the older ones: the list is the plan's history.

```html
<t-amends>
  <t-amend version="3" kind="answer" label="Limits per org too" at="flow scopes"
           re="What should each limit be counted against?" answer="API key; Organization">
    The gateway now looks up each key's org, and the decided question is gone.
  </t-amend>
  <t-amend version="2" kind="comment" label="Two weeks of shadow mode" re="Is one week of shadow mode enough?" at="rollout">
    Shadow mode runs two weeks, to cover a month-end billing run.
  </t-amend>
</t-amends>
```

| Attribute | Use |
|---|---|
| `version="N"` | Required. The version the change landed in, from 2 to the page's `version`. |
| `kind` | Required. What led to it: `answer` (an answer to a question on the page), `comment` (a comment on the page), `message` (the message sent with Send feedback or Approve plan), `chat` (something said in the chat), `claude` (your own fix). |
| `label="…"` | Required. The change in 2 to 6 words: its one-line row in Changes. |
| `re="…"` | What it answers. For `answer`, required: the question word for word, shown beside **Q** (numbers shift once a decided question is removed, so never the number alone). For a comment, message or chat, what was said, short, shown as a quote. Leave it out only for `claude`. |
| `answer="…"` | Required for `answer`: the reader's answer as they gave it (the option labels, their Other text or their written answer), shown beside **A**. |
| `at="id id"` | Where it changed: the ids of the changed elements, of a parent, or of a section's `h2`. The old id of something you removed (a decided question) works too. Optional when the version has one entry. |

Write a `"` inside an attribute as `&quot;`. The text is one or two sentences: what changed, and why. Do not repeat
the answer; it is shown above the text. Inline `code` and links are fine. An answer that changed nothing on the page
still gets an entry, with no `at=`, so the reader finds it in the list.

You write the why; the build finds the where. It keeps each version's blocks in `<name>.history.json` next to the
page and compares the page with the version before:

- In a paragraph, list item, heading or table row that changed, added words are marked and removed words kept, to
  show struck through. A changed figure, question or code block is marked as a whole.
- A removed block leaves a hidden stub where it was ("Removed", then its text, or a question's or figure's name).
- Each change is tied to the entries of its version whose `at=` covers it. The build warns about a change no entry
  covers, and about an entry whose `at=` covers nothing that changed.
- A block keeps its marks until it changes again, so an older entry still shows its words while they stand.

Never write the marks yourself (`<ins>`, `<del data-t>`, `data-v`, `data-amend`, `<t-removed>`): the build owns them
and refuses a page that has them. Without the history file (a new session, a copied page) the page still builds; its
entries then point to their `at=` elements, without word marks, until the next version.

## What the reader gets (you do not write these)

- A sticky bar with the page name once they scroll, and a sound toggle. Sounds play after their first click.
- "On this page" on wide screens: sections, with their questions one notch to the right and a dot that fills when a
  question is answered. The highlight slides along the rail; a click glides to the entry.
- In a plan, the dock at the bottom: the answered count (click it to go to the next open question), **Send feedback**
  and **Approve plan**. Either button opens a panel above the dock with an optional message ("Anything else Claude
  should know?") and **Submit** (⌘↵). Approving with open questions says how many are open, with a link to the first.
  There is no notes element: the message box is where anything else goes.
- In a plan with `<t-amends>`, **Changes**: versions that fold, newest first, each change a one-line row with its
  label; left of the page on wide screens, behind a Changes button in the bar on narrower ones. The current version
  and any with news start open. Opening a row shows where it came from (Q and A for an answer, the quote for a
  comment) and why, lights its changes (added words underlined, removed words struck through, removed blocks shown)
  and glides to the first; the bar then shows where they are (2 / 3) with previous, next and close (Esc). One row is
  open at a time; clicking it again closes it. Rows newer than the reader's last visit get a dot, and their count
  shows on the Changes button.
- Claude's own comment button (from the artifact viewer) works on any paragraph, figure, question or code line.

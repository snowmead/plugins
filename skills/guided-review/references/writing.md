# Writing the guide

A guided review answers one question for a reader who did not write the code: what did this pull request change,
and where is it? The reader should understand the change at a high level from the overview, then review one idea at
a time, and spend attention only where it matters.

## Who reads a guide

Write for an engineer on the same team who works on another system. They can read code in this language. They do
not know this system's words, its files, its history, or why it is built the way it is. They want to understand the
change fast, without reading the code around it first.

So the guide reads **top down**. Each level explains the words and the parts that the next level uses:

1. **Background**: what this system is, what uses it, and how it works before the change. No change yet.
2. **This change**: what was wrong or missing, and what the pull request does about it.
3. **Steps**: the main moves of the change, in chapter order.
4. **Chapters**: one idea each. A chapter starts with what its part of the system does, then says what changed.

Under all four, the **terms**: the words a reader from another system will not know, each with a short meaning. The
page marks a term where each section first uses it, and its meaning opens in a tooltip when the reader points at
it, focuses it or taps it. So a reader who starts at any section can look a word up where they meet it.

A reader who stops after any level knows something true and useful. A word, a code name or a part that a level uses
is explained at that level or at a level above it. When you are not sure if a reader knows a word, explain it.

## Before you write

Read the whole diff, not only the outline `gather.ts` prints: `git diff <base>...<head> -- <path>`, with the refs you
gave `gather.ts`, a file or a folder at a time. After `--worktree` or `--pr`, start from the command gather printed:
plain `git diff` skips untracked files, and the checkout you started in may not hold the pull request. Do not read
`diff.json`; it holds the full old and new text of every changed file. Read the pull request's description, its commits
and the thread that asked for it. Open the callers
and callees of each changed function until you can say what happened before the change and what happens now. On a
large pull request (over about 1,000 changed lines), give that tracing to Explore subagents, one per area, and work
from their short reports. When the diff and the description disagree, the diff wins: the guide describes the code at
its head commit.

As you read, write down the words a reader from another system would not know: the system's own nouns, and the code
names the chapters will lean on. They become `terms`, or a short explanation in the text.

When the change was built from a spec (the description has a `Spec:` line with a thinkr design page's link), read
the agent spec it was built from: `Artifact` `read` of that link, without its `#spec`, with `path: "agent-spec.md"`.
Set `spec` in the guide ([guide-format.md](guide-format.md#top-level)), so the page links to the spec people read.
Where the code does something the agent spec does not say, or leaves out something it does, say so as a plain fact
in the chapter that holds it: the reader reviews the change against the spec it was built from.

If the read finds a defect in a pull request you drive, fix it first: the guide is written for the code that will
merge. In uncommitted changes or someone else's pull request, tell the user; the guide still describes the code as it
is.

## Chapters

Plan the chapters before anything else.

- **One idea per chapter.** A chapter is one change a reviewer can hold in mind: a new check, a moved
  responsibility, a renamed concept, a new screen. Group the files and hunks that make that idea, across folders. A
  file whose hunks serve two ideas is split by hunks.
- **The core change comes first.** Order chapters so each one builds on the ones before it: the type or rule the
  change is about, then the code that uses it, then the surface (route, screen, prompt). Docs that explain the
  change can follow the code they describe.
- **Database, tests and generated files come last.** Give them their kinds so they carry a label. Generated files
  start folded.
- **3 to 8 chapters.** Merge chapters of one hunk into the idea they serve. Split a chapter that needs more than two
  short paragraphs.
- **Title the idea, not the file.** "Merge gate on the board", "The search is a read", "Retry failed async steps".
  A few words, sentence case, no file names.

## Chapter text

- **Start with what this part does, in plain words.** The first sentence says what the part of the system in this
  chapter does, before the change, and names no code: "The worker is a loop that sends the deliveries that are due."
  The code's name comes next: "Each run calls `drain`, which…". Then say what changed. A reader who skips the code
  still knows where they are. Not "`drain` takes `pending` deliveries", not "The new `verifier` is…". The build
  warns when a chapter opens on a code name, or names two in its first sentence.
- **Say what the code does now, and why.** Give the behavior or the rule first, then name the type or function that
  does it. The reader sees the code beside the text, so do not describe it line by line.
- **Two short paragraphs at most, under 130 words.** The first says what this part does and what changed. The
  second, when needed, says a consequence, an edge case, or what the code does not do on purpose.
- **Explain a code name before you lean on it.** The first time a chapter names a type, function or field that is not
  in `terms`, say what it is in a few words: "`nextAttemptAt`, the time of the next post". Name things in backticks.
  Link one with `[name](ref:path:line)` when the reader should jump to it.
- **A table when the change decides between cases.** When a change picks among states or inputs, a state table with
  one row per case says it faster than prose. Mark the new rows.
- **No praise, no review findings.** The guide explains; it does not grade. A risk the reviewer should know about is
  a fact about the code: say it plainly ("The retry runs inside the transaction, so a failure rolls back both
  writes").

## Diagrams

Every section has one, drawn at build in the page's colors: the overview's draws the whole pull request, and each
chapter's draws its own part, above its code. A diagram answers the reviewer's first question about a section: what
did this look like before, and what is different now? Draw each chapter's after its text, from the code.

- **Draw the path that changed, as a diff.** The entry point, the steps under it, the decision or the state that is
  new. Mark what the pull request adds `:::new`, what it changes `:::changed` and what it takes out `:::removed`, and
  keep the nodes around them plain, so the reader knows where they are. A removed node can hang off the node that
  used to lead to it, on a dotted edge labelled `before`.
- **Pick the kind that fits the change.** A flowchart for a path or a decision (`LR` for a pipeline, `TD` for a
  decision tree), a sequence diagram for messages between services, a state diagram for new states, an ER diagram
  for tables.
- **Keep it small: 3 to 10 nodes, labels under about 40 characters.** Name a node for what it does, in plain words
  first and the code's name second ("deliver: posts the signed event"), and put conditions on the edges. Leave out the calls that did not
  change and do not explain the change.
- **Ref every node that stands for code.** A ref makes the node a link to its line, and its tooltip names the
  chapter, so the overview's diagram doubles as a map of the guide.
- **Every chapter, the late ones too.** Docs: the sections that changed and what they now say. A migration: the
  table with its new columns, constraints and indexes. Tests: the cases, grouped by what they test, the new ones
  marked. Generated files: the source they come from and what changed in it.

## Overview

Write it last, from the chapters and their diagrams. On the page it reads top down: background, this change, steps,
with the diagram beside them. The terms have no list of their own: they are marked in the text.

- **Background, 2 to 4 sentences, under 80 words.** What the system or part is, what uses it, and how it works today,
  before this change. Say it as you would to a new engineer on their first day: "The webhook service sends events to
  our customers' servers. A worker loop posts each event, called a delivery, to the customer's URL." Start with
  plain words, with no code names. Do not talk about the change here.
- **Summary, 2 to 4 sentences.** What was wrong or missing, then what the pull request does about it, in the words
  a product person would use. No file names and no code names: say "a reserve that is being closed", not "an
  `Obsolete` reserve". It can use the words the background explained.
- **Steps, 2 to 5 lines,** in chapter order: the main moves of the change. Each one is a sentence a reader can
  follow without the code, with no code names: "The worker now also sends failed deliveries when their retry time
  comes", not "`drain` takes due rows". The build warns on a code name in the background, the summary or a step.
- **Terms, up to 12.** The domain words and code names that a reader from another system will not know, with the
  overview's plain words first ("reserve", "obligation") and then the code names the chapters lean on (`drain`).
  Each meaning is one sentence, 25 words or fewer, in plain words, with no links. Write `term` exactly as the text
  uses it: a word matches with its plural ("delivery" marks "deliveries"), and a code name in backticks matches the
  same code in the text. A term inside a link is not marked, so use it once outside the link. The build warns on a
  term the text never uses. Leave out general programming words ("retry", "index", "migration").
- **Diagram: the whole change at a glance.** The path a request, an event or a record takes now, with what the
  pull request adds, changes and removes marked, in 5 to 10 nodes. Ref each node to the line its chapter shows.

## Style

Write about 80% of the way to [ASD-STE100](https://www.asd-ste100.org/) Simplified Technical English. STE is a
standard for technical text that people read fast, and often not in their first language. Keep its writing rules;
drop its fixed dictionary, since code and its domains need their own words.

Keep:

- **Short sentences.** Aim for 20 words or fewer. The build warns at more than 25: split the sentence in two.
- **One idea per sentence, one topic per paragraph,** and no more than 4 sentences in a paragraph.
- **Active voice and present tense.** "The worker sends the delivery", not "the delivery is sent by the worker".
  Say what the code does now.
- **The same word for the same thing.** When the code calls it a delivery, do not also call it an event, a message
  and a job. Use one word, and keep it in every section.
- **Define a word where it first appears,** in the text or in `terms`.
- **No noun strings of more than 3 words.** "The retry delay of a failed delivery", not "failed delivery retry delay".
- **Keep "the", "a" and "an".** Do not drop them to make text shorter.
- **Precise verbs.** "Sends", "stores", "rejects", "counts", not "handles", "deals with", "processes" or "manages".
- **A verb, not an "-ing" noun.** "When the worker retries a delivery", not "on retrying".
- **No idioms or metaphors.** "Fails", not "falls over"; "starts", not "kicks off".
- **Numbers with their units:** "30 s", "6 posts", "1 hour".

Drop:

- **The STE dictionary.** Use the words the code and the project use, as they are, once you define them.
- **Its limits on technical verbs.** "Serialize", "deploy" and "rebase" are fine.

Before, in the style of an older guide:

> `deliver` used to post once and mark anything but a 2xx as failed. It now counts `attempts` and sorts each failure
> with `retryable`: a timeout, a network error, a 408, a 429 or a 5xx goes to `retrying`, due at `nextAttemptAt`.

After:

> The worker sends each delivery with one HTTP post. Before this change, any answer that was not a success made the
> delivery fail. Now `deliver` counts the posts in `attempts`. It also asks `retryable` if the failure can pass
> later: a timeout, a network error, a 408, a 429 or a 5xx can. Those deliveries go to `retrying`, with
> `nextAttemptAt`, the time of the next post.

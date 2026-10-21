# Writing the guide

A guided review answers one question for a reader who did not write the code: what did this pull request change,
and where is it? The reader should understand the change at a high level from the overview, then review one idea at
a time, and spend attention only where it matters.

## Before you write

Read the whole diff, not only the outline `gather.ts` prints: `git diff <base>...<head> -- <path>`, with the refs you
gave `gather.ts`, a file or a folder at a time. Do not read `diff.json`; it holds the full old and new text of every
changed file. Read the pull request's description, its commits and the thread that asked for it. Open the callers
and callees of each changed function until you can say what happened before the change and what happens now. On a
large pull request (over about 1,000 changed lines), give that tracing to Explore subagents, one per area, and work
from their short reports. When the diff and the description disagree, the diff wins: the guide describes the code at
its head commit.

If the read finds a defect in a pull request you drive, fix it first: the guide is written for the code that will
merge. In someone else's pull request, tell the user; the guide still describes the code as it is.

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

- **Say what the code does now, and why.** Start with the behavior or the rule, then name the type or function that
  carries it. The reader sees the code beside the text, so do not narrate it line by line.
- **Two short paragraphs at most, under 110 words.** The first says what changed; the second, when needed, says a
  consequence, an edge case, or what the code deliberately does not do.
- **Name things in backticks.** `MergeGate`, `search_programs`, `open_fields`. Link one with `[name](ref:path:line)`
  when the reader should jump to it.
- **A table when the change decides between cases.** When a change picks among states or inputs, a state table with
  one row per case says it faster than prose. Mark the new rows.
- **No praise, no review findings.** The guide explains; it does not grade. A risk the reviewer should know about is
  a fact about the code: say it plainly ("The retry runs inside the transaction, so a failure rolls back both
  writes").

## Before / after

Every guide opens with one. It answers the reviewer's first question: what was the system before, and what changed?

- **Draw the path that changed, as a diff of behavior.** Use a call tree or pseudocode: the entry point, the calls
  under it, the decision that is new. Rows that go are `-`, rows that come are `+`, and the rows around them stay
  so the reader knows where they are.
- **Keep it under 30 rows,** each under 90 characters. Leave out calls that did not change and do not explain the
  change.
- **Ref every row you can.** A ref jumps to the code, and the row shows its chapter's number, so the card doubles as
  a map of the guide.
- **Use a flow** when the change adds a path through several components, such as a new message from one service to
  another, or new states. Mark the new nodes `:::new`. Keep the rows too when the flow alone hides what was there
  before.
- **Give a chapter its own before / after** only when its idea is a change of behavior that its code does not show
  at a glance.

## Overview

Write it last, from the chapters.

- **Summary, 2 to 4 sentences.** What was wrong or missing, then what the pull request does about it, in the words
  a product person would use. No file names.
- **Steps, 2 to 5 lines,** in chapter order: the main moves of the change.

## Style

Write close to [ASD-STE100](https://www.asd-ste100.org/) Simplified Technical English: short sentences, active
voice, one idea per sentence, the same word for the same thing, no idioms. Keep the code's names as they are, and use
the project's own domain terms, from its docs and its code.

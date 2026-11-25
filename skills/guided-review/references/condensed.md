# Writing the Condensed tab

The Condensed tab is the page's first tab. It exists so a reviewer can check the direction of a change in a few
minutes, without reading all of its code. Agents find mechanical bugs well; the reviewer checks what the change does,
the decisions in it, and the contracts between its parts. So the tab shows only that, and leaves out everything else.
The Guided tab walks every hunk, and the Diff tab holds every file: nothing is lost.

Write it after you read the change and plan the Guided chapters ([writing.md](writing.md#before-you-write)). The
fields are in [guide-format.md](guide-format.md#condensed).

## The story

The tab tells one story, top down. Leave out a step the change does not have.

1. **The lede.** What changed and why, in one to three lines. When the change replaces a behavior, write it as a
   **Before** line and a **Now** line. Decisions about the whole change, and approaches dropped for it, follow.
2. **A flow chart**, only when the change adds, removes or moves a link between parts of the system, and the link is
   more than a straight line (it branches, loops, or joins many parts). "A, then B, then C" is a sentence, not a chart.
3. **One section per part of the system,** in the order the data moves: the producer before the consumer, the
   contract (types and signatures) before the code that uses it. Name a section for the part ("The worker takes due
   retries"), not for a file.
4. **Tests,** last: the test names that state something about the system that is not obvious.

## Decisions

A decision is a choice that shapes the change and that a reviewer can want done another way. Reviewers find most of
their points in them, so put each one at the top of the section it shapes, or in the lede for the whole change.

- Take decisions from the description, the spec the change was built from, or its review thread. For a change you
  drive, you can also name the choices you made while you built it. Never write a decision nobody made.
- Mark a decision **implicit** when it was made while building, with no discussion.
- `why` says the reason; `tradeoff` says what the choice costs; `discarded` says an approach dropped for it, and why.

## The code

The code is the main part of the tab. Each snippet is the code at the base (`old`) and at the head (`new`), cut by
hand. The build diffs the two sides, and checks each shown line against the real file.

**Show:**

- Signatures, types and contracts that leave their own part of the system, and both ends of each one: where the code
  makes a value and where it reads it.
- The lines that decide: a new condition, a new state, a changed query, a removed safety net (a `try`, a fallback,
  shown on the old side).
- A legacy path that the change keeps, cut short, so the reviewer sees that old data still works.
- Code on a very hot path, and the message of each assertion or error you show.

**Leave out:**

- Imports, and code that only moves or gets a new name with no change in behavior.
- Implementation that the names already say, and guards on the inputs that are not the point of the change.
- Internal helpers, test bodies, and generated output (unless it shows the contract better than its source).
- The same change in many places: show one, and put a note above it, such as `//> The same for each caller`.

**Cut it so it reads:**

- `// ...` on its own line leaves out statements. `/* ... */` inside a line leaves out a part of it: an argument
  list, a long object, a condition. One shown line can stand for a call over several real lines:
  `update(/* ... */, nextAttemptAt: nextAttemptAt(attempts, now) });`.
- Keep the declaration around a cut, shortened (`export async function drain(/* ... */) {` … `}`), so the reader
  knows where the code is.
- Code that is on both sides goes on both sides, cut the same way. Else it shows as added or removed, and the build
  refuses it when the change does not add or remove it.
- `//> text` is a note on the page only, never in the code. Use it for a why, or to say that a cut repeats a pattern
  the tab shows. A note never says what cut code does: show that code instead.
- Put blank lines between steps, as you would in the code. They do not count.

**Code examples** are calls that are not in the change, for a new API or an operation an agent calls: one call for
each new thing a caller can do, with a comment above each. Take the names and values from the tests, so the calls are
real. They do not count toward the budget.

## The budget

The changed lines the tab shows, plus the test names, are at most **20%** of the change's added and removed lines,
and never less than 30. The build counts only real code: a `// ...`, a note and a blank line are free, and so are
unchanged lines, but show only the context a reader needs to place the change. When the tab is over, cut a snippet
that repeats a pattern already shown before you cut the lines that explain a change.

## Tests

- Show a test only when its name states a property of the system that is not obvious. Mark each as added, modified
  or removed. A test whose only change is its setup or an expected value that follows from the new code is not
  modified for the reviewer: leave it out.
- Show every test the change removes, unless a test with a new name checks the same thing.
- **Never misrepresent a test.** Read its body at the head before you name it. Write its name in words, as close to
  the code's name as its assertions allow. When the code's name says something no assertion checks, write a name from
  the assertions, and tell the user.
- `group` is the `describe` block, in words.

## Words

- Use very few words. Before you write a sentence, ask if the code shows it better.
- A section's text says only what its code cannot show: a why, a trade-off, a cost, a fact about code the tab leaves
  out. Do not repeat in words what a snippet shows.
- Write in short, plain sentences, as [writing.md](writing.md#style) says. Name a thing in plain words, and add the
  code's name in backticks only when the reader needs it to find the thing.
- Leave out how the change came to be, CI results, QA steps, and anything about the page itself.

## What the build checks

- Each code line of a snippet is in the real file at that side, in order. A made-up or mistyped line is an error.
- A line that shows as added must be added by the change, and one that shows as removed must be removed.
- A cut with no `// ...` before it warns; a line that is an import warns.
- The budget, each test's line, and a section that shows nothing are errors.
- The build prints which files the tab does not show. Read the list: each file in it must be one the reviewer does
  not need.

Each shown line keeps its real line number, so a comment on a line of the tab is a comment on that line of the file,
the same as on the Guided and Diff tabs.

# Review rules

The review follows this file when a repository has no rules of its own. A
repository's rules file (`REVIEW.md` by default) replaces it whole; start from
a copy. It says how to review, not what the rules are: the rules live in the
repository's own instruction files and the documents they route to, and a
finding cites them there.

## Read before judging

- The repository's instruction files (AGENTS.md or CLAUDE.md), then every
  guide, design document, and module README they route to for the areas the
  change touches.
- The changed code's callers, tests, and history, not only the diff.
- The knowledge base is a map, not an authority. Where it disagrees with the
  repository's documents or code, they win.

## Segments

Each segment reports only what its row names. The settings decide from the
changed files which segments run.

| Segment | Reports | Reads first |
|---|---|---|
| Bugs | Logic errors, broken edge cases, races, swallowed errors, and regressions the change did not intend. | The callers, tests, and history of the changed code; the brief's risk areas; past reverts in the area. |
| Security | Anything that weakens an access or trust check, exposes a secret or personal data, trusts input it should not, or widens a token's permissions in CI. | The repository's security documents, if any. |
| Tests | Changed behavior without the tests the repository's testing guide calls for, and tests that check nothing the change does. | The testing guide and the tests next to the changed code. |
| Design | A change that conflicts with a design document; a structural flaw, such as logic in the wrong layer or a second mechanism for something one already does; a diff that does not do what the description says, or does more; and a violation of any other rule in the instruction files that no other row names. | The design documents the brief names and the guides the instruction files route to for the changed areas. |
| Docs | A behavior, command, or decision the change makes stale in the document that owns it, a second account of something another document owns, and links the change breaks. | The instruction files and each owning document. |

## Never report

- What CI enforces: formatters, linters, type errors, and drift in generated
  files.
- Generated or vendored content, and lockfiles.
- Style preferences no repository rule states.
- A rule violation outside the rule's own scope. Read the rule's conditions
  before applying it.
- A missing caller, route, or consumer that the description says another
  change adds.

### Learned

The [tuning loop](#tuning) adds a row when authors decline the same kind of
finding on three or more pull requests.

| Added | Do not report | Evidence |
|---|---|---|

## Severity

Each finding starts with its severity's badge. Rate a finding by what it lets
happen, not by the size of its fix or how rare its input seems: a privacy leak
or a wrong result for one real input is Important even when the fix is one
line.

| Severity | Meaning |
|---|---|
| Important | Wrong behavior a person or a caller can reach, an edge case included; a security or privacy defect; a claim in the description, or a measurement, that the code does not back; or a broken repository rule other than the Nits below. Fix before merging. |
| Nit | A document the change leaves stale, a test the change should add for behavior that works, or another point worth fixing that changes no behavior. Not blocking. Post at most five; count the rest in the summary. |
| Pre-existing | A real bug the change did not introduce, in code it touches or relies on. |

## Evidence

- Every finding carries a trace, shown under "Why this was flagged": the input
  or state, its path through the code with `file:line`, and the wrong result.
  The skeptic checks the trace against the code; a finding it cannot confirm
  is dropped. A security or privacy finding it can neither confirm nor refute,
  or a security finding whose skeptic did not finish, goes in the summary as
  unverified.
- When the same wrong pattern can occur elsewhere, the finding lists every
  other place in the code the change touches or relies on that has it, so one
  fix covers them all. Findings of one such class merge into one.
- Cite behavior with `file:line`, never an inference from a name. Cite a rule
  by its document and section.
- When the fix is a small local replacement, include a suggestion block.

## Later reviews

Every push gets a review of the pull request as it now stands, with these
limits:

- Segments whose files the new commits do not touch do not run again, and
  their open threads stand. The context stage and the docs segment run on
  every push.
- Each finding listed only in the summary has an id, such as `S3`, and stays
  listed, from any segment, until the code fixes it or the author answers it
  in the pull request's conversation, naming the id. The settling rules for
  threads below apply to it, and an answer that reports a person's decision
  settles it.
- Do not repeat a finding an open thread already raises, from any reviewer.
  List it in the summary with a link to that thread instead.
- Do not re-raise a finding the author answered with a reason, in its thread
  or in the pull request's conversation, unless the reason is wrong; then say
  why in the summary.
- After the first review, post new Nits only on lines changed since the last
  reviewed commit.
- Reply once on a thread this reviewer posted when the code fixes it, naming
  the commit, and resolve the thread.
- Resolve such a thread too when the author answered it with a reason that
  holds, or answered a Nit or a Pre-existing finding at all: those do not
  block the merge, so the author's answer settles them, and later reviews do
  not raise them again. An Important thread whose reason does not hold is
  disputed: keep it open, count it in the summary as open, and say in the
  thread that a person decides. They fix it, or resolve the thread to keep
  the code as it is; a thread resolved by hand is settled, and later reviews
  do not raise its finding again.
- When a person wrote the last comment on such a thread, answer it there:
  agree when their reason holds, and do not raise the finding again; say why,
  with the line that still fails, when it does not; answer a question from the
  code; check a fix they claim. Do not answer thanks or other comments that
  need no answer, and keep an earlier answer unless the code or a newer
  comment changes it.

## Summary

One summary, kept current across pushes, in the review's own section at the
bottom of the pull request description. Each push posts one review that holds
its comments and replies, and says where the summary is.

1. **Confidence to merge**, a score out of 5, in the heading.
2. A one-line verdict: `No blocking issues` or the count per severity; under
   it how many findings are disputed, when any are, and the one-line reason for
   the score.
3. Two to four sentences on what the pull request changes.
4. A Mermaid diagram of the main flow the pull request adds or changes: a
   `flowchart` or `sequenceDiagram` of about 12 nodes at most, with each label
   that holds punctuation in quotes. None when it has no flow to draw, such as
   a change to docs or configuration alone.
5. A list of issues (severity badge, one-line issue linked to its comment or
   thread, `file:line` link), including ones raised in open threads, marking
   the disputed ones, and the Nits over the cap; a finding listed only here
   shows its id.
6. Earlier findings now fixed or answered, threads and summary entries alike.
7. A table of segments: which ran, which did not run again or did not apply,
   which failed, and how many findings each kept.
8. The last reviewed commit, and a note when the knowledge base was not read.

## Tuning

The tuning workflow may draft a change to this file and the eval set that:

- adds a [Learned](#learned) row;
- adds a check to a segment for a kind of miss seen on two or more pull
  requests, or changes a segment's bar;
- adds eval cases.

It never hides security or privacy findings, changes the workflows, the
settings, or the job, removes a segment, or merges its own pull request.

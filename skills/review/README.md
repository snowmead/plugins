# Claude review

A GitHub Action that reviews a pull request with Claude Code: one agent per
lens ("segment"), a skeptic that tries to refute each finding, and an editor
whose findings each push posts as one review of inline comments, with a summary
at the bottom of the pull request description that each push replaces.
It only reads the code; nothing it runs can approve, push, or merge. An
optional second job resolves the review's settled threads
([Resolving threads](#resolving-threads)).

Everything the review needs is in this directory: the action
([action.yml](action.yml)), one Rust program that runs each job step
([src/](src)), the engine that runs the agents on the Claude Agent SDK
([engine/](engine)), and default review rules ([rules.md](rules.md)). It
depends on nothing else in the repository that holds it. The same engine
reviews a branch on your machine ([Reviewing locally](#reviewing-locally)).

## Using it

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
# One review of a pull request at a time: a run deletes the pending review it
# finds of this reviewer, as one a cancelled run left.
concurrency:
  group: claude-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-24.04
    timeout-minutes: 75
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: snowmead/plugins/skills/review@<commit>
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Check out the pull request's head, not the merge commit, with full history,
and keep the `concurrency` group: two runs at once would each delete the
other's pending review.
Pin the action to a commit: the job holds the Claude credential, so the action
must never come from the pull request under review. A repository that keeps
the action in its own tree takes it from the base branch instead: check the
pull request out into a subdirectory, copy this directory from the base
branch outside that checkout with `git archive`, call the copy, and pass the
subdirectory as `path`. When the base branch has no copy, take the default
branch's. Before either has one, only a `pull_request` run may use the pull
request's own copy, as that run takes the job file from the pull request too.

| Input | Default | What it does |
|---|---|---|
| `claude-code-oauth-token` | — | A Claude subscription's token from `claude setup-token`. Reviews count against that subscription's usage limits and are not billed. |
| `anthropic-api-key` | — | An Anthropic API key, billed per review. Claude Code uses it over the token when both are set. Without either, the action skips with a warning. |
| `greptile-api-key` | — | Lets the agents read Greptile's knowledge base of the repository. |
| `github-token` | `github.token` | Reads the pull request and posts the review. |
| `pr` | — | The pull request number, for a run that is not a pull request event, such as `workflow_dispatch`. |
| `path` | `.` | The checkout of the pull request's head. |
| `rules` | `REVIEW.md` | The [review rules](#rules); `rules.md` here when the trusted branch has none. |
| `config` | `.claude/review.json` | The [settings](#settings). |
| `agents` | — | Models and efforts for this run, over the settings' `agents`. |
| `reviewer` | `github-actions` | The login the token posts as. |

Of its outputs, `summary` is `written` when the review wrote its summary: to
the pull request description, or to the run's summary page when the
description has no room for it. `resolve` lists the
[threads to resolve](#resolving-threads).

Before it reviews, the action builds its program with the toolchain
[rust-toolchain.toml](rust-toolchain.toml) pins, in the runner's temporary
directory, outside the checkout: about a minute on two cores. It then installs
a pinned Bun, checked against its checksum, and the engine's packages from
[bun.lock](bun.lock): the Agent SDK, which ships the Claude Code the agents
run on. The action runs on Linux, on x86_64 or aarch64.

### Reviewing locally

With the plugin installed, `/snowmead:review` reviews the branch you are on
against the merge base with the default branch: the files on disk, committed
or not (a new file counts once `git add` names it). It prints the findings and
writes a Markdown report under the git directory (`.git/review/`), where git
never tracks it. Run it as:

```sh
bun install --frozen-lockfile --production --cwd <skill>
bun --no-env-file --cwd <skill> engine/main.ts local --repo "$PWD"
```

where `<skill>` is this directory. `--committed` reviews only the commits,
`--base <rev>` names another base, and `--note <text>` says what the change is
for. A local review uses the repository's `REVIEW.md` and
`.claude/review.json` when it has them, and this directory's defaults when it
does not; it runs on the Claude account Claude Code is signed in with, or on
`ANTHROPIC_API_KEY`. Bun always starts in this directory, never in the
repository under review: Bun runs the `bunfig.toml` and loads the `.env` files
of the directory it starts in.

### Resolving threads

The review resolves its own threads once they are settled: fixed, or answered
as the rules' "Later reviews" says. GitHub resolves a thread only for a token
that can write the repository's contents, which the review job should not
hold, as it runs agents over the pull request. So the action lists the
threads in its `resolve` output, and a second job with that permission
resolves them. It checks out nothing and runs only `gh`:

```yaml
  review:
    outputs:
      resolve: ${{ steps.review.outputs.resolve }}
    steps:
      # ... as above, with `id: review` on the action's step
  resolve:
    needs: review
    if: ${{ !cancelled() && needs.review.outputs.resolve != '' && needs.review.outputs.resolve != '[]' }}
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      pull-requests: write
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          THREADS: ${{ needs.review.outputs.resolve }}
        run: |
          jq -r '.[] | strings' <<< "$THREADS" | while read -r thread; do
            gh api graphql --silent -f thread="$thread" \
              -f query='mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { clientMutationId } }' \
              || echo "::warning::Could not resolve review thread $thread."
          done
```

The job runs also when the review failed after listing the threads, as a
partial review or one GitHub did not take does: it lists only threads whose
reason the author can read. Without that job, the threads stay open for the
author to resolve. A disputed thread, a blocking finding the author declined
for a reason the review does not accept, stays open either way: the review's
answers there say that a person decides, and they fix the code or resolve the
thread.

## How a review runs

| Stage | Agents | Work |
|---|---|---|
| Context | One | Reads the description, the diff, the repository's instruction files and the documents they route to, the rules, and the knowledge base. Writes the brief every segment reads: intent, the rules in play, risk areas, and the changed files in at most four areas. |
| Segments | One per segment that applies; a two-pass segment runs two passes over each area that holds its files (its files are one area when none does), in opposite file orders | Review the pull request as it now stands, each through one lens. |
| Verify | One skeptic per place | Tries to refute each finding at that line from the code, and checks each other place it lists. A finding survives only with a trace. |
| Follow-up | One, when this reviewer has open threads | Checks each open thread this reviewer posted earlier: fixed, answered (and whether the reason holds), or still open. Answers a person who commented last there. |
| Editor | One | Merges findings with one cause, one wrong pattern in several places included, and applies the rules' Severity, Later reviews, and Summary. Says of each earlier summary entry whether it is fixed, answered, or still open. For a finding on a file the pull request does not change, where GitHub takes no comment, names the changed line that makes it true. |

The job then posts one review for the push. It starts a pending review, after
deleting the one a cancelled run of the job left (GitHub allows one for each
person), and adds each finding on its line, or on its file when GitHub refuses
the line. A finding on a file the pull request does not change goes on the
changed line the editor named, and says which line it is about. One that fits
nowhere goes in the summary. The review also replies in its own threads, once
when the review calls one fixed and with the answer to a person who commented
last, adding in a disputed thread that a person decides. The job then replaces
the summary, submits the review once, as a comment, so the pull request gets
one review and one notification, and lists the threads that are settled for
[resolving](#resolving-threads).

The summary, which the rules' "Summary" describes, is the job's own section at
the bottom of the pull request description, between two HTML comments on lines
of their own, below the author's text. Its issues carry severity badges, images
from shields.io, and link to their comments. The job writes it before it
submits the review, whose body says where the summary is and ends with a marker
that names the reviewed commit and the findings only the summary holds. So no
marker names a commit whose findings nobody could read, and a later push reruns
only the segments whose files it touched. Each finding only the summary holds
keeps its id there (`S1`, `S2`, ...) until the editor finds it fixed or
answered, whichever segments run, and the marker keeps the last id given, so
no id names two findings. When
the summary would not fit in the description, the text of the findings that fit
nowhere on the diff goes on the run's summary page; when it still would not,
the whole summary does, and the section keeps its heading and a link there.
When not even the heading fits, as when the author's text fills the
description, the job removes its stale section and the summary is only on the
run's summary page, which the review's body links. When the description write
fails twice, the job deletes the pending review and fails the check, so nothing
is submitted and no marker names the commit. When an agent fails, the job
posts what the others found and fails the check; when GitHub refuses the
review, the job deletes it, the summary lists every finding (the run's summary
page does when the description write then fails), and the check fails. When
GitHub fails on the submit and on the check
of the review's state after it, the review may or may not be posted: the job
keeps it, the summary warns and keeps its links, the run's summary page holds
the text of every finding, and the check fails, asking the author to look for
the review before a re-run. When the review does not finish, the summary says
so. The run's summary page lists the agents, the minutes, each stage's and
each model's tokens, and what they cost at API prices, which on a subscription is usage, not a
bill. When the account hits a usage limit, the run says which and when it
resets.

[engine/review.ts](engine/review.ts) is the review, and
[engine/runtime.ts](engine/runtime.ts) runs each of its agents as one Claude
Code process through the Agent SDK; the job steps run in this order, each as
one subcommand of the program:

| Step | Subcommand | Work |
|---|---|---|
| Find the pull request | `start` | The pull request, its last review's body, and a check that the checkout is at its head. A manual run refuses a fork's pull request. |
| Take the configuration | `protect` | Replaces what configures the review with the trusted branch's copy ([Trust](#trust)). |
| Prepare | `prepare` | The threads, description, and conversation the agents read, without the job's own summary, and the engine's args. |
| Review | `run` | Runs the engine (`engine/main.ts`, by Bun) and waits for it. |
| Read the result | `result` | Takes the engine's result from the record it writes. |
| Post | `post` | Writes the summary to the description, then posts one review of the comments and replies, with the job's secrets removed from every string. |
| Unfinished | `unfinished` | Marks the summary in the description as not current when the review was not posted, or removes the section when not even that notice fits. |
| Report | `report` | Lists each refused tool call with its agent and input, how each agent and the review ended, and the end of the engine's log. |

## Settings

The settings file (`config`, `.claude/review.json` by default) is JSON. Every
key is optional; what it leaves out comes from the engine's `DEFAULTS`
([engine/settings.ts](engine/settings.ts)). The action reads it from the
trusted branch.

| Key | What it holds |
|---|---|
| `classes` | Named lists of path patterns. `generated`, `prose`, `assets`, and `design` exist by default; `code` is every file in none of the first three. A class here replaces the default of the same name. |
| `segments` | Segments by `name`. One with a default's name changes that segment; a new one runs after the defaults and needs `files`. |
| `agents` | The model and effort of each stage, merged over the defaults per stage. |
| `knowledge_base` | `{name, skill}`: how the summary names the knowledge base, and the skill whose steps the agents follow to read it; `false` turns it off. Without a skill, the agents use its read tools, which the engine connects when it has a Greptile key. The default is Greptile's, with no skill. |
| `sweep` | `{max_areas}`: how many areas a [sweep](#sweeps) reviews (default 4). |
| `examples` | `{changed, segments}` pairs that the repository's own test checks against the settings; the engine ignores them. |

A pattern list is read in order, and the last pattern that matches a file
decides: `**` crosses directories, `*` and `?` stay within one, `{a,b}` is
either, `@class` is a class, and a leading `!` takes files back out. Patterns
match a path in any case.

| Segment field | What it does |
|---|---|
| `files` | The patterns of the files it reviews; it runs when the pull request changes one. |
| `title` | Its name in prompts and the summary, and its row in the rules' Segments table. |
| `passes` | `2` reads each area that holds its files twice, in opposite orders. |
| `always` | Runs on every push, not only when its files change. |
| `note` | Text added to its agents' prompt, such as a skill to load. |
| `sweep_note` | The text a [sweep](#sweeps) adds instead of `note`, which may name a diff or description a sweep does not have; without it, a sweep adds `note`. |
| `agents` | `{finder, skeptic}`: its own models and efforts. |
| `keep_unverified` | Keeps a finding its skeptic cannot settle, as unverified. |
| `enabled` | `false` turns a default segment off. |

The default segments are bugs (code, two passes), security (code and the
`design` class: instruction files, the rules (`REVIEW.md`), `docs/`,
`.claude/`, `.agents/`; keeps unverified findings), tests (code), design (code and `design`), and docs
(every file, every push).

| Stage | Default | Runs |
|---|---|---|
| `context` | Sonnet 5.5, high | The brief. |
| `finder` | Sonnet 5.5, high; security's on Opus 5.5 | Each segment's agents. |
| `skeptic` | Opus 5.5, medium | One per finding: it decides what stays. |
| `followup` | Sonnet 5.5, high | The earlier threads, and the answers in them. |
| `editor` | Sonnet 5.5, high | What gets posted. |
| `scope` | Sonnet 5.5, high | A sweep's areas. |
| `judge` | Sonnet 5.5, low | An eval case's match. |
| `tuner` | Sonnet 5.5, high | The [tuning](#tuning) routine's agents. |

A model is Claude Code's name for it; the efforts are `low`, `medium`, `high`,
`xhigh`, and `max`. The `agents` input sets stages for one run, over the
settings field by field: `{"skeptic": {"model": "claude-sonnet-5-5"}}` keeps
the skeptic's effort. A segment's own `agents` still win for its finders and
skeptics. Settings that are not valid stop the review before any agent
starts, and the error names what is wrong. `session` and `loader`, stages of
earlier versions, are taken and ignored.

## Rules

The rules file says how to review: what each segment reports, what never to
report, severity, evidence, later reviews, the summary, and what tuning may
change. The agents read its sections by name: "Read before judging",
"Segments" (a table with a row per segment title and a "Reads first" column,
whose skills the finders load), "Never report" with its "Learned" table,
"Severity", "Evidence", "Later reviews", "Summary", and "Tuning". Start a
repository's rules from [rules.md](rules.md).

## Trust

A pull request can neither change how its own review runs nor instruct it:

- Before any step that holds a secret reads the checkout, `protect` replaces
  with the trusted branch's copy, in the checkout and git's index, every path
  that configures Claude Code (`.claude/`, `.agents/`, `.mcp.json`,
  `.claude.json`, and every AGENTS.md and CLAUDE.md), git (`.gitmodules`,
  `.husky/`, and every `.gitattributes`), or the agents' searches (every
  `.gitignore`, `.rgignore`, and `.ignore`), and the rules and settings files.
  The trusted branch is the pull request's base when it has the rules or the
  settings, else the default branch when it has them, else the base. The
  agents read the pull request's versions as changes, with `git show`.
- Each agent is a Claude Code process with Read, Grep, and Glob, the engine's
  git tool, and the knowledge base's read tools, in don't-ask mode, so any
  other tool is refused. It has no shell and no tool that writes, takes none
  of the repository's Claude Code settings, hooks, or MCP servers. Its
  environment is built from a list of names
  ([engine/runtime.ts](engine/runtime.ts), `agentEnv`): the system's basics,
  proxies and certificates, and Claude Code's own settings and credential
  (`ANTHROPIC_*`, `CLAUDE_*`, and a cloud provider's when Claude Code uses
  one). So it gets no GitHub token, no Greptile key (the engine puts the key in
  the knowledge base's connection), and no other variable of the job's
  environment. Claude Code refuses a read outside the checkout and the
  review's files, through a symlink too. The git tool refuses the options and
  paths that would read or write a file outside the checkout or run a
  command, and every git the engine runs is this program as a guard
  ([src/guard.rs](src/guard.rs)) that refuses them again.
- Bun starts in the action's own copy, never in the checkout, with
  `--no-env-file`: a pull request's `bunfig.toml` or `.env` would otherwise
  run its code or set the environment of the process that holds the Claude
  credential.
- The job reads the review from the engine's record, never from an agent's
  answer, and posts it only when the engine ran on the args the job wrote.
  It replies in, and lists for resolving, only its own open threads, listed
  before the review ran, and answers only where a person commented last. The
  job that resolves them can write the repository, but runs nothing from the
  pull request.
- The author can edit the description, so the job changes only its own
  section there, and nothing in it decides what a later review does: the
  marker the next review reads ends the body of the job's own review, which
  only the job can edit. The unfinished step reads the old section back only
  to put its warning on top.
- The caller decides where the action comes from: a pinned commit, or, for a
  copy in the repository's own tree, the base branch. That choice and the
  trusted branch above are made apart, each from the most trusted branch that
  has what it needs, so a base with its own rules and no copy of the action is
  reviewed by the default branch's action under the base's rules.

## Sweeps

`mode: "sweep"` reviews the repository as it stands instead of a pull
request: a scope agent picks up to `max_areas` areas, code changed since
`since` (a commit or a date) first and areas named in `covered` last; each
segment whose files an area holds reviews it in one pass; a skeptic checks
each finding; and the editor merges them. It posts nothing: it returns the
findings, the areas, and a summary, for a routine that fixes them and opens a
pull request. Run it from the repository's root, with `<skill>` this
directory:

```sh
bun --no-env-file --cwd <skill> engine/main.ts sweep --repo "$PWD" --since 2026-10-01 --out sweep.json
```

## Tuning

[engine/tuning.ts](engine/tuning.ts) learns from a week of outcomes: how
authors handled this reviewer's findings, and what other reviewers found that
it missed. It drafts a change to the rules and the eval set, within what the
rules' Tuning section allows, and returns a decision for the routine that runs
it. Its args are `{repo, since, until, out_dir}`, plus `rules`, `evals`,
`config_file`, and `reviewer` when they differ from the defaults:

```sh
bun --no-env-file --cwd <skill> engine/main.ts tune --repo "$PWD" --repo-name owner/name \
  --since 2026-10-05 --until 2026-10-12 --out-dir .tuning --out .tuning/tuning.json
```

The engine reads GitHub with the token in `GH_TOKEN` or `GITHUB_TOKEN`, or
`gh`'s: it lists the merged pull requests and writes each eval case's pull
request file itself, and its agents read one route of the repository at a
time through a tool that only reads. Only the draft agent writes, and only
inside `out_dir`, a directory of the repository. The guard checks in code
what code can (the files changed outside `out_dir`, an eval case changed or
removed, the cases added) and an agent judges the rules' diff against the
Tuning section. Keep `--out` inside `out_dir` too, or a result left from an
earlier run counts as a file changed outside it.

The routine opens a pull request with the draft when it only adds eval cases,
or when the eval set scores better with the change: more of the cases that
both runs scored come out right, and no quiet case breaks. When fewer than
four in five cases score in both runs, the result is inconclusive. A quiet
case replays the segments the change can alter, and is not counted when none
of them applies to its pull request. Each replay runs at most 45 segments at
the cases' commits, newest pull requests first, with at least half of those
runs for each kind of case when it needs them.

The eval mode of the review replays each case's segment at the commit its
finding was posted on and asks a judge whether the review reported it, or, for
a quiet case, kept quiet. A find case with `expect_severity` counts only when
the finding has that severity. Run it in a clone that has the cases' commits,
with a directory of the cases' pull request files (`<number>.json`, as
`gh pr view --json title,body,url,baseRefName,headRefOid,files` writes them);
`--cases` in place of `--cases-file` scores some of them:

```sh
bun --no-env-file --cwd <skill> engine/main.ts eval --repo "$PWD" --repo-name owner/name \
  --cases-file .claude/review-evals.json --pr-dir prs --out eval.json
```

## Tokens

The engine spends tokens only where an agent reads or judges:

- Every agent of a stage shares one system prompt: the rules' sections that
  stage reads, the description, the brief, and the diff (whole files, up to
  60,000 characters, generated files named but left out). The first agent of
  each prompt starts alone, and the others read it from the prompt cache.
- Claude Code's own instructions that a review agent cannot use (git's for
  commits, CLAUDE.md files, memory) are off, and so are its background model
  calls: measured, a request's own prompt went from about 10,400 tokens to
  3,700.
- The engine reads the settings, rules, threads, diff, and pull request file
  itself, so no agent reads a file to hand it on. The follow-up runs only when
  this reviewer has open threads, one skeptic checks every finding at a place,
  and the editor names the findings it keeps instead of copying them.
- Each run's summary page and local report count each stage's agents and
  tokens.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test engine
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps --document-private-items
cargo deny --locked check advisories sources
```

Run these here: the directory is its own Bun package and its own Cargo
workspace on its own toolchain. `cargo deny` checks the locked crates against
RustSec advisories, with [deny.toml](deny.toml). In a repository that runs
this directory's review job, as this one does, also run that job's test from
the repository's root: `node --test '.github/tests/*.test.mjs'`. The engine
tests run the engine with stub agents ([engine/tests](engine/tests));
`REVIEW_CONFIG=<settings file>` also checks that file's examples. The Rust
tests run the engine under Bun too
([engine/tests/stub.ts](engine/tests/stub.ts)), for what passes between it and
the job: a finding carried through the marker, the replies in fixed and
answered threads, and the fixed one listed to resolve. `src/settings.rs` keeps
its stages equal to the engine's.

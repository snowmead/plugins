---
name: review
description: Reviews code with a pipeline of Claude agents (one per lens, a skeptic that tries to refute each finding, an editor), on the current branch locally or as a GitHub Action that posts one review of inline comments plus a summary in the pull request description. Use when asked to review the current branch or uncommitted changes, to add automated Claude code review to a repository's CI, to write or change its review rules (REVIEW.md) or settings (.claude/review.json), or to run its sweep, eval or tuning modes.
license: Apache-2.0. Complete terms in LICENSE.txt
compatibility: Bun 1.4 or later. Locally, a Claude Code sign-in or ANTHROPIC_API_KEY. The action runs on a Linux runner, builds its Rust program with rustup, and installs a pinned Bun.
allowed-tools: Bash(bun install --frozen-lockfile --production --cwd *), Bash(bun --no-env-file --cwd *)
metadata:
  repository: https://github.com/snowmead/plugins
---

# Review

Everything is in this folder (`${CLAUDE_SKILL_DIR}`), and [README.md](README.md) is the reference: read the section
your task needs before you change anything.

| Path | What it is |
|---|---|
| `engine/` | The agent pipeline in TypeScript on the Claude Agent SDK: context, segments, skeptics, follow-up, editor; the `local`, `ci`, `sweep`, `eval`, and `tune` modes (`engine/main.ts`). |
| `action.yml` | The composite GitHub Action. A repository calls it as `snowmead/plugins/skills/review@<commit>`. |
| `src/` | One Rust program that runs each step of the action: find the pull request, take the review's configuration from the trusted branch, prepare, run the engine, read the result, post. |
| `rules.md` | The default rules, for a repository without its own `REVIEW.md`. |

## Tasks

- **Review the current branch.** From the repository's root, install the engine's packages once, then run it:

  ```sh
  bun install --frozen-lockfile --production --cwd "${CLAUDE_SKILL_DIR}"
  bun --no-env-file --cwd "${CLAUDE_SKILL_DIR}" engine/main.ts local --repo "$PWD"
  ```

  It reviews the files on disk against the merge base with the default branch, prints the findings, and writes a
  Markdown report under `.git/review/`. Add `--committed` to review only the commits, `--base <rev>` for another
  base, and `--note "<what the change is for>"` when the user said. A run takes a few minutes; run it in the
  background and tell the user when it starts. Then show the findings, most severe first, and the report's path.
  Always start Bun with `--cwd "${CLAUDE_SKILL_DIR}"` and `--no-env-file`, never from the repository: Bun would run
  the repository's `bunfig.toml` and load its `.env` files.
- **Add the review to a repository.** Write the job file from README.md, "Using it": pinned to a commit, the pull
  request's head checked out with full history, and the `concurrency` group kept. Add the resolve job from
  "Resolving threads" only when the user wants settled threads resolved; it is the one job with contents write.
  Tell the user to add a `CLAUDE_CODE_OAUTH_TOKEN` secret (from `claude setup-token`) or an `ANTHROPIC_API_KEY`;
  you cannot add secrets.
- **Write or change the rules.** Start from `rules.md` and README.md, "Rules". The repository owns `REVIEW.md`; keep
  its section names, which the agents read by name.
- **Change the settings.** README.md, "Settings": file classes, segments (lenses), models and efforts per stage, the
  knowledge base, the sweep. Give the file `examples` (the files a pull request changes, and the segments that must
  review it) and check them before the user commits it:
  `REVIEW_CONFIG=<repo>/.claude/review.json bun test --cwd "${CLAUDE_SKILL_DIR}" engine`.
- **Sweep, eval or tune.** README.md, "Sweeps" and "Tuning": run `engine/main.ts` with the mode and the options
  shown there, from the repository's root, as above.
- **Change the review itself.** Run the checks in README.md, "Development", from this folder, and bump the plugin's
  version.

The review reads code and reports or posts what it returns; nothing it runs can approve, push or merge. Keep it that
way: never give the review's agents a shell, a write tool, a GitHub token, or the job's secrets (README.md, "Trust").
The tuning routine's draft agent is the one agent that writes, and only inside its `out_dir`.

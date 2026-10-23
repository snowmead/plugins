---
name: review
description: Sets up and tunes the Claude pull request review, a GitHub Action that reviews each push with a pipeline of Claude Code agents (one per lens, a skeptic that tries to refute each finding, an editor) and posts one review of inline comments plus a summary in the pull request description. Use when asked to add automated Claude code review to a repository's CI, to write or change its review rules (REVIEW.md) or settings (.claude/review.json), or to run its sweep, eval or tuning workflows.
license: Apache-2.0. Complete terms in LICENSE.txt
compatibility: GitHub Actions on a Linux runner with sudo, and Claude Code 2.1.293 or later signed in with a Claude subscription token or an Anthropic API key. The action builds its Rust program with rustup; the workflows run from the Workflow tool.
metadata:
  repository: https://github.com/snowmead/plugins
---

# Review

Everything is in this folder (`${CLAUDE_SKILL_DIR}`), and [README.md](README.md) is the reference: read the section
your task needs before you change anything.

| Path | What it is |
|---|---|
| `action.yml` | The composite GitHub Action. A repository calls it as `snowmead/plugins/skills/review@<commit>`. |
| `src/` | One Rust program that runs each step of the action: find the pull request, take the review's configuration from the trusted branch, prepare, run Claude Code, read the result, post. |
| `workflows/pr-review.js` | The agent pipeline, a Claude Code Workflow script: context, segments, skeptics, follow-up, editor. Also the `sweep` and `eval` modes. |
| `workflows/review-tuning.js` | Drafts a rules change from a week of outcomes, kept only when the eval set scores better. |
| `rules.md` | The default rules, for a repository without its own `REVIEW.md`. |

## Tasks

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
  `REVIEW_CONFIG=<repo>/.claude/review.json node --test '${CLAUDE_SKILL_DIR}/workflows/tests/*.test.mjs'`.
- **Sweep, eval or tune.** README.md, "Sweeps" and "Tuning": call the Workflow tool with
  `scriptPath: ${CLAUDE_SKILL_DIR}/workflows/pr-review.js` (or `review-tuning.js`) and the args shown there, from the
  repository's root. Tuning also takes `engine: ${CLAUDE_SKILL_DIR}/workflows/pr-review.js`.
- **Change the review itself.** Run the checks in README.md, "Development", from this folder, and bump the plugin's
  version.

The review reads code and posts what it returns; nothing it runs can approve, push or merge. Keep it that way: never
give the agents a write tool, a GitHub token, or the job's secrets (README.md, "Trust").

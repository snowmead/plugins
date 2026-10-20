# plugins

Michael Assaf's plugins and skills for Claude, in one marketplace.

| Plugin | Skill | What it does |
|---|---|---|
| [thinkr](skills/thinkr) | `thinkr` | Turns a plan or an explanation into a clean, interactive page, published as a Claude Artifact. Plan pages ask you about the real forks and send your answers back to Claude; explainer pages teach with diagrams you step through, WebGPU figures and self-checks. Needs [Bun](https://bun.sh). |
| [guided-review](skills/guided-review) | `guided-review` | Turns a pull request or branch, or a stack of them, into a guided code review, published as a Claude Artifact: an overview with a before / after of the behavior, then the diff as short chapters, each explained beside its code, with review marks, a file tree and syntax-highlighted diffs. A stack's pull requests are picked from a menu in the title. Needs [Bun](https://bun.sh). |
| [changelog](skills/changelog) | `changelog` | Keeps a team changelog as a Claude Artifact: each run writes up the pull requests merged since the last entry (or in the last N days) as features with animated scenes and PR links, and posts a summary to Slack. Runs the same by hand or on a schedule. Needs [Bun](https://bun.sh) and the GitHub CLI. |
| [e-rust](skills/rust) | `rust` | Effective Rust: defaults for reading and writing Rust, from the toolchain and module layout to types, conversions, ownership, unsafe code and tests, with standard-library and nightly references. |

## Install

### Claude Code

Add the marketplace once, then install what you want:

```
/plugin marketplace add snowmead/plugins
/plugin install thinkr@plugins
/plugin install guided-review@plugins
/plugin install changelog@plugins
/plugin install e-rust@plugins
```

Or add and install in one step (Claude Code 2.1.275 or later):

```
/plugin install thinkr --marketplace snowmead/plugins
/plugin install guided-review --marketplace snowmead/plugins
/plugin install changelog --marketplace snowmead/plugins
/plugin install e-rust --marketplace snowmead/plugins
```

From your shell: `claude plugin marketplace add snowmead/plugins`, then `claude plugin install thinkr@plugins`.

Updates: `/plugin marketplace update plugins`, or turn on auto-update for the marketplace under `/plugin` →
Marketplaces. A plugin updates when its `version` changes.

### Other agents, or as plain skills

With the [skills](https://skills.sh) CLI, which installs into Claude Code, Codex, Cursor and other agents:

```sh
npx skills add snowmead/plugins                  # choose from all
npx skills add snowmead/plugins --skill thinkr   # one skill
npx skills add snowmead/plugins --skill rust -g  # every project
```

## Layout

Each plugin is one skill, and its folder is both the skill and the plugin root:

```
.claude-plugin/marketplace.json   the marketplace "plugins", listing each plugin below
skills/thinkr/                    plugin thinkr  (.claude-plugin/plugin.json, SKILL.md, …)
skills/guided-review/             plugin guided-review  (.claude-plugin/plugin.json, SKILL.md, …)
skills/changelog/                 plugin changelog  (.claude-plugin/plugin.json, SKILL.md, …)
skills/rust/                      plugin e-rust  (.claude-plugin/plugin.json, SKILL.md, references/)
```

To add a plugin: create `skills/<skill>/` with `SKILL.md` and `.claude-plugin/plugin.json`, add an entry to
`.claude-plugin/marketplace.json` with `"source": "./skills/<skill>"`, and check it:

```sh
claude plugin validate --strict . && claude plugin validate --strict skills/<skill>
```

**Release:** bump `version` in the plugin's `.claude-plugin/plugin.json` (installed copies update only when it
changes), validate, commit, then tag with `claude plugin tag skills/<skill> --push` (tags look like
`thinkr--v0.2.0`).

## License

Apache-2.0 (`LICENSE`). Third-party parts keep their own licenses, listed in each plugin's `NOTICE`.

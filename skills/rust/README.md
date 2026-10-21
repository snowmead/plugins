# Effective Rust

A coding agent skill for writing effective Rust. It follows a repository's own conventions first, and fills the gaps
with defaults for the toolchain, imports and modules, module reading order, functions and traits, types and
invariants, conversions, ownership and control flow, documentation and unsafe code, and tests. Two references cover
standard-library choices and nightly features.

Install in Claude Code:

```
/plugin install snowmead --marketplace snowmead/plugins
```

That installs the plugin snowmead, with this skill as `/snowmead:rust`. Or for any agent:
`npx skills add snowmead/plugins --skill rust`. More in the repository: https://github.com/snowmead/plugins

Licensed under Apache-2.0 (`LICENSE.txt`).

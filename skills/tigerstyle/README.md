# TigerStyle

A coding agent skill that joins two sources into one way of working. TigerStyle, TigerBeetle's coding style, sets the
rules for the code: bounds on everything, assertions on both the valid and the invalid space, static allocation, short
functions, exact names. Swarm riding, from Georgios Konstantopoulos's essay "Effective Swarm Riding for Engineers"
(Paradigm), sets how the agent drives the work: a measurable goal, prompts that set a hill to climb, deterministic
simulation and differential tests, and persistence until the goal is met.

Run it by hand, or let the agent load it when you ask for TigerStyle, deterministic simulation or differential tests,
or a measurable goal such as 10x faster.

Install in Claude Code:

```
/plugin install snowmead --marketplace snowmead/plugins
```

That installs the plugin snowmead, with this skill as `/snowmead:tigerstyle`. Run it with a task:
`/snowmead:tigerstyle make the parser 10x faster`. Or for any agent: `npx skills add snowmead/plugins --skill tigerstyle`.
More in the repository: https://github.com/snowmead/plugins

Licensed under Apache-2.0 (`LICENSE.txt`). `references/tiger-style.md` is TigerBeetle's text, unchanged; see `NOTICE`.

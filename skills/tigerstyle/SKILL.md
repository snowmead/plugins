---
name: tigerstyle
description: TigerStyle for the code you write, and swarm riding for how you drive the work. Run it by hand on a task.
argument-hint: "[task]"
disable-model-invocation: true
license: Apache-2.0. Complete terms in LICENSE.txt
metadata:
  repository: https://github.com/snowmead/plugins
---

# TigerStyle

This skill joins two sources into one way of working:

- **TigerStyle**, TigerBeetle's coding style, governs the code you write. The full text is in
  [references/tiger-style.md](references/tiger-style.md) (Apache-2.0, from tigerbeetle/tigerbeetle at commit
  `0aeb306561365e21b97775c729bfc439f6c16d72`).
- **Swarm riding**, from Georgios Konstantopoulos's essay "Effective Swarm Riding for Engineers" (Paradigm,
  https://www.paradigm.xyz/writing/swarms), governs how you drive the work: the goal, the prompts, the tests and the
  environment. The essay is paraphrased here, not copied.

Apply this skill only when the user invoked it. The task is `$ARGUMENTS`; when that is empty, the task is the work in
progress in this conversation.

## Order of work

1. **Read [references/tiger-style.md](references/tiger-style.md) in full.** The rules below are a checklist; that file
   holds the reason for each one. Done when you have read every section.
2. **Set the goal as a number.** Turn the task into a target you can measure: "10x faster", "zero gaps against the
   reference implementation", "every state encoded in the type system". A goal like "optimize X" or "fix bugs" is not
   done. Done when the user can check the goal with one command or one measurement.
3. **Sketch before you build.** Write a back-of-the-envelope sketch for network, disk, memory and CPU, each for
   bandwidth and latency. Name the bound on every loop, queue and buffer the design adds. Ask "what could go wrong?"
   now, while the design is cheap to change. Done when the sketch names the slowest resource and every bound.
4. **Write the code to the rules.** Every rule in [Code rules](#code-rules) holds for every function you add or change.
5. **Prove it with tests that hunt.** Use [Testing](#testing). Done when the tests exercise the invalid space as well
   as the valid space, and the goal from step 2 is met and measured.
6. **Keep going.** Persist until the goal is met or a blocker is proven. A first pass that compiles is not the end. When
   you stop short, state the measured gap and the blocker.
7. **Deliver as a pull request.** Put the work on its own branch and open a pull request against the default branch.
   Pushing or merging straight to the default branch is the user's preference to state, per repository; do it only
   when the user asks for it.

## Design goals

Safety, then performance, then developer experience, in that order. Judge every choice by which of the three it moves.
Simplicity is the hardest revision, not the first draft: expect to throw a sketch away. Zero technical debt: solve a
showstopper when you find it, and ship only what meets the goals.

## Code rules

Use the repository's own conventions where they are stricter or where the language forces a choice. The rules name Zig
forms; [Other languages](#other-languages) maps them.

**Control flow and limits**

- Simple, explicit control flow. No recursion.
- Few abstractions, each one a clear fit for the domain.
- A fixed upper bound on every loop and queue. Assert the loops that must never end, such as an event loop.
- Run at your own pace: batch external events, and do not act directly in reaction to each one.
- Split compound conditions into nested `if`/`else`. Give each `if` a matching `else` that handles or asserts the other
  space.
- State invariants positively: `if (index < count)`, not `if (index >= count)`.
- Handle every error. Assertions are for programmer errors; operating errors are expected and handled.

**Assertions**

- Assert arguments, return values, preconditions, postconditions and invariants. Average two or more per function.
- Pair assertions: check each property on two code paths, for example before a write and after the read back.
- Split compound assertions: `assert(a); assert(b);`. Assert an implication as `if (a) assert(b);`.
- Assert relationships between compile-time constants and type sizes at compile time.
- Assert the positive space and the negative space.
- Assertions encode a mental model; build the model first.

**Memory, scope and types**

- Allocate all memory at startup. No allocation, free or reallocation after initialization.
- Explicitly sized integer types (`u32`, `u64`) for data.
- Declare each variable in the smallest scope, close to where it is used. No duplicates or aliases of state.
- Treat index, count and size as distinct: index + 1 is a count; count × unit is a size. Show division intent: exact,
  floor or ceiling.
- Simpler return types: `void` over `bool` over `u64` over `?u64` over `!u64`.
- Pass arguments larger than 16 bytes that must not be copied by const pointer. Initialize large structs in place.
- Functions run to completion without suspending, so precondition assertions stay true.
- Zero buffer padding; guard against buffer bleeds.
- Pass library options explicitly at the call site instead of relying on defaults.

**Shape**

- 70 lines per function at most. Few parameters, a simple return type, the logic in the body.
- Centralize control flow and state in the parent function: push `if`s up and `for`s down. Leaf functions are pure.
- 100 columns per line at most. Braces on every `if` that does not fit on one line.
- All compiler warnings on, at the strictest setting.

**Performance**

- Optimize the slowest resource first (network, disk, memory, CPU), weighted by how often it is used.
- Batch to amortize cost. Separate the control plane from the data plane.
- Give the CPU large, predictable chunks of work. Extract hot loops into functions with primitive arguments and no
  `self`.

**Names and comments**

- `snake_case`; no abbreviations; acronyms keep their capitals (`VSRState`).
- Units and qualifiers last, most significant word first: `latency_ms_max`.
- Related names of the same length: `source` and `target`. Prefix a helper with its caller: `read_sector_callback`.
- Nouns over participles: `replica.pipeline`, not `replica.preparing`. One meaning per name.
- Callbacks last in the parameter list. An options struct where arguments can be mixed up, such as two `u64`.
- File order: important things first, `main` first; in a struct, fields, then types, then methods.
- Comments say why and how, as full sentences. Each test opens with its goal and method. In the code you change,
  delete comments that only restate the code.
- Commit messages explain the change; a PR description is not in `git blame`.

**Dependencies and tools**

- Every dependency is supply-chain, safety and performance risk. Prefer owning a small, well-understood piece of code
  to adding a dependency.
- Write scripts in the project's main language, not shell, when the project has a standard toolchain for it.

## Testing

Tests hunt for bugs; they do not restate the code. TigerStyle asks for exhaustive tests of valid and invalid data; the
essay asks for simulation over agent-written unit tests. This skill keeps both: the order below ranks them.

- **Deterministic simulation tests** come first: drive the system from one seed through faults, reordering and invalid
  input, so every failure replays. A bug found once becomes a seed that runs forever.
- **Differential tests** compare against a reference implementation (the original code, a slower obvious version, or
  another implementation) and close every gap they show.
- **Fuzzing** checks the assertions. Data that moves from valid to invalid is where bugs live.
- Example-based unit tests only where a simulation or a differential test cannot reach. Do not add a unit test that
  only restates the code.

## Swarm riding

The essay's view: the agent is an accelerator, and the environment it runs in decides the result.

- **Be ambitious.** Rewriting a dependency, a custom database for the workload, or a reimplementation in another
  language is in scope when it moves the goal.
- **Phrase the goal as a hill to climb.** A tenfold speedup, a redesign for IO, memory and CPU measured on real
  historical data, every gap found by a differential test closed, or a reimplementation in another language to
  TigerStyle.
- **Sweep the codebase as a find-and-replace on ideas:**
  - Implicit state machines become states encoded in the type system, so whole bug classes fail to compile.
  - Shared mutable state becomes actors or lock-free structures.
  - Independent sequential awaits run concurrently (`tokio::join!`).
  - Observability (OpenTelemetry) measures every bottleneck end to end, by component.
- **Do the simple thing.** A clear prompt in a well-set-up codebase. Add no plans, orchestration or memory layers the
  task does not need. When the work splits into independent pieces, run them in parallel subagents.

### Repository changes that need the user's word

The essay also tells readers to reshape the repository itself. Each of these changes needs the user's explicit request
for that change. Invoking this skill is not that request.

- Delete comments wholesale, or delete `docs/` and skills folders.
- Ban agent-written unit tests in `AGENTS.md` or `CLAUDE.md`.
- Rewrite or vendor dependencies the task did not name.
- Merge repositories into a monorepo.
- Remove CI, or replace pull requests with pushes to the default branch.

## Other languages

TigerStyle is written for Zig. Keep the intent and use the language's form:

| TigerStyle | Rust | Other languages |
|---|---|---|
| `assert` kept in release builds | `assert!`, not `debug_assert!`, for invariants | The language's always-on check |
| Compile-time assertions | `const _: () = assert!(...);` | Static assertions, type-level checks |
| No `usize` | Fixed-width types for data; `usize` only for indexing and lengths, converted with `try_from` at the edge | Fixed-width types for stored and wire data |
| Static allocation | Allocate with capacity at startup; assert that no collection grows past it | Preallocated pools and buffers |
| Options struct | A struct argument or a builder | Named arguments |
| `zig fmt`, `scripts/*.zig` | `rustfmt`, `cargo xtask` | The project's formatter and main language |
| `@divExact`, `@divFloor`, `div_ceil` | `div_ceil`, `div_euclid`, `checked_div`, an assert on the remainder | An explicit rounding helper |

For Rust, also load this plugin's `rust` skill. Where it and this skill differ, the stricter rule wins.

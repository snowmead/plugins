---
name: rust
description: Always use this skill when reading and writing software in Rust.
license: Apache-2.0. Complete terms in LICENSE.txt
---

# Rust

Follow repository-local conventions first. Apply these defaults where the
repository is silent. Keep unrelated cleanup out of behavioral changes.

## Toolchain

Use edition 2024 and Rust 1.99.0 or newer for new projects. Respect an existing
crate's declared minimum supported Rust version, edition, and release channel.
Set `rust-version` to the oldest compiler the crate actually supports and tests.
Check the manifest and toolchain before choosing APIs.

Prefer the current standard library when its contract fits. Remove superseded
helpers and dependencies once their remaining uses are gone. New syntax is not
a reason to change behavior, numeric semantics, or platform guarantees.

Read [standard library choices](references/standard-library.md) when working on
collections, parsing, synchronization, memory, FFI, or platform code. Read
[nightly features](references/nightly.md) when adopting unstable language or
library features, custom targets, or nightly build tooling. Enable only the
features actually used and pin a dated nightly for code that requires them.

When setting up CI, test the supported release toolchain and add a current
nightly compatibility job. Nightly coverage does not establish stable support.
For a warning-free CI build on Cargo 1.97+, use
`CARGO_BUILD_WARNINGS=deny cargo test --keep-going`. Keep linker warnings visible;
suppress a specific diagnostic only when its cause is understood. Cargo 1.99+
disables incremental compilation when `CI` is set; do not add
`CARGO_INCREMENTAL=0` for it.

Verify changing feature status against the [Rust release notes] and the selected
toolchain's API documentation. An RFC, project goal, or final comment period is
not a released feature.

[Rust release notes]: https://doc.rust-lang.org/stable/releases.html

## Imports

Keep all `mod` declarations in one contiguous block, including `pub mod`.
Follow it with one blank line, then one contiguous block of `use` and `pub use`
statements. Do not insert blank lines between declarations or between import
statements, including multiline groups. Visibility and import source do not
create separate blocks. Keep attached documentation and attributes with their
statements.

```rust
pub use std::time::Duration;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;
```

## Modules and visibility

A module owns one responsibility. Split at an existing domain seam when types
do not interact or private helpers serve unrelated sections. Do not split by
line count or fragment a cohesive type to shorten a file.

Name modules after their responsibilities. Avoid `types`, `utils`, `helpers`,
`common`, and `misc`. Avoid redundant item prefixes: use `scan::Scanner`.

Declare submodules in `foo.rs` beside `foo/`. Give each module its own file.
The exceptions are `#[cfg(test)] mod tests`, placed last, and the shared
integration test module at `tests/common/mod.rs`. Cargo treats top-level
`tests/*.rs` files as independent test binaries.

Every `mod.rs` is a module index. Its only Rust items are out-of-line `mod`
declarations and re-exports such as `pub use` or `pub(crate) use`. Never put
structs, enums, traits, impls, functions, constants, statics, macros, or inline
modules there. Put those definitions in child module files. This also applies
to `tests/common/mod.rs`: define helpers in child files and re-export them.

Expose entry points and domain types through the parent module. When the parent
is `mod.rs`, use re-exports. Keep implementation submodules private so a split
preserves caller import paths.
Default moved items to private, then add only the visibility callers require.
Use `pub(crate)` for crate-wide access and `pub(super)` for a real parent-child
boundary. Do not use `pub(in path)`. Reserve `pub` for intended external APIs.

Enable these lints individually. Never enable all of Clippy's `restriction`
group. Leave `clippy::redundant_pub_crate` off to avoid conflicting visibility
advice. Omit a lint the crate's oldest supported toolchain does not know:
`definition_in_module_root`, the rest-pattern lints, and
`raw_borrows_via_references` need Rust 1.99.

```toml
[lints.clippy]
definition_in_module_root = "warn"
inline_modules = "warn"
mod_module_files = "warn"
rest_pattern_accessible_field = "warn"
unnecessary_rest_pattern = "warn"

[lints.rust]
unreachable_pub = "warn"
missing_docs = "warn"
raw_borrows_via_references = "warn"
```

Define inherent `impl` blocks in the type's defining module. Put an operation
used only by one caller in that caller as a private function when it does not
belong to the type's contract. Move tests with the code they cover.

## Module reading order

Order a module so the reader can identify its purpose, major components, and
main operation before reading implementation details. Importance determines
placement, not visibility or item kind alone. Use this default order:

1. Module documentation, module declarations, imports, and public re-exports.
2. Constants, static declarations, compile-time assertions, and `const fn`
   helpers used to compute compile-time values, including implementation-only
   definitions.
3. The main structs, domain enums, and traits that explain the module's model
   and boundaries. Keep their definitions visible before long implementations.
4. Constructors, entry points, and the main behavior of those types. Put a trait
   implementation here when it defines the module's primary operation, such as
   `Iterator::next` for an iterator or `Read::read` for a reader.
5. Supporting types and implementations: error enums with their variants,
   internal representations, and routine `Display`, `Debug`, `From`, or `Default`
   implementations that do not explain the main operation.
6. Private runtime helper functions and supporting methods. Keep related helpers
   together, in the order their callers use them.
7. The `#[cfg(test)] mod tests` block.

Within an inherent `impl`, put associated constants and compile-time helpers
first, then constructors and primary methods, then secondary operations and
private runtime helpers. Keep associated items owned by their type. If private
runtime methods bury the main API, move them into a later inherent `impl` in the
same module. Keep each trait implementation intact and avoid scattering related
behavior.

Keep an enum and its variants together. Move the whole error definition below
its callers when its details interrupt the main flow. In a module whose purpose
is error handling, that enum belongs near the top. Apply the same judgment to
trait implementations: `FromStr` is central in a parsing module, while a routine
error conversion belongs below the main operation.

Do not move an item merely because it is private or public. A private engine can
be the module's central component; a public error can be supporting detail.
Keep declarations with ordering requirements, such as scoped macros, before
their uses. A reader should not need to scroll past error variants, formatting
code, or helper algorithms to discover what the module does.

## Functions and traits

Put behavior in an `impl` when it owns state, maintains invariants, constructs
the type, or performs that type's primary operation. Repeated dependency
parameters across functions call for a context or service that owns them.
Keep supporting methods private. Use free functions for stateless algorithms
or operations with no honest receiver. Do not invent empty namespace structs.

Use traits for substitution or intentional dependency boundaries. Define a
trait near its consumer unless it is a public domain contract. Inject adapters
through constructors or explicit contexts. One implementation is enough when
the trait prevents domain code from depending on a database, HTTP client,
filesystem, or SDK.

Keep traits narrow. Do not mirror an entire inherent API or invent extension
points. Use generics for local compile-time substitution. Use `dyn Trait` for
runtime substitution, heterogeneous storage, or justified compile-time
isolation. Seal public traits when downstream implementations are unsupported.

## Types and invariants

Make invalid code fail to compile. Encode valid states and operations in types
before adding runtime checks. Return explicit errors for invalid runtime input.

Use named structs instead of tuples, including tuple structs, for data you
model. Give enum payloads named fields. Field names must explain the values;
positions are not semantics. Unpack tuples required by external APIs at the
boundary rather than carrying positional data through the application.

Use distinct newtypes or enums for domain IDs, units, amounts, and validation
states. Unrelated values must not be interchangeable merely because they share
a scalar representation. Do not use naked boolean mode flags, magic values,
sentinels, or meaningless defaults. Implement `Default` only for a valid,
meaningful default.

Keep invariant-bearing fields private. Establish invariants through constructors
or `TryFrom`, and preserve them through every mutation and conversion. Encode
only constraints established by requirements or existing code. Never infer
nonzero, positivity, ordering, or other validation rules from a name.

Do not expose partially initialized domain values. Use typestate for
state-dependent APIs: expose only operations valid in that state, and make
transitions consume the old state and return the new one. If construction has
stages, represent each valid stage explicitly.

Express access and capabilities through ownership, borrowing, lifetimes, and
trait bounds. Do not substitute flags or comments for restrictions the compiler
can enforce. Accept `&str`, `&Path`, and `&[T]` for borrowed inputs. Take ownership
when storing, consuming, or returning an owned value.

In struct construction and destructuring, name every field. Do not use `..`,
including struct update syntax such as `..Default::default()`. Adding a field
must force affected sites to be reviewed. The rest-pattern lints check struct
patterns only; review struct update syntax by hand.

## Conversions

Use the standard conversion contract when it fits:

| Contract | Mechanism |
|---|---|
| Infallible, lossless conversion with one obvious meaning | `From` |
| Conversion that can reject input | `TryFrom` |
| Cheap borrowed view | `AsRef` or `AsMut` |
| Lookup view with equivalent `Eq`, `Ord`, and `Hash` | `Borrow` |
| Canonical text parsing | `FromStr` |
| Collection construction or growth | `FromIterator` or `Extend` |
| Lossy, contextual, policy-driven, or I/O operation | Named method |

Implement `From` and `TryFrom`; blanket implementations supply `Into` and
`TryInto`. Use conversion bounds on parameters only when several input forms
benefit callers. Prefer concrete parameters for internal functions.

Preserve error sources in conversions used by `?`. Do not convert unrelated
types just because their fields match, or retain a custom helper that duplicates
a trait implementation. Use `Result::flatten` for nested results with the same
error type. Use `bool::try_from(integer)` when only zero and one are valid;
nonzero truthiness is a different contract.

## Ownership and control flow

Write Rust using enums and patterns, `Option` and `Result`, iterators, and
ownership. Do not translate foreign-language designs into string tags, sentinel
values, manual index loops, defensive copies, or output parameters when Rust's
types and return values express the operation directly.

In `match`, name every enum variant explicitly. Do not use `_` or a catch-all
binding to absorb unlisted variants. Adding a variant must break every affected
match so its behavior is reviewed. Combine named variants with `|` when their
behavior is identical.

At external API boundaries, use wildcard or rest patterns only when the compiler
requires them for a foreign `#[non_exhaustive]` type. Handle unknown variants
deliberately. Keep these required patterns out of domain types you control.

Establish ownership once, then borrow. Every `clone()`, `collect()`, `Arc`, and
`Box` needs an ownership, storage, concurrency, or measured performance reason.
Use entry APIs for map insertion when they express the operation directly.

Use guard clauses, `?`, and `let else` for early exits. Use let-chains when
successive tests depend on earlier bindings. Use `if let` match guards when an
arm depends on another pattern; guarded arms do not establish exhaustiveness.

```rust
fn positive_number(input: Option<&str>) -> Option<u32> {
    if let Some(text) = input
        && let Ok(value) = text.parse::<u32>()
        && value > 0
    {
        return Some(value);
    }
    None
}

assert_eq!(positive_number(Some("42")), Some(42));
assert_eq!(positive_number(Some("0")), None);
```

Use iterator combinators when they expose the computation. Use a loop or match
when a chain hides branching or error policy. Validate before mutation unless
partial progress is the documented contract.

Never use `anyhow`. Use `thiserror` or the framework's typed equivalent to
represent failures explicitly. Map each failure deliberately, preserving its
source and adding operational context at application boundaries.

Do not use `unwrap()`, `expect()`, `panic!`, or `unreachable!` where a type or an
explicit error can handle the case. Outside test assertions, assert only internal
invariants that cannot be encoded in types. State the violated invariant in the
message. Invalid runtime input is an error, not an assertion failure.

Use `core::cfg_select!` for ordered, mutually exclusive configuration branches.
Use `#[cfg(false)]` for intentionally disabled code. Keep feature conditions
explicit. Infer const arguments locally, such as `let bytes: [u8; 4] = [0; _]`
or `zeros::<_>()`; function signatures still need a named const parameter.

## Documentation and unsafe code

Write `//` comments as Markdown sentences with capitalization and punctuation,
including tagged comments. Explain non-local reasons, invariants, and hazards.
Use `//!` for modules and `///` for item contracts, including meaningful private
items. Omit duplicated docs for trivial trait implementations and obvious test
helpers. Put implementation comments after item docs; keep a comment about a
specific documentation line beside that line.

Start with one sentence stating what the item does. Use reference-style intra-doc
links with an explicit canonical path in the same block:

```rust
/// Returns the number of bytes in a [`Path`]'s encoded representation.
///
/// [`Path`]: std::path::Path
fn encoded_len(path: &std::path::Path) -> usize {
    path.as_os_str().as_encoded_bytes().len()
}
```

Add executable examples when they clarify use, `# Errors` for meaningful failure
cases, and `# Panics` for every public panic condition. Unsafe functions and
traits require `# Safety` documenting all caller or implementor obligations.

Every unsafe block, including those inside unsafe functions and examples, needs
an immediately preceding `// SAFETY:` proof of its specific preconditions.
Document unsafe impls the same way. A `# Safety` section defines obligations;
the local proof explains why this operation meets them. Check validity,
alignment, provenance, aliasing, lifetimes, and initialization as applicable.

Use explicit unsafe blocks inside unsafe functions, `unsafe extern` blocks,
and `#[unsafe(...)]` for unsafe attributes. Form raw pointers with `&raw const`
or `&raw mut`, not a reference cast. Safe construction of a raw pointer does not
establish that dereferencing it is valid.

`missing_docs` checks public coverage only. Audit private items separately.
Render docs with `--document-private-items` and deny broken intra-doc links
when supported by the repository.

## Tests

Test behavior through stable entry points with small fixtures. Test accepted and
rejected conversions. Test round trips only when reversibility is promised.
Use a panic test only when panic is the contract.

Use `core::assert_matches!` for pattern assertions and
`core::debug_assert_matches!` for debug-only checks. Import these
macros explicitly when using their unqualified names. Use doctests for public
examples and run checks with the crate's supported toolchain and feature set.

```rust
use core::assert_matches;

assert_matches!(Some(42), Some(value) if value > 0);
```

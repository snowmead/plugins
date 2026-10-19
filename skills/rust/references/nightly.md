# Nightly features

Checked 2026-10-01 with `rustc 1.101.0-nightly (21b707e3f 2026-09-30)`.

Adopt an unstable feature when it solves the task and the crate can require
nightly. Pin a dated toolchain and compile a minimal example before designing
an API around it. Add only the required `#![feature(...)]` gates. Keep gates out
of targets that promise stable support. Verify the pinned toolchain against the
[Unstable Book] and its library source; stabilization in nightly is not a stable
release. Scope platform-specific gates with `cfg_attr` for their target.

## Language choices

| Need | Feature and contract |
|---|---|
| Local scope for `?` | `try_blocks`; annotate the result type, and return its success value as the tail expression |
| Early residual return | `yeet_expr` for `do yeet`; custom residual conversion can also require `try_trait_v2_yeet` |
| Custom `?` type | `try_trait_v2`; implement `Try` and the required `FromResidual` contract with a distinct residual type |
| Never type in type arguments | `!`, such as `Result<T, !>`; available without a gate on the checked nightly |
| Extract a statically infallible variant | `Result::into_ok` / `into_err` with the required `Into<!>` bound; available without a gate on the checked nightly |
| Named opaque type alias | `type_alias_impl_trait`; follow the defining-use and `#[define_opaque]` requirements |
| Opaque associated type | `impl_trait_in_assoc_type` |
| Bound an async or RPITIT method's return | `return_type_notation`, such as `S::call(..): Send` |
| Iterator with suspended local state | `gen_blocks` and `gen { yield value; }` |
| Explicit coroutine implementation | `coroutines` and `coroutine_trait` when those APIs are used |
| Struct or enum const parameter | `adt_const_params`; derive `ConstParamTy`, `PartialEq`, and `Eq` |
| Unsized const parameter | `unsized_const_params` together with `adt_const_params`, with its current structural requirements |
| Expressions involving generic constants | `generic_const_exprs` with required evaluatability bounds; check `gca_min_const_items`, the renamed `min_generic_const_args`, separately for its supported subset |
| Const trait calls | `const_trait_impl`; use `const trait`, `const impl`, and `[const]` bounds |
| Opaque foreign types | `extern_types`; use pointer-based FFI with the target's layout constraints |
| Half or quad precision primitives | `f16` / `f128`; verify operation and target support |

```rust
#![feature(try_blocks)]

let total: Result<u32, std::num::ParseIntError> = try {
    let first = "20".parse::<u32>()?;
    let second = "22".parse::<u32>()?;
    first + second
};
assert_eq!(total, Ok(42));
```

An RTN `Send` bound covers the method's returned future. A spawned task also
needs its captured values, output, and lifetimes to meet the executor's bounds.
Opaque iterators borrowing a receiver must express that lifetime. Do not force
an iterator trait object merely to name an associated type.

Const bounds do not make arbitrary formatting or I/O executable at compile
time. Annotate ambiguous unit or never-type results explicitly instead of
depending on fallback inference. Check follow-on async-closure RTN syntax
against the pinned compiler before using it.

## Library choices beyond Rust 1.99

Use the selected toolchain's stability attributes to decide whether a gate is
still required. These APIs are not part of the Rust 1.99 stable baseline:

| API | Gate or availability check |
|---|---|
| `Vec::from_fn` | Available without a gate on the checked nightly |
| `core::mem::DropGuard` | Available without a gate on the checked nightly |
| `UnsafeCell` accessors | Available without a gate on the checked nightly; preserve aliasing and race proofs |
| `core::mem::conjure_zst` | Available without a gate on the checked nightly; prove the zero-sized type is inhabited and its safety invariants hold |
| `Allocator`, `Global`, and `new_in` on `Vec` and `Box` | Available without a gate on the checked nightly |
| Other allocator-generic collections and `Rc` / `Arc` | `allocator_ext`, which succeeds `allocator_api` |
| Integer funnel shifts | Available without a gate on the checked nightly; observe the selected API's shift-count contract |
| Formatting builder closure helpers | `debug_closure_helpers` |
| Windows `CommandExt::inherit_handles` | `windows_process_extensions_inherit_handles` |
| `NumBuffer::default` and additional `NonZero` conversions | Inspect the exact impl's stability and bounds |
| Elided `'static` inside `thread_local!` declarations | Verify the specific declaration form with the pinned compiler |
| WASM wide-arithmetic target feature | Verify compiler support and execution-environment support independently |

## Compiler and Cargo

Current nightly enables Polonius Alpha and the next-generation trait solver by
default. `generic_const_exprs` currently switches the crate back to the older
trait solver. Test directly with the pinned compiler before adding borrow-checker
workarounds. Prefer simple ownership and entry APIs even when more complicated
borrowing now compiles. Keep stable compatibility checks if stable is supported.

Use `cargo -Z build-std` with the `rust-src` component when rebuilding the
standard library is required. For JSON target specifications use Cargo's
`-Z json-target-spec`, or rustc's `-Z unstable-options` directly. Use Cargo's
`-Z script` for single-file programs with manifest frontmatter.

Field projections through `Pin` or smart pointers, the `Receiver`/`Deref` split,
compile-time reflection, sized-hierarchy/scalable-vector work, and
`#[rustc_splat]` are compiler experiments. Adopt them only after locating the
current implementation, documented flags, and a compiling example for the
pinned toolchain. Do not invent gates or use `rustc_*` internal attributes as
ordinary application interfaces.

[Unstable Book]: https://doc.rust-lang.org/nightly/unstable-book/

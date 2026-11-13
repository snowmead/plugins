# Nightly features

Checked 2026-11-13 with `rustc 1.102.0-nightly (8eb778d04 2026-11-12)` and
`rustc 1.101.0-beta.1 (bbcdfd90a 2026-11-10)`.

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
| Custom `?` type | `try_trait_v2` and `try_trait_v2_residual`; implement `Try` and `FromResidual` with a distinct residual type, and `Residual<Output>` for that residual type with `TryType` naming the `?` type |
| Named opaque type alias | `type_alias_impl_trait`; follow the defining-use and `#[define_opaque]` requirements |
| Opaque associated type | `impl_trait_in_assoc_type` |
| Bound an async or RPITIT method's return | `return_type_notation`, such as `S::call(..): Send` |
| Iterator with suspended local state | `gen_blocks` and `gen { yield value; }` |
| Explicit coroutine implementation | `coroutines` and `coroutine_trait` when those APIs are used |
| Struct, enum, or array const parameter | `min_adt_const_params`; derive `ConstParamTy`, `PartialEq`, and `Eq`, and keep no field more private than the type. Use `adt_const_params` only for types beyond that subset |
| Unsized const parameter | `unsized_const_params` together with `adt_const_params`, with its current structural requirements |
| Expressions involving generic constants | `generic_const_exprs` with required evaluatability bounds. `gca_const_items` with the `gca!` macro is its interim successor, and `gca_min_const_items` the minimal subset; check which one covers the expression |
| Const trait calls | `const_trait_impl`; write `const trait`, `const impl Trait for Type` with `const` before `impl`, and `[const]` bounds |
| Match through a `Box` or other smart pointer | `deref_patterns`; `box` patterns are removed |
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
time. Check follow-on async-closure RTN syntax against the pinned compiler
before using it.

## Library choices beyond Rust 1.100

Use the selected toolchain's stability attributes to decide whether a gate is
still required. These APIs are stable in Rust 1.101, in beta until its release
on 2026-12-24, and need no gate on the checked nightly:

| API | Contract |
|---|---|
| `Result::into_ok` / `into_err` | Extract the only possible variant of `Result<T, !>` or `Result<!, E>` |
| `funnel_shl` / `funnel_shr` on unsigned integers | Observe the shift-count contract; the `unchecked_` forms need a proof of it |
| `DebugList::entry_with`, `DebugStruct::field_with`, `DebugMap::key_with` / `value_with` | Format one entry with a closure |
| `NumBuffer::default` and additional `From<NonZero<_>>` conversions | Inspect the exact impl's bounds |
| Slice `split_once` / `rsplit_once` | Split at the first or last element matching a predicate |
| `Vec::try_remove` | Remove at an index, returning `None` when it is out of bounds |
| `String::into_chars` | Iterate owned `char`s |
| `Arc::is_unique` / `Rc::is_unique` | Check for no other strong or weak pointer |
| `CStr::display` | Display a C string, with invalid UTF-8 shown as U+FFFD |
| `core::sync::SyncView` | Share a value that is `Send` but not `Sync`, such as a future; it gives shared access only when the value is `Sync` |
| Pointer `try_cast_aligned` and `cast_slice` | Cast with an alignment check, or to a slice pointer of a given length |
| `vec::IntoIter::allocator` | Read the allocator of a consuming iterator |
| Windows `CommandExt::inherit_handles` and `ExitCodeExt::from_raw` | Process creation and exit codes on Windows |
| Elided `'static` inside `thread_local!` declarations | Such as `static NAME: Cell<&str>` |

On the checked nightly, `core::mem::Alignment` is also stable without a gate,
for Rust 1.102. These still need gates:

| API | Gate or availability check |
|---|---|
| Allocator-generic collections beyond `Vec` and `Box`, and `Rc` / `Arc` constructors such as `new_in` | `allocator_ext`; a few items remain under `allocator_api` |
| WASM wide-arithmetic target feature | Verify compiler support and execution-environment support independently |

## Compiler and Cargo

Current nightly enables Polonius Alpha and the next-generation trait solver by
default. Nightly therefore accepts borrow patterns that stable 1.100 rejects,
such as returning a map lookup and inserting on the miss path.
`generic_const_exprs` switches the crate back to the stable trait solver, with a
warning. Stable 1.100 uses the next-generation solver only for coherence and
orphan checks. Test directly with the pinned compiler before adding
borrow-checker workarounds. Prefer simple ownership and entry APIs even when
more complicated borrowing now compiles. Keep stable compatibility checks if
stable is supported.

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

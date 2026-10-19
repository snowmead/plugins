# Standard library choices

Use these APIs when their contracts fit. This reference targets Rust 1.99.0.
Check the selected compiler's docs for signatures, target support, and const
availability. A runtime-stable method is not necessarily const-stable.

## Collections, ranges, and text

| Operation | Preferred API and constraint |
|---|---|
| Overlapping fixed-size windows | `slice.array_windows::<N>()`; `N > 0` |
| Fixed-size chunks plus remainder | `as_chunks::<N>()`, `as_rchunks::<N>()`, and mutable variants; `N > 0` |
| Exact-length array borrow | `as_array::<N>()` or `as_mut_array::<N>()` |
| Insert and immediately mutate | `Vec::push_mut` / `insert_mut`; corresponding deque and linked-list methods |
| Conditionally remove deque ends | `VecDeque::pop_front_if` / `pop_back_if` |
| Keep only the last `len` deque elements | `VecDeque::retain_back(len)`; the front-dropping counterpart of `truncate` |
| Iterate a boxed array | `for item in boxed` on `Box<[T; N]>` yields values; `&boxed` and `&mut boxed` yield references |
| Remove matching entries and keep ownership | `HashMap`, `HashSet`, or `BTreeMap::extract_if`; consume the iterator to process the full selection |
| Insert and retain an occupied entry | `BTreeMap` entry `insert_entry` |
| Copyable stored ranges | `core::range::{Range, RangeFrom, RangeInclusive, RangeToInclusive}`; iterate with `IntoIterator` |
| Flexible range parameter | `impl RangeBounds<T>` when the implementation supports those bound forms |
| Strip both delimiters | `str::strip_circumfix` or slice `strip_circumfix` |
| Locate an existing borrowed region | `str::substr_range`, slice `subslice_range`, or `element_offset` |
| Decimal integer formatting into reusable storage | `integer.format_into(&mut core::fmt::NumBuffer::new())`; bind the buffer when retaining the returned borrow |
| Nonzero integer parsing | `NonZero::<I>::from_str_radix` |
| Endian-specific UTF-16 bytes | `String::from_utf16le` / `from_utf16be`; use `_lossy` only when replacement characters are intended |
| Lossy UTF-8 from owned bytes | `String::from_utf8_lossy_owned(bytes)`; after a failed `String::from_utf8`, `FromUtf8Error::into_utf8_lossy`; allocation reuse is not guaranteed |
| Closure-backed formatting | `core::fmt::from_fn` |

Range literals produce `core::ops` ranges. Use explicit `core::range` types for
stored ranges and conversions to `core::range::legacy` types when crossing
representations.
Converting an exhausted inclusive iterator range can panic; inspect that state.
Do not reuse an exhausted `core::ops::RangeInclusive` as a range value. Its
`start()`, `end()`, and slice-indexing behavior are unspecified and changed in
Rust 1.99.

`substr_range`, `subslice_range`, and `element_offset` inspect addresses. Use
`find` or content matching to search for equal data. The slice location methods
panic for zero-sized elements. Safe chunk APIs expose remainders; use unchecked
variants only with a proven nonzero chunk size and exact divisibility.

```rust
let text = String::from("<entry>");
let location = text
    .strip_circumfix("<", ">")
    .and_then(|inner| text.substr_range(inner));
assert_eq!(location, Some(core::range::Range { start: 1, end: 6 }));

let mut buffer = core::fmt::NumBuffer::new();
let digits = 123_u32.format_into(&mut buffer);
assert_eq!(digits, "123");
```

## Synchronization and initialization

Use `Cell::update` for single-threaded read-modify-write. Use atomic `update`
or `try_update` with explicit success and failure orderings for concurrent
updates. Their closures can run repeatedly, so keep retry-sensitive side effects
outside them. Prefer `fetch_add` and other dedicated operations when they fit.
Rename the deprecated `fetch_update` to `try_update`.

```rust
use std::sync::atomic::{AtomicUsize, Ordering};

let counter = AtomicUsize::new(4);
let previous = counter.update(Ordering::Relaxed, Ordering::Relaxed, |n| n * 2);
assert_eq!(previous, 4);
assert_eq!(counter.load(Ordering::Relaxed), 8);
```

Use atomic `from_mut`, `from_mut_slice`, and `get_mut_slice` for exclusive
access to existing storage where the atomic type and target support them.
`from_mut` availability depends on primitive and atomic alignment matching.

Use `RwLockWriteGuard::downgrade(write_guard)` to retain continuous lock
protection while changing from exclusive to shared access.

Use `LazyCell::from` or `LazyLock::from` for already-built values. Use their
`get`, `get_mut`, and `force_mut` associated functions according to whether
initialization is allowed. Use a const initializer in `thread_local!` when the
value can be constructed at compile time.

## Memory and pointers

- Use `Vec::into_raw_parts` and `String::into_raw_parts` when transferring
  allocation ownership, or `Vec::into_parts` / `from_parts` when the pointer
  should be `NonNull`. Preserve the allocator, capacity, layout, and validity
  requirements when reconstructing, including UTF-8 for strings.
- Use `Box::into_non_null` / `from_non_null`, or `into_raw` / `from_raw`, for an
  allocation that will be freed later. Do not write
  `NonNull::new_unchecked(Box::into_raw(boxed))`.
- Use `MaybeUninit` array `From` / `AsRef` / `AsMut` implementations and `Cell`
  array/slice views. Conversion of storage does not initialize its elements.
- Use `MaybeUninit` slice `write_copy_of_slice` or `write_clone_of_slice` to
  initialize elements. Use `assume_init_ref`, `assume_init_mut`, and
  `assume_init_drop` only after proving initialization and appropriate access.
- Use `Box`, `Rc`, and `Arc` `new_zeroed` / `new_zeroed_slice` for zero-filled
  uninitialized allocations. Prove all-zero validity before `assume_init`.
- Use `NonNull::from_ref` / `from_mut` for references. Choose
  `without_provenance`, `with_exposed_provenance`, and `expose_provenance`
  according to the provenance contract; a numeric address alone is insufficient
  for memory access. Raw pointer `Default` constructs a null thin pointer.
- Form raw pointers with `&raw const` / `&raw mut` instead of casting a
  reference, which imposes reference aliasing requirements first. The
  allow-by-default `raw_borrows_via_references` lint reports the cast form.
- Use pointer `as_ref_unchecked` / `as_mut_unchecked` only with the full reference
  validity proof. Prefer existing safe borrows whenever available.
- Use `Layout::dangling_ptr`, `repeat`, `repeat_packed`, and `extend_packed` for
  allocation layout calculations. `repeat` returns layout and element stride.
  Packed layouts do not supply ordinary field alignment.
- Use `mem::size_of_val_raw`, `mem::align_of_val_raw`, and
  `Layout::for_value_raw` to measure a value behind a raw pointer that cannot
  be reborrowed. For a slice, `str`, or trait-object tail, prove the whole
  value's size fits in `isize`. Use the safe reference forms when a reference
  exists.
- Treat a manually dropped value as inaccessible: never read it or drop it
  again. Moving its `ManuallyDrop` wrapper is permitted, including for `Box`.
- Use `Box::leak` and the other `leak` functions only for intentional permanent
  allocation. Never rebuild an owner from a leaked reference to free it.
  `OsString::leak` and `PathBuf::leak` return `&mut OsStr` and `&mut Path`,
  respectively.

## Numbers and performance

Use `isolate_highest_one`, `isolate_lowest_one`, `highest_one`, `lowest_one`, and
`bit_width` for integer bit operations, including supported `NonZero` forms.
`NonZero<char>` expresses a character other than NUL. Use unsigned
`checked_sub_signed`, `overflowing_sub_signed`, `saturating_sub_signed`, or
`wrapping_sub_signed` when the subtrahend is signed.

Use associated constants such as `i32::MAX` and `f64::EPSILON`. The integer
modules such as `std::i32`, module-level float constants such as
`std::f64::EPSILON`, and integer `min_value()` / `max_value()` are deprecated.
`std::f64::consts` remains current.

Use `f32` / `f64` `algebraic_add`, `algebraic_sub`, `algebraic_mul`,
`algebraic_div`, and `algebraic_rem` only when the numeric contract permits
algebraic transformations and their floating-point consequences. Use
`EULER_GAMMA` and `GOLDEN_RATIO` from the corresponding `consts` module.

Use `hint::cold_path` and `hint::select_unpredictable` when workload evidence
supports the hint. Unchecked integer negation and shifts require proofs of
their documented bounds; they are not default arithmetic operations.

## Files, FFI, and tooling

Use `File::lock`, `lock_shared`, `try_lock`, `try_lock_shared`, and `unlock`
where their platform semantics fit. Account for unsupported targets, including
Solaris. Use `fs::set_times` with `FileTimes` to change timestamps by path, and
`fs::set_times_nofollow` to change a symlink itself, instead of opening the file
for `File::set_times`. Use `Duration::from_nanos_u128` for a `u128` nanosecond
count and `Location::file_as_c_str` when a caller location needs C string
representation.

Use `#[unsafe(naked)]` with a `naked_asm!` body for functions whose complete
prologue, epilogue, and ABI obligations are implemented in assembly. Apply
`#[cfg]` to assembly template strings when only individual instructions vary.
Variadic foreign declarations support `C`, `sysv64`, `win64`, `efiapi`, and
`aapcs` on applicable targets. Keep `#[track_caller]` consistent across matching
declarations. Raw borrows of union fields can be formed in safe code; reading
the field still requires a validity proof.

Define a C-variadic function as an `unsafe extern "C"` or `"C-unwind"` function
whose final parameter is `...`. That parameter is a `core::ffi::VaList`:
`next_arg` is `va_arg`, `clone` is `va_copy`, and dropping it is `va_end`. Each
read needs a proof that another argument of a compatible type was passed. Read
C types such as `c_int`, `c_uint`, `c_double`, and pointers; C promotes smaller
integers and `c_float` before the call, so those types cannot be read. Other
ABIs require a `#[unsafe(naked)]` definition written in assembly.

```rust
use core::ffi::c_int;

/// Adds `count` variadic `c_int` arguments.
///
/// # Safety
///
/// The caller must pass at least `count` variadic arguments of type `c_int`.
unsafe extern "C" fn sum(count: c_int, mut arguments: ...) -> c_int {
    let mut total = 0;
    for _ in 0..count {
        // SAFETY: The caller passed at least `count` `c_int` arguments.
        total += unsafe { arguments.next_arg::<c_int>() };
    }
    total
}

let first: c_int = 20;
let second: c_int = 22;
// SAFETY: Two `c_int` arguments follow the count.
let total = unsafe { sum(2, first, second) };
assert_eq!(total, 42);
```

Use `proc_macro::Span` location methods and `TokenStream::extend` over iterators
of `Group`, `Literal`, `Punct`, or `Ident`. A single token is not an iterator.

Use Cargo config `include` for shared configuration and TOML 1.1 syntax where
it improves readability. Use `cargo publish --workspace` for an authorized
workspace release. With Cargo 1.99+, an edition 2024 member can set
`default-features = false` on a `workspace = true` dependency; older Cargo
rejects that manifest, and earlier editions ignore the field with a warning.
Write `[lints]` names with underscores, such as `unexpected_cfgs`; hyphenated
names are deprecated. Let rustc choose its default linker and symbol mangling
unless a target or external tool requires an override. Declare intended WASM
imports with `#[link(wasm_import_module = "...")]`; keep unresolved symbols
as link errors. Check the current [platform support] table for distribution
and CI target decisions.

[platform support]: https://doc.rust-lang.org/rustc/platform-support.html

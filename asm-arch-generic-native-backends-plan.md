# Generic native `Backend`s for AArch64 and RISC-V 64, and asm-arch writer genericity

## 1. Problem

`os-target-native` today has exactly one backend:

```rust
pub struct X86_64SysVBackend {
    cfg: X86_64SysVConfig,
    out: String,
}
```

It is hard-coded to:

- an x86-64 ABI,
- a concrete `String` output destination, and
- concrete `asm-x86-64` writer traits (`X64WriterCore`, `X64Writer`).

This means:

1. **No AArch64 or RISC-V 64 support.** There is no `AArch64SysVBackend` or
   `Riscv64Backend`, even though `asm-arch` already has `asm-aarch64` and
   `asm-riscv64` crates.
2. **No genericity over writers.** The backend currently writes to a `String`,
   so machine-code writers, binary encoders, instrumentation wrappers, and
   `unicorn-engine` execution harnesses cannot be plugged in. `asm-arch`
   already has binary backends (`asm-x86-64/src/out/iced.rs`,
   `asm-aarch64/src/out/bin.rs`, `asm-riscv64/src/out/rv_asm_backend.rs`), but
   `os-target-native` does not use them.
3. **Fragile text-based tests.** The existing tests assert against textual
   assembly output, so tiny formatting changes in `asm-arch` break them.

## 2. Goal

Refactor `os-target-native` into architecture-generic, writer-generic native
backends. After the refactor:

- `X86_64SysVBackend<W>` works with any `W: X64WriterCore`.
- A new `AArch64SysVBackend<W>` works with any `W: AArch64WriterCore`.
- A new `Riscv64Backend<W>` works with any `W: Riscv64WriterCore`.
- All three implement the `NativeBackend` subtrait from the backend-capability
  subtrait plan.
- Tests execute generated **binary** code under `unicorn-engine` rather than
  comparing fragile text output, with text tests kept only as a secondary
  diagnostic.

## 3. Background: asm-arch `WriterCore`

Each asm-arch crate exposes a trait like:

```rust
pub trait WriterCore<Context> {
    type Error: Error;
    fn mov(&mut self, ctx: &mut Context, cfg: X64Arch, dest: &..., src: &...) -> Result<(), Self::Error>;
    // ...
}
```

There is also a `Writer<L, Context>: WriterCore<Context>` trait for label-aware
operations (calls/jumps to labels). The text writer in each crate is exposed via
a `writers!` macro that turns any `core::fmt::Write` into a `WriterCore`/
`Writer` implementor. The binary writers live in the same crates and implement
the exact same `WriterCore` / `Writer` traits, so a generic backend can switch
between text and binary by changing the writer type.

Generic backends should depend only on the generic traits, not on the text
writer macro. Tests should primarily use the existing binary backends and run
the produced bytes with `unicorn-engine`.

## 4. Proposed design

### 4.1 Per-arch generic backend

```rust
// x86-64
pub struct X86_64SysVBackend<W>
where
    W: X64WriterCore + X64Writer<L, ()>,
{
    cfg: X86_64SysVConfig,
    writer: W,
}
```

For tests `W` is a binary encoder (`iced` on x86-64, `bin.rs` on AArch64,
`rv_asm_backend.rs` on RISC-V 64) whose output is fed to `unicorn-engine`. A text
writer feeding an internal `String` remains available for optional
human-readable diagnostics.

Equivalent structures for AArch64 and RISC-V 64:

```rust
pub struct AArch64SysVBackend<W>
where
    W: AArch64WriterCore + AArch64Writer<(), ()>,
{ ... }

pub struct Riscv64Backend<W>
where
    W: Riscv64WriterCore + Riscv64Writer<(), ()>,
{ ... }
```

(Exact `Writer`/`WriterCore` names and `Context`/`Label` parameters must be
verified against `asm-aarch64` and `asm-riscv64` crate definitions.)

### 4.2 Configuration per architecture

Each backend has its own config / helper-name struct, mirroring the existing
`SysVHelpers` and `X86_64SysVConfig`:

| Arch | Config | Notes |
|---|---|---|
| x86-64 | `X86_64SysVConfig` | existing, uses RAX scratch, RDI/RSI args |
| AArch64 | `AArch64SysVConfig` | X0 scratch, X0–X7 args per AAPCS64 |
| RISC-V 64 | `Riscv64Config` | A0 scratch, A0–A7 args per psABI |

Helper names (`os_load_u32`, `os_store_u64`, etc.) can be shared via a common
`NativeHelpers` struct; each arch config contains one.

### 4.3 `NativeBackend` impl

Each generic backend implements:

```rust
impl<W> NativeBackend for X86_64SysVBackend<W> { /* ... */ }
impl<W> NativeBackend for AArch64SysVBackend<W> { /* ... */ }
impl<W> NativeBackend for Riscv64Backend<W> { /* ... */ }
```

This satisfies the backend-capability subtrait plan and lets object-model
native renderers ask for `B: NativeBackend` generically.

### 4.4 Convenience constructors

Keep ergonomic defaults, and add binary-first constructors:

```rust
// Binary-output backend for unicorn-engine tests.
impl X86_64SysVBackend<IcedBinaryWriter> {
    pub fn new_binary() -> Self;
    pub fn into_bytes(self) -> Vec<u8>;
}

// Text-output backend for diagnostics.
impl X86_64SysVBackend<TextWriter> {
    pub fn new_text() -> Self;
    pub fn into_string(self) -> String;
}
```

Existing `X86_64SysVBackend::new()` can become an alias for the binary default
or be replaced site-by-site with the explicit constructor.

## 5. Emulation of `OsOp` per architecture

The baseline `Backend::op` is implemented in terms of `NativeBackend`
primitives. Each arch backend only needs to translate those primitives into
its own writer methods.

| OsOp | x86-64 | AArch64 | RISC-V 64 |
|---|---|---|---|
| `PushU64` | `mov rax, imm` + `push rax` | `mov x0, imm` + `str x0, [sp, #-8]!` | `li a0, imm` + `sd a0, -8(sp)` + `addi sp, sp, -8` |
| `Pop` | `pop rax` | `ldr x0, [sp], #8` | `ld a0, 0(sp)` + `addi sp, sp, 8` |
| `Load` | pop addr; call helper; push value | pop addr; call helper; push value | pop addr; call helper; push value |
| `Store` | pop addr; pop value; call helper | pop addr; pop value; call helper | pop addr; pop value; call helper |
| `Ecall` | `call os_ecall` | `bl os_ecall` | `call os_ecall` |
| `Jump` | pop target; `jmp rax` | pop target; `br x0` | pop target; `jalr x0` |
| `TailCall` | `jmp helper` | `b helper` | `j helper` |
| `Trap` | `ud2` | `brk #0` | `ebreak` |

The helper functions themselves (`os_load_u32`, `os_store_u64`, etc.) stay
out-of-line so the generated binary can be linked against a small arch-specific
runtime shim. In tests the helpers are mocked by either hooking `unicorn`
interrupts or by copying small hand-written jump stubs into the test image.

## 6. Shared unicorn-engine test harness

`os-target-native/tests/harness.rs` provides something like:

```rust
pub fn run_bytes(
    arch: unicorn::Arch,
    mode: unicorn::Mode,
    code: &[u8],
    setup: impl FnOnce(&mut unicorn::Unicorn<()>, u64, u64),
) -> CpuState { ... }
```

Responsibilities:

1. Map an executable page and a stack page.
2. Write the generated bytes.
3. Set the program counter and stack pointer.
4. Run.
5. Return registers and stack memory for assertions.

For `Load`/`Store` tests, the harness reserves a heap page and pre-fills it
with test data; the generated helper calls are replaced by tiny in-image stubs
that read from / write to that page and return.

## 7. Implementation status

**Phase 0 (x86-64 refactor), Phase 1 (AArch64), and Phase 2 (RISC-V 64) are complete.**
- `X86_64SysVBackend<W, L>` is generic over `asm-x86-64` writers, with `new_binary()`
  producing `IcedWriter<Label>` bytes and `new_text()` keeping an optional text path.
- `AArch64SysVBackend<W, L>` is implemented using `asm-aarch64`'s `AArch64Writer` binary encoder.
- `Riscv64Backend<W, L>` is implemented using `asm-riscv64`'s `RvAsmWriter` binary encoder.
- All three implement `os_target_core::NativeBackend`.
- `os-target-core` now defines the `NativeBackend` subtrait.
- Shared `tests/harness.rs` runs generated x86-64, AArch64, and RISC-V 64 bytes under
  `unicorn-engine`.
- `cargo test -p os-target-native` passes 22 tests (12 library/module tests + 10 integration
  unicorn tests) and `cargo test --all` is green.

## 7. Phases

### Phase 0 — Refactor x86-64 backend to be writer-generic and binary-first (1 week) ✅ DONE

1. Replace `out: String` in `X86_64SysVBackend` with a generic `W: X64WriterCore + X64Writer<L, ()>`.
2. Add a binary-writer constructor (`new_binary`) that uses `asm-x86-64`'s
   `iced` backend.
3. Rewrite the existing six tests to drive `unicorn-engine` on the output bytes
   instead of comparing text strings. Keep one smoke text test as a diagnostic.
4. Add a tiny reusable `unicorn` harness in `os-target-native/tests/harness.rs`
   (memory mapping, stack setup, run, register / memory assertion).

### Phase 1 — Introduce AArch64 backend (1 week) ✅ DONE

1. Add `asm-aarch64` as a dependency of `os-target-native`.
2. Define `AArch64SysVConfig` and `AArch64SysVBackend<W>`.
3. Implement `Backend` and `NativeBackend` for AArch64 using `asm-aarch64`'s
   binary writer (`out/bin.rs`).
4. Add `unicorn-engine` execution tests for push/pop/load/store/ecall/jump/trap
   using the shared harness.

### Phase 2 — Introduce RISC-V 64 backend (1 week) ✅ DONE

1. Add `asm-riscv64` as a dependency of `os-target-native`.
2. Define `Riscv64Config` and `Riscv64Backend<W>`.
3. Implement `Backend` and `NativeBackend` using `asm-riscv64`'s
   `rv_asm_backend.rs` binary encoder.
4. Add `unicorn-engine` execution tests.

### Phase 3 — Hook up to `NativeBackend` subtrait and object model (1 week)

1. ✅ Implement `NativeBackend` for all three backends.
2. Add arch-specific `Load`/`Store` helper stubs in unicorn tests so the
   `Load` and `Store` OsOp paths can be executed end-to-end on all three
   architectures.
3. Update the object-model native renderer to use `NativeBackend` instead of
   reaching for arch-specific types.
4. Add an `os-target-native` test that renders a simple object-model operation
   on each of the three architectures.

## 8. Crate changes

`os-emulation/crates/target/os-target-native`:

- `src/lib.rs` — split into modules:
  - `src/x86_64.rs`
  - `src/aarch64.rs`
  - `src/riscv64.rs`
  - `src/config.rs` — shared `NativeHelpers`, arch configs.
- `Cargo.toml` — add `asm-aarch64`, `asm-riscv64`, and `unicorn-engine`
  (dev-dependency) as needed.

No changes to `asm-arch` itself are required; this plan finally *uses* the
genericity that is already there.

## 9. Testing checklist

| Test | Target |
|---|---|
| `x86_64::X86_64SysVBackend` binary output executes under unicorn | `cargo test -p os-target-native` |
| `aarch64::AArch64SysVBackend` binary output executes under unicorn | new tests in `src/aarch64.rs` |
| `riscv64::Riscv64Backend` binary output executes under unicorn | new tests in `src/riscv64.rs` |
| Text output remains available as a diagnostic | one smoke text test per arch |
| Generic writer plugged into x86-64 backend | custom test writer in tests/ |
| `NativeBackend` implemented by all three | `tests/native_backend.rs` |
| Object-model operation rendered and executed on three arches | future integration test |

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `asm-aarch64` / `asm-riscv64` binary encoders differ from x86-64's `iced` | Keep each backend in its own module; isolate arch-specific writer construction in `fn new_binary`. |
| `unicorn-engine` crate / bindings not available on all dev platforms | Gate unicorn tests behind a feature flag (`--features unicorn-tests`); keep text smoke tests unconditional so CI always has a fallback. |
| Binary encoder bugs or missing relocations vs text assembly | Test both paths side-by-side for the first phase; text tests catch encoder regressions that unicorn alone might mask. |
| Label types (`L`) differ across crates | Use the crates' own `Writer<L, Context>` bounds; the text/binary writer constructors pick the correct `L`. |
| Generic parameters make public API noisy | Provide type aliases `type TextX86_64SysVBackend = X86_64SysVBackend<TextWriterX86_64>;`. |
| Breaking the existing `X86_64SysVBackend` API | Introduce `new_binary`/`new_text` explicitly; replace existing `new()` calls during implementation commits. |

## 11. Immediate next steps

1. ✅ Refactor `X86_64SysVBackend` to generic `W` and switch existing tests to
   binary output + `unicorn-engine`.
2. ✅ Add the shared unicorn harness to `os-target-native/tests/harness.rs`.
3. ✅ Implement AArch64 and RISC-V 64 generic binary backends.
4. Add in-image `Load`/`Store` helper stubs for the unicorn harness so those
   OsOp paths can be executed end-to-end on all three architectures.
5. Wire the object-model native renderer to `NativeBackend` so it can emit
   JVM/DEX/.NET/WASMGC-style operations on x86-64, AArch64, and RISC-V 64.
6. Open a tracking issue in `portal-co/os-emulation` for native backend
   architecture expansion.
7. Commit with prefix `[AI]` at each phase checkpoint.
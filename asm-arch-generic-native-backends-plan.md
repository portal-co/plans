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
2. **No genericity over writers.** The backend always writes to a `String`,
   so you cannot plug in a machine-code writer, a logging/tracing writer, or an
   instrumentation wrapper. `asm-arch`'s `WriterCore` traits are designed to
   be generic over output type, but `os-target-native` does not use that
   flexibility.

## 2. Goal

Refactor `os-target-native` into architecture-generic, writer-generic native
backends. After the refactor:

- `X86_64SysVBackend<W>` works with any `W: X64WriterCore`.
- A new `AArch64SysVBackend<W>` works with any `W: AArch64WriterCore`.
- A new `Riscv64Backend<W>` works with any `W: Riscv64WriterCore`.
- All three implement the `NativeBackend` subtrait from the backend-capability
  subtrait plan.
- Existing `String`-output text tests keep passing, and new arch tests are
  added.

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
`Writer` implementor.

Generic backends should depend only on the generic traits, not on the text
writer macro.

## 4. Proposed design

### 4.1 Per-arch generic backend

```rust
// x86-64
pub struct X86_64SysVBackend<W, L = String>
where
    W: X64WriterCore + X64Writer<L, ()>,
    L: fmt::Write,
{
    cfg: X86_64SysVConfig,
    writer: W,
    // phantom label writer if separated from W
}
```

For most cases `W` is a text writer feeding an internal `String`, but the
type parameter allows alternate writers.

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

Keep ergonomic defaults:

```rust
impl X86_64SysVBackend<String> {
    pub fn new() -> Self;
}

impl fmt::WriteExt {
    pub fn into_string(self) -> String;
}
```

So existing code like `X86_64SysVBackend::new()` still works.

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
out-of-line so the generated text can be linked against a small arch-specific
runtime shim.

## 6. Phases

### Phase 0 — Refactor x86-64 backend to be writer-generic (1 week)

1. Replace `out: String` in `X86_64SysVBackend` with a generic `W: X64WriterCore + X64Writer<L, ()>`.
2. Add a text-writer convenience alias so existing tests do not change.
3. Verify all six existing x86-64 unit tests still pass.

### Phase 1 — Introduce AArch64 backend (1 week)

1. Add `asm-aarch64` as a dependency of `os-target-native`.
2. Define `AArch64SysVConfig` and `AArch64SysVBackend<W>`.
3. Implement `Backend` and `NativeBackend` for AArch64.
4. Add text-output tests for push/pop/load/store/ecall/jump/trap.

### Phase 2 — Introduce RISC-V 64 backend (1 week)

1. Add `asm-riscv64` as a dependency of `os-target-native`.
2. Define `Riscv64Config` and `Riscv64Backend<W>`.
3. Implement `Backend` and `NativeBackend`.
4. Add text-output tests.

### Phase 3 — Hook up to `NativeBackend` subtrait and object model (1 week)

1. Implement `NativeBackend` for all three backends.
2. Update the object-model native renderer to use `NativeBackend` instead of
   reaching for arch-specific types.
3. Add an `os-target-native` test that renders a simple object-model operation
   on each of the three architectures.

## 7. Crate changes

`os-emulation/crates/target/os-target-native`:

- `src/lib.rs` — split into modules:
  - `src/x86_64.rs`
  - `src/aarch64.rs`
  - `src/riscv64.rs`
  - `src/config.rs` — shared `NativeHelpers`, arch configs.
- `Cargo.toml` — add `asm-aarch64` and `asm-riscv64` native deps.

No changes to `asm-arch` are required; this plan finally *uses* the genericity
that is already there.

## 8. Testing checklist

| Test | Target |
|---|---|
| `x86_64::X86_64SysVBackend` text output unchanged | `cargo test -p os-target-native` |
| `aarch64::AArch64SysVBackend` text output | new tests in `src/aarch64.rs` |
| `riscv64::Riscv64Backend` text output | new tests in `src/riscv64.rs` |
| Generic writer plugged into x86-64 backend | custom test writer in tests/ |
| `NativeBackend` implemented by all three | `tests/native_backend.rs` |
| Object-model operation rendered on three arches | future integration test |

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `asm-aarch64` / `asm-riscv64` text macros differ from `asm-x86-64` | Keep each backend in its own module; do not try to unify writer method names. |
| Label types (`L`) differ across crates | Use the crates' own `Writer<L, Context>` bounds; the text writer supplies the correct `L`. |
| Generic parameters make public API noisy | Provide type aliases `type TextX86_64SysVBackend = X86_64SysVBackend<TextWriterX86_64>;`. |
| Breaking the existing `X86_64SysVBackend` API | Preserve `X86_64SysVBackend::new()` and `into_string()` through aliases / inherent impls. |

## 10. Immediate next steps

1. Read `asm-aarch64/src/out.rs` and `asm-riscv64/src/out.rs` to capture exact
   `WriterCore` / `Writer` signatures and label types.
2. Refactor `X86_64SysVBackend` to generic `W` as proof of concept.
3. Open a tracking issue in `portal-co/os-emulation` for native backend
   architecture expansion.
4. Commit with prefix `[AI]` at each phase checkpoint.
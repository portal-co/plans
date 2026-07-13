# Shared OS Emulation Layer (SOEL) — Plan

> **Working title:** `@portal-co/os-emulation`  
> **Consumers:** `@speet` (current, reference; uses the `@wax/wax-core` backend today and the refactored `wasm-blitz` backend after it stabilizes), `@vane` (current: JS JIT + interpreter on riscv64; aspirational: WASM JIT, user-facing design, other architectures), fully emulated OS / vkernel / private OS handlers / `parachute` cross-process syscall handling (future).  
> **Hub directory:** `/Users/g/Code-local/portal-hot`  
> **Related active project:** `parachute` (the current OS repo; one goal is a process handling another's syscalls, which `os-emulation` will abstract over once implemented).  
> **Date drafted:** 2026-07-13

This document is the canonical plan for extracting, genericizing, and centralizing the operating-system emulation code and documentation that currently lives inside `@speet`. The goal is a single source-of-truth repository that owns:

1. **Native execution bridge** — the OS-to-OS conversion path ("thin runtime": `speet-host-api`, `speet-runtime`, `speet-recompile`, `speet-rt`, ABI stubs, etc.).
2. **Simple Linux emulation surface** — `osctx`, `speet-linux-wasi`, and the thin runtime's OS bridges.
3. **Fully emulated OS execution (vkernel)** — aspirational future work that reuses the same layers once the integration in (1) and (2) is solid.
4. **Shared runtime and compile-time services** — memory/paging models (both runtime storage and JIT/compile emitters), syscall tables, policy hooks, host-API abstractions, a target-agnostic operation IR (`os-target-core`) with a pluggable `Backend` trait for WASM-like sinks (via `wax-core`), JS, `StackOp`, future `wasm-blitz` direct native, and LLVM; async OS callback surfaces; and extension points that `@speet`, `@vane` (including vane's existing JS JIT), and future emulated-OS / private handlers can consume without duplicating code.

`@speet` will become a **reference consumer** of this layer: its own OS crates will be thin re-exports or wrappers that point to the new repo. `@vane` will consume it first on its **currently supported surface** — the riscv64 interpreter and JS JIT — and only later expand to the aspirational surface (WASM JIT, user-facing API, additional architectures).

---

## 1. Why now: pain points in the current layout

The `@speet` monorepo has grown into two parallel runtime strategies, both of which need the *same* OS concepts but express them differently:

| Capability | Thin runtime (native execution) | Container / vkernel (full emulation) | Fragmentation cost |
|---|---|---|---|
| Guest→host boundary | `HostApi` trait (`speet-host-api`) | `OS` trait (`osctx`) | Two trait hierarchies for the same concept. |
| Syscall dispatch | `speet-host-syscall` (x86_64) / inline WASI | `speet-linux-wasi` / future vkernel | Syscall tables written twice. |
| Policy / sandbox whitelist | `HostPolicy` in `FilteredHostApi` | (future `os-manifest` for vkernel) | No shared policy spec between thin runtime and future emulation. |
| Memory / paging | `speet-memory` (compile-time codegen only) | `vane-arch::Mem` (runtime) + hardcoded JS JIT `data()` emitter (compile-time) | Speet assumes one compile-time paging model; vane hardcodes another in its JIT. No shared `MemorySpec`. |
| ABI redirect stubs | `speet-abi-spec`, `speet-abi-stubs`, `speet-abi-codegen` | (future vkernel bridge) | Heavily speet-branded, thin-runtime specific. |
| Trap hooks | `speet-traps` | `speet-traps` (reusable today) | Already generic; should be invariant of this move. |

Meanwhile, `@vane` already needs the same foundations on the surface it supports today:

- It defines a `Mem` paging system compatible with `rift`/`r52x`/`speet` (currently riscv64 only).
- Its **existing JavaScript JIT** is a compile-time codegen path: it already emits `data(addr)` string code and host-call stubs for riscv64. These should implement the same `MemoryCodegen` and redirect-codegen traits as speet's WASM emitter.
- Any **future** WASM JIT target (`vane-target-wasm`) or architectures beyond riscv64 will reuse the same layers, but they are not part of the first unification.

Finally, private OS handlers will need a stable, *speet-independent* crate surface to implement custom host kernels, sandboxes, and containerd shims without depending on the whole `@speet` recompiler workspace.

**Principle:** OS emulation is a horizontal layer, not a `@speet` vertical. It should live in its own repo.

### 1.1 Supported features: the actual unification target

The first version of SOEL unifies only features that exist in code today. Aspirational capabilities are layered on top once the shared foundation is solid.

| Area | `@speet` (supported today) | `@vane` (supported today) | Aspirational extensions |
|---|---|---|---|
| Guest target | riscv64 Linux ELF | riscv64 interpreter + JS JIT | Other architectures, WASM JIT target, user-facing product layers |
| Host bridge | `HostApi` trait (tunneled / filtered / redirecting) | None; memory/interpreter only | `OS`/`HostApi` integration for vane, host-call stubs for non-JS targets |
| Syscall dispatch | `speet-linux-wasi`, thin runtime `WasmSyscallDispatcher` | Syscalls handled by interpreter inline / not yet factored as `OS` | `VaneOS` implementing `OS::syscall`, vkernel channel |
| Memory model | Compile-time codegen in `speet-memory` (one hardcoded spec) | Runtime `Mem` + JS JIT `data(addr)` string codegen | `MemorySpec` driving both WASM and JS emitters for both repos |
| ABI / redirects | `speet-abi-spec`, `speet-abi-stubs`, `speet-abi-codegen` | JS host-call stubs hardcoded in generator | Shared redirect recipes consumed by WASM and JS emitters |
| Linux emulation surface | `speet-linux-wasi` / thin runtime `HostApi` (simple bridges) | None | Full `os-vkernel` / ptrace / private-kernel contract |
| Process syscall handling | Same-process host bridge | None | `parachute` goal: one process handles another's syscalls; abstracted by future OS layer |
| Codegen backend formats | `WasmBinary` (current); `wasm-blitz` WASM via `wax-core` (future); `wasm-blitz` direct native, LLVM, JS, `StackOp` as separate `Backend`s | `StackOp` IR + JS renderer; interpreter | `wasm-blitz` direct native, LLVM |
| Backend abstraction | `os-target-core::Backend` wraps `wax-core::InstructionSink` for WASM-like targets; direct native/JS/LLVM/StackOp are separate backends | None directly | Keep `wax-core` traits as single-source for WASM-like backends only; do not duplicate them inside `os-emulation` |
| Tests against real native backend | `@wax/wax-core` corpus validated in `@speet` tests | Interpreter + JS tests in `@vane` | Defer `wasm-blitz` native E2E tests until its refactor lands; unit-render tests live in `os-emulation` |
| Foundational WASM utilities | `wax-core` / `wax-tags`; `wax-core` has a single source of truth in `portal-co/wax` | None directly | `os-emulation` may depend on `wax-core` from `portal-co/wax` but must not duplicate it |
| Async OS callbacks | None (`HostApi::syscall` is synchronous) | `AsyncStackHost`, `async_mem`, `await $.ecall()` | `AsyncOS`/`AsyncHostApi` used by assembly paths and wasm-blitz JS/native backends |

**Aspiration is not absence.** `@vane` already has an riscv64 interpreter and JS JIT; the plan's first milestone is to refactor those into the shared traits. The full vkernel, ptrace emulation, private-kernel contract, WASM JIT, non-riscv64 targets, and a user-facing OS layer are explicitly marked as future work.

---

## 2. Scope: what moves, what stays, what is created

### 2.1 Moves from `@speet` to the new repo

The OS **abstractions**, **backends**, **data models**, and **compile-time emitters** move. The actual module/link **builders** stay in `@speet` because they encode the megabinary layout and guest-to-guest jump conventions that are speet-specific.

Moved essentially intact, then genericized:

```text
speet/crates/os/osctx                     →  os-emulation/crates/runtime/os-ctx
speet/crates/os/speet-host-api            →  os-emulation/crates/runtime/os-host-api
speet/crates/os/speet-host-syscall        →  os-emulation/crates/runtime/os-syscall-table
speet/crates/os/speet-syscall             →  os-emulation/crates/runtime/os-syscall-emit
speet/crates/os/speet-linux-wasi          →  os-emulation/crates/backends/os-linux-wasi
speet/crates/os/speet-abi-spec            →  os-emulation/crates/abi/os-abi-spec
speet/crates/os/speet-abi-codegen         →  os-emulation/crates/abi/os-abi-codegen
speet/crates/os/speet-abi-stubs           →  os-emulation/crates/abi/os-abi-stubs
speet/docs/container-plan.md              →  os-emulation/docs/runtime/container-plan.md
speet/docs/thin-runtime-plan.md          →  os-emulation/docs/runtime/thin-runtime-plan.md
speet/docs/osctx.md                       →  os-emulation/docs/runtime/osctx.md
speet/docs/speet-linux-wasi.md           →  os-emulation/docs/backends/linux-wasi.md
speet/docs/future/*.md                    →  os-emulation/docs/future/
speet/goals/os.md                         →  os-emulation/docs/goals/os.md
```

### 2.1a Megabinary builder stays in `@speet`

The megabinary system and the module/link infrastructure stay in `@speet`. `os-emulation` will define *traits* that describe the glue a compiler/megabinary builder must emit, but the concrete `EntityIndexSpace`, `MegabinaryBuilder`, `FuncSchedule`, and `speet-link-core` remain speet-specific:

```text
speet/crates/os/speet-module-target        (stays)
speet/crates/os/speet-module-builder       (stays)
speet/crates/os/speet-schedule             (stays)
speet/crates/os/speet-link-core            (stays)
```

Likewise, the different guest-address resolution mechanisms in `@speet` (one function per instruction, `return_call` chains, speculative-call stubs) and in `@vane` (JS JIT per-PC code strings) remain in their respective repos. `os-emulation` abstracts over them via a new `os-build` trait set.

### 2.2 Stays in `@speet`

These stay close to their recompiler consumers:

- Architecture frontends: `speet-riscv`, `speet-x86_64`, `speet-mips`, `speet-aarch64`, `speet-powerpc`.
- Managed frontends: `speet-dex`, `dex-bytecode`, `speet-wasm`, `speet-object`.
- Helper crates that are *not* OS-specific: `yecta` (reactor/control-flow), `wasm-layout`, `speet-memory` **(see §2.3)**, `speet-ordering`, `speet-traps`, `speet-wasm-helpers`, `speet-reach`, `speet-interp`, `speet-log`.
- Module/link/megabinary layout crates: `speet-module-target`, `speet-module-builder`, `speet-schedule`, `speet-link-core`.
- Thin-runtime *integration* / driver crates: `speet-recompile`, `speet-runtime`, `speet-rt`, `speet-rtd`, `speet-linker`.
  - These will depend on the new `os-emulation` crates and re-export the generic APIs under their current names for backwards compatibility.
- The `@speet` test corpus, corpus harness, and guest runner stay in `@speet`, but reference the new crates.

### 2.3 Shared neutral crates that migrate to a common home (or stay as dual-dependency)

Two crates are already *mostly* generic but carry speet naming:

- `speet-memory` — currently layout/mapper/mem/paging/virtual modules. Its compile-time paging assumptions move into `os-page-codegen`; any reusable runtime traits move into `os-page`. Both `@speet` and `@vane` migrate to those crates. `@speet` keeps a temporary compatibility shim `speet-memory` that re-exports `os-page` and `os-page-codegen` items until all internal call sites migrate.
- `wasm-layout` — already architecture-agnostic; useful for any ISA. It can be left in `@speet/helper/wasm-layout` but the new repo will depend on it via git. Alternatively, move to `portal-co/wasm-layout` once it stabilizes. Decision deferred until Phase 2.
- `wax` (`portal-co/wax`) — a **foundational** abstraction over *WASM-like* backends. It is the **single source of truth** for the `wax-core` traits (`InstructionSink`, etc.) used by plain WASM binary output and by post-refactor `wasm-blitz` WASM input. It stays in its own repo; `os-emulation` may consume it for `WaxBackend<T>` but must not copy or re-export the traits.
- `@speet` current backends — `@speet` is generic over the `wax-core` traits. Today it uses an `InstructionSink` implementor for native output. The OS layer does not need to name or manage that backend; it just emits through `WaxBackend<T>`.
- `wasm-blitz` — the WASM-to-native compiler at `portal-co/wasm-blitz` is under refactor and will implement the `wax-core` traits for WASM consumption. Post-refactor, it will also support a direct native `Backend` (`WasmBlitzDirect`) that does **not** go through `wax-core`. Tests against direct `wasm-blitz` are **deferred** until its API stabilizes.

### 2.4 Created net-new in the new repo

| New crate / doc | Purpose | Horizon |
|---|---|---|
| `os-page` | Common `PageTable`, `GuestMemory`, and `MemoryBackend` traits extracted from `vane-arch::Mem` and `speet-memory`. Initially shaped by riscv64 legacy/shared modes and speet's compile-time paging; extended to new targets only when those targets exist in a consuming repo. | Phase 2 |
| `os-page-codegen` | Compile-time emitters for memory/paging helpers. | Phase 2 |
| `os-build` | Compile-time trait set **generic over `Backend`** whose `BuildGlue` trait uses `GuestMemory`, `PageTable`, `SyscallCodegen`, `RedirectCodegen`, and `MemoryCodegen` as supertraits. It emits `OsOp` stack operations onto a `Backend` to answer recompiler-level questions (jump to address, guest memory access, state layout). Implemented by `@speet`'s module builders and `@vane`'s JS JIT. | Phase 1 |
| `os-target-core` | Shared stack IR / operation format (`OsOp`) + `Backend` trait, extracted from `vane-target-core::StackOp` / `CoreOpcode`. Provides `WaxBackend<T: InstructionSink>` for WASM-like targets (WASM binary and `wasm-blitz` WASM), plus separate backends for JS, `StackOp`, future LLVM, and future `wasm-blitz` direct native. | Phase 2 |
| `os-async` | Async variants of `OS`, `Ctx`, `HostApi`, and stack-host hooks. Makes vane's `AsyncStackHost` / `async_mem` pattern available to all backends, including future assembly paths. | Phase 3 |
| `osctx-vkernel` | Concrete `OS` + `Ctx` impl driving the shared virtual kernel from container-plan. | Future work |
| `osctx-ptrace` | The planned `PtraceLayer` trait and dynamic interception layer. | Future work |
| `os-manifest` | Schema + parser for `manifest.json` (syscall whitelist, binary hash registry, agent tool registry, signatures). | Future work |
| `os-plugin` | Generic plugin host bindings for OS extensions (sandbox policies, custom syscall backends). | Future work |
| `docs/integrations/speet.md` | Reference consumer guide: how `@speet` uses SOEL. | Phase 1 |
| `docs/integrations/vane.md` | Present-to-future consumer guide: `@vane`'s supported riscv64 JS/interpreter surface plus aspirational extensions. | Phase 1 skeleton; Phase 3 current content |
| `docs/integrations/wasm-blitz.md` | Backend contract for `portal-co/wasm-blitz`: NaiveAbi, CTX/SCR, required runtime shims, and how OS code renders to native targets. | Phase 2 skeleton; Future Phase C current content |
| `docs/integrations/private-os-handlers.md` | Contract for third-party / private kernel implementations. | Future work |
| `docs/integrations/parachute.md` | How `parachute` cross-process syscall handling plugs into the same `OS`/`HostApi` backends once implemented. | Future work |

---

## 3. Naming & repository surface

### 3.1 Repository

```text
GitHub:   https://github.com/portal-co/os-emulation
Local:    /Users/g/Code-local/portal-hot/os-emulation
```

If the name conflicts with `os-repo-1`, archive it regardless: `os-repo-1` is a separate, pre-modern legacy project with different OS-area goals, and `parachute` is the current OS repo. `os-repo-1` should not block the new repo; its README should point to `os-emulation` for current OS emulation work and to `parachute` for active OS development.

### 3.2 Crate naming convention

All new crate names are **speet-neutral**:

```text
osctx                   →  os-ctx        (or keep osctx for continuity)
host-api                →  os-host-api
syscall-table           →  os-syscall-table
syscall-emit            →  os-syscall-emit
linux-wasi              →  os-linux-wasi
abi-spec / codegen / stubs → os-abi-*, os-redirect-*
compiler/builder glue   →  os-build
shared operation IR     →  os-target-core
async OS callbacks       →  os-async
vkernel impl            →  os-vkernel
manifest                →  os-manifest
page / memory           →  os-page
plugin                  →  os-plugin
```

`module-*` crates stay in `@speet`; `os-build` supplies the cross-repo trait surface they implement.

`@speet` will retain thin compatibility crates (`speet-host-api = os-host-api` re-export) so existing consumers do not break.

### 3.3 Feature flags for `no_std` / WASM

Every core crate must compile in three modes:

1. `no_std` + `alloc` — used by recompilers running inside WASM build tools.
2. `std` — used by native host kernels / future vkernel.
3. `wasm` — WebAssembly target, including the `wasm32-unknown-unknown` build used by vane.

This is enforced in CI from day one.

---

## 3.5 Compile-time vs runtime variants: the core design shift

Every OS concept in `os-emulation` must be expressible in **two forms**:

| Concept | Compile-time variant | Runtime variant |
|---|---|---|
| **Memory / paging** | `MemoryCodegen` — emit code that accesses guest memory at fixed or computed offsets; produce page-table data structures. | `GuestMemory` / `MemoryBackend` — actually read/write bytes, allocate pages, handle faults. |
| **Syscalls** | `SyscallCodegen` — emit an inline `br_table` or dispatch tree with known function indices. | `SyscallDispatcher` — inspect a live syscall number and call the host. |
| **Host API / redirects** | `HostApi::import_manifest`, `LinkRecipe`, PLT redirect tables. | `OS::syscall` / `OS::osfuncall` — dynamic dispatch at runtime. |
| **Address dispatch (jumps)** | `JumpGlue` — produce jump tables, PLT stubs, `_dispatch` entry points. | `JumpResolver` — map a guest PC to a runtime handler (function index, JS function, native address). |
| **Backend format** | `os-target-core` defines `OsOp`, a stack-machine IR, and a `Backend` trait that turns `OsOp` sequences into concrete output (WASM bytes, JS source strings, native instructions, `StackOp`, etc.). `WaxBackend<T: InstructionSink>` handles WASM-like targets. `BuildGlue<B>` emits pure `OsOp` operations and mutates the `Backend` it is given; it has no backend-specific associated types. | `TargetInterpreter` — consume the same `OsOp`/`Backend` format at runtime without regeneration. |
| **Async OS callbacks** | `AsyncCodegen` — emit async function wrappers and `await` points where backends support it. | `AsyncOS` / `AsyncHostApi` — await host I/O or cross-process syscall responses. |
| **Policy / manifest** | `PolicySpec` — compile into allowlists, import manifests, linker flags. | `PolicyEnforcer` — check each syscall/operation against live policy state. |

### Why both forms matter — the vane JS JIT case

- `@speet` is almost entirely **compile-time**: the recompiler generates WASM functions at build time, and the vkernel/thin runtime execute those generated functions later. Its memory access is currently hardcoded to produce one specific paging model in `speet-memory`.
- `@vane` has **two modes**:
  - **Runtime:** `vane-arch::Mem` stores pages; the `Reactor` calls `interp` or dispatches to generated JS.
  - **Compile-time:** vane's JS JIT already generates `data(addr)` string code at compile (JIT) time. That string emitter is currently hardcoded to one paging mode and should implement `os-page-codegen::MemoryCodegen`.
- The **vkernel** is a runtime consumer, but it is itself **compiled alongside user code** in a megabinary. Therefore its runtime memory, policy, and dispatch code must also be available as compilable glue that the megabinary can link in.

In short: `@vane`'s JS JIT is a compile-time codegen backend in exactly the same sense as `@speet`'s recompiler, even though the emitted artifact is JS source rather than WASM bytes.

### Rules

1. **No compile-time-only assumption.** `os-emulation` must not require a `wasm-encoder` or module builder to be useful at runtime. The runtime forms compile under `no_std` + `alloc`.
2. **No runtime-only assumption.** The compile-time forms must not require a live guest memory or process state. They consume `MemorySpec`, `PolicySpec`, `SyscallTable`, etc.
3. **Shared data model.** Both forms read from the same `SyscallTable`, `MemorySpec`, `Manifest`, `AbiSpec`. These are the canonical contract between compiler and runtime.
4. **Builder trait, not builder implementation.** The actual megabinary builder stays in `@speet`. `os-emulation` only asks questions like "what imports and jump stubs does this OS backend need?" via `os-build` traits.

---

## 4. Genericization strategy: from speet-branded to OS-branded

The move is not a blind copy. Each crate needs a light genericization pass to remove assumptions that `@speet` is the only consumer.

### 4.1 `osctx` → `os-ctx` (runtime layer)

Current `OS` trait is already the right shape — it is a **runtime** boundary. Changes:

- Make `Ctx::read`/`write`/`reg`/`set_reg`/`jalr` return `Result<…, GuestFault>` so current vane and a future vkernel can both report page faults / SIGSEGV uniformly.
- Keep `OS::syscall` and `OS::osfuncall` as dynamic runtime dispatch.
- Add `OS::personality()` returning `Personality { name, arch, os, abi }` so a single `OS` impl can identify Linux vs WASI vs macOS vs a private RTOS.
- Add an optional `RuntimeSyscallTable` helper so backends that *can* pre-compute a dense dispatch table still expose it, without forcing every consumer to do so.

### 4.2 `host-api` → `os-host-api` (compile-time + runtime)

`HostApi` is split into compile-time and runtime surfaces:

- **Compile-time:** `import_manifest()`, `resolve_ambient()`, `link_recipe()`, `resolve_plt_redirect()`. These answer "what imports/stubs/flags does the linker need?" without running guest code.
- **Runtime:** `syscall(nr, args)`. This is the thin-runtime's dynamic fallback.

Changes:

- Introduce `HostApi` and `SandboxApi` as sub-traits of a common `OsApi`.
- Move `filtered.rs`, `tunneled.rs`, `registry.rs` into `os-host-api/backends/`.
- Rename `TunneledHostApi` → `TunneledOsApi` (keep alias).
- Make `ImportManifest` arch-agnostic by accepting `BinaryLayout` instead of assuming RV64 local mapping.
- Ensure the runtime `syscall` surface *can* be compiled into a future `os-vkernel` and linked into a megabinary alongside user code, even though the vkernel itself is not in the initial scope.

### 4.3 `speet-syscall` + `speet-linux-wasi` → `os-syscall-table` + `os-syscall-emit` + `os-linux-wasi`

- `SyscallEntry`/`SyscallTable` are the **shared data model**. They are arch-agnostic; the `xn_local` closure remains arch-specific wiring.
- `os-syscall-emit` is the **compile-time** variant: it emits inline WASM dispatch (`br_table`, calls, continuations) for known syscall numbers.
- `os-linux-wasi` is a backend that owns both:
  - `LinuxWasiCodegen` — compile-time emit for WASI preview1 imports.
  - `LinuxWasiDispatcher` — runtime fallback for a host kernel or interpreter path.
- Add a `RawHostBackend` for the future vkernel path (host kernel syscalls, not WASI preview1).

### 4.4 ABI stubs / codegen

- `speet-abi-spec` becomes `os-abi-spec`: a generic ABI description DSL that can describe SysV, WASM, macOS, *and* custom vkernel function tables.
- `speet-abi-stubs` becomes `os-abi-stubs`: the checked-in redirect-stub registry and emission helpers.
- `speet-abi-codegen` becomes `os-abi-codegen`: the generator that turns an `AbiSpec` into checked-in Rust stub sources.
- `CallingConvention` moves into `os-abi-spec`; `@speet`'s `speet-plugin-api` now depends on `os-abi-spec` for it rather than `speet-abi-stubs` depending on `speet-plugin-api`.

### 4.5 `os-build`: the compiler/builder glue abstraction

The concrete module/link layers stay in `@speet`. `os-emulation` defines `OsOp` in `os-target-core` as an **explicit stack-machine IR**: every operation is a stack operation (`Push`, `Pop`, `Load`, `Store`, `Ecall`, `Jump`, etc.). `os-build` introduces a single `BuildGlue` trait that is **generic over `Backend`** and emits these stack operations onto a passed-in `Backend` rather than returning backend-specific associated types:

```rust
pub trait MemoryCodegen<B: Backend> {
    fn emit_memory_access(&mut self, backend: &mut B, op: &MemoryAccessOp);
    fn emit_page_table_glue(&mut self, backend: &mut B, spec: &MemorySpec);
}

pub trait SyscallCodegen<B: Backend> {
    fn emit_syscall_dispatch(&mut self, backend: &mut B, table: &SyscallTable<B>);
    fn emit_osfuncall_stub(&mut self, backend: &mut B, spec: &AbiSpec);
}

pub trait RedirectCodegen<B: Backend> {
    fn emit_plt_stub(&mut self, backend: &mut B, redirect: &PltRedirect);
}

pub trait GuestMemory {
    fn read(&self, addr: GuestAddr, buf: &mut [u8]);
    fn write(&mut self, addr: GuestAddr, buf: &[u8]);
}

pub trait BuildGlue<B: Backend>:
    GuestMemory + MemoryCodegen<B> + SyscallCodegen<B> + RedirectCodegen<B>
{
    /// Emit the `OsOp` sequence that jumps to a guest address.
    fn emit_jump_to_address(&mut self, backend: &mut B, target: GuestAddr);
    /// Emit page-table / paging-walk setup (required glue, not per-access).
    fn emit_memory_glue(&mut self, backend: &mut B, spec: &MemorySpec);
    /// Reserve import slots, stub functions, and data segments.
    fn reserve_os_glue(&mut self, backend: &mut B, spec: &OsGlueSpec);
    /// Emit the `_dispatch(hash_id, argc, argv)` entry point as `OsOp`s.
    fn emit_dispatch_entry(&mut self, backend: &mut B, entries: &[DispatchEntry]);
}
```

`BuildGlue` is a *supertrait* of the memory and codegen abstractions (`GuestMemory`, `MemoryCodegen`, `SyscallCodegen`, `RedirectCodegen`). Here `GuestMemory` is the compile-time memory abstraction used to reason about address spaces, page properties, and access sizes while emitting code; a separate runtime `GuestMemory` implementation backs the generated code. `BuildGlue` may keep internal recompiler state (e.g., `MegabinaryBuilder`’s entity index space or vane’s JS string buffer), and `Backend` likewise keeps its own state (instruction counts, function references). Both ends mutate their own state; `BuildGlue` never asks for backend-specific handles like `B::Jump` or `B::FuncRef`. All control flow is expressed as `OsOp` stack operations, and the backend turns those into WASM bytes, JS source strings, `StackOp` IR, or native instructions.

- `@speet` implements `BuildGlue<B>` on top of `MegabinaryBuilder`/`EntityIndexSpace` for every `B` it supports (e.g., `WaxBackend<WasmBinary>` and the current native `InstructionSink`).
- `@vane`'s **existing JS JIT** implements `BuildGlue<JsBackend>` by emitting `OsOp`s into the JS string emitter. The same `MemorySpec` / `AbiSpec` drives JS `data(addr)` and host-call stubs instead of speet's WASM functions.
- `@vane-target-wasm` (future) implements `BuildGlue<WaxBackend<...>>` by emitting `OsOp`s into its WASM function emitter.
- A future vkernel would consume the **spec** side (`OsGlueSpec`, `MemorySpec`) to know what runtime structures it must provide.

`BuildGlue` is the compile-time recompiler layer: it knows *what* guest-level operation to encode and delegates *how* to encode it to the stack-machine backend. This keeps speet-specific jump conventions and vane-specific JIT codegen in their own repos while giving `os-emulation` a single contract to target.

### 4.6 Memory / paging — compile-time and runtime

This is the highest-value genericization. Plan:

1. **Shared data model:**
   - `MemorySpec` describes page size, levels, bit widths, security directory layout, etc.
2. **Runtime traits** (used by vane now, and by a future vkernel / private kernels):
   - `GuestMemory` — read/write bytes, allocate pages, handle faults.
   - `PageTable` — explicit shared paging.
   - `AddressSpace` / `MemoryBackend` — host RAM, sparse file, snapshot.
3. **Compile-time traits** (used by speet, future vane WASM JIT):
   - `MemoryCodegen` — emit a `data(addr)` helper or inline page-table walk for a `MemorySpec`.
   - `PageInitCodegen` — emit page-table initialization code.
4. **Concrete runtime backends in `os-page`:**
   - `LegacyOnDemand` (vane's current BTreeMap model)
   - `SharedPageTable` (r5-abi-spec / rift / r52x / vane Shared mode)
   - `LinearHost` (thin-runtime host memory when guest == host)
5. **Concrete compile-time emitters in `os-page-codegen`** (or `os-page/codegen` feature):
   - Emit JS `data(addr)` for vane's existing JS JIT from a `MemorySpec`.
   - Emit WASM helpers for speet from the same `MemorySpec`.
   - Emit page-table setup code that a future vkernel can include.

Vane's current `Mem` and `CoreJS` are the prototype: `CoreJS` **is** a `MemoryCodegen` backend that happens to target JavaScript. Refactoring it makes the relationship explicit.

Both `@speet` and `@vane` will depend on `os-page`; `@speet` removes its hardcoded compile-time paging assumption, and `@vane` removes its hardcoded JIT `data()` generator.

### 4.7 Backend targets, WASM-isms, and `vane` `StackOp`

The current OS crates assume a single output artifact: WASM bytecode generated by `@speet` and interpreted by a WASM engine. That assumption shows up in many small places (`br_table` syscall dispatch, `unreachable` for terminating syscalls, linear memory page size, import namespaces, `i64`→`i32` width choices, sign-extension recipes, and globals as registers). The shared layer must be **target-agnostic** at its core and push backend details into pluggable `Backend` implementations.

Structure:

1. **`os-target-core` crate:**
   - Defines a speet-neutral operation IR (`OsOp`) inspired by `vane-target-core::StackOp`.
   - Keeps only operations that are meaningful to OS emulation: register read/write, memory load/store (with `MemWidth`), arithmetic/control flow, `Ecall`, `Trap`, `TailCall`.
   - Adds metadata that the OS layer needs: whether an `Ecall` may block/`await` (async), and which backend-specific helpers each op requires.

2. **`Backend` trait (owned by `os-target-core`, not by `wax-core`):**
   - `os-target-core` defines its own `Backend` trait that knows how to render OS-level operations (`OsOp`, `MemorySpec`, `AbiSpec`) into a concrete artifact.
   - `Backend` is **one level above** `wax-core`: it can wrap a `wax-core::InstructionSink`, but it is also free to target JS, LLVM, or `vane` `StackOp`.

3. **`wax-core` is the single-source abstraction for *WASM-like* backends:**
   - `wax-core` in `portal-co/wax` defines the traits consumed by WASM-like backends (e.g., `InstructionSink`). It is the **only** home of those traits; `os-emulation` must not duplicate or re-export them.
   - `wax-core` abstracts over **plain WASM binary output** and **post-refactor `wasm-blitz` WASM input**.
   - `@speet` is already generic over the `wax-core` traits and uses a current native backend that implements them. Post-refactor, `wasm-blitz` will also implement the same `wax-core` traits for WASM consumption.

4. **Backend family diagram:**

   ```text
   ┌─────────────────────────────────────────────────────────────┐
   │  os-target-core::Backend trait (render OsOp → artifact)     │
   └──────────────┬───────────────────────┬────────────────────────┘
                  │                       │
       ┌──────────▼──────────┐   ┌───────▼────────┐
       │ WaxBackend<T>       │   │ DirectBackends │
       │ T: InstructionSink  │   │ (not via wax)  │
       └──────────┬──────────┘   └───────┬────────┘
                  │                      │
   ┌──────────────┼──────────────┐   WasmBlitzDirect (future)
   │              │              │   LlvmBackend     (future)
   WasmBinary   wasm-blitz      JsBackend         (current)
   (current)    WASM input      StackOpBackend    (current)
                  (future)
   ```

   - `WaxBackend<T>` — wraps any `wax-core::InstructionSink` implementor. It is the path for plain WASM binary output and post-refactor `wasm-blitz` WASM output.
   - `WasmBlitzDirect` — a future `Backend` that drives the refactored `wasm-blitz` native emitter directly, bypassing `wax-core` when efficiency requires it.
   - `JsBackend`, `StackOpBackend` — vane's JS and WASM renderers (these mirror `vane-target-core`, not `wax-core`).
   - `LlvmBackend` — future LLVM IR output.

5. **WASM-isms to genericize:**
   - **Syscall dispatch:** `speet-syscall` currently emits `br_table` over syscall numbers. Genericize to a `SyscallDispatcher` backend method: WASM uses `br_table`; JS uses a `switch`/`Map`; native backends use a jump table or computed `br`.
   - **Terminating syscalls:** `unreachable` in WASM becomes `throw` in JS, a trap instruction in native, and `llvm.trap()` in LLVM.
   - **Memory helpers:** `data(addr)` in JS, inline byte loads in WASM, `__wasm_mem` access in native, and pointer-based loads in LLVM must all come from the same `MemorySpec`.
   - **Register representation:** WASM globals, JS variables, native scratch registers, LLVM `alloca`/values — all derived from `AbiSpec`.
   - **WASI imports:** `speet-linux-wasi` maps Linux syscalls to WASI preview1 imports. For non-WASM targets the same backend must emit a native host-call sequence or a trap if no host bridge is available.

6. **`vane` `StackOp` integration:**
   - `vane-target-core`'s `StackOp` / `CoreOpcode` is the most mature shared-operation design; `os-target-core` should reuse or mirror it rather than invent a competing IR.
   - `vane-target-js` and `vane-target-wasm` become concrete renderers for `OsOp` + `MemorySpec` + `AbiSpec`.
   - The JS renderer's `async_mem` flag and `await $.ecall()` show that the IR already carries async hints; `os-async` standardizes that.

### 4.8 First-class async support

`@vane` already has async hooks (`AsyncStackHost`, `await $.ecall()`, `async_mem`). The OS layer must generalize this so it works for all backends:

1. **Async traits parallel to sync traits:**
   - `AsyncOS` with `async fn syscall(...)`.
   - `AsyncCtx` with `async fn read` / `write` / `load_mem` / `store_mem`.
   - `AsyncHostApi` with `async fn syscall`/`resolve_ambient`.
2. **By default, most backends use the sync surface.** WASM and native code can elect to trap/yield on a blocking syscall until async is implemented; vane's JS JIT uses the async surface today.
3. **Code generation hint:** `OsOp::Ecall` carries a `may_await: bool` flag. Renderers emit:
   - JS: `await $.ecall()` inside an async function.
   - WASM: `call $os_syscall` returning an async token/poll descriptor (future work).
   - wasm-blitz native: emit a hypercall that cooperatively yields (future work).
   - LLVM: call an async runtime intrinsic (future work).
4. **Guest-visible semantics:** from the guest's point of view, `ecall` completes synchronously; the async machinery is an implementation detail of how the host fulfills it. This keeps the `OS` contract simple while allowing backends to use async I/O internally.

**Implication:** Phases 2 and 3 do not need to implement async for WASM or native, but they must leave room for it in the traits so that `vane`'s existing async path is not a one-off hack.

---

## 5. Trait ladder: the new shared abstraction stack

The new repo exposes a clean stack. Recompilers, runtimes, and kernels only depend on the layers they need. **Layers 0a and 0b are the compiler/encoding floor:** everything below Layer 1 is where recompilers insert their compile-time logic.

```text
┌─────────────────────────────────────────────────────┐
│  Consumers: speet thin-runtime, vane JS JIT /       │
│  interpreter (current), vane WASM JIT / vkernel /   │
│  private kernels / parachute (future)               │
├─────────────────────────────────────────────────────┤
│  Layer 5: OsRuntime                                 │
│   - execve dispatch, process lifecycle,             │
│     snapshot/restore, host bridge                   │
├─────────────────────────────────────────────────────┤
│  Layer 4: OS / SandboxApi / HostApi                   │
│   - live syscall & osfuncall dispatch               │
│   - runtime policy enforcement                      │
├─────────────────────────────────────────────────────┤
│  Layer 3a: AsyncOS / AsyncHostApi / AsyncCtx        │
│  Layer 3b: os-async helpers                         │
│   - async syscall & memory hooks (vane pattern)     │
├─────────────────────────────────────────────────────┤
│  Layer 2: SyscallTable + AbiSpec + MemorySpec +     │
│           PolicySpec (shared data model)            │
│   - the contract between compile-time and runtime   │
├─────────────────────────────────────────────────────┤
│  Layer 1: Compile-time / recompiler layer           │
│   - BuildGlue<B>                                    │
│   - GuestMemory + PageTable + Ctx (supertraits)     │
│   - SyscallCodegen + RedirectCodegen +              │
│     MemoryCodegen (supertraits)                     │
│   - emits `OsOp` stack operations onto a `Backend`  │
├─────────────────────────────────────────────────────┤
│  Layer 0a: os-target-core — `OsOp` stack IR +       │
│            `Backend` trait (pluggable targets)      │
│  Layer 0b: concrete compilers / backends: @speet      │
│            (WaxBackend<T>, native), @vane JS,       │
│            wasm-blitz direct, LLVM                  │
└─────────────────────────────────────────────────────┘
```

Cross-cutting crates:

- `os-manifest` — future shared policy schema; consumed by Layers 2–5 once implemented.
- `os-plugin` — extends Layers 1–5 at runtime.
- `os-traps` — a renamed re-export of `speet-traps` (or move it too once stable).
- `os-target-core` — Layer 0a; shared `OsOp` stack IR + `Backend` trait (with `WaxBackend<T>` adapter for `wax-core` sinks).
- `os-build` — Layer 1; `BuildGlue<B>` trait and its memory/codegen supertraits; emits `OsOp`s onto a backend.
- `os-async` — Layer 3; async OS callback surface.

---

## 6. Documentation migration: source of truth, speet reference, vane aspirational

### 6.1 New source of truth

All canonical design docs and **agent context files** (the files that tell coding agents how this subsystem operates) move to `os-emulation/docs/` and `os-emulation/agents/`. `@speet/docs/os*.md`, `@speet/docs/future/*.md`, and `@speet/AGENTS.md` sections covering the OS emulation surface become **retired** — they either redirect to the new site or are deleted after one transition cycle.

### 6.2 `@speet` integration doc = reference

`os-emulation/docs/integrations/speet.md` will:

- List every SOEL crate that `@speet` consumes.
- Show the exact feature flags and re-export pattern.
- Document the reference test matrix (C corpuses, thin-runtime e2e, container phase-0).
- Be updated whenever `@speet` ships a new SOEL-backed feature.

This is the **reference implementation** document: it proves the abstraction works because `@speet` already uses it.

### 6.3 `@vane` integration doc = aspirational

`os-emulation/docs/integrations/vane.md` will be a **present-to-future** document that stays honest about what is implemented:

- It starts with vane's *current* supported surface: riscv64 interpreter + JS JIT (`vane-arch::Mem` legacy/shared/both modes, `CoreJS`, `Reactor`).
- It maps that surface onto SOEL: `Mem` implements `os-page::GuestMemory`, `CoreJS::data(addr)` implements `os-page-codegen::MemoryCodegen`, and interpreter dispatch is routed through a `VaneOS` impl of `OS::syscall`.
- It marks as `[CURRENT]` only the riscv64 + JS/interpreter refactor.
- It marks as `[ASPIRATIONAL]`:
  - `vane-target-wasm` consuming `os-abi-codegen` + `os-build`.
  - Non-riscv64 architectures.
  - A user-facing OS emulation layer (sitting closer to the application than the interpreter).
  - The `speet ↔ vane` host-JIT bridge.

We explicitly mark sections `[ASPIRATIONAL]` or `[CURRENT]` so readers do not confuse roadmap with shipped code.

### 6.4 Private OS handlers doc = future contract

`os-emulation/docs/integrations/private-os-handlers.md` is drafted early but remains aspirational until the vkernel/ptrace work begins. It defines the minimum surface a private kernel must implement to be a consumer:

- Implement `OS`, `Ctx`, `GuestMemory`.
- Consume `os-manifest` for process policy.
- Optionally implement `OsRuntime` lifecycle hooks.
- Provide a test fixture under `os-emulation/tests/fixtures/private_kernel/`.

The doc is kept in `docs/draft/` until the main integration phases are complete and full OS emulation is the next priority.

### 6.5 Versioning policy for docs

Use semantic doc-versioning tied to code milestones:

- `docs/stable/` — ratified, consumers may depend on it.
- `docs/draft/` — under review, aspirational.
- `docs/archive/` — old `@speet` docs kept for one release, then removed.

### 6.6 Agent context and operation docs migration

This plan treats agent-facing files (e.g., `AGENTS.md` and linked operation/context files) as first-class documentation, not afterthoughts. They are split and consolidated the same way as design docs.

**Move to `os-emulation`:**

- Generic OS-emulation agent context from `@speet/AGENTS.md` and any `@speet/agents/*.md` files covering `osctx`, `HostApi`, syscall dispatch, memory/paging, ABI stubs, or the thin runtime.
- The moved generic sections become the single source of truth under `os-emulation/agents/` (and `os-emulation/docs/` where they overlap with design docs).

**Stay in `@speet`:**

- Speet-specific agent context: recompiler internals, architecture frontends, module builders, `MegabinaryBuilder`, and the speet test corpus.
- `@speet/AGENTS.md` keeps these sections but links to `os-emulation/agents/` / `os-emulation/docs/` for anything generic. The generic sections are *removed* from `@speet` after one transition cycle (no duplicate sources of truth).

**Create in `@vane`:**

- New `vane/AGENTS.md` and `vane/agents/*.md` files describing vane's existing JS JIT, interpreter, and `Mem`.
- These files link to `os-emulation` for generic concepts (`GuestMemory`, `MemoryCodegen`, `OS::syscall`) and only document vane-specific wiring (`CoreJS` string emission, `Reactor` dispatch).

**Cross-repo rule:** any agent prompt about a generic OS concept must reference the `os-emulation` file, not the `@speet` or `@vane` copy. This applies to both human docs and future agent-driven edits.

---

## 7. Phased execution plan

### Phase 0 — Bootstrap the repo and move the invariant crates (Weeks 1–3)

Goal: create `os-emulation` with the least-disruptive subset, establish CI, and keep `@speet` green.

1. Create `/Users/g/Code-local/portal-hot/os-emulation/` (new Git repo).
2. Copy and rename the invariant crates that have no `@speet`-specific linkage dependencies:
   - `osctx` → `crates/runtime/os-ctx`
   - `speet-host-api` → `crates/runtime/os-host-api`
   - **Defer** `speet-syscall` and `speet-linux-wasi` from Phase 0; they depend on `@speet`-internal crates (`speet-riscv`, `speet-link-core`, `speet-module-target`) and will move once `os-target-core` and the compile-time emitters (Phase 2) give them a neutral surface.
3. Genericize imports, comments, and error strings but **do not** change trait shapes yet.
4. Add a top-level `Cargo.toml` workspace.
5. Set up CI: `no_std` build, `std` build, `wasm32-unknown-unknown` build for the moved core crates.
6. In `@speet`, turn the original crate directories into compatibility shims that re-export from `os-emulation`.
7. Verify `@speet` tests still pass.

**Deliverable:** `@speet` builds and tests against `portal-co/os-emulation` for `os-ctx` and `os-host-api`; the syscall/WASI crates stay in `@speet` for now.

### Phase 1 — Move ABI infrastructure, compiler glue traits, and core docs (Weeks 4–6)

1. Move and rename ABI crates:
   - `speet-abi-spec` / `codegen` / `stubs` → `os-abi-*`
   - This required reversing the `speet-plugin-api` dependency: `CallingConvention` now lives in `os-abi-spec`; `speet-plugin-api` depends on `os-abi-spec` instead of `speet-abi-stubs` depending on `speet-plugin-api`.
2. Introduce `os-build` crate with the `BuildGlue<B>` trait set, generic over `os-target-core::Backend` and asking recompiler-level questions: jump to address, guest memory access, and state layout.
3. **Basic wiring done:** Updated `speet-module-builder`/`MegabinaryBuilder` to implement `BuildGlue<B>` generically. The implementation is intentionally shape-correct: every method emits the corresponding `OsOp` stack operations, with no backend-specific handles returned. The full target-aware emission (real page-table walks, backend-specific dispatcher shapes, `WaxBackend`) remains follow-up work as the backend matrix matures.
4. **Deferred:** Move canonical docs:
   - `container-plan.md`, `thin-runtime-plan.md`, `osctx.md`, `speet-linux-wasi.md`
   - `future/*.md`
   - `goals/os.md`
   - `./wasm-blitz/docs/abi.md` and `second-context-register.md` referenced for the backend contract; do not move, but link from `docs/integrations/wasm-blitz.md`
5. **Deferred:** Move generic agent context files from `@speet` to `os-emulation/agents/` and link back from `@speet/AGENTS.md` (see §6.6).
6. In `@speet`, keep the original crate directories as thin compatibility shims that re-export from `os-emulation`, with `Cargo.toml` updated to depend on the moved crates.
7. **Deferred:** Write `docs/integrations/speet.md` as a **reference** doc and `docs/integrations/vane.md` as an aspirational-but-grounded skeleton (riscv64 JS/interpreter as `[CURRENT]` target, everything else `[ASPIRATIONAL]`).
8. **Deferred:** Add initial `@vane` agent files that point to `os-emulation` for generic concepts.

**Deliverable (achieved):** `os-emulation` owns the ABI data model, redirect-stub registry, code generator, and the compiler-glue trait contract; `@speet` still builds with shim re-exports. The concrete `MegabinaryBuilder` `BuildGlue` implementation, doc moves, and agent-file moves remain follow-up work.

### Phase 2 — Memory/paging unification: runtime + compile-time (Weeks 7–13)

This is the deepest integration with `@vane` and requires splitting every memory concept into runtime and compile-time forms.

1. **Extracted `os-target-core`** (Phase 1 carried forward):
   - Speet-neutral `OsOp` stack-machine IR and `Backend` trait are in place.
   - `WaxBackend<T: InstructionSink>`, JS, `StackOp`, future LLVM, and future `wasm-blitz` direct native backends remain scaffolding; they will land once the `os-emulation` → `@vane` wiring begins.
   - `os-syscall-emit` and `os-linux-wasi` now render through the `OsOp`/`Backend` contract; `os-abi-codegen` and `os-page-codegen` are next.
2. **Created `os-page`:**
   - `MemorySpec` moved from `os-build` and is now the shared runtime/compile-time page description.
   - Runtime `PageTable` and `GuestMemory` traits added (with the compile-time `GuestMemory<B>` remaining in `os-build`).
   - Concrete runtime backends (`LegacyOnDemand`, `SharedPageTable`, `LinearHost`) are stubbed in `os-page/src/backends.rs` and filled in as `@vane`/`@speet` adopt them.
3. **Created `os-page-codegen`:**
   - Scaffolding helpers for JS `data(addr)` and `WaxBackend` memory-access emission.
   - Full architecture-specific page-walk generators and `@vane` JS JIT integration are deferred to Phase 3.
4. **Created `os-syscall-emit` and `os-linux-wasi`:**
   - Moved the generic `SyscallTable`/`SyscallEntry`/`ParamSource`/`SavePair`/`MemoryStore` data model from `speet-syscall` into `os-syscall-emit`.
   - Moved RV64 Linux → WASI preview1 table building into `os-linux-wasi`.
   - `@speet`'s `speet-syscall` and `speet-linux-wasi` are now thin compatibility shims that re-export `os-syscall-emit`/`os-linux-wasi` and add the backend-specific rendering (`WasmSyscallDispatcher`) / index-space hooks (`WasiImportsExt`).
5. **Refactor `vane-arch` on its *supported* surface** — deferred to Phase 3:
   - Replace hardcoded JIT `data()` string emitter with `os-page-codegen` JS backend.
   - Use `os-page` runtime traits for interpreter memory.
   - Add a `VaneOS` impl of `OS::syscall`.
6. **Refactor `speet-memory`** — deferred to Phase 3/4:
   - Remove hardcoded compile-time paging assumption.
   - Depend on `os-page` / `os-page-codegen` / `os-target-core`.
   - Keep `speet-memory` as a compatibility re-export for one phase.
7. **Add page-fault handling** to `OS::syscall`/`osfuncall` via `GuestFault` — deferred to vkernel/vane integration.

**Deliverable (achieved):** `os-emulation` owns the generic memory data model, syscall/WASI data model, and compile-time codegen scaffolding. `@speet` is fully wired through `os-syscall-emit`/`os-linux-wasi`. `@vane` integration and concrete backend renderers remain the focus of Phase 3.

### Phase 3 — Consumer integration on supported surfaces (Weeks 14–20)

Before expanding the feature set, harden the shared layer against the two main consumers on what they already support.

1. **In `@speet`:**
   - Validate the thin runtime (`speet-runtime`, `speet-recompile`, `speet-rt`) against the moved `os-host-api` and `os-abi-codegen` crates.
   - Validate `speet-linux-wasi` end-to-end against `os-linux-wasi`.
   - Run the full existing test corpus; this is the reference integration.
2. **In `@vane` (riscv64 + JS JIT + interpreter):**
   - `vane-arch::Mem` delegates to `os-page` runtime traits from Phase 2.
   - Refactor `vane-target-core` to depend on `os-target-core` and share the `OsOp` IR.
   - Refactor `vane-target-js` / `CoreJS` so its `data(addr)` string generator implements `os-page-codegen::MemoryCodegen`.
   - Refactor JS host-call stubs so they implement `os-abi-codegen` redirect recipes.
   - Introduce `os-async` and wire `AsyncStackHost`, `async_mem`, and `await $.ecall()` through `AsyncOS` / `AsyncCtx` surfaces (vane is the first consumer).
   - `vane` interpreter dispatch uses `OS::syscall` / `Ctx` via a `VaneOS` impl (potentially a thin stub at first).
3. **In `@speet` / `wasm-blitz`:**
   - Keep WASM as the reference `TargetFormat`.
   - Add a `wasm-blitz`-native renderer behind a feature gate in `os-page-codegen` / `os-abi-codegen` that emits `OsOp` recipes as native NaiveAbi helper functions (initially only ASM helpers such as `__wasm_memory_grow`, not full megabinary recompilation).
   - Document the `__wasm_exn_propagate` gap and require any future speculative-call work to be gated until the OS layer can emit the backend-specific runtime shim.

4. **Docs and agent context:**
   - Finalize `docs/integrations/speet.md` as `[CURRENT]`.
   - Move the riscv64 + JS/interpreter sections of `docs/integrations/vane.md` from `[ASPIRATIONAL]` to `[CURRENT]`.
   - Verify `@speet/AGENTS.md` and `@vane/AGENTS.md` only document repo-specific wiring and link to `os-emulation/agents/` for generic OS emulation context.
4. **Cross-repo gating:** run the `@speet` and `@vane` test suites against the same `os-emulation` commit; fix any trait drift.

**Deliverable:** `@speet` and `@vane`'s supported surfaces are both wired to `os-emulation`; the same `MemorySpec`, `AbiSpec`, and `HostApi` contracts drive both compilers.

### Phase 4 — Stabilization without a 1.0 tag (Weeks 21–24)

1. Remove deprecated aliases in `@speet` once all internal consumers migrate.
2. Archive `portal-hot/os-repo-1`. It is a separate, pre-modern legacy project with different OS-area goals and is unrelated to the current emulation work; archive it to avoid confusion and free the namespace.
3. Publish source-of-truth docs for the integrated surface under `docs/stable/`.
4. Write a retrospective in `docs/RETRO.md`.
5. **Do not tag `os-emulation` v1.0.0 yet.** Because `@speet` and `@vane` will continue to evolve in lockstep with `os-emulation` — and future expansion phases (vkernel, ptrace, `parachute`) may require trait changes — keep the surface pre-1.0 with clear SemVer minors. A v1.0.0 tag is deferred until the expansion phases are complete and the trait surface is proven stable across multiple consumers.

**Deliverable:** `os-emulation` is the stable, speet-neutral source of truth for the currently supported OS surface; `@speet` and `@vane` consume it. The v1.0 milestone is intentionally deferred.

---

## 7.1 Future work: expansion phases (not in v1.0 timeline)

These use the shared foundation built in Phases 0–4. They are aspirational and intentionally sequenced *after* integration is solid.

### Future Phase A — Vkernel / fully emulated OS execution

1. Implement `os-vkernel`:
   - `VkernelCtx` implementing `Ctx`.
   - `VkernelOS` implementing `OS` with Linux syscall dispatch.
   - Hash-based execve router using a future `os-manifest`.
2. Compile vkernel runtime **into the megabinary alongside user code**:
   - `os-page` runtime page-table code is emitted as guest functions.
   - `os-vkernel` syscall dispatch and policy checks are emitted as guest functions.
   - `os-host-api` runtime surface is emitted as the boundary to the host vkernel process.
3. Wire `os-linux-wasi` and `os-vkernel` behind a backend selector:
   - `TargetBackend::Wasi` — WASI preview1 imports.
   - `TargetBackend::Vkernel` — vkernel syscall channel, with runtime code in the megabinary.
   - `TargetBackend::HostNative` — thin runtime.
4. Extend `os-host-api` with `VkernelApi` backend (the `OsctxHostApi` bridge mentioned in thin-runtime goals).
5. Add container phase-0 harness in `os-emulation/tests/vkernel-phase0/`: build `ls`/`cat`/`echo` megabinary, link vkernel runtime code, and validate hash dispatch + syscall whitelisting.

**Deliverable:** Phase-0 megabinary runs end-to-end inside `os-vkernel`; vkernel runtime is compilable glue, not a separate host-only implementation.

### Future Phase B — Ptrace, policy, and private kernel contract

1. Implement `osctx-ptrace` with `PtraceLayer`.
2. Integrate `PtraceLayer` into:
   - `os-vkernel` for dynamic syscall enforcement.
   - `os-host-api` `FilteredHostApi` for thin runtime dynamic filtering.
3. Implement `os-manifest` and `os-plugin`.
4. Finalize `docs/integrations/private-os-handlers.md` with a reference minimal kernel.

**Deliverable:** A private-kernel consumer can implement `OS` and run the phase-0 megabinary with only `os-emulation` crates.

### Future Phase C — Vane expansion, `wasm-blitz` refactor, and host-JIT bridge

1. Implement `vane-target-wasm` as a consumer of `os-abi-codegen` and `os-build`.
2. Extend `MemoryCodegen` / `SyscallCodegen` / `BuildGlue` to any new vane architectures.
3. Prototype the `@speet` frontend → `os-abi-codegen` → `@vane` WASM JIT emitter host-JIT bridge.
4. Once `portal-co/wasm-blitz` finishes its refactor, add a `WasmBlitzDirect` `Backend` for direct native targets (x86-64, AArch64, RISC-V 64, PPC64), including the required runtime shims (`__wasm_mem`, `__wasm_memory_grow`, `__wasm_exn_propagate`, SCR table setup). Also support `wasm-blitz` as a `WaxBackend<T>` sink for WASM-binary / wasm-blitz-WASM output if desired. Until then, `@speet` continues through the current `wax-core::InstructionSink` backend.
5. Prototype precompiled LLVM as a separate `Backend` for memory helpers and syscall trampolines.
6. Update `docs/integrations/vane.md` and `docs/integrations/wasm-blitz.md` as these capabilities move from `[ASPIRATIONAL]` to `[CURRENT]`.

### Future Phase D — Cross-process syscall handling (`parachute`)

1. Once `parachute` can have one process handle the syscalls of another, expose that as an `os-emulation` backend:
   - `ParachuteHostApi` or `ParachuteOS` implementing `OS` / `HostApi`.
   - Cross-process marshalling of `Ctx` state, syscall numbers, and memory references.
2. Reuse `os-manifest` / `PolicyEnforcer` so the same policy language gates both in-process thin runtime, vkernel, and `parachute`-mediated execution.
3. Update `docs/integrations/parachute.md` describing how the same `OS` trait surfaces syscalls either in-process, in-vkernel, or cross-process.

**Deliverable:** A process-level syscall handler can be swapped in as another OS backend without changing `@speet` or `@vane` code.

---

## 8. Backwards compatibility and migration choreography

### 8.1 In `@speet`

We cannot break the active development workflow. Strategy:

- **Phase 0–3:** Dual-source. `@speet` keeps the original crate directories, but each becomes a *shim* that re-exports from `os-emulation`. Example:
  ```rust
  // speet/crates/os/speet-host-api/src/lib.rs
  pub use os_host_api::*;
  ```
- **Phase 4:** Remove shims and change direct workspace members to point at `os-emulation` paths (via workspace dependency or git).
- Keep `speet-host-api`, `osctx`, etc., as workspace dependencies in `@speet` until Phase 4, when they are deleted.

### 8.2 In `@vane`

Vane is smaller and can migrate aggressively once `os-page` lands, but only on its supported surface:

- Phase 2 (riscv64 only): replace `vane-arch::Mem` runtime with `os-page::LegacyOnDemand`; replace `CoreJS`'s hardcoded `data()` string generator with `os-page-codegen::MemoryCodegen` implementation; layer `vane-target-core` on `os-target-core`'s `OsOp` / `Backend` trait; add a `VaneOS` stub for interpreter syscall dispatch.
- Phase 3 (riscv64 only): adopt `os-host-api` redirect recipes for JS host-call stubs; implement `BuildGlue<JsBackend>` so the JS JIT can answer recompiler-level questions (jump to address, memory access, state layout); adopt `os-async` for `AsyncStackHost` / `async_mem` so the same async surface is available to future assembly paths.
- Future Phase C: adopt `os-abi-codegen` for `vane-target-wasm`; extend `MemoryCodegen` / `SyscallCodegen` support if non-riscv64 targets appear; implement `wasm-blitz` native and LLVM renderers for `OsOp` if pursued.

The JS JIT implementation remains the validated reference for codegen traits, but only for the riscv64 target it already supports. Because vane integration is partial at first, no backwards-compatibility shim is needed in vane until Phase 2.

### 8.3 Version alignment

- `os-emulation` uses SemVer for its crate surface.
- `@speet` pins to a `os-emulation` git branch or tag.
- `@vane` pins to the same branch/tag once it consumes SOEL.
- Breaking trait changes are co-ordinated across the three repos with a shared milestone branch.

---

## 9. Crate dependency map after migration

```text
External foundational dependencies (not duplicated inside `os-emulation`)
├── wax-core                 ← single source of truth in `portal-co/wax`; consumed by `os-linux-wasi`, `os-page-codegen`, `os-abi-codegen`, and `@speet` native backends

os-emulation
├── core
│   ├── os-ctx               ← no_std / std / WASM
│   ├── os-host-api          ← depends on os-ctx
│   ├── os-syscall-table     ← depends on os-ctx (shared data model)
│   ├── os-syscall-emit      ← depends on os-ctx, os-syscall-table (compile-time)
│   ├── os-page              ← no_std / std / WASM runtime traits
│   └── os-page-codegen      ← depends on os-page (compile-time emitters)
├── target
│   └── os-target-core       ← no_std shared operation IR + Backend trait (with WaxBackend<T> adapter for wax-core sinks)
├── abi
│   ├── os-abi-spec
│   ├── os-abi-codegen       ← depends on os-abi-spec, os-build, os-target-core
│   └── os-abi-stubs
├── build
│   └── os-build             ← BuildGlue<B> trait, generic over os-target-core::Backend; trait contract for compiler/builder glue
├── backends
│   ├── os-linux-wasi        ← depends on os-syscall-emit, os-target-core, os-build
│   └── os-vkernel           ← depends on os-ctx, os-manifest, os-page (std) — future work
└── runtime
    ├── os-manifest          — future work
    ├── os-runtime
    ├── os-async             ← async OS / Ctx / HostApi surface; depends on os-ctx
    ├── os-plugin            — future work
    └── osctx-ptrace         ← depends on os-ctx — future work

@speet (after migration)
├── helper/*                 (stays)
├── native/*                 (stays)
├── managed/*                (stays)
├── module/*                 (stays: module-target, builder, schedule, link-core)
│   └── MegabinaryBuilder implements os-build::BuildGlue<B> for each supported Backend B
├── os (compatibility shims until Phase 4)
│   ├── speet-host-api       → re-exports os-host-api
│   ├── speet-syscall        → re-exports os-syscall-emit
│   ├── speet-linux-wasi     → re-exports os-linux-wasi
│   ├── osctx                → re-exports os-ctx
│   └── ...
├── native backend targets (not moved; consumed via `os-target-core`)
│   ├── @wax/wax-core        → current native backend used by `@speet` recompile today
│   └── wasm-blitz           → future native backend after refactor (deferred tests)
├── runtime-integration
│   ├── speet-recompile      → depends on os-host-api, os-abi-codegen, os-build, os-target-core, @wax/wax-core
│   ├── speet-runtime        → depends on os-host-api, os-abi-stubs, os-build, speet-recompile
│   ├── speet-rt             → stays (C/assembly bootstrap)
│   └── speet-rtd            → depends on speet-runtime

@vane (after Phase 2/3)
├── vane-arch                → depends on os-page, os-page-codegen
│   └── Mem implements os-page::GuestMemory
├── vane-riscv               → stays
├── vane-target-core         → depends on os-target-core (shared `OsOp`)
├── vane-target-js           → depends on os-target-core, os-page-codegen, os-abi-codegen, os-async
│   └── CoreJS/data() generator implements os-page-codegen::MemoryCodegen
│   └── JS host-call stubs implement os-abi-codegen redirect recipes
├── vane-target-wasm         → depends on os-abi-codegen, os-build
└── vane                     → wires above, depends on os-page, os-host-api
```

---

## 10. Testing strategy

### 10.1 Tests that live in `os-emulation`

| Test category | Location |
|---|---|
| Unit tests for `OS`, `Ctx`, `GuestMemory` traits with mock impls | `crates/core/os-ctx/tests/` |
| Syscall table invariants (sortedness, param count match) | `crates/core/os-syscall-emit/tests/` |
| WASI import registration and ABI mapping | `crates/backends/os-linux-wasi/tests/` |
| Page-table invariants (legacy, shared, both modes) | `crates/core/os-page/tests/` |
| Memory codegen parity: same `MemorySpec` produces equivalent JS and WASM helpers | `crates/core/os-page-codegen/tests/` |
| Syscall codegen invariants (sortedness, param count match) | `crates/core/os-syscall-emit/tests/` |
| BuildGlue<B> mock implementation, including jump-to-address and state-layout answers for a test backend | `crates/build/os-build/tests/` |
| `os-target-core` roundtrips: render `OsOp` through every supported `Backend` (WaxBackend<MockSink>, JS, StackOp) | `crates/target/os-target-core/tests/` |
| `os-async` mock tests: async syscall dispatch in JS and synchronous fallback in WASM | `crates/runtime/os-async/tests/` |
| Native helper parity (unit-render only): `@wax/wax-core` and `wasm-blitz` NaiveAbi shims (`__wasm_memory_grow`, etc.) produce equivalent effects to WASM `memory.grow` | `crates/core/os-page-codegen/tests/native_helpers.rs` |

These initial tests cover only the supported integration surface. Future expansion tests are listed below.

### 10.1a Tests for future expansion phases

| Test category | Location | Phase |
|---|---|---|
| Manifest parser roundtrips | `crates/runtime/os-manifest/tests/` | Future Phase B |
| Vkernel phase-0 harness | `tests/vkernel-phase0/` | Future Phase A |
| Private kernel minimal fixture | `tests/fixtures/minimal_kernel/` | Future Phase B |
| Speculative-call `__wasm_exn_propagate` in direct native backends | `tests/wasm-blitz-exn/` | Future Phase C |
| Precompiled LLVM memory/syscall intrinsics | `crates/target/os-target-core/tests/llvm_backend.rs` | Future Phase C |
| `wasm-blitz` direct native `Backend` E2E (disabled until API stabilizes) | `tests/wasm-blitz-direct-e2e/` | Future Phase C |
| `wasm-blitz` WASM-via-`wax-core` E2E | `tests/wasm-blitz-wax-e2e/` | Future Phase C |
| Cross-process syscall handler (`parachute`) | `tests/parachute-bridge/` | Future Phase D |

### 10.2 Tests that stay in `@speet`

- Current `@speet` native backend E2E: corpus runs through the current `wax-core::InstructionSink` implementor.
- Architecture recompiler tests (corpuses).
- Thin-runtime E2E (`speet-runtime` tests).
- Guest runner equivalence tests.

`wasm-blitz` E2E tests are intentionally **not** in `@speet` today; they live in `portal-co/wasm-blitz` and are gated until its refactor stabilizes.

These become **consumer tests**: they verify that `@speet` still works when built against `os-emulation`.

### 10.3 Cross-repo gating CI

Create a GitHub Actions workflow in `portal-co/os-emulation` that:

1. Builds and tests `os-emulation`.
2. Checks out `@speet` into a sibling directory and runs `cargo test --workspace` with a path-override to `os-emulation`.
3. (After Phase 2) Checks out `@vane` and runs:
   - `cargo test` for runtime trait usage on supported riscv64 paths.
   - `wasm-pack test --headless --firefox` for the JS JIT and interpreter on supported riscv64 paths.
   - Validates that `vane-target-js` (riscv64) still passes after `os-page-codegen` changes.

This prevents accidental trait breakages in SOEL from breaking consumers without notice.

---

## 11. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Moving active crates breaks `@speet` development for weeks. | High | Use compatibility shims; migrate in phases; keep CI green. |
| `no_std` + `std` + WASM triple build is hard for complex crates. | Medium | Start with the simplest crates; add `#![no_std]` incrementally; gate std-only features. |
| `@vane` `Mem` semantics differ subtly from `speet-memory`. | Medium | Extract traits first, keep both concrete impls side-by-side, unify only after tests pass. |
| Private-kernel contract commits too early and needs breaking changes. | Medium | Keep `docs/integrations/private-os-handlers.md` in `docs/draft/` until Future Phase B; mark the crate surface as `0.x` until then. |
| Git submodules / path overrides confuse downstream users. | Low | Publish clear `docs/integrations/*.md`; use Cargo workspace dependencies, not submodules. |
| Diverging docs: speet docs and os-emulation docs become inconsistent. | Medium | Delete old docs from `@speet` after Phase 1 and redirect via README links. |
| Abstracting WASM-isms too early traps the design in WASM-only idioms. | High | Drive `os-target-core` from `vane-target-core::StackOp`, include `wasm-blitz` native and LLVM as first-class formats from the start, and keep `TargetFormat` exhaustive but feature-gated. |
| Async support adds overhead to synchronous backends. | Medium | Provide sync and async trait variants; sync backends never pay for async machinery. |
| `wasm-blitz` refactor breaks the `Backend` contract before `@speet` switches. | Low | Keep current `wax-core::InstructionSink` backend as the stable path; route future `wasm-blitz` direct native through a separate `Backend` impl with its own milestone branch. Unit-render tests in `os-emulation` stay decoupled from `wasm-blitz` runtime. |
| `wax-core` traits accidentally re-exported from `os-emulation`. | Medium | Review all `os-target-core`/`os-page-codegen`/`os-abi-codegen` public APIs; only accept `InstructionSink` implementors by generic bounds, never re-export the trait definition. |
| `wasm-blitz` ABI gaps (e.g., `__wasm_exn_propagate`) block speculative calls in `os-emulation` consumers. | Low | Document the gap, render `__wasm_exn_propagate` stubs per backend in future phases, and gate speculative-call tests until implemented. |

---

## 12. Immediate next steps (this week)

0. **Bootstrap the `os-emulation` repo and patch it in locally.** (Done: repo created and all current crates are patched in.)
   - Create the repo at `/Users/g/Code-local/portal-hot/os-emulation` as a separate Git repo (target `https://github.com/portal-co/os-emulation.git` in the future). ✅
   - Add a `[patch.'https://github.com/portal-co/os-emulation.git']` section to `/Users/g/Code-local/portal-hot/.cargo/config.toml` so each `os-emulation` crate is resolved from the local path, not from Git, until ready to push:

     ```toml
     [patch.'https://github.com/portal-co/os-emulation.git']
     os-ctx          = { path = "os-emulation/crates/runtime/os-ctx" }
     os-host-api     = { path = "os-emulation/crates/runtime/os-host-api" }
     os-target-core  = { path = "os-emulation/crates/target/os-target-core" }
     os-build        = { path = "os-emulation/crates/build/os-build" }
     os-abi-spec     = { path = "os-emulation/crates/abi/os-abi-spec" }
     os-abi-stubs    = { path = "os-emulation/crates/abi/os-abi-stubs" }
     os-abi-codegen  = { path = "os-emulation/crates/abi/os-abi-codegen" }
     os-page         = { path = "os-emulation/crates/page/os-page" }
     os-page-codegen = { path = "os-emulation/crates/page/os-page-codegen" }
     os-syscall-emit = { path = "os-emulation/crates/emit/os-syscall-emit" }
     os-linux-wasi   = { path = "os-emulation/crates/emit/os-linux-wasi" }
     # os-async        = { path = "os-emulation/crates/runtime/os-async" }  # Phase 3
     # os-redirect-stubs = { path = "os-emulation/crates/abi/os-redirect-stubs" }  # Future expansion
     ```

   - From `@speet`, reference the new crates via path or `https://github.com/portal-co/os-emulation.git`; Cargo resolves them through the local `[patch]` entries.
   - All implementation commits start with `[AI]`.

1. **Create the repo** under `/Users/g/Code-local/portal-hot/os-emulation` as a new Git repo, seed it with a top-level `README.md` referencing this plan, and make the first commit `[AI] initialize os-emulation repo`.
2. **Open a tracking issue** in `@speet` titled "Migrate OS crates to os-emulation" and reference this plan.
3. **Land Phase 0** by moving `osctx` and `speet-host-api` to `os-emulation` and turning the original `@speet` directories into compatibility shim re-exports. Defer `speet-syscall` and `speet-linux-wasi` until Phase 2 provides the neutral target/codegen surface.
4. **Set up CI** in `os-emulation` for `cargo check --workspace` on `no_std`, `std`, and `wasm32-unknown-unknown`.
5. **Verify `@speet`** builds and its tests pass with the shim re-exports in place. Do not delete the original crate directories until Phase 4.
6. **Audit `@speet/AGENTS.md`** and any `@speet/agents/*.md` files for generic OS emulation context; prepare the move list for Phase 1.
7. **Review `vane-target-core::StackOp` / `CoreOpcode`** with `@vane` to decide whether `os-target-core` duplicates the same shapes or re-exports them.
8. **Write a one-page async contract** (`docs/async-contract.md`) describing when `OS`/`Ctx`/`HostApi` use sync vs async traits, so `@vane`'s existing `AsyncStackHost` pattern is not accidentally narrowed to JS.
8a. **Write a one-page `BuildGlue<B>` contract** (`docs/build-glue-contract.md`) defining the recompiler-level questions (jump-to-address, memory-access, state-layout) and how `@speet` / `@vane` answer them for each backend.
9. **Inventory `./wasm-blitz` ABI hooks** (`__wasm_mem`, `__wasm_memory_grow`, `__wasm_exn_propagate`, SCR) so Phase 2 codegen knows what native helpers the OS layer must render.
10. **Audit `@speet`'s `InstructionSink` usage** and confirm how sharding, SCR, and probes are surfaced; ensure `WaxBackend<T>` can propagate those hints without owning the traits.
11. **Create a `wasm-blitz-direct` milestone branch** in `portal-co/os-emulation` for the future native `Backend` impl so it does not block Phase 0–3.
12. **Confirm the `wax-core` dependency boundary:** `os-emulation` depends on `portal-co/wax` as a git path dependency and does not copy or re-export `wax-core` crates or traits.

---

## 13. Appendices

### Appendix A: Glossary

- **SOEL:** Shared OS Emulation Layer (this repo).
- **Thin runtime:** Native-to-native recompilation via `speet-recompile` + `wasm-blitz` host JIT.
- **Container megabinary:** Single WASM module produced build-time from a whole container image.
- **Vkernel:** Host-side virtual kernel providing a Linux syscall surface to WASM instances.
- **OS-to-OS conversion:** The thin-runtime path that translates a guest OS ABI into the host OS ABI at link/load time.
- **Fully emulated OS execution:** Running guest code inside a virtualized kernel, dispatching syscalls through `OS`/`Ctx` traits.

### Appendix B: Files to delete or redirect in `@speet/docs`

After Phase 1, remove or replace with a one-line pointer:

```text
speet/docs/container-plan.md          → redirect to os-emulation/docs/runtime/container-plan.md
speet/docs/thin-runtime-plan.md      → redirect to os-emulation/docs/runtime/thin-runtime-plan.md
speet/docs/osctx.md                  → redirect to os-emulation/docs/runtime/osctx.md
speet/docs/speet-linux-wasi.md      → redirect to os-emulation/docs/backends/linux-wasi.md
speet/docs/future/*.md               → redirect to os-emulation/docs/future/*.md
speet/goals/os.md                    → redirect to os-emulation/docs/goals/os.md
```

### Appendix C: Private OS handler minimum checklist

A third-party kernel is SOEL-compatible if it can:

1. Provide a `struct MyCtx` implementing `os_ctx::Ctx`.
2. Provide a `struct MyOS` implementing `os_ctx::OS`.
3. Load an `os_manifest::Manifest` and enforce `Policy`.
4. Use `os_page::GuestMemory` for guest RAM.
5. Run the `tests/fixtures/minimal_kernel` fixture to completion.

---

*End of plan.*
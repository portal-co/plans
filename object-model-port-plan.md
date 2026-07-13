# Port Speet `ObjectModel` to `os-emulation` and use it as a Jade JIT bytecode backend

## 1. Abstract

Speet currently owns a small but capable `ObjectModel` trait in
`crates/managed/speet-object`. It abstracts how managed objects and arrays are
laid out in WASM (linear memory vs WASMGC, allocation, field/array access, type
checks), but it has three limitations today:

1. It lives inside the `@speet` repository, so it cannot be shared by `@jade`,
   `@jsaw`, or other runtimes.
2. It is hard-wired to `wax_core::InstructionSink` and therefore to WASM output;
   it cannot target JS source, native assembly, or future backends without
   copying code.
3. Speet's own DEX recompiler only uses `NoObjectModel`, so object-memory code
   paths are effectively untested in production.

This plan moves the object model into `os-emulation` under a new
`os-object-model` crate, generalizes it to a *superset* of JVM/DEX, ECMAScript,
.NET, and WASMGC object models, and uses it in `@jade`'s JS JIT as a second
bytecode backend so that Jade can run without depending on a host JS engine's
object semantics.

## 2. Supported features: the actual unification target

The first deliverables focus on restoring object-memory intercomposability for
Speet and giving Jade a portable managed heap.

| Consumer | Current object/memory surface | What the port enables |
|---|---|---|
| `@speet` / DEX | `speet-object::ObjectModel` wired to `NoObjectModel` | A real `LinearMemoryRenderer`, reusable by all Speet managed runtimes. |
| `@jade` JS JIT | Emits JS source that leans entirely on the host JS engine for objects/arrays | A second bytecode backend that emits portable object-model operations backed by an explicit heap (still JS source initially, then WASM/native). |
| `portal-co/wasm-blitz` (future) | N/A | Native renderers for the object model after the wasm-blitz refactor stabilizes. |
| `@jsaw` | N/A (deferred) | Use the same object model for SWC/JS transpilation once core crates mature. |
| **Aspirational** JVM / DEX / ECMAScript / .NET / WASMGC | Each has its own layout / GC story | `ObjectModelFlavor` abstraction so the same descriptions can describe, and eventually target, all of them. |

## 3. Repository placement

The new code lives in `os-emulation` so speet, jade, jsaw, and any future
consumers can depend on it through the same Git + path-patch workflow already
used for `os-ctx`, `os-page`, etc.

```text
Local:  /Users/g/Code-local/portal-hot/os-emulation/crates/object/os-object-model
Remote: https://github.com/portal-co/os-emulation
```

The existing `speet/crates/managed/speet-object` becomes a compatibility shim
(`pub use os_object_model::*;`) so Speet's existing imports keep compiling.

## 4. New crate design

### 4.1 `os-object-model`

A `no_std + alloc` core crate.

#### Core data model

```text
ObjectModelFlavor
├── LinearMemory    // i32 reference into linear memory, SHA3-32 header
├── WasmGc          // externref / structref / arrayref
├── JavaHeap        // JVM/DEX compressed reference, monitor word
├── DotNetObject    // object header + method-table pointer
└── EcmaScript      // property map + hidden-class shape
```

- `TypeHash` — opaque 32-byte runtime type tag. Keep the existing SHA3-256 of a
  fully-qualified class name for linear-memory; other flavors may treat it as a
  stable class ID and derive their own internal IDs.
- `PrimitiveType` — boolean/byte/char/short/int/long/float/double discriminants.
- `FieldValType` — extended to cover the scalar shapes common to all target
  models:
  - `I8/U8`, `I16/U16`, `I32`, `I64`, `F32`, `F64`, `Ref` — existing.
  - Add `AnyRef`, `FunctionRef`, and `StringRef` as ECMAScript / WASMGC-aware
    variants where linear models collapse them to `Ref`.
- `Layout` — per-flavor description of header size, hash offset, array-dim
  offset, array-length offset, element alignment, reference width, etc.
- `ClassLayout` — maps field names / slot indices to byte offsets and
  `FieldValType`s for a given `ObjectModelFlavor`.

#### Unified `ObjectRenderer` trait

The current `ObjectModel<C, E>` trait is replaced by a single, monolithic
`ObjectRenderer<B: Backend>` trait that contains the methods of **all** source
object models: JVM/DEX, ECMAScript, .NET, and WASMGC. Each concrete renderer
targets one concrete layout / heap representation (linear memory, WASMGC,
JS heap, etc.) and implements every method by either using a native target
operation or by emulating the source-model semantics on top of its own layout.

Because all the source models are GC/managed, emulation is feasible but
nontrivial: a linear-memory renderer, for example, can implement ECMAScript
property access on top of its own object headers and a property map, while a
WASMGC renderer can allocate a JVM-like object by building a WASMGC struct with
extra slots for the class hash and monitor.

```rust
pub trait ObjectRenderer<B: Backend> {
    // JVM / DEX
    fn emit_jvm_new(&mut self, backend: &mut B, class_hash: &TypeHash);
    fn emit_jvm_iget(&mut self, backend: &mut B, class_hash: &TypeHash, field: &str);
    fn emit_jvm_iput(&mut self, backend: &mut B, class_hash: &TypeHash, field: &str);
    fn emit_jvm_new_array(&mut self, backend: &mut B, elem: FieldValType);
    fn emit_jvm_aget(&mut self, backend: &mut B, elem: FieldValType);
    fn emit_jvm_aput(&mut self, backend: &mut B, elem: FieldValType);
    fn emit_jvm_array_length(&mut self, backend: &mut B);
    fn emit_jvm_instanceof(&mut self, backend: &mut B, class_hash: &TypeHash);
    fn emit_jvm_check_cast(&mut self, backend: &mut B, class_hash: &TypeHash);

    // ECMAScript
    fn emit_ecma_new_object(&mut self, backend: &mut B, n_pairs: u32);
    fn emit_ecma_get_property(&mut self, backend: &mut B);
    fn emit_ecma_set_property(&mut self, backend: &mut B);
    fn emit_ecma_new_array(&mut self, backend: &mut B);

    // .NET
    fn emit_dotnet_new_object(&mut self, backend: &mut B, mt_hash: &TypeHash);
    fn emit_dotnet_ldelem(&mut self, backend: &mut B, elem: FieldValType);
    fn emit_dotnet_stelem(&mut self, backend: &mut B, elem: FieldValType);

    // WASMGC
    fn emit_wasmgc_struct_new(&mut self, backend: &mut B, type_hash: &TypeHash);
    fn emit_wasmgc_struct_get(&mut self, backend: &mut B, type_hash: &TypeHash, field: u32);
    fn emit_wasmgc_struct_set(&mut self, backend: &mut B, type_hash: &TypeHash, field: u32);
    fn emit_wasmgc_array_new(&mut self, backend: &mut B, type_hash: &TypeHash);
    fn emit_wasmgc_array_get(&mut self, backend: &mut B, type_hash: &TypeHash);
    fn emit_wasmgc_array_set(&mut self, backend: &mut B, type_hash: &TypeHash);
    fn emit_wasmgc_ref_test(&mut self, backend: &mut B, type_hash: &TypeHash);
    fn emit_wasmgc_ref_cast(&mut self, backend: &mut B, type_hash: &TypeHash);
}
```

`backend` is any `os_target_core::Backend`, so the same renderer logic can
emit `OsOp` for WASM (`WaxBackend`), JS source (`JsBackend`), x86-64 text
(`X86_64SysVBackend`), or Vane `StackOp` (`StackOpBackend`).

If a consumer still wants to emit directly into `InstructionSink`, a small
`InstructionSinkBackend<'s, S, C, E>` wrapper can implement `Backend` by
translating `OsOp` into `wasm_encoder::Instruction`s (the semantics already
exist in `os-target-wax`).

#### Backend capability subtraits

The baseline `os-target_core::Backend` only accepts `OsOp`. Higher-level
renderers need to know whether the backend supports WASM locals, JS string
literals, or native registers. See `plans/backend-capability-subtraits-plan.md`
for the full design. The object-model renderers implement the unified
`ObjectRenderer<B: Backend>` trait for concrete `B` that implement the relevant
subtrait:

```rust
impl<B: WasmBackend> ObjectRenderer<B> for WasmLinearRenderer { ... }
impl<B: JsBackend> ObjectRenderer<B> for JadeJsRenderer { ... }
impl<B: WasmGcBackend> ObjectRenderer<B> for WasmGcRenderer { ... }
impl<B: NativeBackend> ObjectRenderer<B> for NativeObjectRenderer { ... }
```

### 4.2 Provided renderers

Each renderer is a module or subcrate under `os-object-model`:

- `wasm_linear` — equivalent to today's `LinearMemoryObjects`.
  - Target: `WaxBackend<InstructionSink>` or `InstructionSinkBackend`.
  - Runtime imports: `alloc_object`, `alloc_array`, `throw_class_cast`.
- `wasm_gc` — full WASMGC renderer (native for its own operations, emulates JVM/ECMAScript/.NET where needed).
- `jade_js` — JS-source renderer backed by an explicit typed-array heap (native for ECMAScript objects/arrays, emulates JVM/.NET/WASMGC on top).
- `ecma_shape` — shared ECMAScript hidden-class / property-map helpers for shape analysis.

### 4.3 Runtime helper contract

`os-object-model` defines allocator / GC / type-check helper signatures but
does *not* implement a GC. Each renderer emits calls to runtime functions; the
runtime is supplied by the consumer.

| Helper | Linear-memory signature |
|---|---|
| `alloc_object` | `(h0 i64, h1 i64, h2 i64, h3 i64, data_bytes i32) -> i32` |
| `alloc_array` | `(len i32, h0 i64, h1 i64, h2 i64, h3 i64, dim i32, elem_bytes i32) -> i32` |
| `throw_class_cast` | `() -> (unreachable)` |

For Jade's JS backend the runtime helpers are JS functions (`jadeOs.newObject`,
`jadeOs.newArray`, `jadeOs.classCast`, `jadeOs.instanceof`) living in a small
JS shim that does not require the full JS engine.

## 5. Speet integration

1. Move `speet-object` source into `os-emulation/crates/object/os-object-model`.
2. Introduce the `ObjectModelFlavor` / `Layout` / unified renderer split while
   keeping the existing linear-memory semantics intact.
3. Turn `speet/crates/managed/speet-object` into a shim.
4. Switch `speet-dex` to default to a real `WasmLinearRenderer` behind a feature
   flag instead of `NoObjectModel`.
5. Keep `NoObjectModel` available for DEX files that are statically known not
   to use managed objects.

## 6. Jade integration

### 6.1 Why this helps Jade

Jade's Tier-0 JIT currently emits JS source that assumes a host JS engine for
`Object`, `Array`, property get/set, string interning, and prototype chains.
That is fine when Jade itself runs inside a JS engine, but it prevents Jade from
running as a standalone WASM module with its own heap or from being compiled
down to native code later.

Using the shared object model, Jade gains a second backend that:

- Represents Jade objects and arrays with explicit layout and type hashes.
- Emits calls to a tiny runtime (`jadeOs.*`) instead of relying on JS engine
  semantics.
- Can therefore run in a pure WASM host or, with a native renderer in the
  future, as native code.

### 6.2 Bytecode operations to map

Jade bytecode ops to lower through the object model:

| Jade op | Object-model operation(s) |
|---|---|
| `Arr(items, dest)` | `emit_ecma_new_array`, then `emit_ecma_get_property`/`emit_jvm_aget`-style store per item (renderer chooses). |
| `Str(items, dest)` | `emit_ecma_new_array` with `StringRef` items, or a runtime string constructor if the renderer specializes strings. |
| `Litobj { pairs, key, ... }` | `emit_ecma_new_object(n_pairs)`, then `emit_ecma_set_property` per pair. |
| `Get { obj, key, dest }` | `emit_ecma_get_property`; the renderer turns this into a native target operation (linear-memory property-map lookup, WASMGC struct get, or real JS property access). |
| `Set { obj, key, val, dest }` | `emit_ecma_set_property`; renderer lowers to the target store. |

### 6.3 Crate changes

Add a `jade-vm-jit-obj` crate (or a module inside `jade-vm-jit`) that provides:

```rust
pub struct ObjectModelJit {
    flavor: ObjectModelFlavor,
    // function registry, async/generator flags, etc.
}

impl ObjectModelJit {
    pub fn emit_program<R: FnRegistry>(
        &mut self,
        code: &[u8],
        registry: &mut R,
    ) -> Result<String, String>;
}
```

Implementation strategy:

1. **Phase A (JS source)** — render through `jade_js::JsObjectRenderer`, still
   producing a JS program, but one that only relies on typed arrays and the
   `jadeOs` helper set, not on host `Object`/`Array`. The renderer is native for
   ECMAScript operations and emulates JVM/DEX/.NET/WASMGC methods when future
   consumers use them.
2. **Phase B (WASM)** — render through `wasm_linear::WasmLinearRenderer`,
   producing a WASM module. Jade can then run as a pure WASM guest.
3. **Phase C (native)** — deferred until `wasm-blitz` direct native is ready.

### 6.4 Compatibility with Tier 2

`jade-vm-jit-swc` (Tier 2) continues to exist as a higher-tier JS optimizer.
The object-model backend is an *alternative* bytecode backend, not a
replacement. Both backends can coexist behind feature flags and runtime
selection.

## 7. Generalization to JVM / DEX / ECMAScript / .NET / WASMGC

The `ObjectModelFlavor` enum is the generalization hook. For each flavor we add:

- A `Layout` with flavor-specific header sizes, reference widths, alignment.
- A `ClassLayout` builder that knows how fields are ordered (packed, aligned,
  with inherited fields, with hidden-class transitions, with method-table
  pointer, etc.).
- A renderer if we intend to emit code for that flavor.

Initial scope is intentionally tight:

| Flavor | Phase 0 | Later |
|---|---|---|
| LinearMemory | ✅ full renderer + runtime contract | stable |
| JavaHeap | layout / class-building only | renderer once JVM/DEX is revived in Speet |
| DotNetObject | layout / class-building only | renderer once .NET managed runtime work begins |
| EcmaScript | layout + hidden-class description | renderer for Jade/JSaw |
| WasmGc | layout description + future renderer | full renderer after WASMGC support lands |

The key design rule: `os-object-model` owns *descriptions* and *renderer
contracts*; concrete GCs / runtimes live in consumer repositories.

## 8. Crate dependency map after migration

```text
os-emulation
└── crates/object/os-object-model
    ├── os-target-core         ← OsOp / Backend
    ├── os-page                ← optional: linear-memory heap can sit in guest memory
    ├── os-target-wax          ← when rendering to wax-core sinks
    └── os-page-codegen        ← when rendering to JS backends

@speet
├── crates/managed/speet-object   → compatibility shim re-exporting os-object-model
├── crates/managed/speet-dex      → uses LinearMemoryRenderer
├── crates/plugin/speet-plugin-api → PluginTypeHash/PluginFieldValType become aliases to os-object-model types
└── crates/plugin/speet-plugin-adapter → converts to os-object-model renderers

@jade
├── crates/jade-vm-jit            → adds ObjectModelJit alternative backend
└── crates/jade-vm-jit-obj        → (new) Jade-specific lowering of bytecode ops to object-model renderers

@jsaw (deferred)
└── TBD — consume os-object-model layout / ECMAScript flavor once core crates settle.
```

## 9. Testing strategy

### 9.1 Tests in `os-emulation`

| Test | Location |
|---|---|
| TypeHash roundrips and primitive sentinels | `crates/object/os-object-model/tests/hash.rs` |
| Layout invariants across flavors | `crates/object/os-object-model/tests/layout.rs` |
| `LinearMemory` renderer output matches old `speet-object` unit tests and correctly emulates ECMAScript/WASMGC/.NET operations | `crates/object/os-object-model/tests/wasm_linear.rs` |
| `JadeJs` renderer emits correct `jadeOs.newArray` / `jadeOs.setProp` calls and exercises JVM/DEX/WASMGC emulation paths | `crates/object/os-object-model/tests/jade_js.rs` |
| Render to `Vec<OsOp>` and to `Vec<StackOp>` via existing backends | `crates/object/os-object-model/tests/cross_backend.rs` |

### 9.2 Tests in `@speet`

- `cargo test -p speet-dex` with `LinearMemoryRenderer` enabled for a small
  object-allocating DEX fixture.
- Recompile E2E corpus unchanged to ensure the shim does not break anything.

### 9.3 Tests in `@jade`

- Baseline: `jade-vm-jit` JS output for a program with arrays and objects.
- Object-model backend: same bytecode compiled with `ObjectModelJit` runs
  through a minimal JS harness that provides `jadeOs.*` helpers and produces
  the same observable values.
- Byte-for-byte checks are *not* required; behavioral equivalence is.

## 10. Phase plan

### Phase 0 — Bootstrap `os-object-model` (1 week)

1. Create `os-emulation/crates/object/os-object-model`.
2. Move `TypeHash`, `PrimitiveType`, `FieldValType`, `ObjectModel`,
   `NoObjectModel`, `LinearMemoryObjects` into it unchanged.
3. Convert `speet-object` into a compatibility shim.
4. Update `.cargo/config.toml` `[patch.'https://github.com/portal-co/os-emulation.git']`
   with `os-object-model = { path = "os-emulation/crates/object/os-object-model" }`.
5. Verify `cargo check --all` in both `os-emulation` and `speet`.

### Phase 1 — Generalize the trait (1–2 weeks)

1. Introduce `ObjectModelFlavor`, `Layout`, and `ClassLayout`.
2. Split `ObjectModel` into description + `ObjectRenderer<B: Backend>`.
3. Add `WasmBackend`, `JsBackend`, `NativeBackend`, `WasmGcBackend` capability
   subtraits to `os-target-core` (see `backend-capability-subtraits-plan.md`).
4. Port `LinearMemoryObjects` to `LinearMemoryRenderer<B: WasmBackend>`.
5. Keep an `InstructionSinkBackend` adapter so Speet can continue to use the old
   `wax_core::InstructionSink` path without rewriting callers.
6. Rename `FieldValType` / add `AnyRef` / `StringRef` / `FunctionRef`.

### Phase 2 — Renderers (2 weeks)

1. `wasm_linear` renderer (restores old semantics).
2. `wasm_gc` layout description + stub renderer.
3. `jade_js` renderer that emits pure JS object/array helper calls.
4. Add `os-object-model` unit tests for each renderer.

### Phase 3 — Jade integration (2–3 weeks)

1. Add `os-object-model`, `os-target-core`, and `os-page-codegen` deps to
   `jade-vm-jit` / new `jade-vm-jit-obj` crate.
2. Implement `ObjectModelJit::emit_program` for the JS-source path.
3. Map `Arr`/`Str`/`Litobj`/`Get`/`Set` to renderer calls.
4. Write a minimal `jadeOs` JS runtime harness.
5. Add behavioral equivalence tests between default JS backend and
   object-model JS backend.

### Phase 4 — Speet DEX object-memory re-enable (1–2 weeks)

1. Plumb `LinearMemoryRenderer` through `speet-dex`, gated by a feature flag.
2. Provide object-allocating runtime helper implementations for Speet tests.
3. Re-enable a small DEX object test.

### Phase 5 — Broader flavors and WASM backend (future)

1. WASMGC renderer.
2. JVM/DEX/.NET layout builders.
3. JSaw ECMAScript flavor renderer (deferred).
4. Native object-model helpers for post-refactor `wasm-blitz`.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Generalizing too early bloats the trait | Keep each flavor as a separate `Layout`/`Renderer`; only common operations go in the core trait. |
| Breaking Speet's existing `NoObjectModel` path | Keep `NoObjectModel` renderer as the default; real object model is feature-gated. |
| Jade JS backend still needs *some* host objects | The `jadeOs` helpers can be polyfilled with typed arrays and plain JS functions, so no engine-level `Object`/`Array` reliance is required. |
| Runtime GC undefined | Scope object model to allocation + layout; GC remains a consumer-supplied runtime contract, documented but not implemented in `os-emulation`. |

## 12. Immediate next steps

1. Create `os-emulation/crates/object/os-object-model` and seed it with the
   moved `speet-object` code.
2. Convert `speet-object` to a compatibility shim.
3. Add `os-object-model` to the root `.cargo/config.toml` patch block.
4. Open a tracking issue in `@speet` titled "Move object model to os-emulation".
5. Commit with prefix `[AI]`.
# Backend capability subtraits for `os-target-core`

## 1. Problem

`os-target-core::Backend` is currently a single method:

```rust
pub trait Backend {
    fn op(&mut self, op: OsOp);
    fn finish(&mut self) {}
}
```

This is enough for pure stack-machine operations, but real consumers need to
know what a backend can actually do. A WASM backend can declare locals, imports,
memories and globals; a JS backend can splice string literals and call JS
functions; a native backend can manipulate machine registers; a future wasm-blitz
direct backend can emit arbitrary machine instructions. Code that builds on
the object model or on OS glue needs to ask for these capabilities without
breaking the simple backends that only implement `Backend`.

## 2. Goal

Introduce a family of capability subtraits under `os-target-core` (and, where
appropriate, in format-specific helper crates). Each subtrait extends
`Backend` with a coherent set of extra operations. A concrete backend opts in
by implementing the subtraits it can support. Higher-level code then bounds
generics on the smallest subtrait it actually needs.

The object-model port plan depends on this: its unified `ObjectRenderer<B>`
trait keeps a single `Backend` bound, but the concrete renderers (`wasm_linear`,
`jade_js`, `wasm_gc`) are implemented for `B` equal to the relevant subtrait
(`WasmBackend`, `JsBackend`, `WasmGcBackend`).

## 3. Proposed subtrait hierarchy

```text
Backend                        (baseline — OsOp only)
│
├── WasmBackend : Backend      (WASM structure: locals, types, imports, exports)
│   └── WasmGcBackend : WasmBackend   (WASMGC structs, arrays, refs)
│
├── JsBackend : Backend        (JS source helpers: string literals, JS calls, await)
│
├── NativeBackend : Backend    (machine-level primitives: registers, native call, ret)
│   └── WasmBlitzDirectBackend : NativeBackend   (future wasm-blitz direct native layer)
│
└── JadeByteBackend : Backend  (future: emit Jade VM bytecodes directly)
```

Subtraits are **not** mutually exclusive. A backend may implement both
`WasmBackend` and `JsBackend` if it targets a JS+WASM hybrid output.

## 4. Per-subtrait operations

### 4.1 `Backend`

```rust
pub trait Backend {
    fn op(&mut self, op: OsOp);
    fn finish(&mut self) {}
}
```

### 4.2 `WasmBackend`

```rust
pub trait WasmBackend: Backend {
    fn memory_index(&self) -> u32;
    fn memory64(&self) -> bool;

    fn declare_local(&mut self, ty: ValType) -> u32;
    fn local_get(&mut self, idx: u32);
    fn local_set(&mut self, idx: u32);
    fn local_tee(&mut self, idx: u32);

    fn import_function(&mut self, module: &str, name: &str, ty: FuncType) -> u32;
    fn call(&mut self, func_idx: u32);
    fn call_indirect(&mut self, type_idx: u32, table_idx: u32);

    fn emit_i32_const(&mut self, v: i32);
    fn emit_i64_const(&mut self, v: i64);
    // floats kept as already-present OsOp/i32/i64 bit-pattern conventions
}
```

The existing `os-target-wax::WaxBackend` will implement this; so will any
future raw `wasm-encoder` backend.

### 4.3 `WasmGcBackend : WasmBackend`

```rust
pub trait WasmGcBackend: WasmBackend {
    fn ref_null(&mut self, ty: HeapType);
    fn ref_is_null(&mut self);
    fn ref_test(&mut self, ty: HeapType);
    fn ref_cast(&mut self, ty: HeapType);
    fn struct_new(&mut self, type_idx: u32);
    fn struct_get(&mut self, type_idx: u32, field: u32);
    fn struct_set(&mut self, type_idx: u32, field: u32);
    fn array_new(&mut self, type_idx: u32);
    fn array_get(&mut self, type_idx: u32);
    fn array_set(&mut self, type_idx: u32);
    fn array_len(&mut self);
}
```

Used by the WASMGC renderer in `os-object-model`.

### 4.4 `JsBackend : Backend`

```rust
pub trait JsBackend: Backend {
    /// Push a JS string literal as a value on the object-model value stack.
    fn push_js_string(&mut self, s: &str);

    /// Call a run-time JS helper by name with `n` arguments popped from the stack.
    fn call_js(&mut self, helper: &str, n_args: u32);

    /// Emit `await <expr>` where `<expr>` is the top-of-stack expression.
    fn await_top(&mut self);

    /// Access a property of an object expression at the given stack depth.
    fn get_js_prop(&mut self, obj_depth: u32, prop: &str);
}
```

The existing `os-page-codegen::JsBackend` becomes an implementor; a future
`jade-vm-jit-obj` backend can as well.

### 4.5 `NativeBackend : Backend`

```rust
pub trait NativeBackend: Backend {
    /// Architecture-agnostic register width.
    type Reg;

    fn stack_push(&mut self, reg: Self::Reg);
    fn stack_pop(&mut self, reg: Self::Reg);
    fn stack_top(&self) -> Self::Reg; // scratch

    fn load_const(&mut self, reg: Self::Reg, val: u64);
    fn move_reg(&mut self, dst: Self::Reg, src: Self::Reg);

    fn load_memory(&mut self, dst: Self::Reg, addr_reg: Self::Reg, width: MemWidth, signed: bool);
    fn store_memory(&mut self, src: Self::Reg, addr_reg: Self::Reg, width: MemWidth);

    fn call_native(&mut self, symbol: &str);
    fn jump_native(&mut self, reg_or_symbol: NativeTarget<Self::Reg>);
    fn ret(&mut self);
    fn trap(&mut self);
}
```

Used by `os-target-native`. Each concrete arch backend (`X86_64SysVBackend`,
`AArch64SysVBackend`, `Riscv64Backend`) implements `NativeBackend` over its
own `WriterCore` (see the separate asm-arch genericization plan).

### 4.6 `WasmBlitzDirectBackend : NativeBackend` (future)

Reserved for the post-refactor wasm-blitz native path. It adds wasm-blitz
specific concepts such as probe tables, sharding, SCR, NaiveAbi vs SysVAbi
selection, and the `__wasm_exn_propagate` helper gap.

### 4.7 `JadeByteBackend : Backend` (future)

Reserved for emitting Jade VM bytecode directly from the object model rather
than JS or WASM. Methods would mirror the Jade `Operation` enum: `emit_lit`,
`emit_arr`, `emit_get`, `emit_set`, etc.

## 5. Composability with `ObjectRenderer`

The unified object-model trait stays generic:

```rust
pub trait ObjectRenderer<B: Backend> {
    fn emit_jvm_new(&mut self, backend: &mut B, class_hash: &TypeHash);
    // ... all source-model methods ...
}
```

Every method has a default implementation that emits `OsOp::Trap`. Concrete
renderers are then implemented for the smallest subtrait they need:

```rust
impl<B: WasmBackend> ObjectRenderer<B> for WasmLinearRenderer { ... }
impl<B: JsBackend> ObjectRenderer<B> for JadeJsRenderer { ... }
impl<B: WasmGcBackend> ObjectRenderer<B> for WasmGcRenderer { ... }
```

This keeps the public surface a single trait while letting each renderer take
advantage of backend-specific features.

## 6. Optionality / introspection

Not every backend needs every subtrait. At compile time a consumer with
`B: Backend` can require `B: WasmBackend` if it needs WASM structure. For
mixed pipelines, an optional downcast pattern is also possible:

```rust
pub trait Backend {
    fn as_wasm(&mut self) -> Option<&mut dyn WasmBackend> { None }
    fn as_js(&mut self) -> Option<&mut dyn JsBackend> { None }
    fn as_native(&mut self) -> Option<&mut dyn NativeBackend<Reg = ()>> { None }
}
```

The default returns `None`; concrete backends override when appropriate. This
lets generic dispatch code adapt to the backend it was actually given.

## 7. Crate placement

Keep the subtraits in `os-target-core` so every backend crate (native, wax,
page-codegen) can depend on one central definition. Concrete implementations
live in their respective crates:

| Subtrait | Implementor crate |
|---|---|
| `WasmBackend` | `os-target-wax` |
| `WasmGcBackend` | `os-target-wax` (feature-gated) or a future `os-target-wasmgc` |
| `JsBackend` | `os-page-codegen` |
| `NativeBackend` | `os-target-native` |
| `WasmBlitzDirectBackend` | future `os-target-wasm-blitz` |
| `JadeByteBackend` | future `jade-vm-jit-obj` |

## 8. Migration steps

1. Add `WasmBackend`, `JsBackend`, and `NativeBackend` to `os-target-core`.
2. Refactor `os-target-wax` to implement `WasmBackend`.
3. Refactor `os-page-codegen::JsBackend` to implement `JsBackend` (it already
   has the functionality; it just needs the trait impl).
4. Refactor `os-target-native::X86_64SysVBackend` to implement `NativeBackend`
   (see separate asm-arch genericization plan).
5. Update the object-model design doc to reference these subtraits as the
   capability contract for renderers.

## 9. Testing

| Test | Location |
|---|---|
| `WaxBackend` implements `WasmBackend` | `os-target-wax/tests/capability.rs` |
| `JsBackend` implements `JsBackend` | `os-page-codegen/tests/capability.rs` |
| `X86_64SysVBackend` implements `NativeBackend` | `os-target-native/tests/capability.rs` |
| A `Vec<OsOp>` backend ignores subtrait methods | `os-target-core/tests/subtrait.rs` |
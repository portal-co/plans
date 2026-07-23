# Lazy transformation plans and demand-driven execution

**Status:** proposed cross-repository design  
**Scope:** `dreamcomp`, `volar`, `grabb`, `speet`, `wasm-blitz`, `moond`, `wax`, `waffle-`, and the explicitly inventoried related plan/execution sites below.  
**Primary outcome:** compiling a requested artifact performs only the planning, source transformation, and execution needed for that artifact's reachable dependency closure—not a whole-program/system pass merely because the existing representation happens to be whole-program.

## 1. Problem

Several Portal projects have the same useful but currently eager shape:

1. inspect/transformation code builds a data structure describing later work;
2. a second phase consumes that structure to emit or execute the work.

The structure has different names—`MonoPlan`, `AdaptiveSplitPlan`, `FuncSchedule`, `ProbePlan`, `PltCallPlan`, a decoded `InstrStream`, or an implicit work queue—but the cost boundary is usually wrong.  Planning or source lowering is often performed for every function, block, instruction, or binary before the consumer knows which outputs it will request.

The desired model is:

- consumers request named artifacts/results, not an entire compilation;
- source-to-plan transformation is itself lazy;
- assembling the required plan is deterministic breadth-first discovery from those requests;
- only the transitive closure of **declared necessary elements** is assembled;
- an assembled element's result is computed only when a consumer reads it;
- caches and errors are keyed by stable input/configuration identity; and
- the common substrate is usable in `no_std` environments.

“Lazy” must not mean “silently omit semantically relevant work.”  A result may be deferred only after its dependencies are known to be irrelevant to the requested output.  Global analyses remain global when their semantics require a whole supplied unit; the unit itself must still be chosen by demand rather than defaulting to the repository/system.

## 2. Goals and non-goals

### Goals

1. Provide one small, `no_std` contract for discovery, demand, result state, deterministic BFS assembly, invalidation, diagnostics, and a project-owned `Context` passed to both discovery and resolution.
2. Let project-specific transforms expose a plan fragment without forcing full source lowering or final code generation.
3. Support recursively discovered dependencies, including dependencies revealed by a lazily transformed source item.
4. Separate **assemble** (discover the needed graph) from **resolve** (compute a result), so inspecting a plan never accidentally compiles every node.
5. Preserve current eager entry points as compatibility wrappers until each migration has parity evidence.
6. Make root set, requested artifact kind, configuration, source revision, and dependency chain observable for cache/debugging.
7. For WASM routes, compile only requested root functions and their conservatively reachable function closure, composing each body transformation as a lazy `wax::InstructionSource` wrapper until Waffle IR or target assembly is actually requested.

### Non-goals

- A universal IR, universal artifact serialization format, executor runtime, or cross-project workspace.
- Replacing project-specific scheduling, ABI/index allocation, provenance, cryptographic validation, or type checking.
- Automatically making inherently global optimizations local.  For example, a cross-block dedup pass may still need every block in a selected reachable function.
- Sharing `std`, async runtimes, `HashMap`, filesystem access, or project IR types through the common crate.
- Changing cryptographic semantics or Volar’s pinnedness/stability policy as part of the infrastructure migration.

## 3. Inventory and classification

This inventory is deliberately source-based (not a name-only search).  It identifies both direct plan→execute pairs and existing demand-driven hooks that should become adapters rather than be replaced.

| Project | Existing structure and consumer | Classification / migration priority |
|---|---|---|
| `dreamcomp` | `ModuleConverter::conv` cache-demand-lowers `MItem`s into `FastModule`; `dreamcompiler-lower::to_fast_ir::wasm::WaffleFuncConverter` converts Waffle WASM bodies/blocks; `dreamcompiler-cps-conv::to_cps::drive` is already a `VecDeque` worklist over `AstCursor` positions. | **Foundation adapter, including the WASM frontend.** The `AstCursor` contract already explicitly permits a cursor that mints Fast-IR-shaped positions from a source AST lazily. Give `MItem::WasmFunc` the same demand-driven frontend boundary; do not introduce a second graph walker or eagerly convert all Waffle bodies. |
| `volar` | `volar-lir-codegen::mono::plan_flat_module` BFS-discovers `MonoPlan` instances, then `lower_planned_module` lowers all planned instances. The `pipeline-wasm` route currently calls `portal_pc_waffle_frontend::from_wasm_bytes` and lowers the resulting module. | **First direct plan migration, including the WASM frontend.** It already has roots, stable instance keys, a queue, and a plan/execute split; replace whole-module WASM frontend/lowering with a demand-indexed function frontend. |
| `volar` | `plan_adaptive_split` produces `AdaptiveSplitPlan`, consumed by `virtualize_ir_adaptive`; `volar-vaffle-target::LowerCtx::plan_functions` reserves layouts before emission; the FHE direct LUT path creates `AffineNegacyclicPlan` then emits it. | **Scoped adapters.** Preserve their required selected-unit/global analysis boundaries; make selected functions/roots lazy before attempting finer granularity. |
| `grabb` | Current public functions directly transform individual SWC nodes (`generate_hook`, `merge_target`, `wrap_in_class`, etc.). No plan object or plan executor exists. | **Consumer-only / no forced abstraction.** Add an adapter only when a caller needs a multi-node transform graph; do not make simple AST helper calls indirect. |
| `speet` | `FuncSchedule::push` registers count + closure, then `execute` emits in declaration order; `PltCallPlan::from_targets` resolves redirects and `to_hook_table` realizes hooks. | **Direct plan migration, with intentional feed granularity.** The feed remains one output function per guest word/possible instruction, but initially records only a per-function instruction sketch. A resolved function may contain substantial code; it need not be split into one tiny function per operation. Preserve the two-phase, final-index invariant while making registered binary units demand-discovered and their instruction content lazily fetched. |
| `wasm-blitz` | `ProbePlan::control_flow_sites` scans a body and backend code fetches `plan.at(op_index, placement)` while compiling. Its backends also compile WASM bodies. | **Lazy WASM-function compiler plus probe adapter.** Start from requested exported/entry functions, assemble every conservatively reachable function, and compile no other body. Represent body transforms as lazy `wax::InstructionSource` wrappers that resolve to Waffle IR or target assembly; keep probe discovery streaming/on-demand without changing emission semantics. |
| `moond` | `decode_stream` already does BFS from entry/indirect roots to an `InstrStream` used by the C backend. In contrast, the WASM `DirectBackend` API requires feeding all `4096 × 2` address/EXTEND pairs before `finish`. | **Highest compilation-cost win, with intentional feed granularity.** Keep one output function per AGC word/possible instruction state, but have feeding first create a sketch of the instruction states belonging to each function. Fetch/lower those states only when that function is resolved; functions may still contain substantial generated code. Promote reachable `(address, extend)` pairs to an explicit plan shared by C and WASM, with opt-in exhaustive and full-analysis compatibility modes. |
| `pixie` | `embedded-llm-tools-compiler::BatchPlan` and async `execute_plan` are a real dataflow plan/executor pair. | **Out of scope for compiler substrate.** It may adopt result-state ideas later, but async tool calls, external effects, and JSON protocol must not determine the compiler API. |
| `wax` | `wax-core::build::InstructionSource<Context, E>` and `InstructionSink<Context, E>` already provide the source/sink boundary for instruction transformations, with `Context` capabilities such as ambient-symbol lookup and execution-state observation, but sources are not yet keyed or scheduled by demanded function. | **Shared WASM lazy-body boundary.** Add lazy, snapshot-keyed, `Context`-generic transformation wrappers around `InstructionSource`; the scheduler remains in `portal-lazy-transform`, while Wax supplies the WASM-body composition and context-capability contract. |
| `waffle-` | Frontend, lowering, pass, and backend APIs operate on direct module/function IR and emission. Dreamcomp and Volar can use it as their WASM IR/assembly route. | **Required lazy-function adapter.** Accept demanded function bodies from Wax wrappers, materialize Waffle IR or assembly only for the requested reachable closure, and isolate/explicitly opt into any pass that truly requires a whole selected module. |
| `pit` | Reviewed transform/emission paths are direct lowering/emission APIs, not persistent plan-then-execute structures. | **No migration now.** Re-audit when it introduces a reusable deferred work graph. |

The inventory must be repeated before implementation starts in each repository, excluding `target/` and generated artifacts, and the document updated if an additional concrete plan/executor pair is found.

## 4. Common model

Use the following terms consistently.

- **Artifact key (`Artifact`)**: what a caller wants, such as a monomorphized function instance, a linked binary unit, an AGC entry point, or a transformed AST export.
- **Plan key (`Node`)**: stable identity of one unit of discoverable/realizable work. It includes its source identity, transform kind/version, configuration fingerprint, and relevant input revision—not a process-local arena index.
- **Demand**: an artifact key plus a requested result facet. A metadata-only request must not imply code emission.
- **Fragment**: a description of one node and its declared dependency demands. It may contain lightweight metadata, a per-function instruction sketch, and deferred result descriptors, but not a precomputed final result. A sketch maps the intentionally coarse output-function unit to its candidate source words/instruction states; it is not an instruction-by-instruction emitted-function plan.
- **Assembly**: BFS collection of fragments reachable from one or more demands. Assembly may lazily parse/index/lower enough source to discover a fragment; it must not run final emission merely to enumerate the graph.
- **Resolution**: execution of a particular result facet. Dependencies are resolved only when that facet needs them.
- **Snapshot**: immutable source/configuration identity attached to every node/result. A different snapshot never reuses an old result.

### Required invariants

1. **Identity is stable and ordered.** `Node` and `Artifact` must be `Clone + Ord`; a project must not use pointer addresses or mutable arena indices as persistent cache keys.
2. **Discovery is pure with respect to final output.** `describe(context, ...)` may query snapshot-bound, immutable context metadata, parse, index, and synthesize a plan fragment. It must not emit an artifact, mutate target or execution state, allocate final entity indices, or depend on prior execution order.
3. **BFS is deterministic.** Roots are normalized/sorted; each fragment’s dependencies are visited in declared order; deduplication happens before enqueue; tie breaking is by `Ord`. This gives reproducible plans and diagnostics.
4. **The closure is bounded.** `AssemblyLimits` bound nodes, edges, depth, source bytes, and optional project-specific specialization counts. Exceeding a bound returns a structured error, never an unbounded queue.
5. **Result resolution is idempotent per snapshot/facet.** A ready result is cached; a failed result is cached as the same failure until invalidated; duplicate demand does not duplicate execution.
6. **Cycles are explicit.** Assembly reports a dependency cycle with the root-to-cycle chain. A project may opt into a documented fixed-point node kind, but ordinary compilation nodes may not “break” a cycle by returning a partial artifact.
7. **Dependencies are facet-specific.** Metadata, type layout, emitted body, and linked artifact may have different edges. A request for one must not force the others.
8. **No hidden whole-system fallback.** Any API named `all`, `default`, or empty-roots must be explicit about whether it means all supplied units or only a project-defined default root set.

## 5. Shared `no_std` crate

Create a standalone repository under `https://github.com/portal-co`, tentatively **`portal-lazy-transform`**.  It is a protocol/scheduler crate, not a project workspace member.

### 5.1 Crate constraints

```rust
#![no_std]
extern crate alloc;
```

- Depend only on `core` and `alloc` in the base crate.
- Use `alloc::{collections::{BTreeMap, BTreeSet, VecDeque}, vec::Vec}`; do not require hashing or a global allocator beyond what the embedding target already supplies.
- Avoid `std::error::Error`, threads, filesystem/network access, Tokio, serde, and `anyhow` in the base API.
- Feature-gate optional adapters (`std`, tracing, serde, async driver) in separate crates or features that never leak into the core traits.
- Keep project IR and result types generic.  The shared crate must not depend on Dreamcomp, Volar, Speet, AGC, SWC, or WASM types.

### 5.2 Proposed core API

Names are illustrative; settle them in a small RFC/example crate before stabilizing.

```rust
pub trait PlanSource<Context> {
    type Node: Clone + Ord;
    type Artifact: Clone + Ord;
    type Facet: Clone + Ord;
    type Fragment;
    type Error;

    /// Query only snapshot-bound metadata from `context` and produce enough
    /// transformed/indexed source to describe `node`.
    fn describe(
        &mut self,
        context: &Context,
        node: &Self::Node,
        demand: &Demand<Self::Artifact, Self::Facet>,
    ) -> Result<Fragment<Self::Node, Self::Artifact, Self::Facet, Self::Fragment>, Self::Error>;

    /// Compute a requested facet after declared dependencies resolve. `context`
    /// may provide mutable execution state; the concrete result stays project-owned.
    fn resolve(
        &mut self,
        context: &mut Context,
        node: &Self::Node,
        facet: &Self::Facet,
        inputs: &mut dyn ResolvedInputs<Self::Node, Self::Facet>,
    ) -> Result<(), Self::Error>;
}

pub struct Demand<A, F> { pub artifact: A, pub facet: F }
pub struct Fragment<N, A, F, Meta> {
    pub node: N,
    pub metadata: Meta,
    pub dependencies: Vec<Demand<A, F>>,
}
```

The exact `resolve` result transport should be deliberately type-erased only at the shared boundary (for example a project-owned `ResultSlot`/callback). Do **not** force all projects to clone artifacts into `Box<dyn Any>`; `no_std` has no useful universal `Any`-based artifact store. Typed façade crates may wrap the core scheduler.

The base crate also provides:

- `assemble_bfs(context, roots, limits)` returning `AssembledPlan<Node, Fragment>` with parent/depth/edge provenance;
- a `DemandExecutor` state table keyed by `(Node, Facet, Snapshot)` with `Unseen`, `Resolving`, `Ready`, and `Failed` states;
- `ResultRef<N, F>` / typed project façade handles whose `get(&mut context)`/`resolve(&mut context)` triggers exactly one required resolution;
- cycle, limit, missing-root, undeclared-dependency, re-entrant-resolution, and stale-snapshot diagnostics; and
- a `PlanObserver` trait for counts and trace events. The no-op observer is zero-cost/no-`std`.

### 5.3 Assembly algorithm

For normalized root demands:

1. map each artifact/facet to its root node using a project adapter;
2. insert unseen root nodes in a `VecDeque` in normalized order;
3. pop one node, call `describe(context, ...)` once for the current snapshot, and store its fragment;
4. validate that fragment identity matches the requested node and validate declared dependencies;
5. append each dependency edge in its declared order; enqueue an unseen target after recording its first parent/depth;
6. continue until the queue is empty or a limit/error occurs.

This is **breadth-first assembly**, not breadth-first execution.  It visits every element necessary to know the requested closure, but it does not resolve a node’s emitted result.  Discovery may add a fragment only through `describe`; it may not mutate already assembled dependencies after the fragment is frozen. If a transform can reveal additional dependencies only after semantic analysis, that analysis belongs in its node’s `describe` facet, or the node must declare a conservative dependency rule. Hidden post-execution edges are forbidden because they invalidate the closure guarantee.

### 5.4 Lazy transformed code

Each project supplies a source adapter with two distinct layers:

```text
raw source / existing IR + Context
  └─ describe(&context, node, demand) → lightweight transformed fragment + edges
       └─ resolve(&mut context, node, facet) → target-specific transformed/emitted result
```

`describe` may query snapshot-bound context metadata and cache a parsed function, an SSA block index, a monomorphization substitution, or an instruction decode. It must retain enough provenance to later resolve the same node without reinterpreting a different source revision. It must not materialize an entire `FastModule`, `IrModule`, megabinary, AST, or WASM module body set solely because one child was requested.

### 5.5 WASM lazy-body composition through Wax and Waffle

`wax-core::build::InstructionSource<Context, E>` is the body-level boundary, not the graph scheduler. For every WASM function node, the project adapter holds an immutable, snapshot-keyed source and composes each transformation as a lazy wrapper parameterized by the same `Context` and `E`:

```text
function key + source snapshot + transform-output metadata snapshot
  └─ InstructionSource<Context, E>
       └─ LazyTransform<Context, E, Source> wrapper(s)
            └─ on demanded body facet: Waffle IR lowering or target assembly sink
```

Define a project-owned `WasmTransformContext` capability surface (implemented by the concrete Wax `Context` and passed to both `PlanSource::describe` and `PlanSource::resolve`), rather than closing over module state in a transform. It must expose: immutable WASM module/output metadata needed by a transform (types, functions/imports, exports, tables/elements, memories, data, index/layout policy, and selected-closure identity); a per-function source provider; ambient-symbol lookup through Wax's `AmbientInfo` capability; and any existing execution/constant-state capabilities needed while emitting (such as `ConstPeek`). The context may be a composite of separate metadata and execution-state objects, but lazy wrappers retain `Context` as their type parameter all the way to the final sink.

The module/source provider is an interface, not a requirement for raw WASM bytes or a prebuilt Waffle module. It may be backed by a lazily indexed binary frontend or by synthetic metadata and function sources. This lets Speet place its synthetic module metadata, imports, tables, functions, and source-provider implementation in its one compilation/link `Context`, then pass that context through Wax and Waffle to Volar's WASM frontend. Volar therefore consumes the same `WasmTransformContext` during `describe` rather than requiring Speet to serialize/build an actual WASM module first.

Constructing or describing a wrapper records transform identity/options and the metadata snapshot identity, but must not iterate or emit its wrapped `InstructionSource`, query mutable execution state, or perform an ambient resolution with output-dependent side effects. Only resolution of that function's IR/assembly facet receives `&mut Context` and invokes the wrapper chain. There, a wrapper may query ambient capabilities, inspect transform-output/module metadata, observe execution state, produce Waffle IR, write assembly directly, or adapt to another `InstructionSource`; it may not materialize sibling function bodies or a whole module as a side effect. Ambient references remain symbolic/label-based unless the selected target ABI explicitly requires a resolved value.

WASM frontends are also lazy adapters, not eager preprocessing. They may scan/index the module headers, type/import/function/export/element/table metadata, and code-section offsets needed to map roots and describe edges, but must not parse/lower every code body. They create the snapshot-keyed `InstructionSource` only when a requested/reachable function body is resolved. In particular, no lazy route may hide a whole-module `from_wasm_bytes`/equivalent conversion behind its first root request.

The descriptor phase must still establish the conservative call closure before body resolution: direct `call`/`ref.func` edges, required imports, and declared table/indirect target sets are dependencies. Unknown dynamic calls follow the same policy as other unknown indirect edges—conservative caller-supplied targets, an explicit selected-module/full mode, or a diagnostic—never silent omission. Type, table, element, memory, data, export, and index declarations needed to validate/link the selected closure may be assembled eagerly as immutable transform-output metadata, but body compilation remains per-function lazy. A metadata revision that changes a wrapper's possible output/edges is part of its node snapshot; transient mutable execution state is not reused as a ready-result cache key unless the adapter gives it an explicit stable revision.

A Waffle pass that semantically needs all functions in a selected module is not implicitly run by a body wrapper. It must expose an explicit selected-module analysis facet whose bounded root/module scope is visible in the plan; otherwise it is refactored into per-function lazy wrappers.

A lazy transformation may expose child nodes while describing its parent. For example, a direct generic call exposes a callee `FunctionInstanceKey`; a WASM call/reference exposes a reachable function key; an AGC conditional exposes its reached instruction-state successors; a Speet binary unit exposes its required imports/entities. This is the recursive bridge between lazy source transformation and BFS assembly.

### 5.6 Execution semantics

- `ResultRef::get(&mut context)` requests one `(node, facet)`.
- The executor recursively requests only its declared facet dependencies, then invokes `resolve(&mut context, ...)`. `describe` receives `&context` during assembly.
- Re-entrant `get()` of an in-progress non-fixed-point key is a cycle error, not a deadlock.
- A caller can inspect `AssembledPlan` without resolving any result.
- Dropping a result handle never invalidates a ready result; explicit snapshot invalidation does.
- Cancellation is cooperative: no partially ready result becomes cacheable. A project may retain discovery caches separately from execution results.

## 6. Repository migration plan

### Phase 0 — contract and reference tests

1. Create `portal-co/portal-lazy-transform` with the core API and a `no_std + alloc` CI build.
2. Add a tiny mock compiler in its tests: roots discover a diamond graph, one branch is never requested as an execution facet, source fragments are counted, and snapshot-bound metadata is supplied through `Context`.
3. Prove deterministic BFS order, one `describe(&context, ...)` per node/snapshot, no eager `resolve`, duplicate-demand deduplication, cycle chains, error memoization, invalidation, and the rule that `describe` cannot mutate execution state.
4. Include a synthetic-WASM-context fixture whose metadata and per-function source provider produce the same closure/result shape as a byte-backed fixture, without constructing a WASM module.
5. Publish no stable API until at least Dreamcomp and one independent plan/executor pair use a prototype revision.

### Phase 1 — Dreamcomp: make the existing seam real

**Relevant code:** `dreamcompiler-lower/src/to_fast_ir.rs`, `to_fast_ir/wasm.rs`, `dreamcompiler-cps-conv/src/to_cps.rs`, `to_cps/{fast_drive,native_dispatch_drive}.rs`.

1. Define Dreamcomp node identities for module item/path, function entry, CPS source position, requested backend artifact, transform registry/configuration, and source/provenance snapshot.
2. Adapt `ModuleConverter::conv` as a `PlanSource<Context>::describe` implementation. Its current cache-on-demand behavior is retained, but cache entries become fragment metadata rather than proof that all `FastModule` members are ready.
3. Implement the documented future lazy `AstCursor`: it mints and stores Fast-IR-shaped positions from demanded JS/WASM/plugin source rather than indexing a fully built `FastModule`.
4. Keep `to_cps::drive` as the CPS-specific worklist. It already separates source access through `AstCursor`, uses a `VecDeque`, and deduplicates by `(FuncId, Src)` because continuation replay makes bare-source dedup incorrect. The shared assembler must not erase that continuation identity or alter `ReturnSite`/`RetPolicy` semantics.
5. Introduce a lazy entry point beside existing `fast_func_to_cps*`/native-dispatch entry points. Existing APIs assemble/resolve eagerly by requesting their legacy complete facet.
6. Migrate Dreamcomp's WASM frontend itself: index `MItem::WasmFunc` identities and required Waffle module metadata without converting all bodies; make `WaffleFuncConverter` obtain/convert only the demanded function and demanded reachable blocks. Expose every requested CPS/WASM function as a snapshot-keyed `wax::InstructionSource` wrapper chain and resolve it through `waffle-` only after its body facet is demanded. Describe direct/reference/indirect WASM call edges before resolution, so the plan contains the requested function and all conservatively reachable functions but no unrelated body.
7. Carry source provenance and plugin/isolate state into fragment identity. Do not cache across isolate stacks, plugin sets, handler registry versions, or provenance-store snapshots.

**Acceptance:** requesting one exported function does not lower unrelated module items or unrelated reachable exports; Dreamcomp's WASM frontend neither converts unrelated `MItem::WasmFunc` bodies nor instantiates their `WaffleFuncConverter`; Dreamcomp WASM compilation materializes Waffle IR/assembly only for requested/reachable function bodies; a direct and a lazy path produce equivalent CPS and WASM for existing e2e fixtures; recursive continuation tests retain `UnboundedInlining` behavior rather than hanging.

### Phase 2 — Volar: monomorphization first

**Relevant code:** `volar-lir-codegen/src/mono.rs` and `lib.rs`.

1. Make `FunctionInstanceKey` plus canonical `MonoEnv`, source revision, and lowering options the node identity. Do not use emitted/mangled name as identity.
2. Convert `plan_flat_module` into an adapter that starts from requested `MonoRoot`s and emits a fragment containing the direct local calls discovered from that instance. Its existing `VecDeque` traversal establishes the intended BFS behavior.
3. Make `lower_planned_module` resolve only demanded instances. Split registration into demand-aware registries: type/tuple/enum layouts required by the selected instance and its signature/body are dependencies; the current full-module registry setup must not force lowering/emission of every function.
4. Migrate Volar's `pipeline-wasm` frontend: replace the eager `portal_pc_waffle_frontend::from_wasm_bytes` followed by whole-module lowering with a snapshot-keyed WASM module index plus demand-indexed function sources. Obtain that index/source provider from `WasmTransformContext` during `describe`, so it may be byte-backed or synthetic; Volar must not require a serialized/actual WASM module. A byte-backed index may read only the metadata needed for exports, signatures, imports, tables/elements, and code-body offsets; neither form may produce Waffle/Vaffle bodies for every function.
5. Route Volar WASM bodies for demanded monomorphized instances through snapshot-keyed lazy `wax::InstructionSource` transform wrappers and `waffle-`. The wrapper chain must lower/emit only the requested instance and its conservatively reachable instance/function closure; a Waffle whole-selected-module pass remains an explicit facet rather than an accidental consequence of one body request.
6. Preserve `max_instances` as an `AssemblyLimits`/project specialization bound and preserve explicit-type-argument diagnostics exactly.
7. Keep `lower_module`, `lower_module_with_opts`, and `lower_module_seeded` as compatibility wrappers that request their current root sets.

**Acceptance:** a generic root only discovers/lowers its reachable specializations; Volar's WASM frontend indexes but does not lower unrequested code bodies, and Volar WASM materializes Waffle/Vaffle IR or assembly only for requested/reachable bodies; stable output names and diagnostics match eager output; mutual recursion and non-finite specialization fail with the same bounded error.

### Phase 3 — Volar: scoped secondary planners

1. **Adaptive virtualization:** treat `AdaptiveSplitPlan` as the plan for a *selected IR unit*. `plan_adaptive_split`/`virtualize_ir_adaptive` remain semantically whole-unit because shared-core matching and layout/dedup can cross blocks. First make selection of the IR unit/function demand-driven; only later investigate component-level partitioning with an explicit proof that no cross-component sharing is lost.
2. **VAFFLE target:** split `LowerCtx::plan_functions` into declaration fragments (needed block/layout reservations) and per-function emission facets. Preserve deterministic function/index layout for the selected module.
3. **FHE direct LUT:** expose each accepted `AffineNegacyclicPlan` root/layer as a lazy emission facet, but retain current conservative rejection/fallback behavior. Do not broaden accepted circuits as part of laziness.
4. Add Volar provenance and reliability evidence for every new transform boundary; use generated-code compile-and-run tests, not only structural assertions. The ZK/non-ZK type discipline remains unchanged.

### Phase 4 — Speet: demand-discovered units with frozen layout

**Relevant code:** `speet-schedule/src/lib.rs`, `speet-link-core`, `speet-recompile/src/{frontend,plt}.rs`.

1. Generalize `FuncSchedule` conceptually to `LinkPlan`: its registration fragment declares the exact entity counts, binary dependencies, and a `FunctionInstructionSketch` for a demanded binary unit without translating instruction bodies.
2. Preserve feeding as an intentional boundary: it creates one output function for each guest word/possible instruction, and records which source instruction states belong in that function. The sketch is the complete scheduling/declaration view, not a requirement to create a separate emitted helper for every operation. A function is allowed to contain substantial generated code.
3. Assemble demanded units by BFS from requested guest entry/module roots. Collect every necessary type/function/memory/table/tag declaration and every selected function sketch before emission, but do not fetch or process a sketch's instruction content merely to freeze layout.
4. Freeze `EntityIndexSpace` only after the selected closure is assembled. This preserves the non-negotiable two-pass invariant: no emit closure creates entity declarations, and cross-binary indices are final before body emission.
5. Resolve a function/unit only when a linker/output facet asks for it; then lazily fetch and translate the source instructions named by its sketch, set its frozen base index, and invoke the existing emission path once. Fetching one function must not fetch instruction content for sibling functions merely because their sketches were fed.
6. Make Speet's compilation/link `Context` the single provider of its synthetic WASM module metadata, imports, tables, function identities, and per-function instruction sources. Pass it to both `describe(&context, ...)` and `resolve(&mut context, ...)`; implement the Wax/Waffle `WasmTransformContext` capabilities there so Volar's WASM frontend can consume the synthetic view directly. Do not serialize or manufacture an actual WASM module merely to cross this boundary.
7. Offer a separately requested full-processing facet for optimizations that require analysis beyond the sketch (for example dynamically-computed static-address handling). It must be opt-in, declare its additional selected-function dependencies before resolution, and remain bounded to the requested closure; normal sketch-mode compilation must not silently promote to a whole-system pass.
8. Treat `PltCallPlan` as a fragment: resolve target metadata and required import facets during assembly; realize `PltHookTable` only when translating a call site. Preserve manifest-derived indices and never restore hand-maintained import tables.
9. Retain a legacy “all registered units” entry point until cross-binary layout and emitted-WASM parity tests pass.

**Acceptance:** a demanded native/WASM/plugin unit has the same final index layout as the equivalent selected eager schedule, while unselected registered binaries are neither decoded nor emitted. Tests also prove that feeding produces all selected function sketches before layout freeze, while source instruction content is fetched only for resolved functions and full processing occurs only through its explicit facet.

### Phase 5 — WASM function-level laziness: Wax, Waffle, and wasm-blitz

**Relevant code:** `wax-core/src/build.rs`, `waffle-/{waffle-frontend,waffle-lowering,waffle-backend}`, `blitz-common/src/ops.rs`, and each wasm-blitz backend.

1. Define a stable `WasmFunctionKey` containing module/code-section or synthetic-module identity, function index, source snapshot, transform-pipeline version/options, and conservative indirect-target declaration. Start every route from explicit requested exports/entries/functions; use `describe(&WasmTransformContext, ...)` to BFS-assemble all reachable function keys before compiling any body.
2. In `wax-core`, retain `InstructionSource<Context, E>`/`InstructionSink<Context, E>` as the no-`std` body-composition API and add a `Context`-generic lazy transformation-wrapper convention/API. Each wrapper stores its input `InstructionSource<Context, E>`, transform identity, source/metadata snapshots, and no hidden module-state closure; it does not call `emit_instruction`/`emit` while being constructed or described. `describe(&Context, ...)` reads the context's immutable module/source-provider metadata; on a demanded body facet `resolve(&mut Context, ...)` can query Wax ambient/execution capabilities and transform-output WASM metadata, then converts the wrapped source to the next `InstructionSource`, Waffle function IR, or target assembly sink. Do not put project root discovery or the scheduler into Wax.
3. Add a Waffle adapter that accepts one demanded Wax source/wrapper chain and materializes only that function's Waffle IR/lowered body/assembly. Assemble module-level validation and link metadata required by the selected closure, but never lower every code-section body as a prerequisite for one requested function. Refactor per-function passes into wrappers; expose a bounded, explicit selected-module facet for a pass whose semantics genuinely require all functions in that selected module.
4. Make wasm-blitz use the same route: compile only requested function bodies and all conservatively reachable functions, not every input WASM function. Keep `ProbePlan` as a compatibility representation and add a streaming `ProbeSource` wrapper that identifies entry/current operator-index probes as a demanded body walks its source. Probe cache keys are `(function snapshot, operator ordinal, placement)`; `ProbeMode`, `ProbeBinding`, state preservation, and zero-overhead `None` behavior remain unchanged.
5. Treat direct `call`, `return_call`, `ref.func`, element/table references, imports, and declared indirect-call targets as closure edges. A dynamic target that cannot be bounded must require a conservative target set, explicit selected-module/full mode, or a diagnostic. It may not cause body compilation to omit a potential callee.
6. Keep eager Waffle/wasm-blitz module compilation and `ProbePlan::control_flow_sites` as compatibility materializers over the lazy route until parity passes.

**Acceptance:** starting from one WASM root constructs/lowers/emits bodies only for that root's conservative reachable closure; byte-backed and synthetic `WasmTransformContext` inputs have equivalent closure/IR/assembly behavior; Wax wrapper construction causes zero instruction iteration; Waffle IR/assembly is absent for unrequested/unreachable bodies; native/JS/WASM backend bytes, validation, and control-flow probe numbering match existing eager tests.

### Phase 6 — Moond: reachable AGC compilation

**Relevant code:** `agc-recompile/src/frontend.rs`, `backend/mod.rs`, `backend/{c,wasm}.rs`.

1. Define `AgcNode = (address: u16, extend: bool, memory_snapshot, indirect_target_set, backend_config)` and artifact facets for decoded instruction, basic block, C unit, WASM instruction function, and explicit full-function analysis.
2. Retain the intentional feed granularity: one output function per AGC word/possible instruction state. Feeding creates an `AgcFunctionSketch` that assigns the candidate decoded instruction states/words and declared successor demands to each output function, but does not eagerly fetch/lower all of their bodies. It must not turn every operation into an emitted helper; a resolved instruction function may contain substantial code.
3. Factor `decode_stream`’s existing worklist into plan assembly. It already seeds entry points and declared indirect targets, uses a `VecDeque`, deduplicates headers, and records successors. In sketch mode, preserve `EXTEND` folding and NDX constant-folding exactly while doing only the decode/index work required to establish the sketch and its edges.
4. Resolve an instruction-function facet by lazily fetching and lowering the states named by its sketch. Resolving one function must not fetch sibling-function bodies. Use the same reachable plan for both the C `Backend` and WASM backend; the WASM backend must no longer require a caller to feed every `4096 × 2` pair for this lazy path.
5. Provide an explicit, opt-in full-processing facet for optimizations that need analysis beyond a sketch, including dynamically-computed static-address handling. That facet may fetch/process every instruction in the selected function or declared selected closure, but must declare that scope during assembly and must not silently expand to the whole AGC image. Correctness-sensitive unknown-control-flow handling remains governed by the next rule, not by skipping analysis.
6. Add a sparse/direct WASM API that declares functions/table entries for all and only reachable instruction states, plus any explicitly supplied indirect targets. Keep the current exhaustive `DirectBackend` feed-order API as a compatibility mode, and make exhaustive/full-processing selection explicit rather than an accidental consequence of feeding.
7. Specify unknown indirect control flow: it is either rejected with a source-address diagnostic, supplied by the caller as a conservative target set, or explicitly requests exhaustive mode. It must never silently omit a possible target.
8. Update WASM table/function-index construction, entry-point mapping, trap setup, and finish-time assertions so they accept a selected plan rather than assuming 8192 functions.

**Acceptance:** existing exhaustive fixtures produce byte-valid/behaviorally equivalent WASM; sparse fixtures prove that unreachable address/EXTEND states are not decoded/emitted; instruction content is fetched only for resolved function sketches; full processing is exercised only through its opt-in facet; and indirect targets and NDX fallback remain safe.

### Phase 7 — Grabb adapter only when composition exists

1. Do not retrofit the shared executor into single-expression SWC helpers.
2. When a user-facing batch transform is introduced, define AST export/module nodes and use `describe` to locate only the demanded AST subtrees/exports.
3. Resolve existing pure transformations as result facets, retain source spans/hygiene, and add AST/codegen golden tests.
4. Until then, document Grabb as intentionally outside the plan/executor migration rather than adding unused infrastructure.

## 7. Compatibility, invalidation, and observability

### Compatibility

Every migrated project keeps a legacy eager adapter:

```text
legacy entry point → derive legacy root set → assemble → resolve legacy final facet
```

No existing public method changes meaning merely because its implementation becomes lazy. New APIs must make root selection explicit. Serialization or wire protocols are versioned only when a plan/result identity crosses a process boundary.

### Invalidation

A snapshot fingerprint must include, as applicable:

- source/module/body bytes or immutable revision;
- transform/planner version;
- compiler/backend/options/features/target ABI;
- dependency interface and plugin/handler registry versions;
- isolate/provenance context (Dreamcomp);
- generic environment (Volar);
- entity/import manifest and host redirect configuration (Speet);
- WASM function/code-section revision, immutable `WasmTransformContext` metadata/output-layout revision, Wax wrapper pipeline/options, Waffle pass/backend configuration, and conservative indirect-target declaration (Wax/Waffle/wasm-blitz); and
- AGC memory image plus indirect-target declaration (moond).

Invalidation removes ready/failed result states for descendants of a changed fragment. Parse/index caches may survive only when their own source fingerprint matches. Never reuse a cached failure or artifact after a snapshot change.

### Observability

Expose, through project logging adapters, at least:

- normalized roots/facets;
- BFS discovery order and parent edge;
- fragments described, results resolved, cache hits/misses, and skipped nodes;
- limits/cycles/missing dependencies with stable key chains; and
- eager-versus-lazy work counters (source items, functions, blocks, instructions, emitted bytes).

Use existing project log facilities; the shared crate itself remains logging-free. Dreamcomp/Speet/wasm-blitz/moond can route through their existing `PORTAL_LOG_JSON` conventions. Volar diagnostics must retain provenance and reliability evidence requirements.

## 8. Test and benchmark matrix

| Layer | Required evidence |
|---|---|
| Shared crate | `cargo check --no-default-features`; deterministic BFS, diamond dedup, facet laziness, cycle/limit/re-entrancy, snapshot invalidation, no eager resolution. |
| Dreamcomp | Existing JS/WASM/plugin/CPS E2E parity; assert only requested module paths/cursor positions and requested/reachable WASM bodies are transformed; assert unrequested `MItem::WasmFunc` entries never construct `WaffleFuncConverter`; continuation replay and exception propagation regressions. |
| Volar monomorphization | Existing monomorphization tests plus generated target compile-and-run; root-specific instance counts; `pipeline-wasm` index-only/no-unrequested-body-lowering assertions and requested/reachable Waffle WASM-body counts; recursive/bounded-specialization parity. |
| Volar secondary planners | Adaptive/FHE/VAFFLE compile-and-run parity for selected units; provenance preserved; cryptographic test/evidence process unchanged. |
| Speet | Multi-binary index-layout parity, selected-unit-only translation, per-word/possible-instruction function-sketch feed counts, lazy per-function instruction fetch assertions, synthetic `Context` metadata/source-provider handoff to the Volar Wax/Waffle frontend without a serialized WASM module, explicit full-processing (including dynamic static-address) coverage, PLT import/ambient redirect parity, `wasmparser` validation. |
| Wax / Waffle / wasm-blitz | Root-specific reachable-function closure tests covering direct, `ref.func`, table/element, import, and declared-indirect edges; `Context` capability tests for module/output metadata, symbolic ambient lookup, and execution/constant-state observation; assert no instruction iteration or mutable-context query during wrapper construction and no Waffle IR/assembly for unreachable functions; eager/lazy byte and `wasmparser` parity; existing `ProbePlan` control-flow count test plus backend byte/behavior parity and “no probes means no plan scan” instrumentation. |
| Moond | C/WASM existing tests, `wasmparser` validation, one-function-per-word/possible-instruction sketch-feed tests, lazy per-function fetch assertions, opt-in full-processing coverage for dynamically-computed static addresses, sparse reachable-plan count tests, exhaustive-vs-sparse behavior parity, indirect/EXTEND/NDX regression cases. |
| Cross-repository lazy-WASM contract | Volar owns a public `volar-vaffle-target` fixture that parses a two-body byte-backed module, lowers only its selected lazy export, and verifies the sibling remains `FuncDecl::Lazy`. Dreamcomp owns the equivalent full private lowering/interpretation fixture because its compiler internals are not a public dependency. Both fixtures use the same minimal byte-backed module shape, so Waffle frontend behavior is exercised through two independent consumers. Moond's sparse-plan fixture remains in moond and exercises its Speet/yecta integration, including the current trap-cell and reactor-sealing APIs. |
| Grabb | Only once batching exists: SWC hygiene/span and printed-JS golden tests, plus demand count assertions. |

### Cross-repository test dependency graph

Keep production crate dependencies one-directional: `moond → speet` (through
`yecta`/`speet-traps`), while Volar and Dreamcomp independently consume the shared
Waffle frontend/lazy-body contract. The Volar fixture must not depend on private
Dreamcomp crates. Dreamcomp's equivalent fixture belongs in its private
`dreamcompiler-e2e-tests` crate and may depend on its own lowering crates only.
This graph prevents an integration test from making either public consumer depend on
the other while still detecting incompatible Waffle/Speet/Moond boundary changes.

Benchmark each migrated route on a representative small root and a large input. Report wall time, peak allocated bytes where available, described nodes, resolved nodes, emitted functions/blocks/instructions, and output equivalence. A lazy implementation that increases work for small roots or changes selected output is not ready to become default.

## 9. Rollout gates

1. **Prototype gate:** shared crate passes `no_std + alloc` tests; Dreamcomp prototype and Volar monomorphization prototype prove independent use.
2. **Correctness gate:** each repository has eager/lazy parity fixtures and explicit negative tests for cycles, missing roots, and conservative indirect dependencies.
3. **Performance gate:** each default-enabled migration demonstrates fewer transformed/resolved units for a narrow root without material regression on legacy all-root compilation.
4. **Default gate:** enable laziness per entry point behind an opt-in feature/configuration first; retain a documented eager escape hatch for one release/migration cycle.
5. **Stabilization gate:** remove redundant eager internals only after downstream callers have migrated and plan identities/invalidation behavior are documented.

## 10. Completion criteria

The feature is complete when:

- `portal-lazy-transform` is independently published/maintained at `portal-co`, builds with `#![no_std]` and `alloc`, and contains no project IR dependencies;
- requested artifacts are assembled through deterministic, bounded BFS over exactly their declared reachable closure;
- reading a plan does not emit results, and results execute only on demand with snapshot-safe memoization;
- Dreamcomp, Volar monomorphization, Speet scheduling, Wax/Waffle/wasm-blitz function compilation, and Moond reachable compilation have migrated or have an explicit tested adapter; every adapter receives its project `Context` in both `describe` and `resolve`; Dreamcomp and Volar WASM frontends index metadata without lowering unrequested bodies, and every WASM route compiles only requested roots and their conservatively reachable function closure through lazy `InstructionSource<Context, E>` wrappers that receive ambient, transform-output metadata, and execution-state capabilities only at resolution; Speet supplies Volar's WASM frontend with its synthetic module metadata/source provider through that same context rather than manufacturing a WASM module; Speet and Moond retain one-function-per-word/possible-instruction feeding as a sketch-only phase and fetch instruction content lazily;
- Grabb remains direct by design until it has a composed transform graph, rather than carrying unused scheduler machinery;
- Volar’s adaptive/VAFFLE/FHE planners are either migrated at selected-unit scope or documented with a semantic reason they remain eager within that unit;
- all listed parity, safety, and `no_std` tests pass; and
- the audit record explains why Pixie and PIT are not consumers of this compiler-focused substrate today, and records the Wax/Waffle adapter boundaries instead.
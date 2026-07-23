# WASM semantic metadata and signed resource contracts

**Status:** proposed cross-repository design  
**Owners:** `wax`, `waffle-`, `wasmsign3`, `volar`, `dreamcomp`, `speet`, and `moond`  
**Primary outcome:** a deterministic, portable WASM metadata map that can travel in a
custom section or an embedding `Context`, can be independently verified and signed,
and gives compilers/optimizers validated facts about memory, code, data, ABI, and
program semantics without forcing them to rediscover or materialize the whole module.

## 1. Problem and scope

Several cross-repository compilation routes know semantic facts that are not represented
by core WASM sections: a fixed maximum memory footprint, unused linear-memory ranges,
source-architecture state layout, selected reachable functions, ABI restrictions, and
which code/data image a consumer is expected to receive. Today those facts are either
lost, recreated independently, or retained in process-local state. That makes memory
lowering unnecessarily expensive in Volar and Dreamcomp, prevents a signer from binding
semantic resource claims to a module, and leaves ordinary WASM passes unaware of useful
facts that can be validated when a caller requests binding verification.

This plan defines a **WASM Semantic Metadata Map (WSMM)**. It is:

- a canonical typed key-value map;
- representable in the custom section `portal.wasm.meta.v1` and in a Wax context/sidecar;
- independently parseable, hashable, and verifiable with `no_std + alloc` support;
- a signing target for `wasmsign3` that binds metadata to code, data, and interface hashes;
- emitted by Speet and Moond; and
- usable by Wax and Waffle as a pass input/output, rather than being a private convention of
  any one compiler.

This is **not** a replacement WASM format, a general debug-info container, or an authority to
ignore WASM validation. Whether a consumer respects a well-formed manifest is its explicit
mode/type choice; neither the manifest's location nor a signature implicitly makes that choice.

## 2. Design principles and invariants

1. **Canonical bytes are the identity.** Equal semantic maps encode to exactly the same byte
   sequence. No host map iteration order, JSON formatting, pointer identity, or process-local
   IDs may influence the signed representation.
2. **Hash binding is opt-in and required for signatures.** `hash.code`, `hash.data`, and
   `hash.interface` are recomputed from the received WASM before a `wasmsign3` signature is
   accepted. An unsigned manifest may omit them and is still a well-formed manifest.
3. **Custom-section and Context forms are equivalent.** Both use the same WSMM payload bytes.
   A Context-only map is a first-class manifest input; it becomes a portable signed claim only
   when those exact bytes are emitted or supplied as an explicitly identified sidecar.
4. **Conflicts fail closed.** A matching custom section and Context map may be deduplicated. A
   disagreement in canonical bytes, duplicate key, incompatible version, or malformed value is
   a diagnostic—not a precedence rule. A requested hash-binding check also diagnoses mismatch.
5. **Use mode, not provenance, controls semantics.** Metadata has no prescribed source and no
   producer identity. Consumers use distinct `Ignore`, `RespectUnstable`, or
   `RequireSignature` modes/types; only the chosen mode determines whether facts affect output.
6. **Metadata invalidates on semantic change.** A pass that changes code, data, memory/table
   declarations, exports/imports, or a metadata-dependent semantic fact must recompute affected
   hashes and either update the map or remove its stale signing target/signature.
7. **No hidden whole-module work.** A consumer can read a bounded header and requested keys
   without decoding all bodies. Hash binding is an explicit full selected-section task; it is not
   silently triggered by a metadata lookup.
8. **WASM remains authoritative for execution.** Metadata can refine allocation, analysis, or
   pass choice in a consumer that selected a respecting mode. It never makes out-of-range memory
   accesses valid or removes required dynamic checks without a separately justified proof.

## 3. Wire format: `portal.wasm.meta.v1`

### 3.1 Placement and ownership

The portable representation is one custom section named exactly:

```text
portal.wasm.meta.v1
```

Its payload is WSMM v1 bytes. The section may appear anywhere permitted by WASM, but emitters
must place it after ordinary executable/data sections and before any signing sections. Readers
must scan all custom sections, reject more than one WSMM v1 section, and preserve unknown
custom sections. `waffle-ir::Module.custom_sections` is the initial in-memory carrier; it must
not be treated as a trusted map until parsed and validated.

The signing target and signature are separate custom sections, so adding a signature does not
change the hashes it verifies:

```text
portal.wasmsign3.target.v1
portal.wasmsign3.signature.v1
```

New names deliberately avoid changing the existing `signature2` format or its compatibility
meaning.

### 3.2 Canonical WSMM payload

WSMM v1 is a small binary typed map designed for `no_std + alloc`; it is not JSON, CBOR, or a
Rust serialization format.

```text
magic       = "WSMM"                         (4 bytes)
version     = 1                              (u8)
flags       = 0                              (u8; reserved bits must be zero)
entry_count = canonical unsigned LEB128
entry       = key_len | UTF-8 key | value_tag | value_len | canonical value bytes
```

Entries are sorted by the raw UTF-8 bytes of `key`; keys are nonempty ASCII lowercase dotted
names (`[a-z0-9][a-z0-9._/-]*`), are unique, and have a bounded length. `value_len` is present
for every tag so unknown keys can be skipped without allocating them. Integer LEB128 values
must be minimally encoded. Lists and maps recursively use counts and canonical ordering; maps
also reject duplicate keys. Strings are valid UTF-8. Boolean values are one byte `0` or `1`.

V1 value tags are `u64`, `i64`, `bool`, UTF-8 string, bytes, list, map, and a fixed 32-byte
`sha3-256` digest. No float, indefinite-length, duplicate-key, or implementation-defined value
is permitted. Size limits are part of the parser API (total payload, entry count, key length,
nesting, individual byte value); the default limits must be conservative and configurable.

`wax-meta` (a new crate beside `wax-core`) owns this codec, its limits, and canonical hashing.
Its base feature set is `#![no_std]` plus `alloc`; `std`, `serde`, and CLI helpers are optional
adapters only.

### 3.3 Canonical key registry

Keys below are standardized in v1. A missing optional key means “unknown”, not zero or false.
A consumer must reject a malformed known value and ignore unknown `vendor.*` keys only after
preserving them through a round trip.

| Key | Type | Meaning |
|---|---|---|
| `format.version` | `u64` | Must be `1`; included to make Context/section mismatches explicit. |
| `hash.algorithm` | string | V1 is exactly `sha3-256`; required when any `hash.*` binding key is present. |
| `hash.code` | digest | Domain-separated canonical hash of code bodies (§4). |
| `hash.data` | digest | Domain-separated canonical hash of active/passive data (§4). |
| `hash.interface` | digest | Hash of index-sensitive non-code/data module interface (§4). |
| `hash.semantic` | digest | Hash of WSMM bytes with all `hash.*` and signing-location keys omitted. |
| `memory.count` | `u64` | Number of memories, including imported memories. |
| `memory/<n>/index` | `u64` | WASM memory index; `<n>` is decimal with no leading zero. |
| `memory/<n>/initial_pages`, `memory/<n>/maximum_pages` | `u64` | Initial/maximum page counts; maximum is required when the manifest makes a bounded-footprint claim. |
| `memory/<n>/page_size_log2` | `u64` | Usually `16`; records custom page sizes where enabled. |
| `memory/<n>/address_bits` | `u64` | `32` or `64`; must agree with memory64 declaration. |
| `memory/<n>/shared`, `memory/<n>/imported`, `memory/<n>/growable` | bool | Declared memory behavior. `growable=false` is a semantic claim requiring validation. |
| `memory/<n>/used` | sorted list of `{start:u64, length:u64, class:string, permissions:string}` | Non-overlapping occupied/reserved ranges. `class` includes `data`, `stack`, `heap`, `registers`, `runtime`, and `unknown`; `permissions` uses `r`, `w`, `x` in canonical order. |
| `memory/<n>/unused` | sorted list of `{start:u64, length:u64}` | Complement ranges that are intentionally unused within the declared bound. It is redundant with `used`, but permits streaming resource consumers; validators must prove the two agree if both are supplied. |
| `memory/<n>/dynamic_access` | string | `none`, `bounded`, or `unknown`; guards use of layout facts by memory optimizers. |
| `data/<n>/memory`, `data/<n>/offset`, `data/<n>/length`, `data/<n>/hash` | scalars/digest | Canonical descriptor of each active segment; passive segments use `memory = null` and include an explicit mode key. |
| `abi.name`, `abi.version`, `abi.entrypoints` | string/u64/list | ABI and exported entry-point contract. |
| `semantics.deterministic`, `semantics.traps` | bool/string | Optional, explicitly scoped facts used by passes. |
| `table/<n>/indirect_targets` | list or string `unknown` | Conservative indirect-call target set for WASM table index `<n>`; each table has an independent claim, never an underspecified module-wide hint. |
| `semantic/<name>` | typed value | Registry-backed semantic extension. A consuming pass must name the exact keys it understands. |
| `vendor/<dns-name>/<key>` | typed value | Forward-compatible opaque producer extension; cannot alter standard-key meaning. |

The hash keys are optional for an unsigned manifest. The `wasmsign3` signing profile requires
all four `hash.*` values and rejects a target that does not match them. The registry must define
the exact grammar for range records, permissions, data modes, and semantic vocabularies before
v1 ships. Range endpoints use checked `start + length`; zero-length,
overlapping, out-of-bounds, and noncanonical adjacent ranges are rejected. A memory claim never
covers an imported memory unless the manifest explicitly supplies the bound and the consuming
mode permits using it.

## 4. Hashes and `wasmsign3` signing target

### 4.1 Recomputable hash domains

V1 uses SHA3-256 and domain-separated byte streams. The final specification must publish test
vectors for every domain. In outline:

```text
H_code      = SHA3-256("portal.wsmm.code.v1"      || canonical code-body sequence)
H_data      = SHA3-256("portal.wsmm.data.v1"      || canonical data-segment sequence)
H_interface = SHA3-256("portal.wsmm.interface.v1" || canonical module declarations)
H_semantic  = SHA3-256("portal.wsmm.semantic.v1"  || canonical WSMM excluding hash keys)
```

The code sequence includes defined-function ordinal, body byte length, and original body bytes;
it cannot be confused by concatenation or import-function shifts. The data sequence includes
active/passive mode, memory index where applicable, canonical constant offset expression bytes,
segment ordinal, payload length, and payload bytes. The interface sequence covers type/import/
function-signature/memory/table/global/tag/element/export/start declarations and their
index-sensitive ordering **including every table element segment**: its active/passive/declarative
mode, table index, offset expression, element type, segment ordinal, and every function/reference
initializer. It excludes custom sections, code bodies, and data payloads.

This division makes code and data hashes independently useful while preventing a module from
reusing a valid code hash with a changed ABI, table declaration or element initialization, memory
limit, or segment placement.

### 4.2 Signing target

`wasmsign3` gains a typed `WsmmSigningTargetV1` encoder/parser. Its canonical target bytes are:

```text
"portal.wasmsign3.target.v1" || version || H_code || H_data || H_interface || H_semantic
|| canonical policy-id || canonical signer-context bytes
```

`policy-id` identifies the verifier’s declared policy (for example `resource-layout/v1`), not a
manifest-source string. The signer context is bounded, explicit bytes for deployment-specific binding
such as network or release identity. It may not contain secret material or an unbounded raw
module copy.

The signer signs these target bytes with the existing SLH-DSA machinery. The target section
contains the five fixed fields needed by an offline verifier, and the signature section contains
algorithm/key/signature material. A verifier must:

1. parse and canonically decode WSMM;
2. recompute all three WASM hashes and `H_semantic`;
3. compare them to WSMM and target-section fields;
4. check the signature over the canonical target; and
5. apply the caller’s signature policy to the verified key, policy-id, and requested keys.

A signature over only the metadata payload is insufficient. A manifest is required by this
signing profile, but a manifest itself need not be signed: a caller in `RespectUnstable` mode may
respect a well-formed unsigned manifest from the start. A missing metadata/target/signature is a
normal unsigned module unless an embedding policy requires a signature. Existing `signature2`
read/render APIs remain unchanged; `wasmsign3` must provide separate v1 APIs and explicit
migration tests.

## 5. Wax Context and sidecar API

`wax-core` remains the no-`std` instruction-source/sink primitive. `wax-meta` provides:

```rust
pub trait WasmMetadataContext {
    fn metadata_snapshot(&self) -> MetadataSnapshot;
    fn metadata(&self) -> Option<&WasmSemanticMetadata>;
    fn metadata_mode(&self) -> MetadataMode;
}

pub enum MetadataMode {
    Ignore,
    RespectUnstable,
    RequireSignature(SignaturePolicy),
}

pub trait WasmMetadataMutContext: WasmMetadataContext {
    fn metadata_mut(&mut self) -> &mut WasmSemanticMetadata;
    fn invalidate_metadata(&mut self, changes: MetadataChanges);
}
```

The concrete Context may hold an owned map, an immutable borrowed map, or a digest-addressed
sidecar resolver. `MetadataSnapshot` participates in lazy body/function cache identity whenever
a transform reads metadata. The metadata map carries no source or trust class: consumers select
behavior through `MetadataMode` (preferably as a type parameter/newtype at pipeline construction,
not an ambient global). `RespectUnstable` is the initial opt-in ABI and respects a well-formed
manifest regardless of where it came from; `RequireSignature` additionally requires a successful
`wasmsign3` binding/signature verification.

Wax lazy wrappers may inspect immutable metadata while being described, but mutable Context and
body iteration remain resolution-time only. A wrapper/pass declares the key prefixes it reads and
the facts it invalidates. This gives a demand planner enough information to avoid cache reuse
when, for example, a memory-layout map changes without changing a function-body source.

For byte-backed input, the section decoder is streaming and only materializes requested values.
For synthetic Speet/Moond input, the same map is supplied by Context before a serialized module
exists. At final emission, `emit_wsmm_custom_section` writes exactly those canonical bytes; a
sidecar is accepted only when its digest is pinned in the same signing target or caller policy.

## 6. Waffle integration and independent passes

Waffle already retains custom sections in `Module.custom_sections` and re-emits them in its
backend. Add a small `portal-pc-waffle-metadata` adapter (or a narrowly scoped
`waffle-passes` module) with no dependency on Volar, Dreamcomp, Speet, or Moond:

1. **Import pass:** find `portal.wasm.meta.v1`, decode it with limits, attach an immutable
   `WasmSemanticMetadata` sidecar to the pass context, and retain original canonical bytes.
2. **Binding-check pass:** on request, compute section-aware code/data/interface hashes from the
   Waffle module or original bytes and validate memory ranges/standard-key consistency. This is
   required by `RequireSignature`, but is not a provenance or trust classifier.
3. **Infer/normalize pass:** derive conservative layout facts from declarations/data segments and
   optional bounded analysis, then emit canonical WSMM. Inference must mark unknown dynamic
   access rather than invent unused ranges.
4. **Use pass API:** passes request named facts (`memory/0/used`,
   `table/0/indirect_targets`, etc.) through `Ignore`, `RespectUnstable`, or `RequireSignature`
   context types. Traditional optimizers can use respected facts for dead-data removal,
   fixed-bound allocation, range-check simplification, function-closure selection, and memory
   representation choice.
5. **Rewrite hygiene:** any Waffle transform that changes a covered section records invalidation;
   the backend either writes regenerated metadata and a newly generated signature target or drops
   stale WSMM/signature sections. It must never blindly copy a stale signed target after a rewrite.

The same pass API works from a Wax `WasmMetadataContext`; Waffle need not construct a whole
external Context merely to parse a custom section. Conversely, Wax does not become a whole-module
optimizer or scheduler.

## 7. Consumer migration

### 7.1 Volar

Volar’s Waffle/VAFFLE route imports metadata before lowering body facets. Its initial explicit
`RespectUnstable` pipeline type respects any well-formed manifest, so existing consumers gain the
allocation benefit immediately; deployments needing authentication select `RequireSignature`.
It uses:

- memory page bounds, address width, and used/reserved ranges to choose compact storage and avoid
  constructing bit-vector/pre-initialization state for proven-unused memory;
- data descriptors/hashes to keep only selected data materialization in the reachable closure;
- ABI, interface, and per-table indirect-target facts to validate selected-function closure
  policy; and
- metadata snapshot/hash as part of `pipeline-wasm` and lazy wrapper cache keys.

`volar-vaffle-target` retains conservative full-memory behavior when its pipeline type is
`Ignore`, metadata is absent or malformed, memory access is dynamically unknown, or a fact is
incompatible with an IR operation. `RespectUnstable` is intentionally an unstable ABI until the
manifest contract stabilizes; it must not silently become an authentication policy. No
cryptographic/proving discipline or ZK/non-ZK boundary is weakened. Generated output tests must
compile and run both metadata-enabled and fallback modules.

### 7.2 Dreamcomp

Dreamcomp imports the same map into `DreamcompModuleSession`/its WASM module provider. Its
`RespectUnstable` module-provider type consumes a well-formed manifest immediately; a separate
`RequireSignature` type is available where authentication is required. A selected
`MItem::WasmFunc` uses memory layout and data descriptors to avoid eagerly expanding
unreferenced data-backed state or allocating Fast-IR/MiniBC representation for declared-unused
ranges. It records the WSMM snapshot together with module bytes and plugin/isolate state; cache
reuse across a changed layout or selected metadata mode is forbidden.

The private Dreamcomp E2E suite owns tests that execute byte-backed modules with and without
WSMM and verifies equivalent results, reduced represented memory for valid bounded layouts, and
fallback behavior for unknown/dynamic layouts.

### 7.3 Speet

Speet produces a WSMM builder from `LinkPlan`/`FuncSchedule`, `EntityIndexSpace`, and
`MegabinaryOutput`: final import/function layout, memory/table declarations, active/passive data,
selected-unit closure, ABI/runtime ranges, and source/guest semantic extensions. It does not
claim an unused range where a mapper, trap, ambient call, or optional full-processing facet can
access it dynamically.

`MegabinaryOutput::assemble` gets an opt-in metadata emission step. It encodes ordinary sections,
computes the three hashes from final bytes/declarations, writes WSMM, then optionally invokes the
`wasmsign3` target/signer stage. This occurs after entity indices freeze and never requires
serializing a synthetic module merely for Volar’s Context route.

### 7.4 Moond

Moond’s direct WASM backend produces WSMM from its reachable `DirectPlan`: AGC ISA/image
revision digest, selected `(address, EXTEND)` function-state closure, runtime import ABI, and the
fixed register backing-store layout (`A`, `L`, `Q`, banks, temporary state, etc.). It declares
memory bounds and ranges only after accounting for dynamic-address/indirect control-flow policy;
an exhaustive fallback reports that scope explicitly rather than pretending it is sparse.

`WasmDirectBackend::finish` gains an opt-in metadata/signing configuration. It seals and encodes
functions first, computes final hashes, appends WSMM, and optionally signs. Existing byte output
and unsigned API remain compatibility paths.

## 8. Delivery sequence

1. **RFC and vectors:** publish exact grammar, range schema, hash domain encodings, limits, and
   valid/invalid vectors. Resolve whether passive-data descriptors need an additional module
   policy key before freezing v1.
2. **`wax-meta`:** implement no-`std + alloc` typed map, canonical codec, limits, digest helpers,
   `Ignore`/`RespectUnstable`/`RequireSignature` Context types, and round-trip/property tests.
3. **`wasmsign3`:** add independent target/signature section parser/renderer and verifier API;
   preserve `signature2`; test code/data/interface (including element segment) mutation rejection
   and Context-vs-section byte equality. Require a manifest for this signing profile only.
4. **Waffle:** add import/binding-check/infer/use/invalidation passes plus backend emission
   support; test that a `RespectUnstable` pass can use facts from the start and that any covered
   rewrite clears/rebuilds signatures.
5. **Emitters:** add Speet and Moond builders behind explicit metadata options, then signed output
   options. Test their output with `wasmparser`, Waffle, and `wasmsign3` verification.
6. **Consumers:** integrate Volar first at VAFFLE memory lowering, then Dreamcomp’s private
   WASM/Fast-IR path. Enable the explicit `RespectUnstable` path from the start (with an
   `Ignore` fallback); benchmark and test it before the ABI is declared stable.
7. **Stabilization:** freeze the respecting ABI after parity, resource-use benchmarks, and
   invalidation tests. Keep `RequireSignature` an independent consumer choice rather than making
   it the implicit meaning of metadata.

## 9. Test and acceptance matrix

| Layer | Required evidence |
|---|---|
| `wax-meta` | `no_std + alloc` build; canonical ordering/minimal-integer/duplicate rejection; bounded streaming parse; Context/section equality; snapshot invalidation. |
| `wasmsign3` | deterministic target vectors; signatures reject changed code, data, interface, semantic map, policy-id, or signer context; existing `signature2` compatibility remains unchanged. |
| Waffle | custom section round trip; `RespectUnstable` fact exposure to an independent pass; `Ignore` does not optimize; code/data/memory/table-element rewrite invalidates signatures; ordinary optimizer output validates. |
| Speet | synthetic Context and emitted section have identical WSMM bytes; frozen-index/data/ABI/table-element facts match final module; signed output validates; dynamic/trap paths do not overclaim unused memory. |
| Moond | sparse and exhaustive plans emit correct closure/layout metadata; fixed register ranges are exact; output validates and signatures reject AGC code/data/table-element changes; legacy unsigned output remains byte/behavior compatible. |
| Volar | `RespectUnstable` metadata-enabled and `Ignore` fallback outputs compile/run equivalently; declared bounded regions reduce allocation from the start; dynamic/unknown memory falls back; discipline tests remain intact. |
| Dreamcomp | private byte-backed `RespectUnstable` lazy-WASM E2E parity; requested export does not materialize unrelated body/data state; changed metadata snapshot or mode misses cache; malformed map falls back safely. |
| Cross-repository | Speet and Moond outputs are accepted by Wax/Waffle and `wasmsign3`; Volar and private Dreamcomp consume the same fixtures without producer-specific parser branches. |

## 10. Non-goals and open decisions

- V1 does not sign arbitrary unknown custom sections, prove memory safety, replace capability
  certificates, or make an imported memory bounded without a policy-approved contract.
- V1 does not require every module to have metadata or a signature.
- The final RFC must choose the standardized semantic-extension registry process, sidecar
  transport framing, maximum default parser limits, and whether multiple independently signed
  targets may coexist.
- Before respecting `unused` ranges for a transformation that removes checks or changes observable
  traps, each consumer needs a scoped proof/validation rule. `RespectUnstable` may immediately
  use the resource contract for allocation/storage reduction; it must not implicitly authorize
  observable semantic changes.

## 11. Completion criteria

This plan is complete when one canonical WSMM implementation is shared through Wax Context and
WASM custom sections; `wasmsign3` verifies a target binding semantic metadata with code, data,
and interface hashes (including table elements); Waffle can bind-check/infer/use/invalidate it as
an independent pass; Speet and Moond can emit it; and Volar and private Dreamcomp demonstrably
reduce selected memory representation under their explicit `RespectUnstable` mode from the start,
while `Ignore`, absent, malformed, changed, or dynamically unknown inputs retain correct
conservative behavior.
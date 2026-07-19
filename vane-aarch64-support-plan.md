# Vane AArch64 support with `disarm64` parity

**Status:** In progress — Phases 0–3 complete; Phase 4 scalar-FP lowering and Phase 5 native/JS embedding hardening are implemented for the documented subset. Full Speet parity remains open.
**Owners:** `@vane` (implementation), `@speet` (reference coverage)
**Reference snapshot:** `@speet` commit `073c872` (`speet-aarch64`)
**Decoder:** [`disarm64`](https://crates.io/crates/disarm64), resolved to `0.1.26` in the reference workspace

## Implementation status (2026-07-18)

The first implementation slice is now present in `@vane`:

- `vane-aarch64` is a workspace crate using `disarm64.workspace = true` at
  version `0.1.26`; its raw-word smoke tests freeze the shared decoder entry
  point.
- The StackOp substrate now has explicit `StateSlot` reads/writes and a
  dedicated `Drop`. This keeps RV64's `LoadReg(0)`/`StoreReg(0)` behavior
  intact while making AArch64 X0 writable and keeping context-sensitive XZR
  and SP separate.
- The native interpreter and JS renderer preserve named state slots; the wasm
  renderer intentionally traps for them until that backend has an explicit
  state layout.
- `a64_emit` implements fixed-width fetch and little-endian `CheckCode`, the
  cached label/tail-call trace lifecycle, `MOVZ`/`MOVN`/`MOVK`, ADD/SUB
  immediate and shifted-register forms (including NZCV production), shifted
  logical AND/BIC/ORR/ORN/EOR/EON, ADR/ADRP, `B`/`BL`/`BR`/`BLR`/`RET`, all
  `B.cond` predicates, `CBZ`/`CBNZ`, and all six integer memory classes:
  unsigned-offset, unscaled, signed imm9 pre/post-index, register-offset,
  signed-offset pair, and indexed pair forms. The native suite includes raw
  address/writeback/pair-order execution coverage.

- Scalar FP infrastructure is now shared by A64 and RV64: raw-bit F32/F64
  `StackOp` operations execute in both the native interpreter and JS JIT,
  with F32 rounded at each operation. AArch64 has initial `FLOATDP1`/`FLOATDP2`
  lowering (arithmetic, min/max, FNMUL, abs/neg/sqrt, and FP-register FMOV),
  and RV64 now lowers scalar loads/stores plus `FADD`/`FSUB`/`FMUL`/`FDIV` and
  `FSQRT` for S/D through the same slots.
- `Aarch64Reactor` is an explicit native embedding that runs an A64 trace
  against a caller-supplied `StackHost`, leaving the existing RV64
  WASM-bindgen `Reactor` ABI unchanged.
- The remaining scalar-FP ledger classes now lower for supported S/D raw-word
  forms: non-fused-policy `FLOATDP3`, `FLOATIMM`, `FLOATSEL`, `FLOATCMP`,
  FP-register/GP bit moves, `SCVTF`/`UCVTF`, and `FCVTZS`/`FCVTZU`. The
  native execution suite exercises those paths, and a Node syntax check
  validates generated `CoreJS` output containing the complete FP sequence.

The remaining decoder families listed below are still deliberately trapped.
In particular, flag-setting logical operations, extended-register ADD/SUB,
bitfield and multiply/divide instructions, the non-Speet rounding-mode FP
variants, scalar FP memory, a browser-runtime execution corpus, and the
checked table-driven all-width parity audit must land before parity may be
claimed.

## 1. Goal

Add an AArch64 guest frontend to `@vane` that decodes A64 machine code with the
same `disarm64` crate used by `@speet` and supports the same *currently
implemented instruction families* as `speet-aarch64` at the reference snapshot.

Vane's output remains its existing execution model:

```text
AArch64 bytes
  -> disarm64 decode
  -> Vane architecture lowering
  -> StackOp trace
  -> JavaScript JIT / native StackOp interpreter
```

This is guest-architecture support, not native AArch64 code generation. Vane
will execute an AArch64 guest through generated JavaScript (and through the
native `StackOp` interpreter where applicable), just as it currently executes
an RV64 guest. It does not emit host AArch64 binaries and does not replace
`asm-aarch64` or `wasm-blitz`.

"Parity" means decoder and lowering coverage: every instruction form currently
translated by Speet's AArch64 frontend must be accepted and lowered by Vane.
It does **not** mean Vane copies Speet's WASM/reactor architecture, its PLT
hook layer, or its native-runtime ABI. Vane may be more precise where its
runtime model permits it, but it must not silently support a smaller set.

## 2. Non-goals

- General AArch64 ISA completeness beyond Speet's current frontend coverage.
- SIMD/NEON/SVE, crypto, pointer authentication, MTE, atomics/exclusive
  accesses, barriers, cache maintenance, or privileged execution.
- ELF/Mach-O loading, Linux/macOS ABI startup, dynamic linking, PLT hooks, or
  syscall emulation. Those are independent host/runtime layers.
- Making `vane-target-wasm` functional. It remains a separate, currently stub
  target; AArch64 first targets Vane's JS JIT and `StackOp` interpreter.
- Treating `disarm64` mnemonic names as semantics. The implementation must use
  decoded operation forms and raw instruction fields, as Speet does.

## 3. Why use `disarm64`

Speet's A64 recompiler dispatches `disarm64::decoder::decode(word)` into
`disarm64::decoder_full::Operation` and then lowers operation classes in
`direct.rs`, `direct/alu.rs`, `direct/mem.rs`, and `direct/fp.rs`. Vane should
use that exact decoder family instead of adding a second A64 decoder or
hand-written masks.

This has three important consequences:

1. **Shared decode vocabulary.** The two projects classify the same raw word
   as the same `Operation`/variant, so a parity test can compare support at
   the natural boundary.
2. **Merged variants are real.** Some `disarm64` variants cover multiple A64
   width combinations. In particular, `SCVTF`, `UCVTF`, `FCVTZS`, and
   `FCVTZU` combine `{W,X}` and `{S,D}` forms; the implementation must branch
   on fields such as `sf` and `ftype`, not assume one enum variant means one
   operand width. Scalar LDR/STR variants have a similar 32/64-bit split.
3. **One version is intentional.** Vane's workspace dependency must be
   `disarm64 = "0.1.26"` (or the same exact version selected by Speet after a
   coordinated upgrade), declared in `[workspace.dependencies]`; the new
   `vane-aarch64` crate uses `disarm64.workspace = true`. Do not introduce an
   `aarch64`/`yaxpeax-arm`/custom decoder beside it.

A decoder upgrade is a cross-project compatibility event: update the Vane
parity ledger, re-run all raw-word decode tests, and review changed generated
`decoder_full` qualifiers before changing the lockfile.

## 4. Current implementation constraints in Vane

The RV64 implementation is not a drop-in A64 backend:

- `vane-riscv/src/template/riscv.rs` decodes `rv_asm::Inst` and owns its own
  `rv_emit`/`rv_body` tracing recursion. A64 needs an analogous fixed-width
  `a64_emit`/`a64_body`, not a growing `match` inside the RV64 module.
- `StackOp::LoadReg(0)` and `StoreReg(0)` currently hard-code RISC-V x0:
  register 0 reads as zero and writes are discarded. AArch64 X0 is ordinary;
  encoded register 31 is context-sensitive XZR or SP. This policy cannot be
  reused as-is.
- AArch64 needs NZCV condition flags and scalar V-register state. `StackOp`
  today only models integer registers, integer values, memory, and control
  flow.
- `render_stack_to_js` currently spells registers as `$.r["x{n}"]` and the `vane_meta!` runtime helper applies `reg %= 32` and
  RISC-V x0 semantics. The rendering/runtime ABI must become architecture
  configured while keeping the current RV64 output behavior byte-compatible.
- A64 is always four bytes per instruction. Its trace builder may use the
  existing `CheckCode`, labels, cached-block trial, and `TailCall` mechanics,
  but no compressed-instruction path.

These are shared infrastructure changes. They must land as compatible,
well-tested primitives before the large decoder match is added.

## 5. Architecture and crate layout

### 5.1 New crate

Add a sibling of `vane-riscv`:

```text
vane/crates/vane-aarch64/
  Cargo.toml
  src/lib.rs
  src/template/aarch64.rs
  src/template/helpers.rs
  src/template/alu.rs
  src/template/mem.rs
  src/template/fp.rs
  tests/decode_parity.rs
  tests/stack_execution.rs
  tests/js_execution.rs
```

- Package: `vane-aarch64`.
- Dependencies: `vane-arch` with JS/interpreter features as appropriate,
  `vane-target-core`, and `disarm64.workspace = true`.
- `lib.rs` re-exports `vane_arch::*`, defines the `Aarch64` renderer marker
  with `vane_arch::renders!(Aarch64)`, and exposes only the A64-specific
  public configuration/state types needed by embeddings.
- `template/aarch64.rs` owns trace construction, decode dispatch, branch
  routing, and the `Aarch64Display` implementation. `alu`, `mem`, and `fp`
  own the per-operation-family lowerers. This follows Speet's separation and
  makes parity audits reviewable.

Register the crate in the Vane workspace. Do **not** make the existing `vane`
RV64 cdylib silently change guest ISA. A later explicit A64 cdylib/demo crate
may use the generalized meta-runtime; its exported type must make the ISA
clear (for example `Aarch64Reactor`), rather than overloading the current
`Reactor`.

### 5.2 Trace lifecycle

For a root PC, `a64_emit` must:

1. Read exactly four bytes through `JitCtx` and emit
   `CheckCode { addr: pc, expected: little_endian_word, miss_label: root }`.
2. Decode `u32::from_le_bytes(bytes)` with `disarm64::decoder::decode`.
3. Lower the decoded `Operation` into a finite `Vec<StackOp>`/extended state
   ops.
4. Recursively emit statically known fall-through and direct branch targets
   using the same label/cached-block mechanism as RV64.
5. Lower dynamic `BR`, `BLR`, and `RET` targets to a dispatcher tail call.
6. Lower unsupported/undefined words to a deterministic `Trap` containing the
   mnemonic/word and record them through a test-visible support report.

A64 direct target calculation is `pc.wrapping_add_signed(sign_extended_offset
* 4)` for PC-relative branch forms. `BL` writes X30 with `pc + 4`; `BLR` does
the same before dispatching its computed target; `RET` dispatches X30. Every
trace and its test fixture must use little-endian instruction bytes.

### 5.3 Architectural state and generic StackOp evolution

Before the A64 frontend, split Vane's current RISC-V-specific register
assumptions from its architecture-neutral stack IR.

Introduce an explicit state-layout/configuration layer supplied by an
architecture renderer and consumed by the JS renderer, native StackOp
interpreter, and meta-generated `$` runtime. It must provide:

- named scalar slots rather than an implicit "slot 0 is immutable zero" rule;
- the JS property name for each state slot;
- optional architectural read/write transforms (for example, W-register
  writes zero-extend before becoming X-register values);
- distinct slots for X0–X30, SP, N/Z/C/V, scratch values, and scalar V0–V31;
- compatibility mapping for RV64's `x0` hard-zero rule and its existing
  `x1`…`x31` property names.

The preferred IR shape is explicit raw state access (for ordinary slots) plus
architecture lowering of special registers:

```rust
LoadState(StateSlot)
StoreState(StateSlot)
```

RV64 can retain `LoadReg`/`StoreReg` as compatibility aliases or lower them to
that model. A64 lowering must emit `PushImm(0)`/discard for XZR itself and use
the dedicated SP slot only in instruction forms where the ISA permits SP.
It must never represent A64 X0 with the RV64 zero-register operation.

Add only the generic scalar operations demonstrably required by both renderer
and interpreter (for example copy/temporary support, rotate-right, and
well-defined 32-bit normalization). Do not smuggle an A64 decoder into
`vane-target-core`. A64-specific bitfield decoding stays in `vane-aarch64`;
the shared IR merely provides the arithmetic/state operations to express it.

### 5.4 NZCV

A64 flags are state, not host-language booleans. Keep N, Z, C, and V as four
integer slots (0 or 1). Implement shared A64 lowering helpers for:

- `set_nzcv_add(width, lhs, rhs, result)`;
- `set_nzcv_sub(width, lhs, rhs, result)`;
- `set_nzcv_logical(width, result)` (N/Z updated, C/V defined as required by
  the instruction family);
- `condition_holds(cond)` for all A64 condition codes.

Use temporary slots or explicit stack duplication so flag calculations never
consume the value needed for the destination write. Test every condition code
against a table of NZCV inputs, including AL/NV behavior as accepted by the
supported encodings.

### 5.5 Scalar FP state

The scope is scalar S/D operations only, matching Speet; V-register SIMD lanes
are out of scope. Store V0–V31 as raw scalar bit patterns (64-bit slot per
register) and expose typed helper operations for 32- and 64-bit interpretation.
This preserves exact `FMOV` GP↔FP behavior, f32 payloads, and NaN bits at the
state boundary.

Extend the shared IR/JS renderer/native interpreter together for the necessary
operations:

- f32/f64 register read/write and rounding at an explicitly chosen width;
- add/sub/mul/div, neg/abs/sqrt, conversion and bit reinterpretation;
- ordered/unordered comparison outcomes needed to set NZCV;
- min/max and numeric-min/max behavior with explicit NaN policy;
- fused-family lowering policy for `FMADD`/`FMSUB`/`FNMADD`/`FNMSUB`.

The implementation must document the semantic policy. Speet currently stores
V registers as f64 and consequently performs S arithmetic at f64 precision;
its guide calls that a known approximation. Coverage parity does not require
Vane to reproduce that bug. Preferred Vane behavior is to round each S
operation through `Math.fround` in JS and f32 in the native interpreter. If a
first implementation deliberately matches Speet's approximation to minimize
scope, mark it **known limitation** in Vane documentation and add a follow-up
with a failing precision regression test; it must not be left implicit.

JavaScript has no portable scalar fused multiply-add primitive. Until a
well-specified helper exists, document whether the fused family is lowered as
separate multiply/add (Speet's current behavior) and test that declared
behavior. Do not claim IEEE fused rounding without implementing it.

## 6. Speet parity ledger

The following is the required initial support set, taken from Speet's current
A64 instruction-sync matrix and its actual `Operation` dispatch. The Vane
ledger must remain in this document and in a machine-checked test table. A row
is complete only when every listed encoding/width has a raw-word decode test
and a lowering/execution test where the Vane target can observe the result.

| Family | Required `disarm64` operation/class and forms |
|---|---|
| add/subtract and flags | `ADDSUB_IMM`, `ADDSUB_SHIFT`, `ADDSUB_EXT`: ADD, ADDS, SUB, SUBS, CMP aliases; immediate SP forms and `add_uxtw` |
| logical | `LOG_SHIFT`, `LOG_IMM`: AND/ANDS, ORR, EOR, BIC/BICS, ORN, EON, MVN aliases |
| move/bitfield | `MOVEWIDE`: MOVZ/MOVN/MOVK; `BITFIELD`: UBFM/SBFM/BFM and LSL/LSR/ASR/sign- and zero-extend aliases |
| integer multiply/divide | `DP_2SRC`: UDIV, SDIV, LSLV, LSRV, ASRV, RORV; `DP_3SRC`: MADD/MSUB, long multiply-add forms, SMULH, UMULH, and MUL aliases |
| conditional/address/system | `CONDSEL`: CSEL/CSINC/CSINV/CSNEG; `PCRELADDR`: ADR/ADRP; `IC_SYSTEM`: MRS/MSR NZCV; `EXCEPTION`: BRK |
| direct and indirect control flow | `BRANCH_IMM`: B/BL; `BRANCH_REG`: BR/BLR/RET; `CONDBRANCH`: B.cond and supported BC form; `COMPBRANCH`: CBZ/CBNZ |
| scalar memory | `LDST_POS`, `LDST_IMM9`, `LDST_UNSCALED`, `LDST_REGOFF`, `LDSTPAIR_OFF`, `LDSTPAIR_INDEXED`: LDR/STR (W/X), byte/halfword forms, signed byte/halfword/word loads, LDRSW, pre/post/unscaled addressing, register offset, LDP/STP/LDPSW |
| scalar FP binary/unary | `FLOATDP2`: FADD/FSUB/FMUL/FDIV/FNMUL/FMIN/FMAX/FMINNM/FMAXNM; `FLOATDP1`: FABS/FNEG/FSQRT/FMOV/FCVT; all S/D forms |
| scalar FP fused/immediate/select | `FLOATDP3`: FMADD/FMSUB/FNMADD/FNMSUB; `FLOATIMM`; `FLOATSEL`: FCSEL |
| FP integer boundary | `FLOAT2INT`: FMOV W/X↔S/D, SCVTF, UCVTF, FCVTZS, FCVTZU, all four `{W,X} × {S,D}` combinations |
| FP comparisons | `FLOATCMP`: FCMP/FCMPE including the FP-immediate-zero compare forms and NZCV result |

The following remain unsupported in the initial Vane A64 scope because they
are not supported by Speet's referenced A64 frontend: `TBZ`/`TBNZ`, A64
atomics/exclusive operations, `SVC`/`HVC`/`SMC`, barriers, NEON/SVE,
pointer-authentication returns, floating-point loads/stores not in the listed
scalar integer memory families, and all unrelated decoder classes. A future
addition may be a Vane superset, but it must first update this ledger and add
its own tests rather than silently expanding the claimed parity boundary.

## 7. Decoder and lowering rules

1. Dispatch first on `Opcode.operation`, then on the concrete generated
   variant. Do not dispatch only on `Mnemonic`; aliases lose required operand
   context.
2. For every merged variant, inspect the installed `disarm64` generated
   definition and branch on raw fields (`sf`, `ftype`, size, addressing mode)
   exactly where required. The parity tests must contain all combinations.
3. Keep field extraction (`rd`, `rn`, `rm`, `ra`, `imm*`, sign extension,
   logical-immediate bitmask decoding, condition decoding) in
   `template/helpers.rs`, with independently tested pure functions.
4. Implement XZR/SP context in lowering helpers, not by mutating decoder
   output: ordinary GPR use of register 31 means XZR; address and permitted
   add/sub immediate forms use SP.
5. W-form writes always clear the upper 32 bits. W-form sources are masked or
   sign-extended precisely where the A64 instruction specifies it.
6. Memory is little-endian and uses Vane `Mem`/the existing JS `data()` route.
   Address calculation wraps as the existing Vane memory policy specifies;
   any later virtual-memory-policy change belongs to `vane-arch::Mem`, not the
   decoder.
7. `BRK` is a `Trap` with an A64-specific diagnostic. Do not map it to RV64
   `Ecall`; parity does not include A64 `SVC`.

## 8. Test strategy and acceptance criteria

The plan is complete only when all of these pass.

### 8.1 Decoder parity tests

`vane-aarch64/tests/decode_parity.rs` contains a table of little-endian raw
words. Each case records the disarm operation/variant, form/width, and parity
family. Tests assert:

- `disarm64::decoder::decode(word)` succeeds and has the expected class;
- Vane lowers the word without `Unsupported`/fallback `Trap`;
- every Speet-required merged-width combination is present, especially all
  SCVTF/UCVTF/FCVTZS/FCVTZU forms and merged 32/64 LDR/STR forms.

The table is checked into Vane; tests must not require a sibling Speet checkout
at build time. Fixtures copied from Speet's A64 corpus retain provenance
comments and are reviewed when the reference snapshot changes.

### 8.2 Pure lowering tests

Unit-test field helpers, logical-immediate masks, branch offsets, XZR/SP
selection, W zero-extension, and NZCV calculations. Include exhaustive NZCV
condition-code cases and boundary arithmetic: zero, carry/borrow, signed
overflow, `u64::MAX`, `i64::MIN`, and 32-bit equivalents.

### 8.3 Native StackOp execution tests

Use the architecture-configured `vane_arch::interp::interpret` path with a
small A64 state host. Test observable register/memory/flag state after traces
for each family, including direct/conditional branches, BL/RET, pairs and
writeback addressing, and all GP↔FP conversion widths. Test that X0 is
writable, XZR remains zero/discarded, and SP is distinct.

### 8.4 Browser JavaScript JIT tests

Create browser-only `wasm-bindgen-test` coverage analogous to Vane's RV64
corpus tests. It should load small A64 byte fixtures into `Mem`, compile via
`Aarch64`/`CoreJS`, execute the generated JIT, and inspect configured A64
state. Cover both normal JS rendering and the `async_mem` path where memory
access is relevant. Existing RV64 API/output tests must continue to pass
unchanged.

### 8.5 Corpus smoke tests

Add a Vane-owned A64 micro-corpus (assembly source plus checked-in byte
fixtures or a documented reproducible generator). Start from the integer,
control-transfer, load/store, and floating-point source organization in
`@speet/test-data/aarch64-corpus`, but do not make Vane's CI depend on the
Speet repository or its toolchain. Programs end in a Vane-observable trap or
state sentinel rather than an unsupported Linux `svc` exit.

### 8.6 Cross-reference audit

For every implementation change, compare the Vane dispatch table with
`speet-aarch64` at the recorded reference commit. If Speet changes first,
update the ledger to one of: supported, explicitly deferred with justification,
or removed from the reference. No unexplained gap is allowed.

## 9. Phased implementation

### Phase 0 — Freeze the contract and dependency (small, reviewable)

1. Add `disarm64 = "0.1.26"` to Vane workspace dependencies and lock it.
2. Add this plan's parity ledger to Vane developer documentation, including
   the Speet commit and explicit non-goals.
3. Add the `vane-aarch64` skeleton with a decode-only raw-word test that proves
   it uses `disarm64`.
4. Capture the exact `disarm64` generated variants used by Speet in comments or
   test metadata; do not infer them from mnemonics.

**Exit criterion:** no implementation uses another A64 decoder, and a decoder
smoke test can identify a known ADD, B, LDR, and SCVTF word.

### Phase 1 — Make shared execution state architecture-neutral

1. Introduce state-layout/configuration support in `vane-target-core`,
   `vane-arch`, the JS stack renderer, native StackOp interpreter, and
   `vane-meta-gen` runtime helpers.
2. Preserve RV64's public state property names, x0 behavior, generated source,
   and existing tests. Add direct compatibility tests before and after the
   refactor.
3. Add raw state slots, scratch handling, rotate/other minimally necessary
   generic scalar operations, and the A64 XZR/SP mapping helpers.
4. Add N/Z/C/V slots and exercise them with architecture-neutral state-host
   tests.

**Exit criterion:** one A64 trace can write/read X0, read XZR, use SP, and
branch on a synthetic flag condition without affecting RV64 behavior.

### Phase 2 — Integer/control flow

1. Implement fixed-width trace construction and `CheckCode` validation.
2. Lower ADDSUB, LOG, MOVEWIDE, BITFIELD, DP_2SRC/DP_3SRC, CONDSEL, ADR/ADRP,
   NZCV MRS/MSR, and BRK.
3. Lower B/BL/BR/BLR/RET, B.cond, CBZ, and CBNZ with proper link/flag state.
4. Add raw-word decode coverage and native/browser execution tests for every
   ledger row in these families.

**Exit criterion:** all non-memory/non-FP parity rows execute in both the
native StackOp interpreter and browser JS JIT.

### Phase 3 — Integer memory

1. Implement the six Speet-supported load/store operation classes, including
   all W/X widths, signed extension, register offset extension/shift rules,
   unscaled offsets, pair accesses, and pre/post-index writeback.
2. Reuse the existing `MemWidth` path where it exactly represents the access;
   add no A64-specific memory model to the decoder.
3. Add alignment/offset/writeback and pair-order tests.

**Exit criterion:** every required integer memory form has a raw decode case
and an execution assertion over Vane memory/state.

### Phase 4 — Scalar FP and conversions

1. Land the typed scalar-FP StackOp/runtime primitives with JS and native
   interpreter implementations in the same change set.
2. Implement FLOATDP1/2/3, FLOATIMM, FLOATSEL, FLOATCMP, and FLOAT2INT.
3. Add every merged int↔FP width form, bit-pattern FMOV tests, NaN/zero/
infinity tests, condition-flag tests, and f32 rounding-policy tests.
4. Document any deliberate semantic approximation in both Vane docs and the
   parity ledger.

**Exit criterion:** all scalar FP rows in §6 pass decode and execution tests;
no S/D or W/X merged-width case is covered only incidentally.

### Phase 5 — Public embedding and corpus hardening

1. Add an explicit AArch64 reactor/demo entry point built on the generalized
   runtime, without changing the current RV64 `Reactor` contract.
2. Add Vane-owned A64 micro-corpus browser tests and CI commands.
3. Update `vane/README.md` with supported A64 scope, unsupported classes, the
   `disarm64` policy, and exact test commands.
4. Record the completed Speet snapshot and audit date.

**Exit criterion:** users can select A64 deliberately, execute the supported
subset through Vane's JS JIT, and reproduce the parity suite without a local
Speet checkout.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| RISC-V x0 assumptions leak into A64 X0/XZR/SP handling | Land and test state-layout generalization before decoder work; explicit X0/XZR/SP tests are required. |
| `disarm64` merges different widths in one variant | Require raw-word cases for every encoding form and inspect generated qualifier metadata on each new arm. |
| FP work becomes an unreviewable renderer-only patch | Extend shared typed FP operations, JS renderer, and native interpreter atomically; every op gets execution coverage. |
| JS BigInt/Number mixing corrupts raw FP state | Store V state as raw bits and restrict number conversion to named typed operations. |
| Vane claims parity while Speet advances | Pin a reference commit, maintain a checked ledger, and audit it on decoder/Speet upgrades. |
| A64 corpus accidentally depends on Linux `svc` | Use Vane-owned microprograms ending in trap/state sentinels; syscall support is separate. |
| Generalizing `vane_meta!` breaks RV64's public ABI | Keep an RV64 compatibility configuration and add source/API regression tests before enabling A64. |
| Incomplete WASM renderer is mistaken for A64 failure | Scope acceptance to JS JIT and native StackOp interpreter; list `vane-target-wasm` as intentionally out of scope. |

## 11. Validation commands

Final command names will be recorded when the crates land. The expected shape
is:

```sh
# Native decode/lowering/interpreter coverage.
RUSTC_BOOTSTRAP=1 cargo test -p vane-aarch64

# Existing Vane regressions, including the shared renderer/interpreter.
RUSTC_BOOTSTRAP=1 cargo test -p vane-arch -p vane-riscv

# Browser JS JIT execution coverage.
wasm-pack test --headless --chrome crates/vane-aarch64
```

If the explicit A64 browser entry crate differs from `vane-aarch64`, use its
path in the final command and document it in `vane/README.md`. Warnings from
unrelated sibling workspaces are not acceptance failures; test failures,
unsupported parity cases, or changed RV64 generated output are.

## 12. Completion definition

This plan is complete when Vane has a separately selectable AArch64 frontend
using the same `disarm64` decoder version as Speet; its checked-in, raw-word
parity ledger covers every instruction family listed in §6; those forms lower
and execute through both Vane's StackOp interpreter and browser JavaScript JIT;
RV64 compatibility is preserved; and limitations outside the Speet reference
set are documented rather than silently treated as supported.

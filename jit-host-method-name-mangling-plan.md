# Configurable host-method names for WSDOM, Vane, and Jade JITs

## 1. Problem

The JavaScript emitted by the three projects assumes that the host-facing
property names are stable:

- `@wsdom` emits its wire/runtime protocol as `_w.g(...)`, `_w.s(...)`, etc.,
  and emits `obj.method(...)` for generated DOM bindings.
- `@vane` emits a JIT function against a `$` host object, using members such as
  `$.r`, `$.get_page(...)`, `$._sys(...)`, `$.ecall()`, and, when asynchronous
  memory is enabled, `$.reg_read(...)` / `$.mem_write(...)`.
- `@jade` emits JIT code against a `tenant` object, including
  `tenant.make/get/set/define/assign`, `tenant.driveTenant`, and
  `tenant.createGuestGen`.

A host build may property-mangle these interfaces. That is safe only when the
host and every emitted JIT body use the same replacement name. Today, a host
whose `tenant.get` became `tenant.a`, for example, either cannot run Jade JIT
output or must preserve the original property names as minifier reserves.

The goal is to let an embedder select a **consistent host-name scheme** while
preserving canonical output and hot-path performance for the normal,
unmangled host.

This is specifically an ABI-name facility, not a general JavaScript minifier:
it must rename only documented runtime-interface members owned by these
projects. Browser/platform APIs (`Object.create`, `Reflect.apply`,
`DataView#getUint32`, DOM APIs from `.d.ts`, etc.) and locally declared JIT
temporaries are out of scope.

## 2. Constraints and non-goals

1. A single compilation/run must use one complete scheme. Mixing canonical and
   mangled names for any member is an ABI error, not a supported fallback.
2. A mangled spelling is an arbitrary JavaScript property key, not necessarily
   an identifier. Emission must support both `receiver.a` and
   `receiver["not-an-identifier"]` safely.
3. The default output must retain its current direct-member spelling (for
   example, `tenant.get(...)`, not `tenant["get"](...)`) so engines retain the
   same inline-cache-friendly source shape and existing output tests remain
   meaningful.
4. Selecting names must not leave a map lookup, proxy, wrapper, or dynamic
   dispatch in the *emitted execution path*. Resolving a name while compiling
   source is acceptable; resolving it for every guest property operation is
   not.
5. Name configuration is not permission to rename generated local names
   (`v0`, `state`, `__ip`, `_t0`, `data`) or standard/global names. Vane's
   existing `Flate` remains responsible only for safe local identifier
   shortening.
6. Existing public entry points must remain canonical by default. Adoption by
   hosts that do not mangle must require no configuration and produce
   byte-equivalent output where practical.

## 3. Design: dependent-owned semantic names plus a generic static trait

Create a tiny shared `no_std + alloc` crate (working name:
`portal-jit-host-names`) in a repository that all three Rust workspaces can
consume. `codegen-utils-common` is the preferred home if it is intended to be
an independently versioned common dependency; otherwise make this a focused
new repository rather than making one of WSDOM, Vane, or Jade the owner of a
cross-project ABI.

The crate defines only safe JavaScript-member rendering and a **generic** name-resolution trait; it must not depend on SWC, wasm-bindgen, WSDOM, Vane, Jade, or their semantic method enums. Each dependent owns the enum that describes its own ABI, implements `Display` for its canonical spelling, and supplies that enum to the shared trait.

```rust
use core::fmt::Display;

/// Renders one already-resolved property access without concatenating raw JS.
pub trait PropertyAccess {
    fn emit_on(&self, receiver: &str, out: &mut String);
    fn emit_call(&self, receiver: &str, args_js: &str, out: &mut String);
}

/// Resolve a dependent-owned semantic key to a safe property-access renderer.
///
/// `Input` is intentionally generic: the host-name crate never imports or
/// enumerates WSDOM, Vane, or Jade method names.
pub trait HostMethodNames<Input: Display>: Clone + 'static {
    type Property: PropertyAccess;

    fn property(&self, input: Input) -> Result<Self::Property, MissingHostMethod>;
}

#[derive(Clone, Copy, Default)]
pub struct CanonicalHostMethodNames;
```

For example, Jade owns `enum JadeTenantMethod { Make, Get, ... }` and its
`Display` implementation writes `make`, `get`, and so on. WSDOM and Vane own
the corresponding protocol/runtime enums. This keeps additions local to the
project that owns the ABI rather than forcing the shared crate to depend on
all three workspaces.

`CanonicalHostMethodNames` implements `HostMethodNames<Input>` for every
`Input: Display`. Its returned canonical `PropertyAccess` converts the
formatted canonical key through the shared property-key encoder: an
identifier-safe key emits `.name`, while any unexpected non-identifier key
emits an escaped computed access. Thus the normal dependent-owned enums still
produce their current direct dotted output, but an arbitrary or erroneous
`Display` implementation cannot inject raw JavaScript. This is also why the
canonical implementation belongs safely in the name crate despite that crate
not knowing any dependent's names.

The API should expose `PropertyAccess::emit_on` / `emit_call` helpers rather
than leaking string concatenation into every backend. `JsMemberName` is an
implementation detail (or a public value behind `PropertyAccess`): it stores
either a validated `Dot` identifier or an owned/interned `Computed` property
key, whose string literal is escaped by the shared implementation. Never
interpolate a mapping as raw source.

Use dependent-owned semantic enums rather than string literals at JIT call
sites. They make each ABI inventory reviewable and make adding a new host call
a compiler-visible change without coupling the shared crate to the dependent:

```rust
// In jade-vm-jit, not portal-jit-host-names.
pub enum JadeTenantMethod {
    Make, Get, Set, Define, Assign,
    DriveTenant, CreateGuestGen,
}

impl Display for JadeTenantMethod { /* canonical ABI spelling */ }
```

The actual enum split follows ownership: WSDOM protocol methods, Vane-runtime
methods, and Jade tenant/driver methods are separate enums even though one
host-name scheme can implement `HostMethodNames<...>` for all of them.

### 3.1 Fast default and dynamic custom schemes

Use two forms of the trait implementation:

- `CanonicalHostMethodNames` is zero-sized and selected by the existing public
  APIs. It implements the generic trait for each dependent's `Input: Display`;
  generator calls are statically dispatched and its returned property renderer
  emits direct dotted access for the existing canonical enum spellings. There
  is no runtime name lookup in generated JavaScript.
- `MappedHostMethodNames` is an opt-in, validated table supplied by a host that
  knows its mangled ABI. It likewise implements `HostMethodNames<Input>`
  generically by using `input.to_string()` as the mapping's canonical key, so
  it needs no WSDOM/Vane/Jade dependency. Each dependent validates the table
  against *its own* complete enum inventory before compilation; `property`
  also returns `MissingHostMethod` rather than silently falling back if a key
  is absent. It is used while source is generated, then discarded. The
  generated source contains the resolved member spelling, so this slower setup
  path cannot affect guest/JIT execution.

Do **not** put `HashMap<String, String>` lookup in `tenant_drive`, Vane's
per-instruction renderer output, WSDOM's client runtime, or a JavaScript
`Proxy`. A compatibility adapter may accept a JSON/object mapping at a
wasm-bindgen boundary, but it must validate it once and convert it to
`MappedHostMethodNames` before compilation.

A configuration type can be generic with a default:

```rust
pub struct Config<N = CanonicalHostMethodNames> {
    pub names: N,
    // existing Jade flags, or project-specific options
}

pub fn compile_with_names<R, N>(
    code: &[u8], reg: R, cfg: Config<N>,
) -> Result<(String, R), String>
where
    N: HostMethodNames<JadeTenantMethod>,
{ /* ... */ }
```

Keep convenience functions such as Jade's current `compile(code, reg,
Config::default())` and Vane's current `jit_code` path bound to
`CanonicalHostMethodNames`. This avoids a default-host regression and keeps
normal callers source-compatible. Where a generic type would unnecessarily
infect a long-lived public WSDOM value type, keep the public `Browser` alias
canonical and provide a separately named/custom-source builder; the trait is
still consulted only while commands are serialized.

## 4. ABI inventory and ownership

Before changing code, turn the following into a checked inventory in the
**owning project** and document each key's owner and emitted form. The shared
crate deliberately has no knowledge of those enums. Search generated strings
as well as ordinary Rust/TypeScript call sites; code assembled by macros and
`format!` is the main source of omissions.

### 4.1 WSDOM

`wsdom-core/src/protocol.rs` owns the private wire-runtime members:

| Semantic key | Canonical emitted member |
|---|---|
| `Get`, `Delete`, `Set`, `Reply`, `Error`, `Catch`, `Import`, `RpcReply`, `Allocate` | `_w.g`, `_w.d`, `_w.s`, `_w.r`, `_w.e`, `_w.c`, `_w.x`, `_w.rp`, `_w.a` |

Update `wsdom-core/src/operations.rs` so `call_function_inner`, field access,
imports, and `JsValue::js_call_method` use emitted member helpers instead of
hard-coded `.{method_name}` / `_w.*` text. Update `wsdom/js/servant.ts` and
copies in examples/generated client code so `WSDOMCore` exposes exactly the
same selected names.

There are two deliberately different categories here:

- Protocol members are owned by WSDOM and are configurable.
- Names from TypeScript DOM definitions (`console.log`, `Element.append`, etc.)
  are external web-platform ABI and must stay literal. A method requested by a
  user through WSDOM's low-level `js_call_method("log", ...)` is likewise not
  automatically mangled.

If changing the generic `Browser` type is too broad, add an explicit
`HostNames`/command-emission context held by `BrowserInternal`. Its canonical
variant must write the same direct source as today; custom variants may be
resolved once per serialized command.

### 4.2 Vane

Vane has two producers of the `$` host ABI and they must share the exact same
name source:

1. `vane-arch/src/template.rs` (`render_stack_to_js` and `CoreJS`) emits JIT
   body calls and direct state access.
2. `vane-meta-gen/src/lib.rs` emits wasm-bindgen inline JS and the exported
   `Reactor` members that implement that ABI.
3. `vane-wsdom/src/lib.rs` bootstraps an independent browser-side `$` object;
   it must use the same scheme rather than its own literal object keys.

Initial Vane keys include `r`, `_r`, `p`, `_p`, `f`, `get_page`, `_sys`,
`ecall`, and the async-memory calls `reg_read`, `reg_write`, `mem_read`, and
`mem_write`. Confirm whether cache members (`p`/`_p`) and the injected `J`
dispatch helper are property keys or separately configurable global bindings;
keep the first version scoped to property methods unless a real mangled host
requires global-name mapping.

Thread `N: HostMethodNames` from `Params`/`CoreJS` into
`render_stack_to_js`, then through every constructor in `vane-meta-gen` and
`vane-wsdom`. Do not merge this with `Flate`: `Flate` changes local variables
such as `max64`/`data`, whereas host-method names are a cross-side ABI.

For the standard wasm-bindgen build, select canonical names statically. For a
WSDOM deployment, construct the same custom mapping for both the Rust emitter
and browser bootstrap before any block is compiled. A block compiled under one
mapping must never be cached and invoked after the mapping changes; name
scheme identity belongs in any future JIT-cache key.

### 4.3 Jade

Jade must use one `JadeTenantMethod` resolver across all textual JIT tiers:

- Tier 0 in `crates/jade-vm-jit/src/lib.rs`, including `op_litobj`,
  `define_properties`, `op_get`, `op_set`, `op_call`, and helper functions such
  as `tenant_drive`.
- Tier 1 in `crates/jade-vm-jit/src/reloop.rs`, which reuses the Tier-0
  per-operation emission and must receive the same generic config.
- Tier 2 in `crates/jade-vm-jit-swc/src/lib.rs`, which reparses Tier-0
  `ops_to_js` output. It must retain the concrete name configuration through
  `nested_body_compiler`; no tier may silently revert to canonical names.
- The wasm-bindgen JIT entry point in `crates/jade-vm-wasm/src/lib.rs`, which
  must accept/select the mapping before calling Tier 2 and creating the
  `Function`.

The initial configurable Jade methods are `make`, `get`, `set`, `define`,
`assign`, `driveTenant`, and `createGuestGen`. Audit tenant method calls in
`packages/jade-js/vm.ts` / `jade-data/index.ts` and the Rust WASM interpreter's
`tenant_call` / `tenant_drive` as a follow-up compatibility surface. They are
not all textual JIT calls today, but an embedder should not get a JIT that
honors mangling while its selected fallback/interpreter does not.

Keep special invariants intact:

- Every tenant operation remains a generator and is composed by the resolved
  `driveTenant` member; never fall back to raw `.next()`.
- `markGuestFn`, `invokeGuestAware`, `invokeTrap`, `createGuestGen`,
  `unpackGuestGen`, `yieldTenant`, and `driveTenant` remain non-inlinable
  tenant ABI helpers. This work changes the spelling of calls, not the
  `TENANT_METHOD_NAMES` inlining boundary.
- Inlined tenant source is supplied by the host's real class source. If the
  class itself was property-mangled, extraction and the configured JIT method
  keys must use the same mapping; otherwise disable that individual inline
  candidate and emit the resolved normal call.

## 5. Implementation sequence

1. **Specify and test the generic shared naming crate.** Define
   `PropertyAccess`, generic `HostMethodNames<Input: Display>`, canonical and
   mapped implementations, identifier validation, computed-property escaping,
   missing-key diagnostics, and a stable mapping serialization format. Keep
   WSDOM/Vane/Jade enums out of this crate; define and inventory them in their
   owning projects, then validate every required `Display` key at each
   project's configuration boundary. Include a version/fingerprint for a
   complete scheme.
2. **Migrate WSDOM protocol emission and client bootstrap together.** Replace
   protocol literals only; leave DOM/user-supplied methods alone. Add a
   canonical-output snapshot before and after the refactor.
3. **Migrate Vane rendering and all `$` providers.** Parameterize Vane source
   rendering, macro-generated inline JS, and WSDOM bootstrap in one change.
   Make cache ownership/mapping identity explicit.
4. **Migrate Jade Tier 0, then propagate the generic config to Tiers 1 and 2.**
   Centralize tenant call construction so there is no remaining
   `format!("tenant.<literal>")` emitter. Thread the same names through nested
   functions and the wasm JIT bridge.
5. **Cover Jade's fallback paths.** Decide and implement the public mapping
   input for the TypeScript VM and Rust WASM interpreter, or explicitly reject
   a mangled host before a fallback can be selected. Do not leave a silently
   incompatible fallback.
6. **Document host integration.** Publish the canonical key list, mapping JSON
   shape, scheme fingerprint rule, and minifier guidance: all participating
   host runtime definitions and every JIT compiler invocation must receive the
   same mapping.

## 6. Tests and acceptance criteria

### Shared crate

- `CanonicalHostMethodNames` implements `HostMethodNames<Input>` using only
  `Input: Display`; the crate compiles without WSDOM, Vane, or Jade types in
  its dependency graph.
- Each owning project proves its full enum inventory is accepted by both the
  canonical resolver and a complete mapped resolver; an incomplete map fails
  before code generation and identifies the dependent-owned canonical key.
- Canonical members render as dotted access exactly where they do today.
- Identifier-safe mangled members render as dotted access.
- Non-identifier, quote, backslash, Unicode, and reserved-word property keys
  render as a correct computed string-literal property access.

### WSDOM

- A canonical protocol round-trip remains byte-compatible and passes existing
  retrieve/RPC behavior.
- A deliberately mangled `WSDOMCore` implementation and matching Rust mapping
  can perform GET/SET/error/reply/import/RPC operations.
- A DOM call such as `console.log` is unchanged by the WSDOM mapping.

### Vane

- Snapshot canonical `jit_code` and `CoreJS` output before the migration; the
  canonical trait reproduces it.
- Execute a small RISC-V block under a host whose `$` ABI uses distinct,
  non-obvious names, in both default and `async_mem` modes.
- Repeat through `vane-wsdom` bootstrap to prove the server-rendered code and
  browser-side runtime agree.
- Verify switching mappings does not reuse a stale compiled-block cache entry.

### Jade

- For Tier 0, Tier 1 (when enabled), and Tier 2, compile GET/SET/LITOBJ/spread
  and function-call bytecode with a mangled tenant; execute it against a
  tenant exposing only mangled names.
- Cover sync, async, generator, and async-generator `driveTenant` paths plus
  `createGuestGen`.
- Compile a nested `FN` through Tier 2 and assert the nested source uses the
  same names as its outer function.
- Exercise both a non-inlined tenant call and an eligible inlined tenant
  method; verify unsupported/mismatched mangled source falls back to the
  resolved tenant call rather than miscompiling.
- Preserve the existing canonical string assertions and end-to-end browser
  tests.

Acceptance is reached when no owned host-interface spelling remains as a raw
literal in a JIT/codegen source path (except the canonical implementation and
tests), all three systems run with the same non-canonical mapping, and the
canonical configuration introduces no dynamic lookup or computed-property
access in emitted hot code.

## 7. Risks and decisions to settle before implementation

- **Shared-crate location/versioning:** decide whether `codegen-utils-common`
  is the durable shared home. The crate's generic `Display`-keyed mapping
  schema must be versioned independently of any one runtime; each runtime
  separately versions or validates its own required key inventory.
- **Mapping producer:** prefer a build-time/generated mapping from the host
  minifier over attempting to discover names at runtime. Runtime discovery is
  ## Implementation status

Implemented across the affected repositories:

- `@codegen-utils` now owns the `portal-jit-host-names` `no_std + alloc`
  crate, with generic `HostMethodNames<Input: Display>`, safe
  `PropertyAccess` rendering, canonical and mapped resolvers.
- `@jade` owns `JadeTenantMethod` and threads a generic resolver through Tier
  0, Tier 1, Tier 2, nested compilation, and the Tier 2 WASM entry point.
- `@vane` owns `VaneHostMethod`, supports named stack-operation rendering and
  `CoreJS::with_names`, and retains canonical wrappers for existing callers.
- `@wsdom` owns `WsdomMethod` and has validated safe `_w` protocol call/member
  helpers; existing canonical protocol constants remain compatible.

Each consumer validates its whole ABI inventory before source generation, and
all custom keys are emitted as direct identifiers or escaped computed property
accesses. The host and its producer must still select the same complete scheme
for a run.
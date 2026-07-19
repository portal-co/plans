# Plan: WSDOM host for the Jade VM

## Status

**Proposed — not implemented.**

This plan adds a server-side Rust host for Jade that executes Jade-generated
JavaScript in the browser attached through WSDOM. The public execution shapes
should match the existing `jade-vm-wasm` host—sync, async, generator, and async
generator—while respecting the fact that WSDOM values and control flow live on
the browser side. It supports both browser-resident tenants and
asynchronous, server-resident tenant implementations through a small shared
runtime imported from the `portal-co/wsdom` fork and driven by WSDOM callbacks.

The work spans `@jade` primarily and uses the `@portal-co/wsdom` fork's import
and callback facilities for the server-tenant bridge. It does not turn WSDOM into a bytecode
transport and does not duplicate Jade's TypeScript interpreter in Rust.

## 1. Goal and terminology

Today, `crates/jade-vm-wasm` provides `WasmPlatform`, a direct Rust bytecode
interpreter whose values are `wasm_bindgen::JsValue`s in the same JavaScript
realm as the WebAssembly module. It exports four entry points:

| WASM entry point | Effective execution shape |
| --- | --- |
| `run_virtualized` | synchronous value |
| `run_virtualized_a` | `Promise` |
| `run_virtualized_g` | iterator |
| `run_virtualized_ag` | async iterator |

The proposed `jade-vm-wsdom` crate gives Rust code driving a WSDOM
`Browser` the equivalent ability to execute Jade in the **connected browser**.
The Rust server retains remote handles (`wsdom::js_types::JsValue`); the
browser owns the actual JavaScript values, tenant, state, promises, iterators,
and execution stack.

The desired first-class workflow is:

```text
Rust server                         WSDOM browser
-----------                         -------------
Jade bytecode
  -> jade-vm-jit compile       JS function source
  -> WSDOM command ----------> construct and call function
                                tenant/state/globalThis execute locally
remote result handle <----------- _w stores result by ID
(optional retrieve/await) -----> browser resolves/serializes requested result
```

This is analogous to `vane-wsdom`'s server-hosts/browser-executes mode, but
Jade sends one compiled function invocation rather than tracing one RISC-V
basic block at a time.

## 2. Why this is JIT-backed rather than a literal `WasmPlatform` port

A direct port of `WasmPlatform` would use
`type Value = wsdom::JsValue` and implement `jade_vm_core::{State, Ops}`.
That is not sufficient and must not be presented as a complete host:

- WSDOM can enqueue `get`, `set`, arithmetic, and function-call expressions
  without a network roundtrip, but Rust cannot synchronously inspect the
  truthiness or numeric value of an unresolved remote `JsValue`.
- Jade's VM loop must inspect conditions for `CONDJMP`/`SWITCH`, comparison
  results, and generator/promise boundaries. Retrieving after every operation
  would introduce at least one network roundtrip per branch and would destroy
  WSDOM's roundtrip-free design.
- The existing Jade JIT already emits exactly the local browser-side loop,
  branch, tenant-driver, and function-call behavior needed here. It expects
  only lexical `tenant`, `nt`, `state`, and `globalThis` bindings.

Therefore Phase 1 executes JIT output in the browser. It is still a Jade host:
it owns the bytecode-to-executable path, state setup, variant selection,
remote-result types, and tenant ABI contract. The direct interpreter remains a
potential debugging/reference implementation only after an explicit design for
asynchronous remote control flow exists.

## 3. Scope and non-goals

### In scope

- A new `portal-solutions-jade-vm-wsdom` crate in the Jade workspace.
- Tier-0 Jade JIT compilation and browser-side execution through
  `px-wsdom`/`px-wsdom-core`.
- The four Jade execution variants and usable remote iterator helpers.
- Caller-supplied WSDOM tenant facade, `nt`, state, and global object values.
- Browser-resident Jade tenants and asynchronous server-resident tenants via
  an imported shared runtime, WSDOM callbacks, and browser-side Jade tenant
  facade.
- Canonical tenant names by default and custom
  `HostMethodNames<JadeTenantMethod>` mappings through the existing JIT
  configuration.
- Unit, protocol-level, and real WSDOM-browser end-to-end coverage.

### Explicitly out of scope for the first implementation

- Sending a Rust `WasmPlatform` interpreter operation-by-operation over
  WSDOM.
- Making `MultiTenant` or `single_tenant` magically available in a connected
  browser. The embedder must load/construct a tenant runtime before invoking
  Jade.
- Cross-browser/connection values or automatic transfer/serialization of a
  remote object handle.
- A general-purpose WSDOM RPC framework beyond the fork's existing import,
  generated RPC, and callback facilities, and the Jade-specific tenant adapter
  built on them.
- Replacing Jade's TypeScript VM, direct WASM host, Tier 1, or Tier 2.
- Supporting arbitrary untrusted JavaScript source. The only raw source this
  crate sends is Jade's own generated source plus fixed wrappers; dynamic data
  remains a `UseInJsCode` value or JSON serialization.
- Introducing a general WSDOM remote-object RPC abstraction. The small
  iterator API below is Jade-specific.

## 4. Existing contracts that the host must preserve

### 4.1 Jade tenant and generator-driver ABI

The JavaScript value passed to compiled Jade code as `tenant` must satisfy the
full `packages/jade-js/index.ts` `Tenant` interface. It may be either a native
browser tenant (such as `MultiTenant` or `single_tenant`) or the browser-side
facade for an asynchronous server tenant described in section 6. In both
cases, it includes the mixin methods injected by `guestAbiMixin`:

```text
make, get, set, define, assign,
markGuestFn, invokeGuestAware, invokeTrap,
createGuestGen, unpackGuestGen, yieldTenant, driveTenant
```

All tenant operations are generators. Generated code must retain the existing
rule that calls are driven as:

```js
tenant.driveTenant(tenant.get(object, key), addAsync, addGen)
```

No WSDOM host code or server-tenant adapter may call `.next()` on a raw tenant
operation or treat a `TenantOp` as its completed result. The browser executes
the Jade driver. For a server-resident tenant, the imported runtime forwards an
operation to a WSDOM callback and later settles its promise through the
per-request resolver/rejecter callback handles; `driveTenant` composes that
promise into the selected Jade variant.

### 4.2 Four effective variants

The JIT uses `Config.add_async`/`Config.add_gen` to emit `await` and/or
`yield*` at tenant and function boundaries. The WSDOM wrapper must use the
matching declaration form:

| Flags | Wrapper declaration | Immediate WSDOM handle represents |
| --- | --- | --- |
| neither | `function` | final value |
| async only | `async function` | `Promise` |
| generator only | `function*` | iterator |
| both | `async function*` | async iterator |

Calling an async/generator body through a plain `function` would make emitted
`await`/`yield*` invalid JavaScript. This mapping is a required invariant and
must be tested as source as well as end to end.

### 4.3 WSDOM ownership, ordering, and errors

`wsdom_core::JsValue` is a browser-local handle. Commands created through a
single `Browser` are batched in order, and the browser's `_w` heap owns the
value. The Jade host must:

1. Require all supplied `tenant`, `nt`, `state`, and optional explicit global
   values to belong to its `Browser` connection.
2. Never use a remote ID from another connection.
3. Return remote result handles immediately where possible; retrieval and
   promise settlement remain explicit async operations.
4. Preserve WSDOM's present error model: a remote throw becomes an error slot
   in `_w`; a later use/retrieval observes it. Do not falsely claim a typed
   server-side JavaScript exception unless WSDOM supplies one.

A tiny `Browser::same_connection(&self, other: &Browser) -> bool` helper,
implemented with `Arc::ptr_eq`, is an acceptable `wsdom-core` addition if no
existing public identity comparison can enforce item 1.

### 4.4 Safe source production and host-name mappings

`jade-vm-jit` already validates the complete `JadeTenantMethod` inventory and
uses `PropertyAccess` to render mapped member names safely. The WSDOM host must
forward the caller's `Config<N>` unchanged into compilation; it must not
reconstruct `tenant.foo` strings itself.

The selected map applies to the **Jade tenant ABI**, not WSDOM's private `_w`
protocol ABI. If an embedder also mangles WSDOM's protocol implementation, it
must separately use WSDOM's protocol-name facilities. A tenant mapping is valid
only when the browser tenant and all generated Jade functions use one complete,
identical scheme.

## 5. Proposed crate and public API

### 5.1 Placement and dependencies

Add a workspace member:

```text
jade/crates/jade-vm-wsdom
package: portal-solutions-jade-vm-wsdom
```

Initial dependencies:

```toml
portal-solutions-jade-vm = { path = "../jade-vm", features = ["alloc"] }
portal-solutions-jade-vm-jit = { path = "../jade-vm-jit" }
px-wsdom = { package = "px-wsdom", version = "0.0.6", git = "https://github.com/portal-co/wsdom.git" }
px-wsdom-core = { package = "px-wsdom-core", version = "0.0.6", git = "https://github.com/portal-co/wsdom.git" }
```

Use `https://github.com/portal-co/wsdom.git`, not the upstream
`wishawa/wsdom` remote. The repository-root Cargo patch must likewise patch
that fork URL to select the local `wsdom` checkout in development. `futures-util`
is appropriate for iterator/result helpers and tests. Do not make `axum` or
`tokio` a normal dependency: the crate accepts a `Browser` and works with
whichever WSDOM transport/executor the embedding application uses.

Add optional `tier1`/`tier2` features only after their entry-point semantics
are deliberately made equivalent to Tier 0; the Phase-1 default is Tier 0.

### 5.2 Runtime/context object

Use a context object rather than a large positional-function API:

```rust
pub struct WsdomRuntime {
    browser: wsdom::Browser,
    tenant: wsdom::js_types::JsValue,
    nt: wsdom::js_types::JsValue,
    global_this: wsdom::js_types::JsValue,
}

pub struct RunOptions<N = CanonicalHostMethodNames> {
    pub ip: u32,
    pub add_async: bool,
    pub add_gen: bool,
    pub names: N,
}
```

`WsdomRuntime::new` constructs the browser-tenant form and validates that all
three remote values belong to `browser`. `install_server_tenant` imports the
fork-provided shared runtime, wires its callback handles, constructs the
server-tenant facade, and performs the same connection/capability validation.
Provide `WsdomRuntime::default_state()` to allocate `Object.create(null)` in
the connected browser, and an explicit state-taking call for callers that need
to preserve or inspect state across invocations.

The public methods should separate compile/setup errors from remote execution
results:

```rust
impl WsdomRuntime {
    pub fn run_virtualized<N>(
        &self,
        code: &[u8],
        state: &JsValue,
        options: RunOptions<N>,
    ) -> Result<JsValue, WsdomJadeError>
    where N: HostMethodNames<JadeTenantMethod>;

    pub fn run_virtualized_a<N>(...) -> Result<RemotePromise, WsdomJadeError>;
    pub fn run_virtualized_g<N>(...) -> Result<RemoteGenerator, WsdomJadeError>;
    pub fn run_virtualized_ag<N>(...) -> Result<RemoteAsyncGenerator, WsdomJadeError>;
}
```

`RemotePromise` may initially be a transparent newtype over `JsValue`, with an
`IntoFuture`/`await_value` convenience that delegates to WSDOM's existing
`JsValue::into_future`. Newtypes make the returned shape clear and leave room
for later diagnostics.

`WsdomJadeError` covers local compilation, malformed bytecode/start offsets,
and cross-connection values. It does not pretend to contain arbitrary remote
JavaScript exceptions; WSDOM's remote exception `JsValue` is surfaced by the
operation that retrieves/awaits it.

### 5.3 Source wrapper and arbitrary start offsets

Factor the existing Tier-0 compile function into a public,
backwards-compatible entry point such as:

```rust
pub fn compile_from<R, N>(
    code: &[u8],
    start_ip: usize,
    registry: R,
    config: Config<N>,
) -> Result<(String, R), String>
```

`compile` remains `compile_from(code, 0, ...)`. This uses the existing
`emit_program(..., start_ip)` and `discover_blocks` machinery rather than
copying a bytecode dispatcher into `jade-vm-wsdom`. It gives the WSDOM host the
same useful `ip` capability as the WASM entry points. Tier 1/Tier 2 may only
advertise arbitrary `ip` when they implement it with the same behavior.

For a result `body` plus `VecRegistry::prelude()`, WSDOM evaluates one trusted
expression of this shape (illustrative formatting only):

```js
(function (tenant, nt, state, globalThis) {
  /* VecRegistry prelude: nested guest-function declarations */
  /* Jade compiled body, ending in return */
})(REMOTE_TENANT, REMOTE_NT, REMOTE_STATE, REMOTE_GLOBAL)
```

Choose `function`, `async function`, `function*`, or `async function*` from
`RunOptions` before immediately invoking it. Passing `globalThis` as a lexical
parameter is intentional: it gives `GLOBAL` bytecode the caller-selected realm
value just as `jade-vm-wasm` does, while nested functions close over that
binding.

The crate may use a private `Display` adapter over `UseInJsCode` (as
`vane-wsdom` does) to interpolate remote handles into fixed generated source.
It must never expose WSDOM's crate-private raw-code writer or emit user text as
raw syntax.

### 5.4 Remote generator API

A raw remote iterator `JsValue` is not ergonomic: its `{ value, done }` result
remains in the browser and an async generator's `next()` returns a promise.
Provide a minimal Jade-facing API:

```rust
pub struct RemoteGenerator { /* remote iterator handle + browser */ }
pub struct RemoteAsyncGenerator { /* remote async-iterator handle + browser */ }
pub struct RemoteIterResult {
    pub value: JsValue,
    pub done: bool,
}

impl RemoteGenerator {
    pub fn next_raw(&self, sent: Option<&dyn UseInJsCode>) -> JsValue;
    pub async fn next(&self, sent: Option<&dyn UseInJsCode>)
        -> Result<RemoteIterResult, RemoteJsError>;
    pub fn return_raw(&self, value: Option<&dyn UseInJsCode>) -> JsValue;
    pub fn throw_raw(&self, value: &dyn UseInJsCode) -> JsValue;
}
```

`RemoteAsyncGenerator::next` first awaits the remote promise, then reads the
remote `done` and `value` fields. The synchronous type performs the same
field extraction without promise settlement. `value` intentionally remains a
remote `JsValue`; callers opt into `retrieve_json`, `retrieve_int`, etc. only
when they actually need to cross the network.

Implement calls using fixed, static member syntax for `next`, `return`, and
`throw`; those are ECMAScript iterator protocol methods, not Jade host ABI
members and are not part of configurable host-method mapping.

## 6. Tenant provisioning and the callback-driven server-tenant bridge

The `portal-co/wsdom` fork provides two building blocks that this host must
compose deliberately:

1. **Imported shared runtime.** `wsdom-gen` emits a frozen `_w.x` import table,
   and `Browser::import(name)` resolves a named import by its SHA-3-derived key
   and caches the WSDOM handle. Jade supplies one small, versioned
   `jade-wsdom-tenant-runtime` module as a normal WSDOM import rather than
   placing an ad-hoc tenant implementation in every embedding page.
2. **Callbacks for the reverse direction.** `callback::new_callback` creates a
   browser function and a Rust `Stream`. A browser call queues its argument in
   a browser array and notifies Rust through `_w.r`; polling the stream yields
   the original browser `JsValue`. The generated WSDOM client also has
   promise-style RPC methods settled through `_w.rp` callbacks. Jade uses these
   callback handles for request delivery and explicit resolve/reject settlement.

This is the material fork behavior to rely on. Compared with upstream, the
fork provides import lookup/caching, a hardened generated client with private
state and frozen API/import objects, queued pre-open messages, and callback
promise RPC. Jade must use the `portal-co/wsdom` remote, but must not invent a
second raw-WebSocket protocol or treat `_w.x` as a place to inject server tenant
business logic.

`jade-vm-wsdom` supports two tenant modes per connection:

| Mode | Tenant storage/logic | Browser-side JIT value | Supported variants |
| --- | --- | --- | --- |
| **Browser tenant** | Browser module, e.g. `MultiTenant` or `single_tenant` | Real tenant object | All four |
| **Server async tenant** | Rust server's separate value system | Jade facade from imported shared runtime; operations issue callback requests and yield promises | Async and async-generator in Phase 1; sync/generator only after a nonblocking `next()` design exists |

### 6.1 Imported runtime and callback wiring

The imported `jade-wsdom-tenant-runtime` is the only server-tenant-specific
browser code. It is small, shared, and versioned with the Jade browser package;
it holds neither server tenant state nor tenant business logic. Installation
obtains it with `browser.import("jade-wsdom-tenant-runtime")` and supplies
callback functions created with `callback::new_callback`:

| Callback | Browser → Rust payload | Rust → browser effect |
| --- | --- | --- |
| `request` | `{ capability, requestId, operation, args }` | Its stream delivers the request to the server tenant dispatcher. |
| `release` | `{ capability, serverValueIds }` | Dispatcher decrements/drops server-value references. |

For each pending request, Rust creates a fresh pair of settlement callbacks:
`resolve(requestId, value)` and `reject(requestId, error)`. It passes those
functions to the request call, and the imported runtime retains the pair until
it settles the corresponding promise. This follows the actual WSDOM callback
contract—callbacks carry browser-to-Rust arguments; Rust calls their remote
function handles to send a response—without assuming a nonexistent global
server-to-browser callback registry.

Callback signatures must use generated WSDOM TypeScript bindings or a small,
audited binding—not raw formatted JavaScript. The installation API gives the
runtime those handles and an opaque connection-scoped capability. The runtime
constructs a Jade `Tenant` facade with generator operations:

```js
function* get(object, key) {
  return yield bridge.request("get", [object, key]);
}
```

`bridge.request` allocates a request ID, creates the settlement callback pair,
invokes the `request` callback with safe descriptors plus that pair, and returns
a browser `Promise`. The current `packages/jade-js` `guestAbiMixin` supplies `yieldTenant` and
`driveTenant`; `tenant.driveTenant(tenant.get(...), true, false)` therefore
awaits the promise, while `true, true` composes it in an async generator. The
runtime must use current Jade package helpers, never Rust-embedded stale source.

The Rust dispatcher consumes the request callback stream asynchronously,
validates capability and request ID, invokes `AsyncTenant`, then calls exactly
one of the callback pair's remote function handles. Its pending-request table
rejects duplicate settlements, unknown requests, cross-connection capabilities,
and post-teardown messages before they reach the tenant.

### 6.2 Explicit server-value system and browser shims

Server tenant values are not browser JavaScript values and are not WSDOM `_w`
heap handles. Model that boundary explicitly:

```text
browser JavaScript value <-> BrowserValue (WSDOM JsValue handle)
server tenant value      <-> ServerValueId + tenant/connection capability
browser server-value     <-> opaque ServerValueShim
```

`ServerValueId` is allocated per server-tenant installation. A Rust
`ServerValueStore` maps it to the tenant's actual value plus reference/liveness
metadata. It is never JSON-serialized, never reused across tenants or
connections, and is distinct from a WSDOM remote-value ID.

When a server operation returns a server value, `resolve` receives a small
server-value descriptor. The shared runtime encapsulates it as an opaque,
frozen/null-prototype shim and records the descriptor in a private `WeakMap`:

```js
// conceptual only; the descriptor belongs in the runtime's private WeakMap
{ __jadeWsdomServerValue: capability, id }
```

Only the bridge may unwrap the shim to `{ capability, id }` for a later request.
Guest code must not be able to forge or mutate a server token by copying public
fields. A private `WeakMap` is preferred to trusting an object-shaped marker.

Arguments use a tagged representation:

| Source value | Request representation | Dispatcher treatment |
| --- | --- | --- |
| Server shim | `{ kind: "server", capability, id }` | Validate and look up `ServerValueStore`. |
| Browser-local value | `{ kind: "browser", value }` | Preserve as callback-delivered WSDOM `JsValue`; never JSON-copy it. |
| Primitive / `undefined` / `null` | Explicit tagged primitive | Decode without mistaking it for a server ID. |

Browser values travel as callback arguments/WSDOM handles, not JSON embedded in
the descriptor. Server values travel only as shims. This makes ownership,
identity, capability checks, liveness, and cleanup explicit and testable.
`release` batches discarded shim IDs; disconnect invalidates the capability and
drains pending requests and the value store. Correctness cannot depend on a
finalizer running promptly.

### 6.3 Server tenant API and variant constraints

Server tenants are a Phase-1 capability, not a future convenience. The adapter
boundary is approximately:

```rust
#[async_trait]
pub trait AsyncTenant {
    type Value;

    async fn make(&self, request: TenantRequest) -> Result<Self::Value, TenantError>;
    async fn get(&self, request: TenantRequest) -> Result<Self::Value, TenantError>;
    async fn set(&self, request: TenantRequest) -> Result<(), TenantError>;
    async fn define(&self, request: TenantRequest) -> Result<(), TenantError>;
    async fn assign(&self, request: TenantRequest) -> Result<(), TenantError>;
    // Stabilize only after inventorying all reachable Jade tenant operations.
}
```

`TenantRequest` decodes tagged arguments into `ServerValueRef`, browser
`JsValue` handles, and primitives. A result becomes a server-value shim or an
explicit primitive/browser result; it is never silently a `serde_json` copy.
The JIT directly emits `make`/`get`/`set`/`define`/`assign`/`driveTenant`/
`createGuestGen`, while reachable helper paths can require `ownKeys`,
`invokeGuestAware`, and `invokeTrap`. The adapter must implement every
reachable operation or reject the workload before execution; it cannot claim
`MultiTenant` parity while only supporting GET/SET.

Phase 1 requires `add_async = true` for a server tenant and rejects sync use
before any WSDOM command is emitted. `add_gen = true` is supported with async;
the normal async-generator driver awaits runtime promises. A pure synchronous
generator remains unsupported until its request/`next()` boundary can be
preserved without blocking.

### 6.4 Browser-resident provisioning, mappings, and teardown

The browser mode remains useful for zero-latency operations and is required for
sync and ordinary-generator calls:

```js
import { MultiTenant } from "@portal-solutions/jade-js";
globalThis.jadeTenant = new MultiTenant();
```

```rust
let tenant = browser.value_from_pure_raw_code("globalThis.jadeTenant");
let global_this = browser.value_from_pure_raw_code("globalThis");
let nt = browser.value_from_raw_code(format_args!("undefined"));
let runtime = WsdomRuntime::new(browser.clone(), tenant, nt, global_this)?;
```

- The runtime operation table is keyed by Jade semantic tenant methods, not raw
  property strings. `RunOptions.names` renders calls on the facade; the facade
  and imported runtime install the same complete mapping.
- WSDOM `_w` protocol mappings are independent. The import/callback machinery
  resolves its protocol members through WSDOM's resolver facilities.
- Every request, shim, and release includes the capability. The dispatcher
  validates it before accessing `ServerValueStore` or calling `AsyncTenant`.
- Success resolves a tagged primitive, browser value, or server shim; failure
  rejects with a browser error. `driveTenant` controls the resulting Jade throw,
  promise rejection, or async-generator observation.
- Cancellation/disconnect invalidates the capability, drains callback queues
  and pending requests, and drops server values. It must not settle a promise
  or call the tenant after teardown.

`install_browser_tenant` and `install_server_tenant` are welcome convenience
APIs. The latter imports the shared runtime and wires callbacks as above;
neither may embed a stale tenant or driver source in Rust.

## 7. Implementation phases

### Phase 0 — write down and lock the executable contract

1. Add this plan and cross-link it from Jade's README/agent notes when work
   begins.
2. Confirm the two initial tenant modes: a browser-resident tenant and the
   portal-co fork's imported shared runtime plus callback-driven asynchronous
   server tenant. Jade does not own a WebSocket server.
3. Document the exact fork import resolution, generated RPC/callback request,
   reply, cancellation, and remote-value-identity APIs. Specify the separate
   `ServerValueStore`, browser shim, capability, and release contract before
   naming the Rust `AsyncTenant` adapter methods.
4. Add small compile-only tests proving the existing Tier-0 wrapper can be
   made `function`/`async function`/`function*`/`async function*` with free
   `tenant`, `nt`, `state`, and lexical `globalThis` bindings.
5. Decide whether a same-connection check is exposed by `wsdom-core`; add the
   tiny identity method there only if needed.

**Exit criterion:** the public API does not promise an impossible synchronous
Rust interpreter or implicit tenant installation; it explicitly supports a
browser tenant and the fork-backed async server tenant.

### Phase 1 — Tier-0 browser invocation

1. Add `jade-vm-wsdom` to `jade/Cargo.toml` workspace members and add its
   manifest/dependencies.
2. Factor `jade-vm-jit::compile_from` out of the current `compile` path without
   changing the canonical `compile(code, reg, Config::default())` output.
3. Implement `WsdomRuntime`, connection validation, `default_state`, and a
   trusted expression builder that combines `VecRegistry::prelude()` with the
   compiled body.
4. Implement canonical `run_virtualized` at an arbitrary validated `ip`.
   It must compile once, enqueue a single browser-side function construction
   and invocation expression, and return the result handle without retrieval.
5. Add `_with_names` or generic `RunOptions<N>` support from the beginning;
   do not add a separate, hard-coded tenant-member emitter.
6. Implement `install_server_tenant`: import the shared runtime; create and
   wire request/release streams plus per-request resolve/reject callback pairs;
   construct the facade from current Jade package helpers; and reject non-async
   `RunOptions` before sending a command. Add source-shape tests for its
   promise-yielding generator operations and opaque server-value shims.
7. Write source-shape tests for:
   - canonical `tenant.driveTenant(tenant.get(...))` output;
   - a computed mapped member such as `tenant["not-a-name"](...)`;
   - prelude plus nested `FN` registration remaining lexically visible;
   - provided `globalThis` parameter shadowing the browser global correctly.

**Exit criterion:** a sync program containing literals, branches, object
literal/`GET`/`SET`, `GLOBAL`, and nested synchronous functions can execute in
a WSDOM browser with a supplied browser tenant, and its final primitive can be
retrieved from Rust. An async object program can execute through the imported
server-tenant facade, with each operation delivered through its request callback
stream and settled through that request's resolve/reject callback pair. Server
values remain opaque browser shims mapped to the installation's
`ServerValueStore`.

### Phase 2 — async and generator variants

1. Implement `run_virtualized_a` using `Config.add_async = true` and an
   `async function` wrapper. Return the remote promise immediately.
2. Implement `RemotePromise` settlement helpers using WSDOM's `IntoFuture`.
3. Implement `run_virtualized_g` and `RemoteGenerator`, including `next`,
   `return`, and `throw`; preserve remote yielded values instead of eagerly
   serializing them.
4. Implement `run_virtualized_ag` and `RemoteAsyncGenerator`, awaiting each
   remote `next()` promise before extracting `{ value, done }`.
5. Exercise tenant-driver behavior in every effective variant—especially
   `make`/`get`/`set`/`define`/`assign`, `createGuestGen`, `YIELDSTAR`, and the
   declared-generator-plus-ambient-generator `doubleGen` through-tag rule.
6. Exercise a server-side `AsyncTenant` through the imported runtime and its
   callback streams, including a successful server-value shim, a browser-value
   identity roundtrip, an `undefined` mutation result, tenant rejection, shim
   release, and connection teardown with an outstanding request.

**Exit criterion:** each remote shape behaves like the matching Jade JS/WASM
entry point when driven from Rust, including completion, values, and errors
observable through WSDOM's established error semantics.

### Phase 3 — integration harness and regression matrix

1. Create an integration test application using `wsdom-axum` (or WSDOM's
   existing transport fixture) and a headless browser page containing the
   WSDOM servant, a Jade browser tenant, the imported Jade shared runtime, and
   its callback wiring for the server-tenant facade.
2. Keep the browser test tenant intentionally minimal but conformant: it must
   use real generator operations and a real `driveTenant`, not plain methods.
   Add a bundled real `MultiTenant` smoke test once a browser bundle exists.
   Add a Rust `AsyncTenant` fixture that owns at least object construction,
   GET, SET, DEFINE, and ASSIGN and verifies that remote browser values retain
   identity across a callback roundtrip and that server values remain opaque
   shims mapped through `ServerValueId`, not JSON copies.
3. Cover at least:
   - literal/branch/loop execution;
   - state reuse across independent invocations;
   - `GLOBAL` with an explicitly supplied remote global object;
   - tenant isolation and object `LITOBJ`/`GET`/`SET`;
   - nested Jade `FN` and remote function invocation;
   - async browser-tenant promise composition and an imported server-side
     async tenant driven through callback request and per-request settlement flows,
     including server-shim identity, browser-value identity, error rejection,
     release, and cancellation on disconnect;
   - sync and async iterator iteration, yield, completion, and `YIELDSTAR`;
   - incomplete/custom tenant-name maps failing before a WSDOM command is
     emitted;
   - accidental tenant/state/global handles from a second WSDOM connection
     failing locally.
4. Add an explicit disconnect/error test. It should assert the documented
   WSDOM behavior rather than hanging indefinitely in CI.

**Exit criterion:** CI proves the complete Rust-server → WSDOM-browser path,
not merely JIT source snapshots or a locally evaluated browser function.

### Phase 4 — optional optimized tiers and ergonomics

1. Add an explicit `ExecutionTier` selection only after Tier 1 and Tier 2
   offer the same `start_ip`, nested-function, name-map, and four-variant
   guarantees. Tier 0 remains the correctness baseline.
2. Add a `jade-vm-wsdom-axum` example/application crate only if common server
   setup warrants it; keep `jade-vm-wsdom` transport-agnostic.
3. If a maintained browser bundle of `jade-js` exists, add opt-in helpers for
   browser-tenant installation and shared-runtime/callback server-tenant
   installation, plus a version/ABI compatibility check. Neither helper may
   silently inject a stale tenant implementation.
4. Consider a server-side compile cache keyed by bytecode bytes, `ip`, variant,
   tier, tenant-name scheme, and tenant-inlining source/version. The cache must
   store source only; each call still binds the correct connection's remote
   values.

### Phase 1 implementation status

The Tier-0 browser host baseline is implemented:

- `jade-vm-wsdom` is a transport-agnostic workspace crate using
  `https://github.com/portal-co/wsdom.git` and the matching repository-root
  Cargo patch.
- It compiles Tier-0 code once with `compile_from_variant`, evaluates the
  trusted wrapper in a WSDOM browser, supports arbitrary bytecode offsets,
  canonical or mapped tenant names, and returns typed sync/promise/generator/
  async-generator remote handles.
- `RemoteGenerator` and `RemoteAsyncGenerator` expose `next`/`return`/`throw`
  remote operations while leaving values browser-local until explicitly
  retrieved.
- `wsdom-core::Browser::same_connection` rejects cross-browser tenant/state/
  global values before source is emitted.
- The Jade browser package now contains the importable
  `@portal-solutions/jade-js/wsdom-tenant-runtime`. It builds an opaque,
  callback-driven server facade from current `guestAbiMixin` helpers, maintains
  private `WeakMap` server-value shims, and forwards request/release messages.
- Rust has `install_server_tenant`, which imports the shared runtime, creates
  request/release `callback::new_callback` streams, supplies the runtime with
  their browser functions and a connection-scoped capability, and returns the
  installation for an application dispatcher to consume. Each request carries
  its own resolver/rejecter callback handles.
- Rust also has the initial explicit `ServerValueStore`, `ServerValueId`,
  browser/primitive/server argument boundary, and `AsyncTenant` adapter trait.
  A real-browser dispatcher integration test—which decodes callback requests,
  validates the capability, invokes `AsyncTenant`, and settles the resolver or
  rejecter—is the remaining Phase-1 slice.

### Phase 4 implementation status

`ExecutionTier` is now public on `RunOptions`:

- `Tier0` remains the default correctness baseline.
- `Tier1` uses the `ssa-reloop2` structured-control-flow pipeline, now with
  arbitrary entry offsets and top-level async/generator wrapper context.
- Opt-in `tier2` uses `jade-vm-jit-swc`; its new variant-aware entry point
  supports the same offset/wrapper contract. Select it by enabling
  `portal-solutions-jade-vm-wsdom`'s `tier2` feature.

The browser integration suite in
`crates/jade-vm-e2e-tests/tests/wsdom_browser.rs` is intentionally serverless:
its real browser page runs an in-page WSDOM servant and Rust pumps the generic
`Browser` stream through an imported JS bridge. It covers actual Tier 0, Tier
1, and (under the feature) Tier 2 source execution rather than source-shape
`RemotePromise` implements `IntoFuture`, so the Tier-1/Tier-2 async wrappers
are tested through WSDOM's actual promise-settlement bridge rather than merely
checking that a remote promise object was created. Run it with:

```sh
CHROMEDRIVER=/path/to/chromedriver \
  wasm-pack test --headless --chrome jade/crates/jade-vm-e2e-tests \
  --test wsdom_browser --features tier2
```

## 8. Testing and validation commands

During implementation, run at least:

```sh
cargo test --manifest-path jade/crates/jade-vm-jit/Cargo.toml --lib
cargo check --manifest-path jade/crates/jade-vm-jit/Cargo.toml --features reloop
cargo test --manifest-path jade/crates/jade-vm-wsdom/Cargo.toml
cargo test --manifest-path wsdom/wsdom-core/Cargo.toml --lib
```

Run the new browser integration suite with its documented headless-browser
command. It must be a separate, opt-in CI target when browser tooling is not
available locally, but it is required before declaring WSDOM support complete.

Run `git diff --check` in both `jade` and `wsdom`. If the new crate changes
Jade's package/lockfile graph, validate the standalone Git dependency path as
well as the repository-root local `[patch]` path.

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A direct Rust port works only for straight-line code and silently stalls/branches incorrectly on remote values. | Make JIT-backed browser execution the baseline; do not implement a partial `State + Ops<JsValue>` host as the public path. |
| Tenant operations return generators/promises and are mistaken for values. | Reuse emitted `tenant.driveTenant` calls; test all four variants against the actual driver. |
| Generated async/generator body is wrapped in the wrong function kind. | Centralize wrapper-kind selection and cover each syntax/execution shape. |
| A remote value from another browser corrupts `_w` heap access. | Validate browser identity in runtime construction and every supplied state/input handle. |
| User/configuration text becomes raw JS source. | Only compiler-produced source and fixed wrappers are raw; serialize values through WSDOM and use existing safe host-name renderers. |
| A browser page lacks Jade's tenant runtime or the shared server runtime. | Support explicit browser provisioning and a first-class `install_server_tenant` that imports Jade's shared runtime and wires callbacks from the current package, never stale Rust-embedded source. |
| Server and browser values are conflated, copied as JSON, or a forged shim reaches a tenant. | Keep `ServerValueStore` separate from WSDOM handles; use private `WeakMap` shims, tagged requests, capabilities, and identity/forgery tests. |
| The server tenant is accidentally used through Jade's synchronous contract. | Require `add_async`; reject sync server-tenant execution before dispatch and test the diagnostic. |
| Callback responses are settled twice or target the wrong request. | Make resolver/rejecter callbacks per-request, retain them in the runtime pending table, and test duplicate/unknown request rejection. |
| WSDOM error/retrieval limitations obscure browser exceptions. | Preserve native WSDOM semantics, expose remote error handles, and test disconnect/error behavior instead of inventing inaccurate typed errors. |
| Tier-2 inlining or generated prelude changes lexical behavior. | Start at Tier 0, concatenate registry prelude inside the same wrapper scope, and make higher tiers opt-in only after parity tests. |

## 10. Acceptance criteria

The plan is complete when all of the following are true:

1. `jade-vm-wsdom` is a documented public Jade workspace crate, with no server
   framework dependency.
2. A Rust WSDOM server can supply either a browser-resident Jade tenant or an
   imported, callback-driven asynchronous server tenant with a separate
   server-value store and opaque browser shims, and execute bytecode at a
   selected entry offset without per-op network roundtrips.
3. The sync, async, generator, and async-generator APIs have explicit remote
   result types and correctly preserve Jade's tenant-driver semantics; the
   server-tenant mode explicitly accepts async/async-generator execution and
   rejects unsupported synchronous shapes locally.
4. The canonical JIT output remains unchanged for existing hosts, and a custom
   complete `JadeTenantMethod` mapping works with WSDOM execution—including
   safely escaped computed property names.
5. All remote handles are connection-validated, all generated source is
   trusted/safely assembled, and remote JavaScript errors retain WSDOM's
   documented behavior.
6. Automated real-browser WSDOM integration tests cover the variant matrix,
   state/object behavior, nested functions, a browser tenant, and a
   fork-imported asynchronous server tenant, callback request/settlement flows,
   opaque server-value shims, remote errors, and disconnect behavior.
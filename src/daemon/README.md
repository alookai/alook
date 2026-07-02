# @alook/daemon

A **pure, host-neutral agent-runtime "driver" abstraction** in TypeScript.

It documents — as compilable code — how a host adapts many different AI coding
runtimes (Claude Code, Codex, Gemini, Kimi, Pi, Copilot, Cursor, OpenCode,
Antigravity) behind one uniform interface, and how it delivers messages into a
running agent (the "steering" mechanism).

The backend hardcodes **no specific host platform**. The agent always invokes a
stable CLI name (`alook`); `cliTransport.ts` writes a small wrapper by that
name into a per-launch state dir, prepends it to `PATH`, and forwards to the
host's real `targetCommand` — **decoupling the agent-facing name from the host's
real binary** (the host can rename/relocate its CLI without touching the agent
surface). It also injects an `ALOOK_*` env contract. The default
`MOCK_CLI_CONFIG` wires no `targetCommand` (the wrapper errors if invoked); a
real deployment passes its own `CliTransportConfig` (CLI name, env prefix,
`targetCommand`) and its own system-prompt communication guide. The abstraction
is what's reusable — plug in whatever host you like.

> **Provenance.** The shapes, protocols, flag strings, and control flow here were
> derived by studying how production agent-runtime daemons drive these CLIs, then
> re-expressed as a tidy, generic abstraction. It is original code, not a copy of
> any vendor source, and carries no platform-specific glue.

---

## The big idea

The daemon never speaks a runtime's native protocol directly. Each runtime is
wrapped by a **`Driver`** (`src/types.ts`) that knows how to:

1. **`spawn`** (or `createSession`) — launch the runtime,
2. **`encodeStdinMessage`** — encode an outgoing user message for the runtime's
   input channel,
3. **`parseLine`** — normalize the runtime's output into a tiny shared event
   vocabulary (`ParsedEvent`: `session_init`, `thinking`, `text`, `tool_call`,
   `tool_output`, `compaction_*`, `turn_end`, `error`, `telemetry`).

A generic **session host** then runs the process and fans `ParsedEvent`s out to
the daemon:

- `ChildProcessRuntimeSession` (`src/runtime/runtimeSession.ts`) for CLI runtimes.
- `SdkRuntimeSession` (`src/runtime/sdkRuntimeSession.ts`) for in-process SDK
  runtimes (pi).

Because everything downstream consumes the same `ParsedEvent` stream and the
same `Driver` capability flags, the rest of the daemon is transport-agnostic.

---

## Two delivery models (the heart of it)

When a message arrives, what happens depends on the runtime's lifecycle:

### Persistent runtimes (claude, codex, kimi, pi)
One long-lived process spans many turns. A new message is **written onto the
still-open input channel** — no restart. This is "steering."

- **`direct`** (codex, kimi, pi): write immediately; the runtime
  tolerates injection any time.
- **`gated`** (claude): a raw write mid-stream could collide with an active
  signed thinking block, so writes are **held until a safe boundary**. Two state
  machines implement this:
  - `RuntimeTurnState` (`src/runtime/turnState.ts`) — the instantaneous gate:
    `canSteerBusy = currentTurnId && !steeringGateActive`. Tool boundary closes
    the gate; progress / turn-start reopens it.
  - `apmStateMachine` (`src/runtime/apmStateMachine.ts`) — the policy reducers
    that decide *when* to flush queued inbox notices and emit the concrete
    `notify_stdin` / `deliver_stdin` effects (clause `SMR-002`). Flushing is
    blocked while `outstanding_tool_uses > 0`, while `compacting`, while
    `reviewing` (Codex review mode), or when `tool_boundary_flush_disabled`.
    Compaction *and* review exit are treated as safe flush boundaries.

For Claude specifically, the input channel is **stream-json**: the process is
launched with `--input-format stream-json --output-format stream-json
--include-partial-messages`, and each message is one NDJSON line
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}`.

### Per-turn runtimes (gemini, copilot, cursor, opencode, antigravity)
The process handles exactly one turn and exits. `supportsStdinNotification` is
`false` and `encodeStdinMessage` returns `null`. A new message means a **brand-new
process**; the agent re-checks the inbox each wake (`messageNotificationStyle:
"poll"`). `opencode` is a special per-turn case: it defers spawning until a
concrete message and terminates the process on turn end.

---

## Runtime comparison

| Runtime | Lifecycle | Transport / protocol | Steering | Initial input | Output format |
|---|---|---|---|---|---|
| **claude** | persistent | child process, stream-json NDJSON | `gated` | `{type:"user",…}` line on stdin | stream-json |
| **codex** | persistent | child process, JSON-RPC 2.0 (`app-server --listen stdio://`) | `direct` (`turn/steer`) | `initialize` → `thread/start`/`resume` | JSON-RPC notifications |
| **kimi** | persistent | child process, JSON-RPC "wire" | `direct` (`steer`) | `initialize` → `prompt` | JSON-RPC events |
| **pi** | persistent | in-process SDK (`@earendil-works/pi-coding-agent`), multi-provider | `direct` | `session.prompt()` | SDK event callback |
| **gemini** | per-turn | child process, stream-json | none | prompt on stdin, then close | stream-json |
| **copilot** | per-turn | child process, JSON | none | prompt as `-p` arg | JSON events |
| **cursor** | per-turn | child process, stream-json | none | prompt as trailing arg | stream-json |
| **opencode** | per-turn (defer-spawn, terminate-on-end) | child process, JSON | none | prompt as `-- <arg>` | JSON events |
| **antigravity** | per-turn | child process, **plain text** | none | prompt on stdin, then close | plain text lines |

(Each driver's exact launch flags live in its file under `src/drivers/`.)

---

## Layout

```
src/
  types.ts                       # Driver interface + ParsedEvent + lifecycle/capability types
  index.ts                       # public entry point
  drivers/
    index.ts                     # getDriver(runtimeId) registry  ← start here
    cliTransport.ts              # shared: state dir, token, decoupling cliName wrapper -> targetCommand, env
    systemPrompt.ts              # shared: standing-prompt assembly
    probe.ts                     # CLI/binary detection + version
    claude.ts                    # Claude Code driver
    claudeLaunch.ts              #   args / command / spawn-spec / prompt-file
    claudeProviderIsolation.ts   #   custom-provider HOME/config isolation
    claudeEventNormalizer.ts     #   stream-json → ParsedEvent
    codex.ts / codexEventNormalizer.ts / codexTelemetrySidecar.ts
    gemini.ts  copilot.ts  cursor.ts  opencode.ts  antigravity.ts
    kimi.ts                      # child-process Kimi (JSON-RPC wire)
    pi.ts                        # in-process Pi SDK (multi-provider)
  runtime/
    runtimeSession.ts            # ChildProcessRuntimeSession + descriptor
    sdkRuntimeSession.ts         # SdkRuntimeSession (in-process)
    turnState.ts                 # instantaneous steering gate
    apmStateMachine.ts           # gated-delivery policy reducers (SMR-002)
    progressState.ts             # liveness / stall detection
    notificationState.ts         # inbox-notice de-dup + batching
    errorDiagnostics.ts          # runtime-error classification + scrubbing
  inbox/
    projection.ts                # bucket pending messages by target → notice snapshots
    stateMachine.ts              # pre-action freshness guard (forward / hold / bypass)
  manager/
    managerPolicy.ts             # pure reducer: single-flight, wake/sleep, queue+coalesce, stalled
    managerRuntime.ts            # AgentProcessManager: applies effects to real sessions
  server/
    contract.ts                  # ServerApi (data) + EnrollmentApi (machine→runner key) + HostControlChannel (control) + AdminApi
    mockServer.ts                # in-memory ServerApi+AdminApi+EnrollmentApi (enrollMachine / verifyMachineKey / mintAgentCredential)
    wsControlServer.ts           # server end of the control plane over ws (machine-key authed)
    wsControlChannel.ts          # host end: WebSocket HostControlChannel (injectable socket, reconnect + heartbeat + resync)
    localControlChannel.ts       # in-process HostControlChannel — unit tests only
  daemon/
    createDaemon.ts              # runtime-agnostic daemon factory (driver/sessionFactory/runtimes INJECTED; no test code)
  cli/
    index.ts                     # the `alook` agent CLI skeleton (message send / inbox pull)
    proxyServerApi.ts            # agent data-plane client: voucher → proxy → server (identity from the voucher)
  credentials/
    credentialProxy.ts           # CredentialBroker (mint/revoke/check per-voucher vouchers) + local key-swapping proxy
scripts/                         # local-dev scaffolding (the only place "mock" is wired)
  mock-server.ts                 # SERVER process: MockServer + ws (authed) + http (/api /admin /enroll); prints MACHINE_KEY
  daemon.ts                      # DAEMON process: thin launcher — createDaemon + injected mock brain / stub driver
  mockAgentBrain.ts              # rule-brain stub (test only), driven by the daemon's proxy client
  localBridge.ts                 # the mock-server's HTTP face (/api /admin /enroll)
  smoke.ts / test-server.ts      # operator surface (admin plane): provision + post + read
```

## Host orchestration (manager + server)

Beyond driving a single runtime, the backend includes the **host-side**
orchestration so it can run agents end-to-end:

- **`manager/`** — `AgentProcessManager` schedules processes. Decisions live in a
  pure reducer (`managerPolicy.ts`: single-flight one-process-per-agent, wake/sleep,
  message queue + coalesce, stalled detection → `spawn`/`send`/`stop`/`terminate_stalled`
  effects); a thin executor (`managerRuntime.ts`) applies them to real sessions and
  feeds runtime events back in. `AgentRouter` consumes the control plane (below).
- **`server/`** — the agent ⇄ server boundary, split into two planes that share
  one contract (`contract.ts`):
  - **data plane** (`ServerApi`): what the `alook` CLI calls — `send` / `inboxPull` /
    `ack` / `read` / `listChannels`, addressed by path-style `ChannelRef`s.
  - **control plane** (`HostCommand` + `HostControlChannel`): server → host commands
    (`agent:start` / `agent:deliver` / `agent:stop`); the server owns addressing.
  `mockServer.ts` is a fully in-process `ServerApi`/`AdminApi`. The **control plane
  runs over a real WebSocket** so local dev exercises the actual transport, not an
  in-process shortcut: `wsControlServer.ts` (server end) and `wsControlChannel.ts`
  (host end, injectable socket + exponential-backoff reconnect + heartbeat) carry the
  `HostCommand` frames over `ws://127.0.0.1`. `localControlChannel.ts` is kept only for
  pure unit tests. A real server connection is the same `WsControlChannel` pointed at a
  real URL — nothing upstream changes.

The e2e test `test/e2e/controlPlane.e2e.test.ts` wires `MockServer →(real ws)→
AgentRouter → AgentProcessManager` into a complete loop (provision a
server/agent/channel, post a message, the server dispatches `agent:start`/`agent:deliver`
over the socket, the agent replies back to the channel) — single process, no real
runtime, but the control frames cross an actual WebSocket. The `scripts/` dir runs
the same stack across SEPARATE processes — `mock-server` (the server) and `daemon`
(machine-key + URL only, no server ref) — with `smoke`/`test-server` as operators.

## Credentials (zero-trust isolation)

A spawned runtime needs *some* credential to call back to the server, but handing
it the real API key means the agent process (and any tool it runs) can read it,
can't be scoped, and a leak forces a rotation. `credentials/credentialProxy.ts`
implements the **voucher** pattern instead — the same shape a production daemon
uses:

1. The host starts one local key-swapping proxy on `127.0.0.1` (loopback only).
2. For each launch, a `CredentialBroker` **mints a per-launch voucher** (`vch_…`)
   into a 0600 file. The child is given `<PREFIX>_PROXY_URL` +
   `<PREFIX>_PROXY_TOKEN_FILE` + its capability set — **never the real key**.
3. The child's CLI calls the proxy with `Authorization: Bearer vch_…`.
4. The proxy validates the voucher, **swaps in the real `Bearer <hostApiKey>`**,
   stamps `X-Agent-Id` / `X-Client` / `X-Agent-Active-Capabilities`, and forwards
   to the host-supplied upstream.

This buys **credential isolation** (the agent only ever holds a voucher),
**capability scoping** (the proxy rejects endpoints outside the voucher's caps),
and **revocability** (vouchers are per-launch and individually revocable; rotating
a leaked voucher never touches the real key). This is the **only** credential path
— `cliTransport` requires `ctx.credentialProxy` (a running broker + proxy URL) and
throws without it; there is no plaintext fallback that would hand the agent a real
key. Everything is host-neutral: the real key, upstream URL, voucher prefix, and
header names all come from the host via `CredentialBrokerConfig`.

`src/credentials/credentialProxy.test.ts` covers the swap, voucher rejection
(`invalid local agent proxy token`), capability scoping, and revocation against a
throwaway upstream.

### Three key tiers (and where each lives)

A production daemon keeps **three** credential tiers, not two — important for
understanding what `hostApiKey` should be:

1. **Machine master key** — authenticates the daemon to the server and is used to
   **mint** per-agent credentials. Held in daemon memory only (not persisted to
   disk or keychain). ⚠️ In the current daemon it is passed as a process **argv**
   (`--api-key …`), so any local process can read its full value via `ps aux`.
   Mitigation: source it from an env var, a 0600 file, or the OS keychain instead
   of argv. This proxy **never forwards the master key**.
2. **Per-agent runner credential** — the server mints one per agent (scoped to
   that agent, individually revocable) when the daemon asks with the master key.
   This is what the proxy actually swaps in and forwards upstream, and what
   belongs in `CredentialBrokerConfig.hostApiKey`. Minting it from the master key
   is **host-side orchestration** and is intentionally out of scope for this
   backend.
3. **`vch_` voucher** — minted by `CredentialBroker` per launch, written to a 0600
   file, and the only credential the agent process ever sees.

## Inbox layer (freshness)

Two pieces govern how messages reach the agent and how outgoing actions are
gated:

- **`inbox/projection.ts`** — `projectAgentInboxSnapshot` buckets pending
  messages by target (channel / DM / thread) and projects each into the
  metadata-only summary surfaced as an `[inbox notice: …]` (count, first,
  latest, sender, flags). No bodies — the agent pulls those with
  `alook message check`.
- **`inbox/stateMachine.ts`** — `planAgentInboxSideEffect` is the "don't reply on
  stale context" guard. Before an outward action (`send` / `task_claim` /
  `task_update`) it compares the model's seen `seq` boundary against pending
  messages and returns **forward** (let it through), **held** (hold the action,
  surface the latest few unseen messages as held context to reconcile first —
  this is the "Freshness hold → saved as a draft" you can hit when messaging a
  busy agent), or **bypass** (explicit `continueAnyway`). It is a pure function
  producing a stable `producerFactId`; clause ids `SMR-002` (consume) and
  `SMR-006` (held envelope) are preserved.

## Build & run

This project uses **pnpm** (see the `packageManager` field).

```bash
pnpm install
pnpm run typecheck           # tsc --noEmit (passes clean)
pnpm test                    # vitest — unit + e2e (control plane over real ws)
```

Behavior is covered by the test suite, not runnable example scripts:
`src/**/*.test.ts` (unit — drivers/manager/inbox/credentials/server) and
`test/e2e/*.e2e.test.ts` (the full control plane + credential chain over real ws).

### Local end-to-end (two real processes)

`pnpm test` already exercises everything in-process. To watch it run for real
across **separate processes** — the way a deployed daemon talks to a server,
purely over the network — use the split stack. The daemon holds only a machine
key + the server's URLs; it never holds a server reference.

**Terminal 1 — the server.** Prints a machine key + its URLs:

```bash
pnpm run mock-server
# MACHINE_KEY=sk_machine_…
# SERVER_URL=http://127.0.0.1:4517
# SERVER_WS_URL=ws://127.0.0.1:4518
```

**Terminal 2 — a daemon**, given that machine key + those URLs (copy the three
values printed above). It connects the control plane (machine-key authed) and
starts the per-agent credential proxy:

```bash
ALOOK_MACHINE_KEY=sk_machine_… \
ALOOK_SERVER_URL=http://127.0.0.1:4517 \
ALOOK_SERVER_WS_URL=ws://127.0.0.1:4518 \
pnpm run daemon
# → [daemon] control plane OPEN (machineKey accepted)
```

**Terminal 3 — drive it.** `smoke` provisions a user / 3 agents / a server /
a channel, posts a message, and reads the transcript back — each agent replies
"hi!" through the real credential chain (enroll → voucher → proxy → X-Agent-Id):

```bash
pnpm run smoke
# → result: 3 agent replies (expected 3)
```

`test-server` is the same operator surface as one-off commands (e.g.
`pnpm run test-server -- post --channel /<server>/<channel> --text hi`).

**Verify auth is real (it rejects).** Start the daemon in Terminal 2 with a bogus
key — it never reaches "control plane OPEN" (the server closes the connection),
and the enroll endpoint refuses it:

```bash
ALOOK_MACHINE_KEY=sk_machine_FORGED ALOOK_SERVER_URL=http://127.0.0.1:4517 \
ALOOK_SERVER_WS_URL=ws://127.0.0.1:4518 pnpm run daemon      # never logs OPEN
curl -s -X POST http://127.0.0.1:4517/enroll/agent-credential \
  -H "Authorization: Bearer sk_machine_FORGED" -H "content-type: application/json" \
  -d '{"agentId":"x"}'
# → {"error":"unknown or invalid machine key","code":"UNAUTHORIZED_MACHINE"}
```

The daemon process holds only a machine key + URLs — no server object, no admin
access — so the local mock walks the *same* credential code a real agent would,
and identity can't be forged. `smoke`/`test-server` act as the server-side
operator (admin plane); the daemon can't reach that surface.

> **Run the source, not `dist/` (yet).** `pnpm run build` emits JS, but the
> current Bundler-resolution emit produces extensionless relative imports that
> Node's native ESM rejects (`Cannot find module './types'`). Until that's
> switched to NodeNext or bundled, consume the library through a TS toolchain
> (tsx / ts-node / vite / esbuild / webpack).

## Usage sketch

```ts
import { getDriver, createChildProcessRuntimeSession } from "@alook/daemon";

const driver = getDriver("claude");
const session = createChildProcessRuntimeSession(driver, ctx);
session.on("runtime_event", (e) => handleParsedEvent(e));
await session.start({ text: initialPrompt });

// Later, a message arrives while the agent is working:
session.send({ text: "new message from #general", mode: "busy" }); // steer
```

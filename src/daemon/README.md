# @alook/daemon

Alook's host daemon: control-plane connectivity, agent scheduling, credentials,
diagnostics, and lifecycle orchestration.

Runtime execution lives in the independently buildable `@alook/agent-driver`
package under `agent-driver/`. That package adapts Claude Code, Codex, Cursor,
OpenCode, and Pi behind one public `AgentSession` contract. The daemon consumes
that contract and does not speak vendor process or SDK protocols.

The driver package remains host-neutral. Its CLI transport creates a per-launch
state directory, exposes a stable `alook` command through `PATH`, and composes
explicit environment layers supplied by the host. Vendor adapters never import
daemon credentials or control-plane code.

> **Provenance.** The shapes, protocols, flag strings, and control flow here were
> derived by studying how production agent-runtime daemons drive these CLIs, then
> re-expressed as a tidy, generic abstraction. It is original code, not a copy of
> any vendor source, and carries no platform-specific glue.

---

## Daemon lifecycle commands

The web Machines sheet generates the full command. Production commands use the
built-in Alook endpoints; local development commands include explicit local URLs:

```sh
npx --yes @alook/daemon@latest daemon start --machine-key '<cmt_pair_token>'
```

Restart a previously paired machine without rotating its credential:

```sh
npx --yes @alook/daemon@latest daemon start --id '<machine_id>'
```

Reconnect/rotate only with the command generated for that exact machine:

```sh
npx --yes @alook/daemon@latest daemon reconnect \
  --id '<machine_id>' --machine-key '<cmt_reconnect_token>'
```

Reconnect first takes replacement ownership and stops only the matching saved
PID, then activates the token. A proven pre-commit rejection resumes the prior
launch record. If a committed response is received and local launch then fails,
the newly persisted record remains offline and is recovered with
`daemon start --id '<machine_id>'`. A network error, timeout, 5xx, or otherwise
ambiguous activation response never restarts the possibly revoked old credential;
because the new credential was not received, mint a fresh reconnect token in the
UI and run `daemon reconnect` again. Never paste pairing or machine credentials
into logs, bug reports, or chat.

---

## The big idea

The daemon creates an `AgentDriverSdk`, probes or opens a selected backend, and
then works only with an `AgentSession`:

- `start(message)` admits the first command.
- `send(message)` accepts, queues, or rejects a later command with a typed receipt.
- `interrupt(...)` and `stop(...)` provide bounded lifecycle control.
- `snapshot()` exposes logical state without leaking process/SDK objects.
- `events` is an async stream of normalized `AgentEvent` values.
- `closed` settles exactly once with terminal and host-cleanup facts.

Inside `@alook/agent-driver`, a backend adapter declares its execution model and
normalizes vendor output. `LogicalAgentSession` owns admission, FIFO queueing,
safe-boundary delivery, terminal ordering, and cleanup. Internal `ProcessLane`
and `SdkLane` hosts make child-process and in-process SDK transports look alike;
they are deliberately not public daemon primitives.

---

## Persistent delivery models (the heart of it)

When a message arrives, what happens depends on the runtime's lifecycle:

### Safe-boundary runtimes (Claude and Codex)

One child process spans many turns. Both adapters declare `lifetime: "session"`;
their public capability is `midTurnDelivery: "safe_boundary_queue"`. A message arriving during tool use,
compaction, or review is queued by `LogicalAgentSession` and receives a later
`command_accepted` or `command_failed` event. The daemon does not implement that
protocol or queue.

For Claude specifically, the input channel is **stream-json**: the process is
launched with `--input-format stream-json --output-format stream-json
--include-partial-messages`, and each message is one NDJSON line
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}`.

### In-process SDK runtime (Pi)

Pi declares the `in_process_sdk` transport and
`midTurnDelivery: "steer"`. Its lane delegates prompt, steer, abort, and dispose
to the SDK while preserving the same receipts, events, and terminal contract.

### Persistent queued runtime (Cursor)

Cursor keeps one `cursor-agent acp` process and ACP session for the logical
session. Each idle command is a `session/prompt` request; while one is active,
later commands remain in the logical next-turn FIFO until its correlated
response arrives. Interrupt sends `session/cancel` without killing the process.

### Persistent service runtime (OpenCode)

OpenCode starts one authenticated, loopback-only v2 service per logical session.
Root prompts and busy steers share the same service and vendor session. Durable
session SSE is replayed by event id and sequence across reconnects; a separate
live stream handles permissions.

---

## Runtime comparison

| Runtime | Lifecycle | Transport / protocol | Steering | Initial input | Output format |
|---|---|---|---|---|---|
| **claude** | persistent session | stream-json NDJSON | `safe_boundary_queue` | stdin user-message line | stream-json |
| **codex** | persistent session | JSON-RPC 2.0 (`app-server --listen stdio://`) | `safe_boundary_queue` | `initialize` → `thread/start`/`resume` | JSON-RPC notifications |
| **pi** | persistent session | `@earendil-works/pi-coding-agent` | `steer` | `session.prompt()` | SDK callback |
| **cursor** | persistent session | ACP JSON-RPC 2.0 (`cursor-agent acp`) | `next_turn_queue` | `session/prompt` | `session/update` + correlated prompt response |
| **opencode** | persistent session | authenticated HTTP + SSE (`opencode serve --pure`) | `steer` | v2 session prompt API | durable + live SSE |

(Exact launch flags live in `agent-driver/src/adapters/<backend>/`.)

---

## Layout

```
agent-driver/
  src/
    contract.ts                  # public SDK, session, receipt, event, and result types
    sdk.ts                       # createAgentDriverSdk
    registry.ts                  # built-in ids and capabilities
    controller/
      logical-session.ts         # admission, queueing, turns, stop, cleanup
      process-host.ts            # internal child-process lane
      sdk-host.ts                # internal in-process SDK lane
    adapters/<backend>/          # vendor launch + normalization
    host/default-host.ts         # standalone host implementation
    internal/                    # adapter-only transport/config/process helpers
    testing/                     # public conformance fixtures
src/
  index.ts                       # daemon exports; re-exports the driver public API
  drivers/index.ts               # daemon runtime lookup/probe facade only
  logger.ts                      # structured daemon logging
  runtime/                       # manager liveness, notification, error helpers
  inbox/                         # unread projection and freshness policy
  manager/
    agentDriverHost.ts           # host resource/env/CLI preparation
    managerPolicy.ts             # pure scheduling reducer
    managerRuntime.ts            # applies effects through AgentSession
  server/                        # data/control-plane contracts and WebSockets
  daemon/createDaemon.ts         # runtime-agnostic daemon composition
  cli/                           # lifecycle CLI and proxy data-plane client
  credentials/                   # voucher broker and key-swapping proxy
scripts/
  daemon.ts                      # local daemon entry
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
    (`agent:wake` / `agent:stop`; plus `bot:*` lifecycle frames). `agent:wake` carries a
    bodiless `UnreadNotice` (channel + latest seq, no message content) — the DAEMON
    (`AgentRouter`/`AgentProcessManager`), not the server, decides whether to spawn a
    process, notify an already-running one, or coalesce the notice for the next turn.
  There is no in-process fixture standing in for the server: `wsControlServer.ts`
  (server end) and `wsControlChannel.ts` (host end, injectable socket +
  exponential-backoff reconnect + heartbeat) carry the `HostCommand` frames over
  a real WebSocket (`ws://127.0.0.1` in local dev, a real `ws-do` URL in
  production). A real server connection is the same `WsControlChannel` pointed
  at a real URL — nothing upstream changes.

`tests/integration/daemon/control-plane.test.ts` wires a real `WsControlChannel`
against a running `ws-do dev` server into a complete loop: seed a server/bot/
machine, post a message as a human owner over real HTTP, and assert the daemon's
control channel receives the resulting `agent:wake` `HostCommand` — then, acting
as the agent (no CLI spawned), replies over the real credential chain
(enroll → voucher → proxy → X-Agent-Id) and asserts the reply is readable back
over real HTTP. See "Point a daemon at real infra locally" below for how to run
the pieces this test drives by hand.

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
  `alook inbox pull`.
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
pnpm test                    # vitest — unit tests only (drivers/manager/inbox/credentials/server)
pnpm run test:integration    # real infra: requires wrangler dev + ws-do dev + wake-worker dev (see below)
```

Unit behavior is covered by `src/**/*.test.ts`. Full control-plane and
credential-chain behavior against real infra is covered by
[`tests/integration/daemon/`](../../tests/integration/daemon) — see that
directory for the executable reference of how the pieces fit together over
the network (real `WsControlChannel` over a real WebSocket, real
`enroll-agent`/credential-proxy HTTP calls, no in-process shortcuts).

### Point a daemon at real infra locally

There's no mock server to stand in for `src/web`/`src/ws-do` — a daemon
always talks to the real thing. To drive one by hand in local dev, run the
real servers and walk the real credential chain (`cmt_` pairing token →
`cmk_` daemon credential → `crk_` per-agent runner key):

**Terminal 1 — the web app + control-plane DO:**

```bash
pnpm --filter @alook/web dev      # http://localhost:3000
pnpm --filter @alook/ws-do dev    # ws://localhost:8789
```

**Terminal 2 — pair + activate a machine**, then start a daemon with the
resulting `cmk_...` credential:

```bash
# 1. As a signed-in user, create a pairing token:
curl -s -X POST http://localhost:3000/api/community/machines/pair \
  -H "Cookie: <session-cookie>" | tee /tmp/pair.json
# → { "tokenId": "cmt_…", "expiresAt": "…" }

# 2. Exchange it for a daemon credential:
curl -s -X POST http://localhost:3000/api/community/daemon/activate \
  -H "Authorization: Bearer $(jq -r .tokenId /tmp/pair.json)" \
  -H "content-type: application/json" \
  -d '{"hostname":"my-laptop","platform":"darwin","arch":"arm64"}'
# → { "credential": "cmk_…", "machineId": "cm_…", "expiresAt": null }

# 3. Start it detached (the default):
pnpm run daemon -- start --machine-key cmk_… \
  --server-url http://localhost:3000 \
  --ws-url ws://localhost:8789

# Keep it attached for local debugging:
pnpm run daemon -- start --foreground --machine-key cmk_… \
  --server-url http://localhost:3000 \
  --ws-url ws://localhost:8789
```

A bot bound to this machine (via the community UI/API) can now be woken by
posting a message in a channel it's a member of — the real wake-producer path
(`src/web` → `src/wake-worker` → `src/ws-do`) delivers `agent:wake` over the
daemon's real `WsControlChannel`.

`pnpm --filter @alook/daemon build` emits a self-contained daemon bundle. The
published tarball includes the runtime-driver implementation, while
`@alook/agent-driver` is also independently buildable and publishable for hosts
that want only the logical-session SDK.

## Usage sketch

```ts
import { createAgentDriverSdk } from "@alook/agent-driver";

const sdk = createAgentDriverSdk();
const opened = await sdk.open({
  backend: "codex",
  launch: {
    workingDirectory: ".",
    instructions: { format: "markdown", content: "Be concise." },
    launchId: "launch-example",
  },
  config: {
    model: { kind: "default" },
    mode: "default",
  },
});
if (!opened.ok) throw new Error(opened.error.message);

const { session } = opened;
const eventsDone = (async () => {
  for await (const event of session.events) {
    if (event.type === "assistant_message_completed") console.log(event.text);
  }
})();

await session.start({ id: "command-1", kind: "user", text: "Inspect this repository." });
await session.send({ id: "command-2", kind: "user", text: "Now summarize the risks." });
await session.stop({ reason: "owner_request", forceAfterMs: 5_000 });
const result = await session.closed;
await eventsDone;
void result;
```

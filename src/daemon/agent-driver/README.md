# @alook/agent-driver

Repository-private logical-session drivers for Claude, Codex, Cursor, OpenCode,
and Pi.

The package's exported contract owns backend lifecycle, message admission,
buffering, queueing, interrupts, stop deadlines, and normalized events. The
daemon selects a backend and interacts with one `AgentSession`; process and SDK
implementation details are internal.

The package root exposes only the logical SDK/session/event/result contract.
`@alook/agent-driver/testing` contains black-box exported-session fixtures.
Repository adapters use the separately versioned
`@alook/agent-driver/adapter-author` extension boundary; process and vendor-SDK
declarations are intentionally absent from both the root and `/testing`
declarations. The daemon uses the narrow `@alook/agent-driver/host` boundary for
host resource preparation and the host-enabled built-in SDK factory.

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

const session = opened.session;
const observedText: string[] = [];
const eventsDone = (async () => {
  for await (const event of session.events) {
    if (event.type === "assistant_message_completed") observedText.push(event.text);
  }
})();

const receipt = await session.start({
  id: "command-example",
  kind: "user",
  text: "Explain this repository.",
});
if (receipt.status === "rejected") throw new Error(receipt.reason);

await session.stop({ reason: "owner_request", forceAfterMs: 5_000 });
const result = await session.closed;
await eventsDone;
void { result, observedText };
```

## Recent context discovery

The SDK can discover bounded global history for Onboard without opening or
resuming an agent session. The two Top-K values are independent, non-negative
safe integers. A zero value skips that collection.

```ts
const recent = await sdk.discoverRecentContext({
  backend: "codex",
  recentSessionFilesTopK: 5,
  recentProjectsTopK: 3,
});

if (!recent.ok) throw new Error(recent.error.message);
// {
//   ok: true,
//   sessionFiles: {
//     capability: "supported",
//     items: [{ sessionFilePath, projectPath, modifiedAt }],
//   },
//   recentProjects: [{ projectPath, modifiedAt }],
// }
```

Discovery covers root sessions across the machine, not only the current
working directory or sessions created by Alook. Results are newest-first;
projects are deduplicated by normalized absolute path and retain the newest
root-session timestamp. No titles, previews, messages, session ids, or vendor
payloads cross the public boundary.

| Backend | Session files | Recent projects | Source |
|---|---|---|---|
| Claude | supported | supported | direct root JSONL scan |
| Codex | supported | supported | read-only rollout-header scan, child threads excluded |
| Cursor | unavailable | supported | ACP `session/list` |
| OpenCode | unavailable | supported | async, adaptively bounded `session list --format json` prefixes |
| Pi | supported | supported | JSONL metadata and first-line header only |

Cursor and OpenCode return `sessionFiles.capability: "unavailable"` with an
empty item list. This is distinct from a supported backend with no saved
sessions. Discovery is read-only: it does not export, materialize, migrate,
repair, resume, or create provider artifacts.

## Built-in execution matrix

All built-ins keep one physical lane for the lifetime of a logical session.
There is no per-turn built-in fallback.

| Backend | Physical lifetime | Transport | Busy delivery | Terminal owner |
|---|---|---|---|---|
| Claude | session | `stdio_stream` / `claude.stream-json.v1` | `safe_boundary_queue` | `vendor_message` |
| Codex | session | `stdio_rpc` / `codex.app-server.v1` | `safe_boundary_queue` | `transport_request` |
| Cursor | session | `stdio_rpc` / `cursor.acp.v1` | `steer` | `transport_request` |
| OpenCode | session | `http_sse` / `opencode.v2.service.1.17.20` | `steer` | `transport_request` |
| Pi | session | `in_process_sdk` / `pi_sdk` | `steer` | `prompt_invocation` |

Pi's runtime behavior did not change in this migration. It already kept one
SDK session and used prompt/steer/abort/dispose on that session; contract v1
formalizes that existing persistent behavior as an `in_process_sdk`
`RuntimeLane`.

## Repository adapter contract v1 migration

Repository adapters must import `ADAPTER_AUTHOR_CONTRACT_VERSION` from
`@alook/agent-driver/adapter-author` and set every
`AgentBackendRegistration.contractVersion` to that value (currently the numeric
literal `1`). Missing, older, and unknown newer versions fail closed before host
preparation or adapter open.

For contract v1:

- declare `BackendAdapter.execution` with `lifetime`, an opaque
  `transport.kind`/`transport.protocol`, `wakeStart`, and `terminalOwnership`;
- make registration capabilities agree with it: `sessionLifetime` maps to
  `execution.lifetime`, and `midTurnDelivery` describes the lane's real busy
  delivery behavior;
- replace one-shot spawn or SDK entry points with `openLane()`, returning one
  `RuntimeLane` that implements `start`, `send`, `interrupt`, `stop`, and the
  typed `RuntimeLaneEventMap` listener surface;
- return a non-empty authoritative receipt from every successful lane
  admission and emit terminal events with the matching owner identity; do not
  derive completion from output text or a generic idle/exit signal;
- report an unavailable required protocol/capability as incompatible or
  unhealthy. Do not silently fall back to a one-shot runtime.
- optionally implement `discoverRecentContext()` for bounded, global,
  read-only history discovery. All built-in adapters implement it; extension
  adapters that omit it receive `recent_context_discovery_unsupported` from the
  SDK without changing adapter-author contract version 1.

Package semver and the numeric adapter-author contract version are independent.
Only an incompatible `/adapter-author` change increments the latter.

## Diagnostics

`session.snapshot().diagnostics` is the exported, read-only diagnostic surface.
`deliveryPhase` comes from the same logical-session facts that own admission and
FIFO delivery. Its fixed precedence is admission wait, in-flight steering,
next-turn queue, compaction, review, tool wait, generic work, then idle. This
keeps a queued or in-flight delivery from being hidden by a generic working
state.

The accompanying metrics are cumulative and contain no prompt, response, tool,
credential, path, or vendor payload:

- physical opens and logical turns;
- command-admission count and total admission latency in milliseconds;
- queue-dwell count and total dwell time in milliseconds;
- SSE reconnect count;
- resume outcome and terminal-owner kind.

Every numeric metric is finite and non-negative. A latency or dwell value is a
`*TotalMs` accumulator, not an instantaneous sample.

## Migration from daemon-owned runtimes

Daemon integrations should create one `AgentSession`, attach its event iterator
before `start`, and keep that session until `closed` settles. Do not spawn a
backend per turn or infer completion from text, idle notifications, process
exit, or SDK callbacks that do not own the current terminal receipt. Each
command settles exactly once through `command_accepted` or `command_failed`; a
queued receipt is not final.

Cursor moved from one-shot `--print` execution to one persistent ACP session,
and OpenCode moved from one-shot `run` execution to one authenticated loopback
v2 service. Pi remains the same persistent SDK session; only its contract shape
was formalized.

The old daemon trace field `apmPhase` has been removed. Trace consumers should
read `deliveryPhase` and the allowlisted cumulative metrics projected from the
session snapshot. The daemon's pending-delivery mode is used only during the
narrow interval before the driver has observed an admission; after that, the
snapshot is authoritative.

## Rollback

Cursor and OpenCode migrations are isolated backend commit stacks and can be
reverted independently without reverting the shared `RuntimeLane` contract:
revert Cursor's `94b864c8`, `9e9f1697`, then `3ca4ff65`, or OpenCode's
`c2d98fb4`, then `ba2b2121`, in newest-first order. A rollback must disable the
affected backend or leave it incompatible/unhealthy if ACP or v2 is unavailable;
it must not ship, retain, or automatically select the restored one-shot path.
Do not fall back to `cursor-agent --print` or `opencode run`. Verify the
unaffected backends and the capability probe before resuming rollout.

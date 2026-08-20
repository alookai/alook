# @alook/agent-driver

Standalone logical-session drivers for Claude, Codex, Cursor, OpenCode, and Pi.

The public API owns backend lifecycle, message admission, buffering, queueing,
interrupts, stop deadlines, and normalized events. Consumers select a backend
and interact with one `AgentSession`; process and SDK implementation details are
internal.

The package root exposes only the logical SDK/session/event/result contract.
`@alook/agent-driver/testing` contains black-box public-session fixtures.
Adapter authors use the separately versioned `@alook/agent-driver/adapter-author`
extension boundary; process and vendor-SDK declarations are intentionally absent
from both the root and `/testing` declarations.
Daemon embedders use the narrow `@alook/agent-driver/host` boundary for host
resource preparation and the host-enabled built-in SDK factory.

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
    if (event.type === "text_delta") observedText.push(event.text);
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

## Built-in execution matrix

All built-ins keep one physical lane for the lifetime of a logical session.
There is no per-turn built-in fallback.

| Backend | Physical lifetime | Transport | Busy delivery | Terminal owner |
|---|---|---|---|---|
| Claude | session | `stdio_stream` / `claude.stream-json.v1` | `safe_boundary_queue` | `vendor_message` |
| Codex | session | `stdio_rpc` / `codex.app-server.v1` | `safe_boundary_queue` | `transport_request` |
| Cursor | session | `stdio_rpc` / `cursor.acp.v1` | `next_turn_queue` | `transport_request` |
| OpenCode | session | `http_sse` / `opencode.v2.service.1.17.20` | `steer` | `transport_request` |
| Pi | session | `in_process_sdk` / `pi_sdk` | `steer` | `prompt_invocation` |

## Diagnostics

`session.snapshot().diagnostics` is the public, read-only diagnostic surface.
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

Consumers should create one `AgentSession`, attach its event iterator before
`start`, and keep that session until `closed` settles. Do not spawn a backend per
turn or infer completion from text, idle notifications, process exit, or SDK
callbacks that do not own the current terminal receipt. Each command settles
exactly once through `command_accepted` or `command_failed`; a queued receipt is
not final.

The old daemon trace field `apmPhase` has been removed. Trace consumers should
read `deliveryPhase` and the allowlisted cumulative metrics projected from the
session snapshot. The daemon's pending-delivery mode is used only during the
narrow interval before the driver has observed an admission; after that, the
snapshot is authoritative.

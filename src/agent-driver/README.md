# @alook/agent-driver

`@alook/agent-driver` is the public contract between an Alook daemon host and a coding-agent runtime.

The package owns runtime discovery, session opening, prompt delivery, normalized events, turn results, and cleanup. It does not own machine credentials, wake routing, daemon policy, WebSockets, or database state.

## Contract

```ts
import {
  AGENT_DRIVER_CONTRACT_VERSION,
  createAgentDriverRegistry,
  defineAgentDriverDescriptor,
  type AgentDriver,
} from "@alook/agent-driver";

const descriptor = defineAgentDriverDescriptor({
  contractVersion: AGENT_DRIVER_CONTRACT_VERSION,
  id: "codex",
  displayName: "Codex",
  lifecycle: {
    kind: "persistent",
    input: "gated",
    inFlightDelivery: "queue",
  },
  transport: { kind: "child_process", protocol: "json_rpc" },
  resume: { kind: "by_id", missingSession: "fresh" },
  model: { detectedModels: "launchable", selection: "supported" },
  capabilities: {
    reasoningEffort: true,
    fastMode: true,
    disallowedTools: false,
    command: true,
    nativeStandingPrompt: true,
  },
});

declare const driver: AgentDriver;
const registry = createAgentDriverRegistry([driver]);
registry.get(descriptor.id);
```

An opened session never receives the initial prompt implicitly. Consumers subscribe first and then call `deliver`, so synchronous SDK event emitters cannot lose the first turn's events.

Every launch carries a required `AbortSignal`. A conforming driver settles a pending `open()` after abort; if a driver resolves late anyway, the host closes that session without delivering or exposing events.

Thinking, text, tool, compaction, and review events carry the prompt's stable `deliveryId`; session-scoped progress, diagnostic, and telemetry events may carry one. Every terminal `turn_result` must carry it. A delivery receipt only acknowledges prompt/steer/queue acceptance; it never stands in for turn completion.

`close()` is bounded and idempotent: concurrent or repeated callers share one cleanup operation and receive the same typed result, and any in-flight delivery settles as rejected/closed when cleanup begins. `forceAfterMs` is a duration, and every controller must provide a force-cleanup operation so a forced result always reflects an invoked hook (resource-free drivers provide an explicit no-op). The host clock exposes cancellable scheduling so graceful cleanup cannot leave a deadline timer alive. Runtime-specific process, environment, and dispose effects are supplied through a typed `AgentDriverHost`; the SDK contract does not import daemon internals.

The supported runtime ids are exactly `claude`, `codex`, `cursor`, `opencode`, and `pi`. Built-in adapters will move into this package incrementally; the contract and registry do not import daemon internals.

## Child-process transport

The package also owns the shared transport boundary used by child-process drivers:

```ts
import {
  AGENT_DRIVER_STOP_GRACE_MS,
  AgentDriverLineFramer,
  serializeAgentDriverJsonRpcRequest,
  spawnAgentDriverProcess,
  terminateAgentDriverProcessTree,
  tryParseAgentDriverJsonLine,
} from "@alook/agent-driver";
```

`spawnAgentDriverProcess` creates a detached process group on POSIX and pipes stdout/stderr. `terminateAgentDriverProcessTree` signals the process group and the direct PID with SIGTERM, then escalates to SIGKILL after `AGENT_DRIVER_STOP_GRACE_MS`.

`AgentDriverLineFramer` turns arbitrary stdout byte chunks into ordered, complete, non-empty lines without corrupting split UTF-8 input. The JSON helpers parse NDJSON and serialize JSON-RPC 2.0 request envelopes.

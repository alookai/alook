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
    busyDelivery: "gated_steer_coalesce",
  },
  transport: { kind: "child_process", protocol: "json_rpc" },
  terminal: { source: "protocol_event", processExit: "abort_active_turn" },
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

Every prompt has a stable `deliveryId`, plus independent `intent` (`user` or `control`) and execution (`concrete` or `bookkeeping`) fields. That distinction lets a deferred runtime avoid spawning for bookkeeping while still treating reset, nap, model-switch, and rewake control work as concrete.

The contract separates delivery identity from physical turns:

- `turn_started` is emitted exactly once when a fresh physical turn really starts.
- `delivery_bound` associates a delivery with a `turnId` after its prompt or steer is accepted by the runtime.
- Thinking, text, tool, compaction, and review events are scoped to `turnId`.
- Every accepted delivery receives one `delivery_result`; every physical turn receives one `turn_result`.

A busy steer binds to the existing turn and never emits another `turn_started`. The accepted receipt is a closed union: `prompt` and `steer` require a `turnId`, while `pending_gated`, `queued_next_turn`, and `deferred_bookkeeping` cannot carry one. Queued or gated acceptance does not claim that the delivery has been written or completed. `AgentDriverTurnCoordinator` keeps not-yet-written gated deliveries, active deliveries, and next-turn work in separate ledgers so an early turn completion cannot falsely complete an unwritten prompt.

`startTurn` and `steerTurn` return (or resolve) as soon as the runtime has accepted the prompt or steer; only then does the coordinator bind its deliveries. They must not wait for the physical turn to finish. Completion is reported exclusively with `operation.emit({ kind: "turn_terminal", ... })`. A callback throw/rejection means the runtime did not accept the operation, so provisional events are discarded and only those delivery ids fail.

Turn callbacks accept turn-scoped events, including active-turn progress, diagnostics, and telemetry. Handshake/sidecar progress, diagnostics, telemetry, and session opened/resumed events that occur outside a turn use `publishSessionEvent` and remain unscoped; the logical cores buffer them until the first subscriber.

Tool events require a stable `toolCallId`. `AgentDriverToolCallLedger` preserves native ids and the original tool name, synthesizes a turn-scoped id only when a protocol identity can be retained, and rejects ambiguous or mismatched completion instead of pairing by name. At turn termination, `abortOutstanding(reason)` returns one error `tool_result` per unfinished call and drains the ledger idempotently.

`close()` is bounded and idempotent: concurrent or repeated callers share one cleanup operation and receive the same typed result, and any in-flight delivery settles as rejected/closed when cleanup begins. `forceAfterMs` is a duration, and every controller must provide a force-cleanup operation so a forced result always reflects an invoked hook (resource-free drivers provide an explicit no-op). The host clock exposes cancellable scheduling so graceful cleanup cannot leave a deadline timer alive. Runtime-specific process, environment, and dispose effects are supplied through a typed `AgentDriverHost`; the SDK contract does not import daemon internals. `AgentDriverArtifact` is a closed union: files require `content` and forbid `target`, while symlinks require `target` and forbid `content`.

The supported runtime ids are exactly `claude`, `codex`, `cursor`, `opencode`, and `pi`. Reusable logical child-process and in-process session cores are public, as is the black-box `verifyAgentDriverConformance` harness. Built-in adapters move into this package in later migration checkpoints; the contract and registry do not import daemon internals.

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

A per-turn `AgentDriverLogicalChildProcessSession` requires `settlePhysicalTurn`. The hook receives the declared natural/terminate exit policy, and queued work cannot promote until the prior child has physically exited or termination has completed. If that barrier throws or rejects, the logical session closes synchronously, errors each still-unwired accepted delivery once, and starts the same bounded cleanup path as an explicit close.

`AgentDriverLineFramer` turns arbitrary stdout byte chunks into ordered, complete, non-empty lines without corrupting split UTF-8 input. The JSON helpers parse NDJSON and serialize JSON-RPC 2.0 request envelopes.

# Release notes

## Bounded recent-context discovery

- Added `AgentDriverSdk.discoverRecentContext()` with independent
  `recentSessionFilesTopK` and `recentProjectsTopK` bounds.
- Claude, Codex, and Pi return root session files plus deduplicated projects.
  Cursor and OpenCode explicitly mark per-session files unavailable while still
  returning recent projects.
- Discovery is global across projects and read-only. Public results contain only
  absolute paths and ISO-8601 modification times; provider titles, previews,
  messages, ids, and payloads stay inside adapters.
- Codex reads only rollout headers and filters subagent sources; Claude ignores nested
  subagent JSONL; Pi reads only each candidate's first-line header and excludes
  `parentSession` children instead of calling the body-reading `listAll()` API.

### Compatibility

The consumer SDK gains an additive method and result vocabulary. The optional
adapter-author discovery method does not change numeric contract version 1.
Extension adapters that omit it fail that call with
`recent_context_discovery_unsupported`; their existing probe/open behavior is
unchanged.

## Complete semantic output and payload-free liveness

- Replaced public text/reasoning delta events with
  `assistant_message_completed` and `assistant_reasoning_completed`.
- Provider fragments now stay inside the logical session, where they are
  assembled per exact root turn with a 1 MiB UTF-8 bound and explicit
  completion truncation metadata.
- Added payload-free `work_heartbeat` events for real fragment activity. The
  first fragment emits immediately, later fragments are coalesced to at most
  one heartbeat per second, and no timer creates trailing activity.
- Crashes discard incomplete fragment buffers; trusted turn terminals flush
  delta-only backends before `turn_completed`.

### Compatibility

This is an intentional breaking change to the repository-private event
contract. Consumers must handle complete semantic events rather than public
transport chunks. Provider adapter-author fragment/completion events remain
internal to `@alook/agent-driver`.

## Persistent built-in sessions and logical diagnostics

- Unified Claude, Codex, Cursor, OpenCode, and Pi behind the persistent
  `RuntimeLane` contract. Ten sequential root turns now reuse one physical open
  for every built-in backend.
- Migrated Cursor from one-shot `--print` execution to a persistent ACP session.
- Migrated OpenCode from one-shot `run` execution to one authenticated,
  loopback-only v2 service with durable replay and exact internal SSE reconnect
  accounting.
- Pi runtime behavior is unchanged: its existing single persistent SDK session
  is now formally represented by the contract-v1 `in_process_sdk` `RuntimeLane`.
- Added shared FIFO stress conformance for active busy delivery, stale-terminal
  races, and idle bursts. Every command has exactly one final accepted/failed
  event.
- Added `AgentSessionSnapshot.diagnostics`, including deterministic logical
  `deliveryPhase` and cumulative, payload-free operational metrics.
- Removed the daemon's fixed `apmPhase: "idle"` trace value. FSM traces now
  project the authoritative logical delivery phase and allowlisted metrics.

### Compatibility

`AgentSessionSnapshot` gains one readonly structured field, `diagnostics`. This
is an additive change to the private workspace API. There is no `apmPhase`
compatibility alias.
Code that constructs snapshot test doubles must add `diagnostics`; code that
only reads existing snapshot fields remains source compatible.

Adapter behavior and the adapter-author contract version are unchanged by the
diagnostic surface. The OpenCode reconnect signal is an internal, exact
allowlisted metric event and is not public telemetry.

### Adapter-author contract v1

Repository adapter registrations must use the exported
`ADAPTER_AUTHOR_CONTRACT_VERSION` and set `contractVersion: 1`. Adapters must
declare execution lifetime, opaque transport/protocol, wake behavior, and
terminal ownership; registration capabilities must match those declarations.
`openLane()` must return one `RuntimeLane` implementing typed events plus
`start`, `send`, `interrupt`, and `stop`, with authoritative admission/terminal
receipts. Missing or unsupported contract versions and declaration mismatches
fail closed before host preparation/open. Missing required runtime capabilities
must report incompatible/unhealthy and must not select a one-shot fallback.

### Rollback

The Cursor and OpenCode migrations can be reverted independently. Revert the
Cursor stack (`94b864c8`, `9e9f1697`, `3ca4ff65`) or OpenCode stack
(`c2d98fb4`, `ba2b2121`) newest first, without reverting the shared contract.
Do not ship a rollback that restores or auto-selects `cursor-agent --print`
or `opencode run`; disable the affected backend or surface it as
incompatible/unhealthy until its required ACP/v2 capability is available.

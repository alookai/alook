# Release notes

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

# Release notes

## Persistent built-in sessions and logical diagnostics

- Unified Claude, Codex, Cursor, OpenCode, and Pi behind the persistent
  `RuntimeLane` contract. Ten sequential root turns now reuse one physical open
  for every built-in backend.
- Migrated Cursor from one-shot `--print` execution to a persistent ACP session.
- Migrated OpenCode from one-shot `run` execution to one authenticated,
  loopback-only v2 service with durable replay and exact internal SSE reconnect
  accounting.
- Added shared FIFO stress conformance for active busy delivery, stale-terminal
  races, and idle bursts. Every command has exactly one final accepted/failed
  event.
- Added `AgentSessionSnapshot.diagnostics`, including deterministic logical
  `deliveryPhase` and cumulative, payload-free operational metrics.
- Removed the daemon's fixed `apmPhase: "idle"` trace value. FSM traces now
  project the authoritative logical delivery phase and allowlisted metrics.

### Compatibility

`AgentSessionSnapshot` gains one readonly structured field, `diagnostics`. This
is an additive public API change. There is no `apmPhase` compatibility alias.
Code that constructs snapshot test doubles must add `diagnostics`; code that
only reads existing snapshot fields remains source compatible.

Adapter behavior and the adapter-author contract version are unchanged by the
diagnostic surface. The OpenCode reconnect signal is an internal, exact
allowlisted metric event and is not public telemetry.

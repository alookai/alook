# Agent driver design contract

These rules add to `../AGENTS.md` for the independent
`@alook/agent-driver` workspace package.

## Independent private boundary

- Keep agent-driver as an independent private package even without an external
  consumer. Its purpose is to make daemon/provider coupling structurally
  impossible. Do not fold it into daemon source or change its directory/package
  boundary merely because publishing is a lower priority.
- Keep its manifest, declared exports, build, tests, API reports, ownership, and
  artifact-isolation checks. Daemon consumes only declared root/host contracts;
  it never deep-imports adapters, controllers, transports, provider SDKs, or
  internals.
- Daemon may bundle the package from the same commit, but its packed artifact
  must not require a separately published agent-driver at runtime.

## Persistent provider contract

- Use each provider's strongest native persistent session, process, and
  transport. Never substitute a per-turn process for an available persistent
  protocol to simplify shared lifecycle code.
- Keep vendor protocol details inside the adapter. Normalize them into public
  session events, receipts, snapshots, capabilities, and terminal results;
  vendor SDK objects are never daemon authority.
- Declare busy delivery truthfully as immediate steer, safe-boundary injection,
  or next-turn queue. A queued receipt retains command ownership; it is not
  acceptance or completion. Never report a fake steer.
- All modes preserve stable command identity, order, and exact-once settlement
  across queueing, interruption, close, failure, and restart.

## Root, terminal, and process authority

- Correlate events to the exact physical session, logical epoch, and root turn.
  Child/subagent, stale, unknown, and duplicate terminals cannot become root
  terminals or start root idle cleanup.
- Stop receipts admit a request. `already_stopping` preserves the existing
  cleanup owner; `session.closed` becomes terminal only after lanes, transports,
  and processes are cleaned. Late cleanup cannot affect a replacement session.
- All CLI launches and termination go through the package's single host process
  authority. Adapters have no direct spawn/kill escape path.
- POSIX cleanup retains bounded authority over captured descendants and their
  owned process groups, including detached MCP/tool groups. Windows cleanup
  remains inside the kill-on-close Job Object authority.

## Contract standard

- Shared conformance covers native persistent reuse, declared busy-delivery
  semantics, stable receipts, root-vs-child terminal correlation, recovery, and
  complete process cleanup for every built-in adapter. A fake adapter alone is
  not evidence for real providers.
- Adapter-specific behavior may strengthen but never weaken shared semantics.
  Public exports, API reports, and packaged artifacts must preserve the same
  boundary as source imports.

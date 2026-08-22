# Daemon design contract

These rules define the product architecture and runtime behavior for
`src/daemon`. `agent-driver/AGENTS.md` adds package-specific rules.

## Design from the product guarantee

- Never trade away a stronger user capability because a weaker state machine is
  easier to implement, own, clean up, or test. Define the user's minimum
  guarantee first; optimization and deduplication operate above that floor.
- Persistent execution is the default and preferred product model. If a backend
  supports a native persistent session, process, or transport, keep it
  persistent. Never replace it with per-turn execution for engineering
  convenience. A lifecycle downgrade requires an explicit product decision.
- A priority statement is not cancellation. Do not remove or rewrite a locked
  architecture, capability, module, or package boundary without an explicit
  decision to change that design.

## Architecture

- D1/server state owns durable messages and read state. The wake coordinator
  owns unread reminder coverage. The daemon manager owns logical-session and
  admission orchestration. The independent agent-driver package owns provider
  protocols, physical sessions, capabilities, and process lifecycles.
- A stored message is not proof of wake delivery. A WebSocket acknowledgement is
  not proof of session injection. A driver receipt is not proof of terminal
  cleanup. Keep these boundaries and authorities separate.
- Daemon code consumes declared contracts and capabilities. Provider names,
  wire events, SDK objects, and transport quirks stay inside adapters.
- In-memory state coordinates only the current daemon instance. Unread work must
  remain recoverable after disconnect, crash, restart, reset, model switch, or
  failed spawn.

## Wake is lossless

- Every unread must be covered by at least one effective wake injection. Wakes
  may merge from N to 1; they must never collapse from N to 0.
- Every accepted WebSocket wake that advances an unread watermark must reach the
  current logical session or remain reliably queued for it. This is required
  while the agent is active or admitting too; never acknowledge and suppress a
  new watermark into unowned memory.
- Coverage ends only when model-seen proves the agent actually observed that
  unread. `active`, `admitting`, persistence, transport send/ack, driver receipt,
  or a later incidental inbox pull do not satisfy this condition.
- A higher watermark arriving during active work enters the same persistent
  logical session. Its adapter may steer now, inject at a safe boundary, or
  queue the next turn, but delivery cannot wait for outbound alignment or
  shutdown.
- Deduplicate by stable semantic identity and covered watermark, not by the
  existence of an active turn. Preserve order; settle multi-channel coverage per
  channel; return every unseen watermark to idempotent FIFO retry after failure,
  idle, close, or epoch replacement.

## Session and turn authority

- Bind mutable authority to the exact session instance/epoch and root turn.
  Stale, duplicate, unknown, child, or superseded events cannot close, revive,
  delete, or settle the current owner.
- Only the matching root terminal ends root execution. Subagent completion is
  not root completion. Long-running root tools remain live work across silence;
  a queued-next-turn diagnostic must not hide that tool ownership.
- A queued command receipt preserves provisional responsibility; it does not
  complete the command. Acceptance settles it. Failure, close, or exit requeues
  it exactly once. True unacknowledged admissions and true inactive roots must
  still time out.
- Reset, stop, model switch, restart, and recovery preserve unread work and
  fence the old epoch. Old cleanup can affect only its captured instance and
  must never delete or terminate a replacement.
- A stop receipt, including `already_stopping`, is not terminal. The exact
  session's `closed` completion is authoritative only after logical and physical
  cleanup has finished.

## Capability and process ownership

- Busy delivery is capability-driven: immediate steer, safe-boundary injection,
  or next-turn queue. These modes change when an injection is consumed, never
  whether it is delivered. Do not fake unsupported steering or branch shared
  code on backend names.
- Every CLI, tool, and MCP server belongs to one agent-driver process authority.
  Before spawn, the daemon/host ensures the workspace and working directory
  exist; fresh start cannot depend on a previous run or adapter side effect.
- On POSIX, retain bounded authority over the exact root's captured descendant
  PIDs and descendant-owned process groups through TERM/KILL. Never global-scan
  or signal an unrelated group. On Windows, retain the Job Object boundary.
- Shutdown completes only after snapshotted sessions reach `closed` and every
  owned process is dead. Killing only the root, sending a signal, or exhausting
  a grace period is not successful cleanup; daemon exit must leave no orphan.

## Required behavioral proof

- Test the public chain: durable unread -> wake coverage -> session injection ->
  model-seen -> ordered handling. Isolated downstream tests cannot prove wake
  delivery.
- Cover persistent reuse, rapid-message N-to-1 delivery, message-during-work,
  failure/retry, partial observation, reset/replacement fencing, long root tools,
  root-vs-child terminal correlation, and clean shutdown.
- Process cleanup requires real operating-system trees, including detached
  descendants. Every built-in backend must pass the same user journeys with its
  declared capability and without loss, duplication, false terminal, or orphan.

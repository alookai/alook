# @alook/agent-driver

Repository-private logical-session drivers for Claude, Codex, Cursor, Grok,
OpenCode, Pi, and Antigravity.

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

For Claude and Codex, `safe_boundary_queue` waits for at most the next valid
tool-output event. A tool start closes the boundary for messages that arrive
after it; the next matching tool output reopens the boundary and flushes queued
messages even if other concurrent tools remain active. A later tool start
closes the boundary again. Compaction and review remain closed until their
matching finished events. Cursor, OpenCode, and Pi steer immediately and do not
participate in this boundary latch.

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


## Antigravity (native ACP)

The `antigravity` backend uses Google's native `agy_acp_server.par` (`agy_acp_server.exe`
on Windows), not the one-shot `agy --print` command. It keeps one process and one
provider session across turns. Busy input queues until the current prompt returns;
concurrent steering is not advertised. Restart uses `session/load` with the stored
provider session ID. An unavailable session requires an explicit reset.

Install the native distribution listed in the
[ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
Version 1.3.0 was used for protocol validation. Keep `localharness_external` beside
the server executable. Put an executable wrapper named `agy_acp_server.par` on PATH,
which execs the absolute server path, or set the runtime's `command` override to
that path. Linux adds the registry's `--uid=` argument; Windows uses the `.exe` name.
Do not substitute a third-party ACP wrapper around print mode.

For example, after extracting the macOS arm64 archive into
`$HOME/.local/share/alook/runtimes/antigravity-acp/1.3.0`, a PATH wrapper contains:

```sh
#!/bin/sh
exec "$HOME/.local/share/alook/runtimes/antigravity-acp/1.3.0/agy_acp_server.par" "$@"
```

Authentication is local to Google's ACP server. Complete Google sign-in using an
ACP client's `authenticate` request with `methodId: "oauth-personal"` before
launching an agent. The provider's settings live under
`~/.gemini/antigravity-acp/`; leave credentials there and never put them in agent
instructions. Runtime detection initializes the protocol and requests a session catalog without
authenticating or sending a prompt. Healthy means the native binary is compatible,
not that an account is signed in; unauthenticated discovery has no model catalog.
The catalog probe can create an empty provider session. The adapter does not
send an `authenticate` request during discovery or launch. It reports explicit
provider authentication errors when returned. In native 1.3.0 testing, unreadable
Keychain credentials with no valid file fallback left `session/load` waiting for
login and discovery ended with `antigravity_acp_timeout` at the existing 10-second
deadline. A separate 30-second diagnostic on the same credential condition was
correlated with an opened Google sign-in page by its OAuth callback port. The
native server can therefore start its own browser login flow during discovery,
even though the adapter does not send `authenticate`. Complete native sign-in
before running the daemon; a timeout does not establish that credentials are valid.

Standing instructions accompany the first prompt of every physical session,
including resumed sessions. Later prompts reuse its context. Tools use ACP
permission requests scoped to the active session and prompt, choosing only a
provider-offered `allow_once` option. Models must be present in the native session's
advertised model catalog before they can be selected. Discovery publishes the
native model catalog through the existing machine model/effort controls. Gemini
high/medium/low variants are offered as effort choices only when the same model
family's exact variant IDs are returned by the server. Effort changes select that
native variant on the same idle session; unsupported values fail explicitly.

Native 1.3.0 exposes model/mode config options but no independent effort option.
The adapter reads generation usage from the exact session's native SQLite WAL view;
input already excludes cache and output includes thinking. Missing fields stay null.
Native session/home plus generation index deduplicates accounting across reloads.
Dates use the native invocation start timestamp. The daemon commits counts and
processed generation ranges in one atomic daily store, retries transient write
failures on subsequent telemetry reads, and recovers native records after restart.
Reading requires Node's built-in SQLite (Node 22.13+) or the system sqlite3 CLI;
if neither is available, conversations continue and metrics remain unknown.
Child trajectories are not yet aggregated: their presence makes session metrics
unknown rather than presenting partial root usage as complete.

Personal OAuth quota uses the official loadCodeAssist and retrieveUserQuotaSummary
endpoints with the native credential storage. Reading never starts onboarding or
interactive authentication. API-key/business modes and absent credentials report
unavailable/unauthorized. Native bucket identity, remainingFraction and resetTime
are preserved; provider-defined windows are not guessed. ACP usage_update is
context occupancy and is never counted. Recent-history import remains unavailable.
On October 6, 2026, real authenticated execution with official ACP 1.3.0 passed
on macOS, including native model/effort selection, persistent turns, daemon
recovery and native/local/D1/API usage correlation. Real quota reading passed
with the official isolated file credential store and with Keychain-first file
fallback, using the reader's existing five-second request deadlines. The default
Keychain store remained unreadable on the tested machine and had no file fallback;
that condition reports retryable unavailable before HTTP, not an authentication
refusal. These results supersede the earlier Google location-eligibility block
and do not establish default Keychain access or acceptance on other platforms.

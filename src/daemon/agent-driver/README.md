# @alook/agent-driver

Repository-private logical-session drivers for Claude, Codex, Cursor, Grok,
OpenCode, Pi, Antigravity ACP, Antigravity CLI (`agy`), Qoder, Copilot,
Cursor SDK, and Pi Durable.

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
| Claude | session | `stdio_stream` / `claude.stream-json.v1` | `steer` | `vendor_message` |
| Codex | session | `stdio_rpc` / `codex.app-server.v1` | `steer` | `transport_request` |
| Cursor | session | `stdio_rpc` / `cursor.acp.v1` | `steer` | `transport_request` |
| OpenCode | session | `http_sse` / `opencode.v2.service` | `steer` | `transport_request` |
| Pi | session | `in_process_sdk` / `pi_sdk` | `steer` | `prompt_invocation` |
| Antigravity CLI (`agy`) | session | `stdio_stream` / `agy.stream-json.v1` | `next_turn_queue` | `vendor_message` |
| Qoder | session | owned SDK worker / `qoder.sdk-worker.v1` | `steer` | `prompt_invocation` |
| Copilot | session | owned SDK worker / `copilot.sdk-worker.v1` | `steer` | `prompt_invocation` |
| Cursor SDK | session | owned SDK worker / `cursor-sdk.sdk-worker.v1` | `steer` | `prompt_invocation` |
| Pi Durable | session | owned SDK worker / `pi-durable.sdk-worker.v1` | `steer` | `prompt_invocation` |

## Optional native SDK entries

Install the SDK for the entry being used. A project-local installation or an npm
global installation is supported; explicit `npm_config_prefix`/`NPM_CONFIG_PREFIX`
is also honored. Resolution prefers the package/project installation, then the
running Node/npm installation and configured prefix. Missing SDKs make only
their corresponding entries unavailable.

| Backend ID | Optional npm package | Native state and authentication |
|---|---|---|
| `qoder` | `@qoder-ai/qoder-agent-sdk` | Native Qoder session; SDK CLI login, personal access token, or service account |
| `copilot` | `@github/copilot-sdk` | Native Copilot session and its normal SDK/CLI authentication |
| `cursor-sdk` | `@cursor/sdk` | Local SDK agent with a JSONL store under `.alook/cursor-sdk`; SDK credentials |
| `pi-durable` | `@earendil-works/pi-durable` | Native Harness/SQLite under `.alook/pi-durable`; selected provider key or ambient provider authentication |

For example, `npm install -g @cursor/sdk` enables SDK discovery without replacing
the existing `cursor` ACP entry. `pi` remains the Pi coding-agent entry. Pi
Durable does not import the coding-agent's private credential files.

The tested SDK versions are Qoder 1.0.58, Copilot 1.0.28, Cursor 1.2.0, and Pi
Durable 1.5.0. These are evidence versions, not accepted-version gates. Their
runtime API and required native capabilities are checked. Current Cursor SDK
requires Node >=22.13; Pi Durable requires Node >=22.19; Copilot SDK requires
Node ^20.19 or >=22.12. Other backends retain the package's existing Node floor.

Cursor SDK requires an explicit model for a fresh local agent. Pi Durable
requires an explicit `provider/model` selection for a fresh conversation; its
native catalog supplies these IDs. Both can restore a saved model on resume.
Reasoning effort is supplied at launch/resume; these entries do not claim a
live settings update. Missing history is rejected using the existing admission
contract, without creating a substitute context.

Each SDK runs in one persistent managed Node child. It retains native session
state across turns; tool and CLI descendants remain under the existing process
authority. Stop captures the owned tree before TERM invokes native shutdown.
Pi Durable shutdown closes the Harness; interrupt explicitly aborts its work.
Its SQLite ownership lock prevents concurrent drivers of the same store.

The public API and adapter-author version remain unchanged. Runtime-specific
native completion and input acknowledgement are mapped onto existing receipts
and events. A receipt is not proof of model consumption.

### Codex App executable discovery

On macOS, Codex uses an explicit command first, then PATH, then executable
`Contents/Resources/codex` files in system/user Codex.app and ChatGPT.app.
Probe, model discovery and launch use the same selection. This starts a separate
owned stdio app-server; it does not attach to an active desktop conversation.

### SDK validation

Source tests include real process cleanup, UTF-8 framing and SDK write callback
regressions. Optional native tests use installed official SDKs with local
protocol servers or Pi's scripted provider, without paid inference:

```sh
ALOOK_NATIVE_SDK_ROOT=/absolute/path/to/isolated/npm-prefix pnpm test
```

The prefix must contain the four optional packages. The same environment
variable enables all four SDK worker and daemon-manager journeys in the
daemon's installed-package test. Cursor's execution fixture verifies its SDK
mapping and packaged worker; real Cursor account inference and Windows runtime
verification remain separate checks. Native SDK fixtures do not establish
external service behavior or account entitlement.

Claude and Codex submit busy inputs immediately through their native persistent
protocols. Submission is not proof that the model has read the input: Claude may
echo it after an active tool returns; Codex reports the correlated `turn/steer`
RPC result. Grok retains `safe_boundary_queue`: a valid tool result opens its
boundary, while tool starts, compaction and review can close it. A native busy
refusal retains input responsibility in the existing next-turn queue.

OpenCode selects a private compatibility lane from the actual CLI version.
CLI v1 retains its `--pure` launch and durable event admission frontier; CLI v2
recovers native inbox/messages and requires a new idle record after every
accepted input. Both retain one authenticated service/session and the same
public contract. Recent-project discovery stays global: v1 uses session list,
while v2 queries its native session API without a project filter. Unknown CLI
majors and missing required capabilities fail explicitly.

Pi retains one `in_process_sdk` session and uses its native
prompt/steer/abort/dispose methods. Missing saved history now fails with
`reset_required`; it cannot create an empty context with the requested ID.

## Repository adapter contract v2 migration

Repository adapters must import `ADAPTER_AUTHOR_CONTRACT_VERSION` from
`@alook/agent-driver/adapter-author` and set every
`AgentBackendRegistration.contractVersion` to that value (currently the numeric
literal `2`). Missing, older, and unknown newer versions fail closed before host
preparation or adapter open.

For contract v2:

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
  SDK. This method remains optional.

- pass every merged `{ commandId, attemptId }` member into the lane; correlate
  native responses by native IDs, never text or timing;
- preserve `success | failed | interrupted | unknown` terminal outcomes. An
  absent outcome becomes `unknown`, and a tool result never inherits root success.
  ACP normal completion, refusal, execution limits and cancellation remain distinct;
  `AgentTurnResult.stopReason` preserves their native cause;
- separate input/control errors from root failures and preserve off-root
  attribution. Child/unknown events become public `activity` and cannot mutate
  root text, tools, recovery or terminal ownership;
- report acquisition using native API/protocol guarantees. A matching session ID
  alone is `unverified`; missing history requires explicit reset;
- return `acknowledged` for a settings ACK without value evidence. `applied`
  requires `observed`; initial configuration without readback is `unverified`.

### Input responsibility and evidence

`AgentMessage.id` remains the logical identity; optional `attemptId` defaults to
that ID. Repeating the same pair reuses its admission receipt. Only an input whose
responsibility was returned can use a fresh attempt, with unchanged original
text, kind and sequence. Optional `delivery: "next_turn"` uses the existing queue.

A `queued` receipt retains provisional responsibility. `command_accepted` means
the driver owns delivery, not that the native runtime or model consumed it.
`input_observed` records a correlated native ACK, user echo or conversation fact;
it does not establish Alook's separate model-seen watermark.

`command_returned` includes the original input, attempt, ordinal, evidence and
retry eligibility. Daemon retries only proven unsent/rejected eligible inputs,
with the same command ID and a fresh attempt, ahead of still-unsent work. Already
admitted later inputs cannot be reordered. Unknown delivery and permanent refusal
are audited without blind replay; durable unread coverage remains wake-owned.
Immediate input refusal cannot stop an existing healthy root.

`session_acquired` and `configuration_observed` retain their latest evidence in
the snapshot. Configuration ACKs settle the daemon's existing revision without
restarting or repeating it; requested values do not become observed values.

Native correlation is currently available for Claude UUID echoes, Codex RPC IDs,
Qoder input lifecycle IDs and Copilot message IDs. Other lanes retain exact host
input references but do not invent native observations. Protocols that expose no
separate child stream cannot supply child details. Native tool output/outcomes
are retained when supplied; absent tool outcome is explicitly `unknown`.

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


## Antigravity CLI (`agy`)

The `agy` backend supports Google's official Antigravity CLI, independently of
the `antigravity` ACP backend below. Install and sign in with the
[official CLI instructions](https://antigravity.google/docs/cli/install/).
Discovery and launch share the same executable lookup: an explicit `command`,
`agy` on PATH, then `~/.local/bin/agy` on macOS/Linux or
`%LOCALAPPDATA%/agy/bin/agy.exe` on Windows (the default user-local directory
is used only when `LOCALAPPDATA` is absent). Run the selected CLI executable in a terminal and finish
Google sign-in before starting a bot; ACP authentication is separate.

Opening the model list runs the native `agy models` command and preserves its returned slugs and labels. Installation checks and Bot launch do not run that command. The model list does not establish an authenticated model request or infer per-model effort support.

The CLI must advertise native `--input-format stream-json`,
`--output-format stream-json` and `--conversation` support. Alook keeps one
process across turns and queues busy input until the current result completes.
It passes selected model and effort through `--model` and `--effort`, delivers
standing instructions with the first input, and uses the injected Alook CLI
through the existing host environment. Sign-in is local to the native CLI;
discovery compatibility does not prove an authenticated model request.

Resume passes the exact saved conversation ID to `--conversation`. A missing
or substituted ID fails; no new conversation is silently accepted. The CLI
does not support ACP or Claude control messages. This backend declares
`interrupt: false`; stop and reset retain the existing process cleanup boundary.

Token usage comes from live completed step events, deduplicated with native
conversation/step identity. Cumulative result usage is not added again. Unknown
counts remain unknown. Provider quota is unsupported until a CLI-specific
source is established; ACP credentials and quota are not reused.

Version 1.3.4 was checked for executable discovery, advertised protocol and
unauthenticated startup cleanup. Authenticated multi-turn and resume acceptance
are separate checks and must not be inferred from protocol fixtures.

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
instructions. Runtime detection initializes the protocol and exits; it does not authenticate or create/load a session. Healthy means the native binary is compatible, not that an account is signed in.

Opening the model list requests a session catalog, reusing the discovery session when available. This can create an empty provider session. The adapter does not send `authenticate` during discovery or launch, but native 1.3.0 can start its own browser login when a session request needs credentials. Complete native sign-in before discovering its models or running a Bot. A catalog timeout does not establish that credentials are valid; it leaves the installed runtime health unchanged.

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

### Model discovery

`probe({ backend, includeModels: false })` checks installation and native protocol compatibility without discovering model catalogs. The daemon uses this mode at machine startup. Antigravity ACP initializes and exits without authenticating or creating/loading a catalog session; Grok also stops after its compatibility handshake.

Opening a model list requests the selected machine and backend through the owner-scoped API and machine control WebSocket. The default SDK probe retains each backend's native catalog discovery. The result is correlated by request ID and saved in the existing machine runtime report. Backends without a native catalog return no catalog; their custom model entry remains available. Discovery does not wake or reset a Bot, and catalog errors do not change installed runtime health. Native catalog discovery may require the user's existing vendor login.

## Codex installation sources

`codex-app` (Codex) discovers the executable bundled in Codex.app, with the legacy ChatGPT.app bundle supported on macOS. It supports the current nested `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` layout and the earlier `Contents/Resources/codex` layout. `codex-cli` (Codex CLI) discovers `codex` on PATH. Neither source falls back to the other. Health, native model discovery and session launch use the selected source. Both reuse the native persistent app-server protocol and native account/history configuration. Native model discovery has a bounded 10-second deadline, including process startup, and releases its child on completion or timeout.

The existing `codex` ID retains PATH-first, then App discovery for previously saved bot bindings. It is hidden from new selections when explicit source IDs are reported, and remains available when editing an existing binding or using an older daemon. Existing bot bindings are not rewritten. Explicit command overrides remain supported.

Apply migration `0113_community_machine_backend_quota_codex_sources.sql` before the updated daemon reports source-specific quotas. It preserves existing observations and adds independent App/CLI keys.

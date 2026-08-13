/**
 * createDaemon — the real daemon, end-to-end.
 *
 * A daemon holds a machine credential (`cmk_...`) + the server's URLs. It
 * does NOT import a server object and cannot reach the admin plane — its
 * whole capability surface is three network faces (all toward the server
 * it was pointed at):
 *
 *   1. control plane (ws):   receive agent:wake/stop, report ready/
 *      session/ack. Connects with `Authorization: Bearer <machineKey>`
 *      (`cmk_`). This is the only path — no URL-token fallback exists.
 *   2. enroll plane (http):  POST /api/community/daemon/enroll-agent
 *      (Bearer `cmk_`) → per-agent runner key (`crk_`).
 *   3. credential proxy (http): validates agent vouchers, swaps in runner
 *      keys, stamps X-Agent-Id, and forwards to the server's data plane.
 *      All agent traffic flows through canonical `/api/community/*` REST
 *      doors; the deleted flat `/api/<verb>` catalog is rejected by the proxy.
 *
 * It is agnostic on both axes:
 *   - whether the server is a real Alook server or a local `wrangler dev`
 *     instance — same wire contract either way;
 *   - whether an agent is a real runtime (Claude, Codex, …) or a test stub
 *     — the `driverFor` is INJECTED by the caller.
 */
import { homedir } from "os";
import { appendFileSync, mkdirSync } from "node:fs";
import { createRotatingFileSink, type RotatingFileSink } from "../util/rotatingFileSink.js";
import { createTraceSampler, DEFAULT_TRACE_FILE_MAX_BYTES } from "../util/traceSampler.js";
import { writeStatusFile } from "../util/statusFile.js";
import { WsControlChannel } from "../server/wsControlChannel.js";
import { CredentialBroker, startCredentialProxy } from "../credentials/index.js";
import { AgentProcessManager, AgentRouter, createTypingScopeTracker } from "../manager/index.js";
import type { ManagerTraceRecord, TypingScopeTracker } from "../manager/index.js";
import { UnknownBotError, BotEnrollFailedError, UnknownRuntimeError } from "../manager/agentRouter.js";
import { createTimelineRecorder, sweepTimelineHistory } from "../timeline/index.js";
import { resolveAlookCliPathWithFallback } from "../discovery.js";
import { createPiSdkDriverDeps } from "../drivers/piSdkDeps.js";
import { createLogger, type Logger } from "../logger.js";
import type { Driver, LaunchContext } from "../types.js";
import type { RuntimeConfig } from "../runtimeConfig.js";
import type { UnreadNotice, HostCommand } from "../server/contract.js";
import { formatHandle } from "@alook/shared/lib/discriminator";
import type { DiagnosticCollectCommand } from "@alook/shared";
import {
  createDiagnosticsCommandListener,
  type DiagnosticFailureReport,
} from "./diagnosticsCommand.js";
import { createSelfUpdateCommandListener } from "./selfUpdateCommand.js";
import {
  MessageReminderScheduler,
  type MessageReminderSchedulerOptions,
} from "./messageReminderScheduler.js";

// Cold-start warmup backoff schedule (ms).
const WARMUP_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;
const WARMUP_CEILING_MS = 30_000;
/** Per-file cap for opt-in raw runtime stdout trace (independent of FSM trace). */
const RUNTIME_RAW_TRACE_MAX_BYTES = 8 * 1024 * 1024;
export const RUNTIME_RAW_TRACE_AGENT_IDS_ENV = "ALOOK_RUNTIME_RAW_TRACE_AGENT_IDS";
/** How often the daemon rewrites the `daemon status` snapshot file (batch E2). */
const STATUS_WRITE_INTERVAL_MS = 5_000;

export function parseRuntimeRawTraceAgentIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((agentId) => agentId.trim())
      .filter((agentId) => agentId.length > 0 && agentId !== "*"),
  );
}

export function createRuntimeRawLineTap(args: {
  traceDir?: string;
  enabledAgentIds: ReadonlySet<string>;
  logger: Pick<Logger, "warn">;
  maxBytes?: number;
}): ((agentId: string, line: string) => void) | undefined {
  if (!args.traceDir || args.enabledAgentIds.size === 0) return undefined;
  const traceDir = args.traceDir;
  const maxBytes = args.maxBytes ?? RUNTIME_RAW_TRACE_MAX_BYTES;
  const sinks = new Map<string, ReturnType<typeof createRotatingFileSink>>();
  const warned = new Set<string>();
  const warnOnce = (agentId: string, path: string, operation: string, error: unknown): void => {
    if (warned.has(agentId)) return;
    warned.add(agentId);
    args.logger.warn("runtime raw trace sink failed", {
      agentId,
      path,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  return (agentId, line) => {
    if (!args.enabledAgentIds.has(agentId)) return;
    const encodedAgentId = encodeURIComponent(agentId).replace(/\./g, "%2E");
    const path = `${traceDir}/runtime-raw-events-${encodedAgentId}.jsonl`;
    const serializedBytes = Buffer.byteLength(line, "utf8") + 1;
    if (serializedBytes > maxBytes) {
      warnOnce(
        agentId,
        path,
        "oversize",
        new Error(`raw line is ${serializedBytes} bytes; max is ${maxBytes}`),
      );
      return;
    }
    let sink = sinks.get(agentId);
    if (!sink) {
      try {
        mkdirSync(traceDir, { recursive: true });
      } catch (error) {
        warnOnce(agentId, path, "mkdir", error);
      }
      sink = createRotatingFileSink(path, maxBytes, {
        mode: 0o600,
        hardMaxBytes: true,
        onError: ({ operation, error }) => warnOnce(agentId, path, operation, error),
      });
      sinks.set(agentId, sink);
    }
    sink.write(line);
  };
}

/**
 * Derive the audit-log `cli_invocation` subcommand from a proxy request
 * pathname. The CLI calls canonical `/api/community/*` REST doors directly;
 * the proxy preserves that pathname unchanged.
 *
 * Canonical `users/me/inbox/ack` is the advance sibling of `inboxPull` with no
 * user intent, so it is dropped (returns `null`). Anything outside recognized
 * canonical shapes returns `null` too — the proxy is generic and could carry
 * non-audit traffic in the future.
 */
export function deriveAuditLogSubcommand(pathname: string, method?: string): string | null {
  // Route/disc retarget: several flat verbs now hit the canonical id-in-path
  // door (`channels/{id}/messages`, `messages/{id}/reactions/…`) instead of
  // `/api/<verb>`. Slicing the first segment of those would log the DOOR name
  // (`channels`/`messages`) instead of the logical verb the bot invoked, so the
  // `cli_invocation` audit row would lose which action ran. Map the canonical
  // SHAPES back to their verb FIRST, on the canonical `/api/community/…`
  // shape. The messages door is dual-verb — GET is `read`, POST is `send` — so
  // it needs the method; the others are single-verb.
  const canonical = pathname.split("?")[0] ?? pathname;
  if (/^\/api\/community\/messages\/[^/]+\/reactions\//.test(canonical)) return "reactAdd";
  if (/^\/api\/community\/messages\/[^/]+\/marks$/.test(canonical)) {
    if (method === "PUT") return "markSet";
    if (method === "DELETE") return "markRemove";
    return null;
  }
  if (method === "GET" && /^\/api\/community\/users\/me\/marks$/.test(canonical)) return "markList";
  if (/^\/api\/community\/channels\/[^/]+\/messages\/seq\//.test(canonical)) return "resolve";
  if (/^\/api\/community\/channels\/[^/]+\/messages(\/|$)/.test(canonical)) {
    return method === "GET" ? "read" : "send";
  }
  if (/^\/api\/community\/channels\/[^/]+\/members(\/|$)/.test(canonical)) return "channelMember";
  // Attachments door (attachments fold): the flat `attachmentUpload` /
  // `attachmentDownload` verbs fold onto channels/{id}/attachments (POST upload)
  // + channels/{id}/attachments/{attachmentId} (GET download). Map both back so
  // the audit row keeps the logical verb, not the `channels` door segment. The
  // download shape (has the `{attachmentId}` sub-segment) is tested FIRST so the
  // bare-upload shape doesn't swallow it.
  if (/^\/api\/community\/channels\/[^/]+\/attachments\/[^/]+/.test(canonical)) return "attachmentDownload";
  if (/^\/api\/community\/channels\/[^/]+\/attachments(\/|$)/.test(canonical)) return "attachmentUpload";
  // Single-message hydrate door GET messages/{id} = the folded `resolve` verb.
  // AFTER the reactions pattern so that specific sub-path wins.
  if (/^\/api\/community\/messages\/[^/]+$/.test(canonical)) return "resolve";
  // Server-scoped list doors (轴3 fold): GET servers/{id}/members = the folded
  // `listMembers` verb; GET servers/{id}/channels and GET servers/channels (the
  // all-servers collection read) = the folded `listChannels` verb. Map back so
  // the audit row keeps the logical verb, not the `servers` door segment.
  if (/^\/api\/community\/servers\/[^/]+\/members(\/|$)/.test(canonical)) return "listMembers";
  if (/^\/api\/community\/servers\/[^/]+\/channels(\/|$)/.test(canonical)) return "listChannels";
  if (/^\/api\/community\/servers\/channels(\/|$)/.test(canonical)) return "listChannels";
  // Friends bucket doors (轴3 fold): the bot's `listFriends` fans out to
  // GET friends/accepted + GET friends/pending. Map both back to the logical
  // verb so the audit row stays `listFriends`, not the `friends` segment.
  // (/friends/blocked is bot-403 → never reached by a bot, so it needs no map.)
  if (/^\/api\/community\/friends\/(accepted|pending)(\/|$|\?)/.test(canonical)) return "listFriends";
  // friend-request door (friendRequest fold): the bot verb folded onto POST
  // friends/request (dual-actor). Map back to `friendRequest` so the audit row
  // stays the logical verb, not the `friends` segment. (Audit derivation is
  // daemon/proxy-only = bot path; the human arm's own logAudit is untouched.)
  if (/^\/api\/community\/friends\/request(\/|$|\?)/.test(canonical)) return "friendRequest";
  // Inbox trinity doors (轴3 fold): the caller's own inbox pull/snapshot/ack fold
  // into users/me/inbox/{pull,snapshot,ack}. Map back to the logical verb so the
  // audit row stays inboxPull/inboxSnapshot/ack, not the `users` segment. (ack is
  // the advance operation of the fetch↔advance trinity — snapshot=peek /
  // pull=fetch / ack=advance; route/disc Gener #215 乙, relocated with the inbox
  // family, NOT to channels/{id}/read.)
  if (/^\/api\/community\/users\/me\/inbox\/pull(\/|$|\?)/.test(canonical)) return "inboxPull";
  if (/^\/api\/community\/users\/me\/inbox\/snapshot(\/|$|\?)/.test(canonical)) return "inboxSnapshot";
  if (/^\/api\/community\/users\/me\/inbox\/ack(\/|$|\?)/.test(canonical)) return null; // ack writes no audit row here (re-homed to daemon reborn-ready signal)

  // Bot-self lifecycle door (bots/me/*, Blondie #527): nap relocated from the flat
  // /nap to bots/me/nap. Map back to the logical `nap` verb so the audit stays
  // `nap`, not the `bots` segment.
  if (/^\/api\/community\/bots\/me\/nap(\/|$|\?)/.test(canonical)) return "nap";

  return null;
}

/**
 * Implicit typing.stop on `alook message send`. Emits `agent_typing_stop` for
 * every DM scope currently tracked for the agent, and DELIBERATELY leaves the
 * `typingTracker` + heartbeat interval untouched. Semantics:
 *   - Client pill drops immediately (nice UX when the reply just landed).
 *   - If the agent is still working, the next scheduled `agent_typing` frame
 *     (≤5s later, from the heartbeat) re-arms the pill.
 *   - If `turn_end` follows shortly, the normal FSM path (`onAgentActivity` →
 *     `emitTypingStopsAndClear`) clears the tracker and stops the heartbeat,
 *     so the pill stays down.
 * Guards a driver stream that never emits `turn_end` (a known Claude Code
 * failure mode: `type:"result"` never lands, `turnActive` stays `true`
 * forever, pill would dangle without this fallback).
 */
export function emitImplicitTypingStopOnSend(args: {
  subcommand: string;
  agentId: string;
  typingTracker: Pick<TypingScopeTracker, "snapshot">;
  reportAgentTypingStop?: (info: { agentId: string; channelId: string }) => void;
}): void {
  if (args.subcommand !== "send") return;
  const emit = args.reportAgentTypingStop;
  if (!emit) return;
  for (const channelId of args.typingTracker.snapshot(args.agentId)) {
    emit({ agentId: args.agentId, channelId });
  }
}

/** The minimal WebSocket the control channel needs (host injects a `ws` factory). */
export type DaemonWebSocketFactory = (url: string, headers: Record<string, string>) => unknown;

export interface CreateDaemonOptions {
  /** Long-lived credential (`cmk_...`) minted by /activate. */
  machineKey: string;
  /** Server HTTP base, e.g. http://127.0.0.1:4517 (enroll + data plane upstream). */
  serverUrl: string;
  /** Server control-plane ws base, e.g. ws://127.0.0.1:4518. */
  serverWsUrl: string;
  /** Builds the real `ws` client (injected so this module has no hard ws dep). */
  webSocketFactory: DaemonWebSocketFactory;
  /** Runtime descriptors advertised on the ready frame. Must include unhealthy runtimes too. */
  runtimeReport: Array<{
    id: string;
    version?: string;
    status?: "healthy" | "unhealthy";
    lastError?: string;
    lastErrorAt?: string;
  }>;
  /**
   * Per-agent runtime driver. `runtimeConfig` (server-pushed on
   * `agent:wake`) is passed so callers can dispatch on the actual runtime
   * the agent asked for; tests may omit it and hand back a stub driver.
   */
  driverFor: (agentId: string, runtimeConfig?: RuntimeConfig) => Driver;
  /** Default capability set granted to each agent's voucher. */
  capabilities: string[];
  /** Working directory base for agent launch contexts. */
  workingDirectoryBase?: string;
  /** Override the manager's pre-handshake watchdog (primarily for tests). */
  handshakeTimeoutMs?: number;
  /**
   * Directory for the DEFAULT-ON bounded FSM transition trace
   * (`<fsmTraceDir>/fsm-trace.jsonl`, size-capped/rotating — batch E1). When
   * omitted the default trace is off (test stubs). `ALOOK_FSM_TRACE=<path>`
   * overrides BOTH: it takes precedence and uses an unbounded single-file
   * append (deep-investigation mode). See plans/daemon-fsm-desync.md batch E.
   */
  fsmTraceDir?: string;
  /**
   * Absolute path for the periodic `daemon status` snapshot file (batch E2).
   * The running daemon writes a slim per-agent FSM projection here (atomic
   * tmp→rename) on a timer; the `daemon status` CLI reads it. Omit for test
   * stubs → no snapshot writing. See plans/daemon-fsm-desync.md batch E2.
   */
  statusFilePath?: string;
  /**
   * Absolute path to the host's agent CLI entrypoint. Real deployments point this
   * at the shim/binary the agent subprocess invokes (via a symlink in PATH).
   * Omit for test stubs that don't invoke the CLI.
   */
  agentCliPath?: string;
  tickIntervalMs?: number;
  /** Called when the server rejects our machine key (fatal — no reconnect). */
  onAuthRejected?: () => void;
  /** Optional machine metadata surfaced in the ready frame. */
  hostname?: string;
  platform?: string;
  arch?: string;
  osRelease?: string;
  daemonVersion?: string;
  /**
   * Shared logger for the whole daemon process. Defaults to
   * `createLogger({ header: "@alook/daemon" })`; `.child("ws")` /
   * `.child("router")` / `.child("manager")` are passed into the respective
   * collaborators so every line from one daemon process shares one header
   * family. `daemonStart.ts` passes its own instance here so the process has
   * exactly one logger tree instead of two independent ones.
   */
  logger?: Logger;
  /** B2b interception seam; B2c supplies the local collector/uploader. */
  handleDiagnosticCommand?: (command: DiagnosticCollectCommand) => void | Promise<void>;
  /** Machine-level lifecycle command; consumed before bot observers/router. */
  handleSelfUpdate?: () => void | Promise<void>;
  /** Fixed-code failure callback used when diagnostics is not available. */
  reportDiagnosticFailure?: (failure: DiagnosticFailureReport) => void | Promise<void>;
  /** Injectable daemon-local reminder clock; tests only, defaults to Node timers. */
  messageReminderClock?: Pick<MessageReminderSchedulerOptions, "now" | "setTimer" | "clearTimer">;
  /** Supplies only the bounded default FSM snapshot source and status snapshot path. */
  onDiagnosticSources?: (sources: {
    fsmTraceSource: Pick<RotatingFileSink, "openSnapshot"> | null;
    statusFilePath: string | undefined;
  }) => void;
}

export interface RunningDaemon {
  /** True once the control plane is open (machine key accepted). */
  isOpen(): boolean;
  /**
   * Register a hook fired after every (re)connect once the resync completes —
   * including the first open. Delegates to `channel.onOpen` (see
   * `WsControlChannel.onOpen`). Lets callers switch off event-driven signals
   * instead of polling `isOpen()`.
   *
   * The channel is already connecting by the time a caller can reach this, so
   * if the socket is ALREADY open at registration time the hook also fires
   * once immediately — otherwise a hook registered a tick too late would never
   * run for the connection it was meant to observe.
   */
  onOpen(hook: () => void): void;
  proxyUrl: string;
  stop(): Promise<void>;
}

/**
 * Start a daemon. Connects the control plane, starts the credential proxy (with
 * an inboxPull hook for timeline), enrolls agents on first contact, and wires
 * the agent manager. The full real code path is exercised — no shortcuts.
 */
export async function createDaemon(opts: CreateDaemonOptions): Promise<RunningDaemon> {
  const log = opts.logger ?? createLogger({ header: "@alook/daemon" });
  const fallbackBase = (process.env.ALOOK_PROJECT_ROOT || `${homedir()}/.alook`) + "/daemon";
  const workingDirectoryBase = opts.workingDirectoryBase ?? fallbackBase;
  const workdirFor = (agentId: string) => `${workingDirectoryBase}/${agentId}`;
  void sweepTimelineHistory(workingDirectoryBase).catch(() => {
    log.warn("timeline startup sweep failed");
  });

  // Self-healing: resolve CLI path with fallback if primary is missing
  const resolvedCliPath = resolveAlookCliPathWithFallback(opts.agentCliPath);
  const onRuntimeRawLine = createRuntimeRawLineTap({
    traceDir: opts.fsmTraceDir,
    enabledAgentIds: parseRuntimeRawTraceAgentIds(process.env[RUNTIME_RAW_TRACE_AGENT_IDS_ENV]),
    logger: log,
  });

  const timeline = createTimelineRecorder({
    timelineDirFor: (agentId) => `${workdirFor(agentId)}/.context_timeline`,
    providerFor: () => opts.runtimeReport[0]?.id ?? null,
  });

  // Held in a mutable cell so the credential-proxy and manager audit hooks
  // (constructed above the WsControlChannel below) can call it lazily —
  // the closures fire on real traffic long after `channel` is populated.
  let channelRef: WsControlChannel | null = null;
  // Populated after `manager` is constructed below. Producer B reads
  // `auditContext(agentId)` off it inside `onProxyRequest`.
  let managerRef: AgentProcessManager | null = null;
  let reminderSchedulerRef: MessageReminderScheduler | null = null;
  const emitBotAuditEvent = (
    agentId: string,
    event:
      | { kind: "cli_invocation"; payload: { subcommand: string } }
      | { kind: "tool_call"; payload: { name: string; target?: string } }
      | { kind: "thinking"; payload: { text: string; truncated: boolean; chars: number } }
      | {
          kind: "error";
          payload: {
            scope: "spawn" | "runtime" | "exit" | "handshake_timeout" | "model_switch" | "reset";
            code: string;
            message: string;
            model: string | null;
          };
        },
    context?: { sessionId?: string | null; launchId?: string | null }
  ) => {
    void channelRef?.reportBotAuditEvent?.({
      type: "bot_audit_event",
      agentId,
      sessionId: context?.sessionId ?? null,
      launchId: context?.launchId ?? null,
      event,
    });
  };

  // Declared above the proxy so `onProxyRequest`'s implicit-typing.stop hook
  // can read it. Populated later by the AgentRouter on each `agent:wake`.
  const typingTracker: TypingScopeTracker = createTypingScopeTracker();

  const broker = new CredentialBroker({ upstreamBaseUrl: opts.serverUrl });
  const proxy = await startCredentialProxy(broker, {
    onInboxPullResponse: (agentId, messages) => timeline.appendEntryForAgent(agentId, messages),
    onMessageReminderArm: (input) =>
      reminderSchedulerRef?.arm(input) ?? { armed: false, reason: "reminder_scheduler_unavailable" },
    // Bot audit log — Producer B (authoritative for `alook <sub>`). Fires
    // ONLY on `verdict.ok === true`, before the upstream request is written.
    onProxyRequest: (agentId, method, pathname) => {
      const subcommand = deriveAuditLogSubcommand(pathname, method);
      if (!subcommand) return;
      // Producer B: read the same audit context Producer A does so
      // cli_invocation rows carry launchId (and sessionId once the runtime
      // handshake has landed) — matches plan §Data model.
      const context = managerRef?.auditContext(agentId);
      emitBotAuditEvent(agentId, {
        kind: "cli_invocation",
        payload: { subcommand },
      }, context);
      // Typing pill fallback — see `emitImplicitTypingStopOnSend` docstring.
      emitImplicitTypingStopOnSend({
        subcommand,
        agentId,
        typingTracker,
        reportAgentTypingStop: channelRef?.reportAgentTypingStop?.bind(channelRef),
      });
    },
  });

  // Per-agent enrolled runner keys (enrollment is async; stored before deliver).
  const enrolledKeys = new Map<string, string>();

  // ── Bot typing indicator (DM-only) ─────────────────────────────────────
  //
  // `typingTracker` is declared above the proxy so `onProxyRequest`'s
  // implicit-typing.stop hook can read it. Populated by the AgentRouter on
  // each `agent:wake` (from `unreadNotice.channelId`) and cleared on
  // FSM transitions into `idle`/`stopping`.
  //
  // Per-agent heartbeat interval handles. Only alive while an agent is in
  // a running-family state; recreated on each starting/running transition.
  const typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
  const TYPING_HEARTBEAT_MS = 5_000;
  function stopTypingHeartbeat(agentId: string): void {
    const timer = typingHeartbeats.get(agentId);
    if (timer) {
      clearInterval(timer);
      typingHeartbeats.delete(agentId);
    }
  }
  // Level-triggered activity re-assert (durability for the profile pill).
  // `onAgentActivity` is edge-triggered, so an `agent_activity` frame dropped
  // during a disconnect window strands the pill on a stale state with no
  // recovery. This re-sends the manager's CURRENT derived activity
  // unconditionally each heartbeat — independent of any transition diff — so a
  // live, never-reconnecting agent's pill self-heals within one interval. The
  // heartbeat only runs while the agent is in a starting/running-family state
  // (torn down on idle/stopping), so it never wrongly asserts "working" for an
  // idle agent. Idempotent on the ws-do side (rewrites the same preset).
  function reassertAgentActivity(agentId: string): void {
    const state = managerRef?.agentActivity(agentId);
    if (state) channel.reportAgentActivity?.({ agentId, state });
  }
  function startTypingHeartbeat(agentId: string): void {
    stopTypingHeartbeat(agentId);
    // Immediate emit + every 5s while active — comfortably refreshes the
    // client's 8s expiry, and bypasses the ws-do 8s dedup gate (which only
    // guards the client-inbound `community:typing.start` path — daemon
    // metered heartbeats reach clients unconditionally).
    for (const channelId of typingTracker.snapshot(agentId)) {
      channel.reportAgentTyping?.({ agentId, channelId });
    }
    const timer = setInterval(() => {
      for (const channelId of typingTracker.snapshot(agentId)) {
        channel.reportAgentTyping?.({ agentId, channelId });
      }
      reassertAgentActivity(agentId);
    }, TYPING_HEARTBEAT_MS);
    timer.unref?.();
    typingHeartbeats.set(agentId, timer);
  }
  function emitTypingStopsAndClear(agentId: string): void {
    // Order: emit stops FIRST, then clear tracker. If two transitions fire
    // (running→stopping→idle), the second sees an empty tracker and
    // per-scope loop no-ops — matches the "emit-then-clear" rule in the
    // plan's race-handling section.
    stopTypingHeartbeat(agentId);
    for (const channelId of typingTracker.snapshot(agentId)) {
      channel.reportAgentTypingStop?.({ agentId, channelId });
    }
    typingTracker.clear(agentId);
  }

  // ── Bot cache ──────────────────────────────────────────────────────────
  //
  // `botsById` holds the minimum info the daemon needs to assemble system
  // prompts + gate `agent:*` commands. Maintained by:
  //   1. Cold-start warmup on WS `ready` (HTTP fetch, retried with backoff).
  //   2. Steady-state server pushes: bot:added / bot:updated / bot:removed.
  //   3. Reconnect: warmup re-runs; server's snapshot wins.
  //
  // Note: `cmk_`-rotation-implies-re-pair is documented as an assumption;
  // runtime code doesn't handle rotation.
  const botsById = new Map<
    string,
    { name: string; discriminator: string; description?: string; ownerName?: string; ownerDiscriminator?: string }
  >();

  async function listMyBotsHttp(): Promise<
    Array<{
      id: string;
      name: string;
      discriminator: string;
      description?: string;
      ownerName?: string;
      ownerDiscriminator?: string;
    }>
  > {
    const res = await fetch(`${opts.serverUrl}/api/community/daemon/bots`, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.machineKey}` },
    });
    if (!res.ok) throw new Error(`listMyBots ${res.status}`);
    const json = (await res.json()) as {
      bots?: Array<{
        id: string;
        name: string;
        discriminator: string;
        description?: string;
        ownerName?: string;
        ownerDiscriminator?: string;
      }>;
    };
    return json.bots ?? [];
  }

  async function coldStartWarmup(): Promise<void> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < WARMUP_CEILING_MS) {
      try {
        const bots = await listMyBotsHttp();
        // Server snapshot wins — reconcile the cache.
        botsById.clear();
        for (const b of bots) {
          botsById.set(b.id, {
            name: b.name,
            discriminator: b.discriminator,
            description: b.description,
            ownerName: b.ownerName,
            ownerDiscriminator: b.ownerDiscriminator,
          });
        }
        log.info("cold-start bot-cache warmup succeeded", { bots: bots.length, attempt });
        return;
      } catch {
        const delay = WARMUP_BACKOFF_MS[Math.min(attempt, WARMUP_BACKOFF_MS.length - 1)];
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
      }
    }
    // Ceiling exhausted — resolve empty. A subsequent `agent:wake` frame
    // will trigger a deferred retry via enrollAgent.
    log.warn("cold-start bot-cache warmup exhausted its ceiling", { ceilingMs: WARMUP_CEILING_MS, attempts: attempt });
  }

  /**
   * Ask the server to re-check each of this machine's bots for unread work
   * and re-wake any that have some. Recovers a message that arrived while
   * this daemon was offline: the wake-queue consumer acks (never retries) a
   * `delivered_nowhere` outcome, so without this call that wake is gone for
   * good once the daemon reconnects. The daemon drives WHEN this runs; the
   * server alone decides WHAT an `agent:wake` looks like (same
   * `dispatchOneUnreadWake` rebuild the queue consumer uses) — this call
   * carries no addressing/config, just "check now". Best-effort: logged, never
   * thrown, never blocks the rest of connect.
   */
  async function resyncPendingWakes(): Promise<void> {
    try {
      const res = await fetch(`${opts.serverUrl}/api/community/daemon/resync-wakes`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.machineKey}` },
      });
      if (!res.ok) throw new Error(`resync-wakes ${res.status}`);
      const json = (await res.json()) as { woken?: number };
      log.info("wake resync completed", { woken: json.woken ?? 0 });
    } catch (err) {
      log.warn("wake resync failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  const enrollAgent = async (agentId: string): Promise<string> => {
    const existing = enrolledKeys.get(agentId);
    if (existing) return existing;
    // Bot-scoped cache-invalidation: if this agent isn't in `botsById` we
    // don't have authoritative confirmation the server thinks it exists;
    // proceed anyway (the server-side enroll route is the source of truth
    // and will 404 if the bot is unknown/cross-owner).
    try {
      const res = await fetch(`${opts.serverUrl}/api/community/daemon/enroll-agent`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.machineKey}` },
        body: JSON.stringify({ agentId }),
      });
      const text = await res.text();
      let json: { runnerKey?: string; error?: string } = {};
      if (text) {
        try {
          json = JSON.parse(text) as { runnerKey?: string; error?: string };
        } catch {
          json = {};
        }
      }
      if (!res.ok || !json.runnerKey) {
        if (res.status === 404) {
          throw new UnknownBotError(agentId);
        }
        throw new BotEnrollFailedError(
          agentId,
          new Error(json.error ?? `enroll failed (${res.status})${text ? `: ${text.slice(0, 512)}` : ""}`),
        );
      }
      enrolledKeys.set(agentId, json.runnerKey);
      return json.runnerKey;
    } catch (err) {
      if (err instanceof UnknownBotError || err instanceof BotEnrollFailedError) {
        log.warn("agent enroll failed", { agentId, err: err.message });
        throw err;
      }
      const wrapped = new BotEnrollFailedError(agentId, err);
      log.warn("agent enroll failed", { agentId, err: wrapped.message });
      throw wrapped;
    }
  };

  const channel = new WsControlChannel({
    url: opts.serverWsUrl,
    headers: { Authorization: `Bearer ${opts.machineKey}` },
    webSocketFactory: opts.webSocketFactory as never,
    onAuthRejected: opts.onAuthRejected,
    logger: log.child("ws"),
  });
  channelRef = channel;

  // Cache-side handler for bot:* frames. Runs BEFORE AgentRouter sees them,
  // via a channel wrapper (registered below).
  function handleBotFrame(cmd: HostCommand): void {
    switch (cmd.type) {
      case "bot:added":
        botsById.set(cmd.botId, {
          name: cmd.name,
          discriminator: cmd.discriminator,
          description: cmd.description,
          ownerName: cmd.ownerName,
          ownerDiscriminator: cmd.ownerDiscriminator,
        });
        log.debug("bot:added", { botId: cmd.botId, name: cmd.name });
        break;
      case "bot:updated": {
        const prev = botsById.get(cmd.botId);
        botsById.set(cmd.botId, {
          name: cmd.name,
          discriminator: cmd.discriminator,
          description: cmd.description,
          ownerName: cmd.ownerName,
          ownerDiscriminator: cmd.ownerDiscriminator,
        });
        // If a subprocess is running for this bot AND name/description changed,
        // stop it so the next wake trigger spawns a fresh subprocess with the
        // new system prompt. Rename is effective on next spawn, not mid-flight.
        const nameChanged = prev && prev.name !== cmd.name;
        const descChanged = prev && (prev.description ?? "") !== (cmd.description ?? "");
        log.debug("bot:updated", { botId: cmd.botId, name: cmd.name });
        if (nameChanged || descChanged) {
          void manager.stop(cmd.botId);
        }
        break;
      }
      case "bot:removed":
        botsById.delete(cmd.botId);
        enrolledKeys.delete(cmd.botId);
        log.debug("bot:removed", { botId: cmd.botId });
        void manager.stop(cmd.botId);
        break;
      default:
        break;
    }
  }

  // Router is wired below. Held in a mutable cell so `driverFor` — which
  // needs to consult live runtime-health — and the manager's session-lifecycle
  // callbacks can reach it after construction. Both closures resolve `router!`
  // lazily; router.start() runs at the bottom of createDaemon before any
  // command dispatch, so runtime code always sees a populated cell.
  let router: AgentRouter | null = null;

  const diagnosticTrace = (() => {
    const overridePath = process.env.ALOOK_FSM_TRACE;
    if (overridePath) {
      return {
        source: null,
        onFsmTransition: (rec: ManagerTraceRecord) => {
          try {
            appendFileSync(overridePath, JSON.stringify(rec) + "\n");
          } catch {
            /* never let tracing break the daemon */
          }
        },
      };
    }
    if (!opts.fsmTraceDir) return { source: null };
    try {
      mkdirSync(opts.fsmTraceDir, { recursive: true });
    } catch {
      /* best-effort: if the dir can't be made, sink writes just no-op */
    }
    const source = createRotatingFileSink(
      `${opts.fsmTraceDir}/fsm-trace.jsonl`,
      DEFAULT_TRACE_FILE_MAX_BYTES,
    );
    const sampler = createTraceSampler((rec) => source.write(JSON.stringify(rec)));
    return {
      source,
      onFsmTransition: (rec: ManagerTraceRecord) => sampler.offer(rec),
    };
  })();

  const manager = new AgentProcessManager({
    // Wrap the caller's driverFor to short-circuit dispatch to a known-unhealthy
    // runtime. If the router flags the runtime as unhealthy we throw
    // UnknownRuntimeError with the healthy-only id list — the existing catch
    // in agentRouter.onCommand produces bot_runtime_missing + runtime_not_available
    // frames, matching the "runtime not installed" path.
    driverFor: (agentId, runtimeConfig) => {
      const requested = runtimeConfig?.runtime;
      if (requested && router && !router.isRuntimeHealthy(requested)) {
        throw new UnknownRuntimeError(requested, router.healthyRuntimeIds());
      }
      return opts.driverFor(agentId, runtimeConfig);
    },
    onRuntimeSpawnFailed: (runtimeId, reason) => {
      router?.recordRuntimeSpawnFailure(runtimeId, reason);
    },
    onRuntimeSessionEstablished: (runtimeId) => {
      router?.markRuntimeHealthy(runtimeId);
    },
    baseContextFor: (agentId: string) => {
      const runnerKey = enrolledKeys.get(agentId);
      if (!runnerKey) throw new Error(`agent ${agentId} not enrolled yet — enroll before deliver`);
      // Look up bot metadata for system-prompt assembly. Missing (unknown bot
      // that pre-dates warmup) is not fatal — the manager's default prompt
      // path handles missing name/description.
      const botMeta = botsById.get(agentId);
      return {
        agentId,
        workingDirectory: workdirFor(agentId),
        credentialProxy: { broker, proxyUrl: proxy.url, runnerKey, capabilities: opts.capabilities },
        agentCliPath: resolvedCliPath ?? opts.agentCliPath,
        config: {
          ...(botMeta?.name ? { agentName: botMeta.name } : {}),
          ...(botMeta?.discriminator ? { agentDiscriminator: botMeta.discriminator } : {}),
          ...(botMeta?.name && botMeta?.discriminator
            ? { agentHandle: `@${formatHandle(botMeta.name, botMeta.discriminator)}` }
            : {}),
          ...(botMeta?.description ? { description: botMeta.description } : {}),
          ...(botMeta?.ownerName && botMeta?.ownerDiscriminator
            ? { ownerHandle: `@${formatHandle(botMeta.ownerName, botMeta.ownerDiscriminator)}` }
            : {}),
        } as LaunchContext["config"],
      } as Omit<LaunchContext, "prompt" | "standingPrompt"> & { config?: LaunchContext["config"] };
    },
    ...(opts.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: opts.handshakeTimeoutMs }
      : {}),
    tickIntervalMs: opts.tickIntervalMs ?? 2000,
    onAgentSession: (info) => void channel.reportAgentSession(info),
    onAgentActivity: (info) => {
      void channel.reportAgentActivity?.(info);
      // Bot typing indicator (DM-only) — install / tear down the daemon-metered
      // heartbeat off the derived FSM activity, so the pill lifecycle exactly
      // mirrors "is this bot actively working."
      //
      // `onAgentActivity` fires on every derived-activity change, so a natural
      // `idle → starting → running` sequence emits BOTH starting and running.
      // The `typingHeartbeats.has(agentId)` guard makes install idempotent —
      // subsequent starting/running transitions are no-ops instead of
      // restarting the interval + firing a duplicate immediate frame.
      if (info.state === "starting" || info.state === "running") {
        if (!typingHeartbeats.has(info.agentId)) {
          startTypingHeartbeat(info.agentId);
        }
      } else {
        emitTypingStopsAndClear(info.agentId);
      }
    },
    // Bot audit log — Producer A (runtime thinking + non-Bash tool_call).
    // Bash suppression + thinking truncation happen inside managerRuntime.
    onBotAuditEvent: (agentId, event, context) => emitBotAuditEvent(agentId, event, context),
    // Idle hibernation / stall-recovery stops the subprocess without a
    // server-sent agent:stop; keep AgentRouter.running aligned so the next
    // `ready` frame's `runningAgents` reflects what's actually live and the
    // server's reconciler safety net can flip stale pills to idle.
    onAgentLocallyStopped: (info) => router?.markLocallyStopped(info.agentId),
    onRuntimeRawLine,
    // FSM transition trace → file. One JSON line per reduce so a wedge that
    // logs nothing else is reconstructable from its FSM history (the "no log
    // when it breaks" fix, plans/daemon-fsm-desync.md). Two modes:
    //   - DEFAULT ON (batch E1): a bounded, size-capped/rotating sink at
    //     `<fsmTraceDir>/fsm-trace.jsonl` — so we're never blind to the last
    //     wedge without pre-setting an env, and it can't fill the disk.
    //   - `ALOOK_FSM_TRACE=<path>` OVERRIDE: unbounded single-file append at
    //     that path (deep-investigation mode; takes precedence over the
    //     default). Content is FSM metadata only (no PII) — safe to default on.
    ...(diagnosticTrace.onFsmTransition
      ? { onFsmTransition: diagnosticTrace.onFsmTransition }
      : {}),
    // Only the "pi" runtime declares `Driver.createSession` today (in-process
    // SDK, no child process) — this is only ever consulted for that case.
    sdkDriverDepsFor: (ctx) => createPiSdkDriverDeps(ctx),
    timeline,
    wakePromptFooter: "Use `alook inbox pull` to read your messages.",
    stampWakePromptTime: true,
    logger: log.child("manager"),
  });
  managerRef = manager;
  manager.start();
  reminderSchedulerRef = new MessageReminderScheduler({
    deliver: (agentId, message) => manager.deliver(agentId, message),
    ...opts.messageReminderClock,
  });

  // Periodic `daemon status` snapshot (batch E2): the daemon has no IPC, so it
  // writes a slim per-agent FSM projection to a file that the out-of-band
  // `daemon status` CLI reads. Best-effort + atomic (inside writeStatusFile).
  // Interval a bit slower than the tick — this is for human/agent diagnosis,
  // not a hot path; staleness is bounded by this interval and the reader always
  // flags the snapshot's age via `writtenAt`.
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.statusFilePath) {
    const statusPath = opts.statusFilePath;
    const writeStatus = () =>
      writeStatusFile(statusPath, { writtenAt: Date.now(), agents: manager.statusProjection(Date.now()) });
    writeStatus(); // one immediately so `daemon status` works right after boot
    statusTimer = setInterval(writeStatus, STATUS_WRITE_INTERVAL_MS);
    statusTimer.unref?.();
  }
  opts.onDiagnosticSources?.({
    fsmTraceSource: diagnosticTrace.source,
    statusFilePath: opts.statusFilePath,
  });

  router = new AgentRouter({
    manager,
    channel,
    runtimeReport: opts.runtimeReport,
    hostname: opts.hostname,
    platform: opts.platform,
    arch: opts.arch,
    osRelease: opts.osRelease,
    daemonVersion: opts.daemonVersion,
    typingTracker,
    logger: log.child("router"),
    // onBeforeAgent gate — reject unknown bots BEFORE enroll to keep the
    // failure code stable (`bot_unknown` vs `bot_enroll_failed`).
    onBeforeAgent: async (agentId) => {
      if (!botsById.has(agentId)) {
        // Try one deferred warmup pass — the ceiling-exhaustion case parks
        // the daemon with an empty cache; the first real frame should retry
        // the fetch once before erroring out.
        try {
          const bots = await listMyBotsHttp();
          for (const b of bots) {
            botsById.set(b.id, {
              name: b.name,
              discriminator: b.discriminator,
              description: b.description,
              ownerName: b.ownerName,
              ownerDiscriminator: b.ownerDiscriminator,
            });
          }
        } catch {
          // Fall through — still treat as unknown below.
        }
      }
      if (!botsById.has(agentId)) {
        throw new UnknownBotError(agentId);
      }
      await enrollAgent(agentId);
    },
    formatUnreadNoticeText: (notice: UnreadNotice) =>
      `You have unread messages in channel ${notice.channel}.`,
  });

  // Machine lifecycle commands are claimed before diagnostics, bot observers,
  // and AgentRouter; updates never enter agent lifecycle routing.
  channel.onCommand(createSelfUpdateCommandListener(opts.handleSelfUpdate));
  // Diagnostics likewise claims its machine-level command before bot/router.
  channel.onCommand(createDiagnosticsCommandListener({
    handleDiagnosticCommand: opts.handleDiagnosticCommand,
    reportDiagnosticFailure: opts.reportDiagnosticFailure,
  }));
  // Local reminder bookkeeping observes the original FIFO control stream
  // before AgentRouter registers its listener in router.start(). It never
  // consumes commands; AgentRouter remains the sole server-wake dispatcher.
  channel.onCommand((cmd) => {
    switch (cmd.type) {
      case "agent:wake":
        reminderSchedulerRef?.observe(cmd.agentId, cmd.unreadNotice.channel, cmd.unreadNotice.latestSeq);
        break;
      case "agent:stop":
        reminderSchedulerRef?.clearAgent(cmd.agentId);
        break;
      case "bot:removed":
        reminderSchedulerRef?.clearAgent(cmd.botId);
        break;
      default:
        break;
    }
  });
  channel.onCommand((cmd) => {
    handleBotFrame(cmd);
  });
  // Warmup on every (re)connect — including the first open. `onOpen` fires
  // after resync completes. Wake-resync runs alongside it so a message
  // dropped while this daemon was offline gets a second chance right away.
  channel.onOpen(() => {
    void coldStartWarmup();
    void resyncPendingWakes();
  });

  channel.connect();
  await router!.start();

  return {
    isOpen: () => channel.status === "open",
    // `channel.connect()` already ran above, so a caller registering here is
    // racing the first open: if the socket won that race the hook would never
    // fire at all. Fire it once immediately in that case (on a microtask, so
    // registration itself stays side-effect-free for the caller) and still
    // register it for every subsequent reconnect.
    onOpen: (hook: () => void) => {
      channel.onOpen(hook);
      if (channel.status === "open") queueMicrotask(hook);
    },
    proxyUrl: proxy.url,
    stop: async () => {
      reminderSchedulerRef?.clearAll();
      // Clear all bot-typing heartbeat intervals and emit final stops for
      // any outstanding scopes so no pill is left dangling.
      for (const agentId of [...typingHeartbeats.keys()]) {
        emitTypingStopsAndClear(agentId);
      }
      if (statusTimer) clearInterval(statusTimer);
      channel.close();
      await proxy.close();
      await manager.stopAll();
    },
  };
}

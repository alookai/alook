/**
 * Agent process manager — thin side-effect executor.
 *
 * This is the impure half: it owns the mutable `ManagerState`, drives the pure
 * `reduceManager` policy with real events, and applies the emitted effects
 * against real runtime sessions (spawn / send / stop) plus a tick timer for
 * stall detection. It is intentionally thin — all decisions live in the policy;
 * this layer only does I/O.
 *
 * A host wires it up with a `SessionFactory` (how to build a runtime session for
 * an agent) and feeds it inbound messages via `deliver()`.
 */
import {
  reduceManager,
  createInitialManagerState,
  DEFAULT_STOPPING_STUCK_THRESHOLD_MS,
  type ManagerState,
  type ManagerEvent,
  type ManagerEffect,
  type AgentRuntimeCaps,
  type AgentMsg,
  type AgentState,
  isActivelyWorking,
} from "./managerPolicy.js";
import type { Driver, LaunchContext, SdkDriverDeps } from "../types.js";
import { busyDeliveryModeOf, supportsStdinNotificationOf } from "../types.js";
import { resolveLaunchFieldsOrDefault, type RuntimeConfig } from "../runtimeConfig.js";
import { createChildProcessRuntimeSession, type ChildProcessRuntimeSession } from "../runtime/runtimeSession.js";
import { SESSION_STOP_GRACE_MS } from "../runtime/killTree.js";
import { scrubRuntimeErrorDiagnosticText } from "../runtime/errorDiagnostics.js";
import { SdkManagedSession } from "../runtime/sdkManagedSession.js";
import { DEFAULT_CLI_CONFIG } from "../drivers/cliTransport.js";
import { createLogger, type Logger } from "../logger.js";
import { nowLocalISO } from "../util/localTime.js";

/**
 * Derived activity state reported up the control plane — NOT a raw passthrough
 * of `AgentState.status` (see `deriveActivity` below). Mirrors
 * `@alook/shared`'s `AgentActivityState`, inlined here since this is
 * daemon-internal.
 */
export type AgentActivityState = "idle" | "starting" | "running" | "stopping";

/** Minimal shape the executor needs from a runtime session. */
export interface ManagedSession {
  on(event: string, cb: (...args: unknown[]) => void): void;
  start(input: { text: string; sessionId?: string }): Promise<unknown>;
  send(input: { text: string; mode: "busy" | "idle" }): unknown;
  stop(opts?: { reason?: string; forceAfterMs?: number }): Promise<void> | void;
  readonly currentSessionId: string | null;
}

/**
 * How the host builds a session for an agent launch. Given the agent id, the
 * driver, and the launch context (prompt + resume id filled in), return a
 * session the executor will drive.
 */
export type SessionFactory = (args: {
  agentId: string;
  driver: Driver;
  ctx: LaunchContext;
}) => ManagedSession;

export interface ManagerRuntimeOpts {
  /**
   * Resolve a driver for an agent. The optional `runtimeConfig` is supplied
   * whenever the manager knows it (i.e. after `register` with the server-pushed
   * config) so callers can pick the right runtime; tests may omit it.
   */
  driverFor: (agentId: string, runtimeConfig?: RuntimeConfig) => Driver;
  baseContextFor: (agentId: string) => Omit<LaunchContext, "prompt" | "config" | "standingPrompt"> & {
    standingPrompt?: string;
    config?: LaunchContext["config"];
  };
  sessionFactory?: SessionFactory;
  /**
   * Zero-trust credential handoff for real (child-process) spawns. Required when
   * NOT using a `sessionFactory` — `prepareCliTransport` refuses to launch a CLI
   * runtime without it (no plaintext fallback). Threaded into each LaunchContext.
   */
  credentialProxy?: LaunchContext["credentialProxy"];
  /**
   * Builds the `SdkDriverDeps` for an in-process SDK driver's `createSession`
   * (see `types.ts`). Required when NOT using a `sessionFactory` AND a
   * resolved driver declares `createSession` (Pi today) — mirrors the
   * `credentialProxy` requirement for child-process drivers. Called once per
   * spawn with the same base `ctx` a `ChildProcessRuntimeSession` would get.
   */
  sdkDriverDepsFor?: (ctx: LaunchContext) => SdkDriverDeps;
  staleThresholdMs?: number;
  /** Idle hibernation timeout (ms): stop a persistent process idle this long. */
  idleTimeoutMs?: number;
  /** Reset-stuck reconcile threshold (ms): `resetting` stuck this long ⇒ escalate. */
  resetStuckThresholdMs?: number;
  /** Stopping-stuck escalation threshold (ms): `stopping` this long (no exit came) ⇒ force_exit. */
  stoppingStuckThresholdMs?: number;
  /**
   * Handshake watchdog (ms): a spawned session that never emits its first
   * `runtime_event` (the handshake) within this window is treated as a
   * pre-establishment failure — the process is stopped, an `error` audit row
   * is emitted, and the FSM is returned to idle. Catches the case a bad model
   * makes the CLI HANG (no exit, no stderr, no stdout) — otherwise invisible
   * and unrecoverable (the `onTick` stall watchdog excludes an empty-inbox
   * gated agent). Defaults to 60s: a healthy cold start handshakes in <10s.
   */
  handshakeTimeoutMs?: number;
  tickIntervalMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Notified when an agent's runtime session id is first learned (from a
   * `session_init` event). The router relays this to the server as
   * `reportAgentSession` so the server can correlate + resume.
   */
  onAgentSession?: (info: { agentId: string; sessionId: string; launchId: string }) => void;
  /**
   * Notified whenever an agent's DERIVED activity (per `deriveActivity`)
   * changes — not on every raw FSM transition. See the Design Overview in
   * plans/community-bot-status-telemetry.md.
   */
  onAgentActivity?: (info: { agentId: string; state: AgentActivityState }) => void;
  /**
   * Notified whenever a runtime `thinking` or `tool_call` event lands. Wired
   * in `createDaemon` to send a `bot_audit_event` frame through the WS
   * control channel. Tool calls flow through `extractToolAudit`, which
   * canonicalizes the tool name to lowercase (`Bash` → `bash`, codex
   * `shell` → `bash`, codex `file_change` → `edit`, etc.), picks a
   * `target` field driver-agnostically (file path / shell command /
   * pattern / url / mcp name), and suppresses any bash-family call whose
   * resolved command is `alook <sub>` — the credential-proxy
   * `cli_invocation` sighting is authoritative for those.
   *
   * `thinking` payloads carry truncated `text` + original `chars`; the audit
   * log does not record raw tool input beyond the optional `target`.
   */
  onBotAuditEvent?: (
    agentId: string,
    event:
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
    context: { sessionId: string | null; launchId: string | null }
  ) => void;
  /**
   * Notified when the daemon itself terminates an agent (idle hibernation or
   * stall-recovery) — NOT for server-sent `agent:stop`, which the router
   * already tracks. Wired in `createDaemon` to `AgentRouter.markLocallyStopped`
   * so `ready.runningAgents` stays aligned with what's actually live.
   */
  onAgentLocallyStopped?: (info: { agentId: string; reason: "stop" | "terminate_stalled" }) => void;
  /**
   * Pure-observability FSM transition trace. Called once per `dispatch` reduce
   * (for events carrying an agentId) with the post-reduce key fields + the
   * effect kinds produced. Wired in `createDaemon` to append to a file when
   * `ALOOK_FSM_TRACE` is set — lets a wedge that produces no other log be
   * reconstructed from its FSM history. No behavior change; omit ⇒ no-op.
   */
  onFsmTransition?: (rec: {
    agentId: string;
    event: string;
    status: string;
    turnActive: boolean;
    inbox: number;
    lastDeliverAt: number | null;
    lastProgressAt: number;
    idleSince: number | null;
    resetting: boolean;
    resettingSince: number | null;
    apmPhase: string;
    effects: string[];
    nowMs: number;
    /** `nowMs - lastProgressAt` — stalled/suspectedDeaf "no progress for how long". */
    sinceProgressMs: number;
    /** `nowMs - lastDeliverAt` (null if never delivered) — suspectedDeaf's half. */
    sinceDeliverMs: number | null;
  }) => void;
  /**
   * Optional context-timeline recorder. When provided, the manager logs each
   * spawn as a "running" row, fills in the session id on session_init, and closes
   * the row on turn_end / exit — a pure DAILY LOG, no steering. It also supplies
   * the resume session id for an agent's next launch (latest finished session in
   * that agent's own timeline). Omitted ⇒ no logging, in-memory resume only.
   */
  timeline?: TimelineRecorder;
  /**
   * Appended once to the coalesced wake prompt (after dedup). Use for a
   * one-shot instruction like "Use `alook inbox pull` to read your messages."
   */
  wakePromptFooter?: string;
  /**
   * When true, prepend a `[<local-tz ISO>]` timestamp to every prompt handed
   * to the runtime driver (both spawn's initial prompt and mid-turn steer
   * sends). Stamped inside `withFooter` — as close to "the moment the agent
   * actually sees this text" as we can get — so the number reflects the real
   * arrival wall-clock, not an earlier layer's timestamp. Off in tests so
   * exact-string assertions on send/prompt stay stable; enabled in production
   * via `createDaemon`.
   */
  stampWakePromptTime?: boolean;
  /**
   * Notified when a spawn fails BEFORE the runtime emits its handshake
   * `runtime_event` (pre-establishment error). Typically wired to
   * `AgentRouter.markRuntimeUnhealthy` so /community reflects the broken
   * runtime; see plans/community-machine-presence-fix.md.
   *
   * `reason` is a short code like `"ENOENT"` or `"pre_handshake_exit"`.
   */
  onRuntimeSpawnFailed?: (runtimeId: string, reason: string) => void;
  /**
   * Notified once per session when it emits its first post-handshake
   * `runtime_event`. Typically wired to `AgentRouter.markRuntimeHealthy` so
   * a runtime that was flagged unhealthy self-heals after the user fixes
   * their install (or after a genuine transient failure).
   */
  onRuntimeSessionEstablished?: (runtimeId: string) => void;
  /** Defaults to `createLogger({ header: "@alook/daemon:manager" })`. */
  logger?: Logger;
}

/**
 * Lifecycle sink the manager calls to record turns + look up resume. Kept as an
 * injected interface so managerRuntime stays fs-free and unit-testable; the
 * daemon backs it with the `src/timeline` module over the agent's workdir.
 */
export interface TimelineRecorder {
  /**
   * Record the runtime session id (from session_init). The recorder bakes it into
   * the entry opened by the agent's next inbox pull (which happens after
   * session_init), so the row carries the right session id.
   */
  setSession(agentId: string, sessionId: string): void;
  /**
   * Append a piece of the agent's response (a runtime `text` event) to the
   * agent's latest entry's `agent_responses` — the "what I said this turn" data
   * that makes the timeline usable as memory. The entry itself is opened on the
   * DATA plane (inbox pull); the manager only accumulates onto the latest row.
   */
  appendResponseToLatest(agentId: string, text: string): void;
  /** Latest session id for this agent (resume target), or null. */
  resumeSessionId(agentId: string, provider: string | null): string | null;
  /**
   * Reset: the caller asked the daemon to forget this agent's prior session so
   * the next spawn starts fresh. Recorder appends a `system` barrier row —
   * `reset_session` (owner) or `nap` (agent self-reset, default
   * `reset_session`) — visible to both the resume walker (returns null on the
   * barrier — every turn at or before it becomes invisible to
   * `resumeSessionId`) and the agent's own history read (so the agent sees it
   * in-line with turns). Kill happens BEFORE the barrier is written (see
   * `AgentProcessManager.resetSession`), so no race — no `forgot_session_id`
   * needed. Safe to call on an unknown agentId.
   */
  forgetSession(agentId: string, barrierType?: "reset_session" | "nap"): void;
}

/** Max UTF-8 byte budget for `thinking` text in the audit log. */
const THINKING_MAX_BYTES = 4096;

/** Max length of a runtime-stderr line the daemon logs verbatim (with an ellipsis when cut). */
const STDERR_LOG_MAX_LEN = 2000;

/** Max length of an `error` audit row's message (schema caps at 2048; leave headroom). */
const AUDIT_ERROR_MESSAGE_MAX_LEN = 2000;

/**
 * Max UTF-16 code units for a tool_call's `target` field. The wire schema
 * caps `target` at 240 (see `AuditLogToolCallPayloadSchema`) and Zod's
 * `.max()` measures UTF-16 length — the extractor truncates at 200 to keep
 * 40 units of headroom for any future producer that stamps a suffix before
 * wire validation. Truncating on codepoints would let an emoji-heavy target
 * exceed 240 UTF-16 units and get rejected at the wire.
 */
const MAX_TARGET_CODE_UNITS = 200;

/**
 * Canonicalize a driver-raw tool name to the lowercase tag the audit log
 * stores. The map is case-insensitive on the input: `Bash|bash|BASH → bash`,
 * codex's `shell → bash` and `file_change → edit`, `MultiEdit → edit`
 * (intentional semantic collapse — every MultiEdit acts on one file),
 * `NotebookEdit → notebook_edit`, `LS → ls`, `WebSearch → web_search`,
 * `WebFetch → web_fetch`, `TodoWrite → todo_write`. Anything else falls
 * through to its lowercased original (e.g. `mcp_search` stays `mcp_search`,
 * an unknown `Frobnicate` becomes `frobnicate`) so new drivers don't need
 * this table updated to surface.
 */
export function canonicalToolName(rawName: string): string {
  const lower = rawName.toLowerCase();
  switch (lower) {
    case "bash":
    case "shell":
      return "bash";
    case "read":
      return "read";
    case "edit":
    case "multiedit":
    case "file_change":
      return "edit";
    case "write":
      return "write";
    case "grep":
      return "grep";
    case "glob":
      return "glob";
    case "find":
      return "find";
    case "ls":
      return "ls";
    case "notebookedit":
    case "notebook_edit":
      return "notebook_edit";
    case "websearch":
    case "web_search":
      return "web_search";
    case "webfetch":
    case "web_fetch":
      return "web_fetch";
    case "todowrite":
    case "todo_write":
      return "todo_write";
    default:
      return lower;
  }
}

type ToolClass = "shell" | "file_target" | "pattern" | "fallthrough";

function classify(canonicalName: string): ToolClass {
  switch (canonicalName) {
    case "bash":
      return "shell";
    case "read":
    case "edit":
    case "write":
    case "ls":
    case "notebook_edit":
      return "file_target";
    case "grep":
    case "glob":
    case "find":
      return "pattern";
    default:
      return "fallthrough";
  }
}

/**
 * Coerce a runtime-emitted `input` to a plain record for field-picking.
 * Non-object inputs (null, undefined, array, number, boolean) become
 * `undefined`. As a special case, string inputs get a single `JSON.parse`
 * attempt: copilot's OpenAI-style tool-call `arguments` reaches this layer
 * as a stringified JSON blob when the driver's `arguments ?? parameters ??
 * input ?? {}` fallback picks the raw string up unparsed. If the parse
 * succeeds and yields a record, that record is returned; on any failure
 * (non-JSON string, JSON that decodes to a non-object) we return
 * `undefined` — never throw. One parse attempt per event, so an adversarial
 * huge string is bounded by the runtime's own event size limits.
 */
function coerceInputRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

/**
 * Extract a raw command string from a shell-class tool_call's `input`. Every
 * driver reduces to a root `input.command` after its normalizer runs
 * (Anthropic, cursor, kimi, opencode, pi, gemini, copilot, and codex — the
 * codex normalizer unwraps `params.item`, so `command` is already flat).
 * String or array (`["bash", "-lc", "..."]` from codex) — arrays get
 * space-joined, keeping the honest form the runtime saw. Returns
 * `undefined` when no plausible command is present.
 */
export function pickCommandString(input: unknown): string | undefined {
  const rec = coerceInputRecord(input);
  if (!rec) return undefined;
  if (typeof rec.command === "string") return rec.command;
  if (Array.isArray(rec.command)) return rec.command.filter((v) => typeof v === "string").join(" ");
  return undefined;
}

function pickFileTarget(input: unknown): string | undefined {
  const rec = coerceInputRecord(input);
  if (!rec) return undefined;
  if (typeof rec.file_path === "string") return rec.file_path;
  if (typeof rec.path === "string") return rec.path;
  if (typeof rec.notebook_path === "string") return rec.notebook_path;
  return undefined;
}

function pickPatternTarget(input: unknown): string | undefined {
  const rec = coerceInputRecord(input);
  if (!rec) return undefined;
  if (typeof rec.pattern === "string") return rec.pattern;
  if (typeof rec.query === "string") return rec.query;
  if (typeof rec.path === "string") return rec.path;
  return undefined;
}

function pickFallthroughTarget(input: unknown): string | undefined {
  const rec = coerceInputRecord(input);
  if (!rec) return undefined;
  if (typeof rec.url === "string") return rec.url;
  if (typeof rec.query === "string") return rec.query;
  if (typeof rec.path === "string") return rec.path;
  if (typeof rec.name === "string") return rec.name;
  return undefined;
}

/**
 * A bash-family tool_call is the daemon proxy's shadow when — and only when
 * — the resolved command is `alook` or `alook <sub …>`. In that case the
 * credential proxy emits an authoritative `cli_invocation` audit row and
 * the tool_call would duplicate it. Any other command (rm, sed, git, pnpm,
 * echo, `bash -lc "alook …"` — the outer shell is real work) is user
 * intent and must surface.
 */
const ALOOK_SHELL_INVOCATION_RE = new RegExp(`^${DEFAULT_CLI_CONFIG.cliName}(\\s|$)`);

export function isAlookShellInvocation(command: string | undefined): boolean {
  if (!command) return false;
  return ALOOK_SHELL_INVOCATION_RE.test(command.trimStart());
}

/**
 * Truncate a target to at most `MAX_TARGET_CODE_UNITS` UTF-16 code units,
 * appending `…` when cut. Walks back one unit if the boundary lands on a
 * high surrogate (never emits a lone surrogate).
 */
export function truncateTargetToCodeUnits(s: string): string {
  if (s.length <= MAX_TARGET_CODE_UNITS) return s;
  let end = MAX_TARGET_CODE_UNITS - 1;
  const cu = s.charCodeAt(end - 1);
  if (cu >= 0xd800 && cu <= 0xdbff) end -= 1;
  return s.slice(0, end) + "…";
}

/**
 * Driver-agnostic tool_call extractor. Given a runtime-raw `(name, input)`
 * pair, returns the canonical lowercase `name`, an optional short `target`
 * summary (file path / shell command / pattern / url / mcp name), and a
 * `suppressed` flag that's true for bash-family calls whose command is
 * `alook <sub>` (the credential proxy's `cli_invocation` is authoritative
 * for those).
 *
 * The returned object contains ONLY `{name, target?, suppressed}`. Raw
 * `input` is NEVER returned. Callers must destructure — never spread — so
 * a future extractor field addition cannot accidentally leak sensitive tool
 * args onto the wire.
 */
export function extractToolAudit(
  rawName: string,
  rawInput: unknown
): { name: string; target?: string; suppressed: boolean } {
  const name = canonicalToolName(rawName);
  const cls = classify(name);
  if (cls === "shell") {
    const raw = pickCommandString(rawInput);
    if (isAlookShellInvocation(raw)) {
      return { name, suppressed: true };
    }
    const firstLine = typeof raw === "string"
      ? raw.split("\n").map((s) => s.trim()).find((s) => s.length > 0)
      : undefined;
    if (!firstLine) return { name, suppressed: false };
    return { name, target: truncateTargetToCodeUnits(firstLine), suppressed: false };
  }
  let target: string | undefined;
  if (cls === "file_target") target = pickFileTarget(rawInput);
  else if (cls === "pattern") target = pickPatternTarget(rawInput);
  else target = pickFallthroughTarget(rawInput);
  if (typeof target !== "string" || target.length === 0) {
    return { name, suppressed: false };
  }
  return { name, target: truncateTargetToCodeUnits(target), suppressed: false };
}

/**
 * Truncate a `thinking` string to at most `THINKING_MAX_BYTES` UTF-8 bytes
 * without splitting a multi-byte sequence. Exported for tests. Callers get the
 * (possibly truncated) text plus the original char count so the UI can render
 * "+N more chars" without re-fetching.
 */
export function truncateThinking(
  text: string
): { text: string; truncated: boolean; chars: number } {
  // Count codepoints (user-facing characters), not UTF-16 code units — an
  // emoji-heavy string reports one "char" per emoji, matching the "Show N
  // more characters" affordance in the UI.
  const chars = [...text].length;
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= THINKING_MAX_BYTES) {
    return { text, truncated: false, chars };
  }
  // Walk back from the boundary to a safe UTF-8 char break. Continuation
  // bytes are `10xxxxxx` (0x80-0xBF); slice must land BEFORE one.
  let end = THINKING_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const truncatedText = buf.subarray(0, end).toString("utf8");
  return { text: truncatedText, truncated: true, chars };
}

export class AgentProcessManager {
  private state: ManagerState;
  private readonly sessions = new Map<string, ManagedSession>();
  /** agentId → server-pushed RuntimeConfig (from agent:wake). */
  private readonly runtimeConfigs = new Map<string, RuntimeConfig>();
  /** agentId → resume sessionId pushed by the server (from agent:wake). */
  private readonly resumeSessions = new Map<string, string>();
  /** agentId → launchId from the latest agent:wake (for session correlation). */
  private readonly launchIds = new Map<string, string>();
  /** agentId → live runtime sessionId (learned from session_init), for resync. */
  private readonly liveSessions = new Map<string, string>();
  /**
   * agentId → accumulated `thinking` text for the current reasoning block.
   * Several drivers (codex, pi, copilot) stream thinking token-by-token; we
   * buffer the deltas and flush ONE audit row at the next non-thinking event /
   * turn boundary / exit, instead of a D1 insert+prune per token. Block-based
   * drivers (claude, cursor) emit one full-text event → one row, unchanged.
   */
  private readonly thinkingBuffers = new Map<string, string>();
  /**
   * agentId → the current spawn's per-session end-tracking flags, shared
   * between `doSpawn`'s closure (turn_end / exit) and `applyEffect` (stop /
   * terminate_stalled) — see `logSessionEnded`'s `suppressExitLog` handling.
   */
  private readonly activeSpawnState = new Map<
    string,
    {
      hasEstablished: boolean;
      hasReportedSpawnFailure: boolean;
      suppressExitLog: boolean;
      /** Handshake watchdog timer; cleared on first `runtime_event` or on exit. */
      handshakeTimer: ReturnType<typeof setTimeout> | null;
      /**
       * Set once this spawn's teardown has run (delete from maps + dispatch
       * `exit`). Guards against a SECOND teardown: the handshake watchdog tears
       * down eagerly, then the killed process emits its own late `exit` — that
       * late event must be a no-op, not a duplicate FSM `exit` that could clobber
       * a session a fresh wake spawned in between.
       */
      torndown: boolean;
      /**
       * Set when this session has been SUPERSEDED by an intentional kill
       * (reset / nap / model_switch) — `markResetting` flips it before the
       * kill. The error-audit gate uses it to suppress this outgoing session's
       * interrupted-turn death rattle while still surfacing a reborn session's
       * genuine error (the reborn gets a fresh entry with `superseded=false`).
       * Per-session identity, not agent-level status. See batch C reader-C fix.
       */
      superseded: boolean;
    }
  >();
  private readonly opts: Required<
    Omit<
      ManagerRuntimeOpts,
      | "sessionFactory"
      | "now"
      | "credentialProxy"
      | "sdkDriverDepsFor"
      | "onAgentSession"
      | "onAgentActivity"
      | "onBotAuditEvent"
      | "onAgentLocallyStopped"
      | "onFsmTransition"
      | "timeline"
      | "wakePromptFooter"
      | "onRuntimeSpawnFailed"
      | "onRuntimeSessionEstablished"
      | "logger"
    >
  > &
    Pick<
      ManagerRuntimeOpts,
      | "sessionFactory"
      | "now"
      | "credentialProxy"
      | "sdkDriverDepsFor"
      | "onAgentSession"
      | "onAgentActivity"
      | "onBotAuditEvent"
      | "onAgentLocallyStopped"
      | "onFsmTransition"
      | "timeline"
      | "wakePromptFooter"
      | "onRuntimeSpawnFailed"
      | "onRuntimeSessionEstablished"
      | "logger"
    >;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(opts: ManagerRuntimeOpts) {
    this.opts = {
      tickIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      idleTimeoutMs: 300_000,
      resetStuckThresholdMs: 120_000,
      stoppingStuckThresholdMs: DEFAULT_STOPPING_STUCK_THRESHOLD_MS,
      handshakeTimeoutMs: 60_000,
      stampWakePromptTime: false,
      ...opts,
    };
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.logger ?? createLogger({ header: "@alook/daemon:manager" });
    this.state = createInitialManagerState(
      this.opts.staleThresholdMs,
      this.opts.idleTimeoutMs,
      this.opts.resetStuckThresholdMs,
      this.opts.stoppingStuckThresholdMs,
    );
  }

  /**
   * Register an agent (idempotent) so it can receive messages. `launch` carries
   * the server-pushed RuntimeConfig (and optional resume sessionId) from
   * `agent:wake`; it's remembered and merged into the LaunchContext at spawn.
   */
  register(agentId: string, launch?: { runtimeConfig?: RuntimeConfig; sessionId?: string; launchId?: string }): void {
    if (launch?.runtimeConfig) this.runtimeConfigs.set(agentId, launch.runtimeConfig);
    if (launch?.sessionId) this.resumeSessions.set(agentId, launch.sessionId);
    if (launch?.launchId) this.launchIds.set(agentId, launch.launchId);
    const driver = this.opts.driverFor(agentId, this.runtimeConfigs.get(agentId));
    const caps: AgentRuntimeCaps = {
      lifecycleKind: driver.lifecycle.kind,
      supportsStdinNotification: supportsStdinNotificationOf(driver.lifecycle),
      busyDeliveryMode: busyDeliveryModeOf(driver.lifecycle),
    };
    this.dispatch({ type: "register", agentId, caps });
  }

  /**
   * Inbound message for an agent → drives spawn/steer/queue per policy.
   * Returns whether the wake produced any executable effect (spawn/send/
   * gated_hold). `false` means the message was only coalesced into the inbox
   * with nothing dispatched toward a process — benign for the queue-and-drain
   * cases (starting/stopping/reset-window/per-turn), pathological for a
   * deaf-but-`running` agent that will never drain. The router uses this for a
   * daemon-local honest-ack diagnostic; it does NOT change the wire ack status.
   * See plans/daemon-fsm-desync.md batch B.
   */
  deliver(agentId: string, message: AgentMsg): boolean {
    const effects = this.dispatch({ type: "wake", agentId, message, nowMs: this.now() });
    return effects.length > 0;
  }

  /**
   * Clear every cached source that could seed the next spawn's
   * `resumeSessionId`, append the timeline barrier, and null the FSM
   * sessionId. Does NOT touch the running process (existing contract) and
   * does NOT block subsequent wakes — see `resetSession` for the full
   * orchestration. Caller: `resetSession` (below), after `register` and
   * before `markResetting`.
   */
  forgetSession(agentId: string, barrierType: "reset_session" | "nap" = "reset_session"): void {
    this.resumeSessions.delete(agentId);
    this.liveSessions.delete(agentId);
    this.dispatch({ type: "reset_session", agentId });
    this.opts.timeline?.forgetSession(agentId, barrierType);
  }

  /**
   * Append a synthetic rewake message to the agent's FSM inbox WITHOUT
   * emitting any effect. Called by `resetSession`'s live-branch: `stop()` is
   * about to kill the ManagedSession, so a `send` toward it (via `deliver`
   * → `onWake` → `send` effect on a persistent+direct agent) would be
   * silently dropped. The queued message rides the `onExit` drain-then-
   * spawn path instead.
   */
  enqueueRewake(agentId: string, message: AgentMsg): void {
    this.dispatch({ type: "rewake_after_reset", agentId, message });
  }

  /**
   * Mark the agent as being in a reset window (`resetting = true`). Every
   * subsequent non-idle wake queues to inbox instead of steering the dying
   * session or spawning a duplicate — see `onWake` in managerPolicy. The
   * flag clears automatically on `onExit` (kill-and-respawn path) and on
   * `onSpawned` (idle-branch spawn path); the runtime does not dispatch an
   * explicit "end reset" event.
   */
  markResetting(agentId: string): void {
    this.dispatch({ type: "begin_reset", agentId, nowMs: this.now() });
    // Mark the CURRENTLY-live session (if any) superseded, so its death rattle
    // — the interrupted-turn error the dying process emits before `exit` — is
    // suppressed by the error-audit gate, while the reborn session (a fresh
    // `activeSpawnState` entry with `superseded=false`) still surfaces its own
    // genuine errors. Per-session identity, set at kill-initiation. If there's
    // no live session yet (reset of an idle agent), there's nothing to rattle.
    const live = this.activeSpawnState.get(agentId);
    if (live) live.superseded = true;
  }

  /**
   * Owner-triggered synchronous reset. Orchestrates the "kill and rewake"
   * flow atomically:
   *   1. `register` — idempotent; ensures the FSM knows the agent and its
   *      runtime caps (fresh daemon after restart, bot never woken since).
   *   2. `forgetSession` — clears resume caches + writes the timeline
   *      barrier; nulls `AgentState.sessionId` via the reset_session event.
   *   3. `markResetting` — flips `agent.resetting = true` so any wake that
   *      lands between here and the reset spawn just enqueues to inbox
   *      (no steer against the dying session, no duplicate spawn).
   *   4. If idle: `deliver` — emits `spawn` for a fresh session with the
   *      rewake as the prompt. `resetting` is cleared by `onSpawned`.
   *   5. If live/starting/stopping: `enqueueRewake` (no effect) then
   *      `stop`. The `exit` event fires later; `onExit` drains the inbox
   *      (rewake + any queued unreads) into a single fresh spawn and clears
   *      `resetting`.
   *
   * Steps 1–3 (and 4/5's initial dispatch) are all synchronous reducer
   * dispatches inside a single Node tick — no incoming wake can interleave
   * before `resetting = true` is set. Only `await stop()` yields the event
   * loop; by then the gate is up.
   */
  async resetSession(
    agentId: string,
    opts: {
      runtimeConfig: RuntimeConfig;
      launchId: string;
      rewakePrompt: string;
      /** Timeline barrier kind — `reset_session` (owner) or `nap` (self). Default reset_session. */
      barrierType?: "reset_session" | "nap";
    },
  ): Promise<void> {
    // Reset = restart that FORGETS the session (writes the timeline barrier),
    // so the fresh spawn starts with no prior context. `agent:nap` reuses this
    // path with `barrierType: "nap"`.
    await this.restartAgent(agentId, {
      runtimeConfig: opts.runtimeConfig,
      launchId: opts.launchId,
      rewakePrompt: opts.rewakePrompt,
      forgetSession: true,
      barrierType: opts.barrierType ?? "reset_session",
      opName: "reset",
    });
  }

  /**
   * Shared "kill and rewake" orchestration behind `resetSession` (forget) and
   * `switchModel` (preserve). Atomic within one Node tick up to `stop()`:
   *   1. `register` — idempotent; ensures the FSM knows the agent + its runtime
   *      caps (fresh daemon after restart, bot never woken since).
   *   2. `forgetSession` (ONLY when `opts.forgetSession`) — clears resume caches
   *      + writes the timeline barrier + nulls `AgentState.sessionId`. Skipped
   *      by `switchModel` so the session + history SURVIVE across the relaunch.
   *   3. `markResetting` — flips `agent.resetting = true` (the SPAWN GATE, not a
   *      semantic "reset"): a wake landing between here and the respawn queues
   *      to inbox instead of steering the dying session / double-spawning.
   *   4. idle → `deliver` emits a fresh `spawn` with the rewake as prompt
   *      (`resetting` cleared by `onSpawned`). Non-idle → `enqueueRewake` then
   *      `stop`; `onExit` drains rewake + queued unreads into one fresh spawn
   *      and clears `resetting`.
   *
   * The idle branch's `doSpawn` can throw synchronously (missing
   * credentialProxy / sdkDriverDepsFor, driver constructor throwing). Without
   * recovery the FSM would wedge at `starting`+`resetting=true` forever; the
   * catch dispatches `exit` so `onExit` clears the gate back to `idle`, then
   * rethrows. This is the single unified failure path for both callers — the
   * observable failure landing (idle, gate cleared, throw propagated) is
   * identical to the pre-convergence per-method arms.
   */
  private async restartAgent(
    agentId: string,
    opts: {
      runtimeConfig: RuntimeConfig;
      launchId: string;
      rewakePrompt: string;
      forgetSession: boolean;
      barrierType?: "reset_session" | "nap";
      /** Human label for logs so a restart failure reads as reset vs model switch. */
      opName: string;
    },
  ): Promise<void> {
    this.register(agentId, { runtimeConfig: opts.runtimeConfig, launchId: opts.launchId });
    if (opts.forgetSession) this.forgetSession(agentId, opts.barrierType ?? "reset_session");
    this.markResetting(agentId);
    const status = this.state.agents[agentId]?.status;
    if (status === "idle") {
      try {
        this.deliver(agentId, { text: opts.rewakePrompt });
      } catch (err) {
        this.log.error(`agent ${opts.opName} idle-branch spawn threw synchronously`, {
          agentId,
          err: err instanceof Error ? err.message : String(err),
        });
        this.dispatch({ type: "exit", agentId });
        throw err;
      }
      return;
    }
    // Live / starting / stopping: enqueue the rewake so `onExit`'s drain picks
    // it up. `stop()` yields the event loop; any inbound wake in the interim
    // hits the gate and queues to inbox — landing in the SAME drain-and-spawn.
    this.enqueueRewake(agentId, { text: opts.rewakePrompt });
    await this.stop(agentId);
  }

  /**
   * Owner-triggered model switch — `resetSession` MINUS the `forgetSession`
   * call, so the session and conversation history SURVIVE while the process is
   * relaunched on the new model. `register` installs the new `runtimeConfig`
   * into `runtimeConfigs`, which `doSpawn` reads at launch, so the respawn
   * carries the new model.
   *
   * Session preservation comes from two verified places — NOT from
   * `resumeSessions` (that map is only populated when `register` receives a
   * `launch.sessionId`, and `buildUnreadWakeCommand` never sets one, so it is
   * empty for community bots):
   *   - Live path: skipping `forgetSession` means `reset_session` is never
   *     dispatched, so `agent.sessionId` is still set at exit time and `onExit`
   *     emits `{ type: "spawn", resumeSessionId: agent.sessionId }` — the
   *     respawn resumes the same session.
   *   - Durable path: no `reset_session` timeline barrier is written, so
   *     `findResumableSession` still walks back to the last real session id
   *     after a daemon restart.
   *
   * `markResetting`/`begin_reset` are reused as the SPAWN GATE, not as a
   * semantic "reset": they set `agent.resetting = true` so a wake landing
   * mid-switch queues to inbox instead of double-spawning. The field name reads
   * as reset-specific but the mechanism is identical; duplicating it would just
   * fork the same gate. `onExit` clears the flag unconditionally (including on
   * the spawn-failure path), so no new unlock path is needed.
   */
  async switchModel(
    agentId: string,
    opts: { runtimeConfig: RuntimeConfig; launchId: string; rewakePrompt: string },
  ): Promise<void> {
    // Model switch = restart that PRESERVES the session: skipping `forgetSession`
    // means no `reset_session` barrier is written and `agent.sessionId` is still
    // set at exit time, so `onExit` respawns with `resumeSessionId` (live path)
    // and `findResumableSession` still resolves the last session after a daemon
    // restart (durable path) — the agent picks up where it left off on the new
    // model.
    await this.restartAgent(agentId, {
      runtimeConfig: opts.runtimeConfig,
      launchId: opts.launchId,
      rewakePrompt: opts.rewakePrompt,
      forgetSession: false,
      opName: "model switch",
    });
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.dispatch({ type: "tick", nowMs: this.now() }), this.opts.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  /** Stop a single agent's session (if running). */
  async stop(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    await Promise.resolve(session.stop({ reason: "requested", forceAfterMs: SESSION_STOP_GRACE_MS }));
    this.sessions.delete(agentId);
  }

  async stopAll(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    await Promise.all(
      [...this.sessions.values()].map((s) =>
        Promise.resolve(s.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS })),
      ),
    );
    this.sessions.clear();
  }

  /** For inspection/testing. */
  snapshot(): ManagerState {
    return this.state;
  }

  /**
   * Live agent sessions (agentId + sessionId + launchId) for control-plane
   * resync after a reconnect. Only agents whose runtime has reported a session.
   */
  /**
   * Current (sessionId, launchId) for an agent, or nulls if not yet known.
   * Read by Producer B (credential-proxy sighting) so `cli_invocation` audit
   * events carry the same context Producer A's `tool_call` / `thinking`
   * events do — plan §Data model asks for launchId on every event where
   * known, and sessionId once the runtime handshake has landed.
   */
  auditContext(agentId: string): { sessionId: string | null; launchId: string | null } {
    return {
      sessionId: this.liveSessions.get(agentId) ?? null,
      launchId: this.launchIds.get(agentId) ?? null,
    };
  }

  liveSessionReports(): Array<{ agentId: string; sessionId: string; launchId: string }> {
    return [...this.liveSessions.entries()].map(([agentId, sessionId]) => ({
      agentId,
      sessionId,
      launchId: this.launchIds.get(agentId) ?? "",
    }));
  }

  /**
   * Current derived activity for every known agent, for control-plane resync
   * and heartbeat re-assert. Level-triggered snapshot of the same
   * `deriveActivity` the edge-triggered dispatch uses, so a dropped
   * `agent_activity` frame can be recovered from the daemon's own truth.
   */
  liveAgentActivities(): Array<{ agentId: string; state: AgentActivityState }> {
    return Object.entries(this.deriveActivitySnapshot(this.state)).map(([agentId, state]) => ({
      agentId,
      state,
    }));
  }

  /** Current derived activity for one agent, or null if it isn't known. */
  agentActivity(agentId: string): AgentActivityState | null {
    const agent = this.state.agents[agentId];
    return agent ? this.deriveActivity(agent) : null;
  }

  /* --------------------------------------------------------------- */
  /* Core dispatch: reduce → apply effects                            */
  /* --------------------------------------------------------------- */

  private dispatch(event: ManagerEvent): ManagerEffect[] {
    const before = this.deriveActivitySnapshot(this.state);
    const { state, effects } = reduceManager(this.state, event);
    this.state = state;
    // FSM transition trace (plans/daemon-fsm-desync.md): pure observability, no
    // behavior change. Emits one record per reduce so a wedge that leaves no
    // other log (the gated_hold/send branches are the only ones that log today,
    // and the wedge slips both) is reconstructable from the agent's FSM history
    // — the missing capability behind every "no log when it breaks" incident.
    // Guarded so it's a no-op unless a sink is wired (createDaemon opts).
    if (this.opts.onFsmTransition) {
      const nowMs = this.now();
      const emit = (agentId: string): void => {
        const a = this.state.agents[agentId];
        if (!a) return;
        // Effects this dispatch produced FOR THIS agent (effects carry agentId,
        // so a tick that terminates one wedged agent attributes correctly).
        const myEffects = effects.filter((e) => (e as { agentId?: string }).agentId === agentId).map((e) => e.type);
        this.opts.onFsmTransition!({
          agentId,
          event: event.type,
          status: a.status,
          turnActive: a.turnActive,
          inbox: a.inbox.length,
          lastDeliverAt: a.lastDeliverAt,
          lastProgressAt: a.lastProgressAt,
          idleSince: a.idleSince,
          resetting: a.resetting,
          resettingSince: a.resettingSince,
          apmPhase: a.apm.phase,
          effects: myEffects,
          nowMs,
          // Derived watchdog inputs — the ONLY way to judge, per wedge, WHY no
          // watchdog fired: `sinceProgressMs` is `stalled`/`suspectedDeaf`'s
          // "no progress for how long" (if it keeps getting reset small on a
          // wedged agent, lastProgressAt is being bumped by stray progress =
          // the anchor is unusable — the exit-1 decision). `sinceDeliverMs` is
          // suspectedDeaf's half (null when no deliver ever happened = its
          // blind spot). See plans/daemon-fsm-desync.md.
          sinceProgressMs: nowMs - a.lastProgressAt,
          sinceDeliverMs: a.lastDeliverAt === null ? null : nowMs - a.lastDeliverAt,
        });
      };
      const agentId = (event as { agentId?: string }).agentId;
      if (agentId) {
        // Agent-scoped event (wake / spawned / turn_end / …).
        emit(agentId);
      } else if (event.type === "tick") {
        // A tick carries no agentId but the reducer evaluates EVERY agent's
        // watchdogs — fan out so each agent's per-tick watchdog inputs + any
        // effect (or its ABSENCE) are on record. This is what makes "did the
        // tick run and why did stalled not fire" answerable (exit-3).
        for (const id of Object.keys(this.state.agents)) emit(id);
      }
    }
    for (const effect of effects) this.applyEffect(effect);
    if (this.opts.onAgentActivity) {
      const after = this.deriveActivitySnapshot(this.state);
      for (const [agentId, activity] of Object.entries(after)) {
        // Skip a brand-new agent appearing this dispatch (register) — only
        // report real transitions of an already-known agent.
        if (agentId in before && before[agentId] !== activity) {
          this.opts.onAgentActivity({ agentId, state: activity });
        }
      }
    }
    return effects;
  }

  private deriveActivitySnapshot(state: ManagerState): Record<string, AgentActivityState> {
    const snapshot: Record<string, AgentActivityState> = {};
    for (const [agentId, agent] of Object.entries(state.agents)) snapshot[agentId] = this.deriveActivity(agent);
    return snapshot;
  }

  /**
   * `AgentState.status` alone doesn't mean "actively working" — a persistent
   * agent stays `"running"` for up to `idleTimeoutMs` after a turn ends, before
   * the tick loop finally stops it. A `running` agent is "running" only while it
   * has work in hand (`isActivelyWorking`: turn in flight OR queued inbox);
   * otherwise it reads "idle" the moment the turn ends, without waiting for the
   * hibernation timeout. `starting`/`stopping` pass through unchanged.
   */
  private deriveActivity(agent: AgentState): AgentActivityState {
    if (agent.status === "running") return isActivelyWorking(agent) ? "running" : "idle";
    return agent.status;
  }

  private withFooter(text: string): string {
    return this.opts.wakePromptFooter ? `${text}\n\n${this.opts.wakePromptFooter}` : text;
  }

  /**
   * Prepend the local-tz wall-clock the moment BEFORE the text is handed to
   * the runtime driver. Called at the very last mile — inside `doSpawn` right
   * before `session.start(...)`, and inside `applyEffect`'s `send` branch
   * right before `session.send(...)` — so the timestamp reflects "when the
   * agent actually sees this text", not when the effect was scheduled. Gated
   * by an opt-in flag so tests that assert on exact prompt strings stay
   * stable; enabled in production via `createDaemon`.
   */
  private stampNow(text: string): string {
    return this.opts.stampWakePromptTime ? `[${nowLocalISO()}] ${text}` : text;
  }

  private applyEffect(effect: ManagerEffect): void {
    switch (effect.type) {
      case "spawn":
        // Timestamp is applied inside doSpawn just before session.start — the
        // spawn path adds workdir resolution + system-prompt assembly + child
        // wiring latency between here and there, which can be tens to hundreds
        // of ms on cold start. Stamping now would lock in a moment that lags
        // reality by the whole spawn setup window.
        this.doSpawn(effect.agentId, this.withFooter(effect.prompt), effect.resumeSessionId);
        break;
      case "send": {
        const session = this.sessions.get(effect.agentId);
        // Stamp at the moment the text hits `session.send`, not earlier —
        // between effect creation and this call the event loop can drain other
        // dispatches, and we want the timestamp to match the agent's arrival.
        session?.send({ text: this.stampNow(this.withFooter(effect.text)), mode: effect.mode });
        this.log.info("steering message sent to running agent", { agentId: effect.agentId, mode: effect.mode });
        break;
      }
      case "stop":
      case "terminate_stalled": {
        const session = this.sessions.get(effect.agentId);
        void Promise.resolve(session?.stop({ reason: effect.type, forceAfterMs: SESSION_STOP_GRACE_MS }));
        // The stop we just issued will make the underlying process emit its
        // own `exit` shortly after — suppress that follow-up log so a single
        // termination doesn't produce two contradictory "session ended" lines.
        const spawnState = this.activeSpawnState.get(effect.agentId);
        if (spawnState) spawnState.suppressExitLog = true;
        this.logSessionEnded(effect.agentId, effect.type === "stop" ? "stopped" : "terminate_stalled");
        this.opts.onAgentLocallyStopped?.({ agentId: effect.agentId, reason: effect.type });
        break;
      }
      case "force_exit": {
        // Stopping-stuck black-hole escape (plans/daemon-fsm-desync.md batch L3):
        // the agent sat in `stopping` past the threshold because the `exit` a
        // prior stop/terminate expected never came. Force the FSM out.
        //
        // (1) Best-effort kill any still-tracked process so we don't leak an
        //     orphan. The session handle is the ONLY process reference we have
        //     (activeSpawnState carries no pid), so if it's already gone — the
        //     very no-op case that caused this wedge (the handle was cleared
        //     before the original stop ran) — we genuinely CANNOT kill the
        //     process here; the synthetic exit below still frees the FSM, but
        //     the old process is orphaned. Warn so that orphan is VISIBLE
        //     (Claudette's gate requirement) rather than a silent leak — an
        //     orphan beats a permanent wedge. Actually reaping the orphan needs
        //     an independent pid record (activeSpawnState.pid); that's a
        //     followup, so this branch honestly only warns, it does not pretend
        //     to kill what it can't reach.
        const session = this.sessions.get(effect.agentId);
        const state = this.activeSpawnState.get(effect.agentId);
        if (session) {
          void Promise.resolve(session.stop({ reason: effect.reason, forceAfterMs: SESSION_STOP_GRACE_MS })).catch(() => {});
        } else {
          this.log.warn("force_exit: no session handle to kill before synthetic exit — possible orphan process (reap is a followup, needs an independent pid record)", {
            agentId: effect.agentId,
            reason: effect.reason,
          });
        }
        // (2) Tear down tracking + mark torndown so the killed process's eventual
        //     late `exit` (if the kill does land) is a no-op, not a second
        //     teardown that could clobber a session a fresh wake spawned in
        //     between — same guard the handshake-timeout path uses.
        if (state) state.torndown = true;
        this.logSessionEnded(effect.agentId, "terminate_stalled");
        if (this.sessions.get(effect.agentId) === session) this.sessions.delete(effect.agentId);
        this.liveSessions.delete(effect.agentId);
        if (this.activeSpawnState.get(effect.agentId) === state) this.activeSpawnState.delete(effect.agentId);
        this.opts.onAgentLocallyStopped?.({ agentId: effect.agentId, reason: "terminate_stalled" });
        // (3) Synthetic `exit` → the normal onExit recovery (drain-respawn or
        //     settle idle; enterStable clears stoppingSince). Universal backstop:
        //     works whether or not we could kill the process.
        this.dispatch({ type: "exit", agentId: effect.agentId });
        break;
      }
      case "gated_hold":
        // Pure observability — no behavioral effect. Emitted whenever a
        // gated agent has a non-empty inbox but nothing was actually sent.
        this.log.info("gated busy message held", {
          agentId: effect.agentId,
          reason: effect.reason,
          blockedReason: effect.blockedReason,
          recentEvents: effect.recentEvents,
        });
        break;
    }
  }

  private logSessionEnded(agentId: string, reason: "turn_end" | "stopped" | "terminate_stalled" | "exit"): void {
    this.log.info("agent session ended", { agentId, sessionId: this.liveSessions.get(agentId) ?? "", reason });
  }

  private doSpawn(agentId: string, prompt: string, resumeSessionId: string | null): void {
    const driver = this.opts.driverFor(agentId, this.runtimeConfigs.get(agentId));
    const base = this.opts.baseContextFor(agentId);
    // The server-pushed RuntimeConfig (from agent:wake) takes precedence over
    // any baseContextFor default; the resume sessionId likewise prefers the
    // manager's runtime-tracked id, then the server-pushed one, then the base.
    const runtimeConfig = this.runtimeConfigs.get(agentId) ?? base.config?.runtimeConfig;
    // Logged AFTER `runtimeConfig` is declared — reading it above would be a
    // `const` TDZ ReferenceError on every spawn. The resolved model is the QA
    // signal that a wake/reset/switch launched on the configured model.
    this.log.info("spawning agent", {
      agentId,
      runtime: driver.id,
      model: resolveLaunchFieldsOrDefault(runtimeConfig).model ?? "default",
    });
    const provider = runtimeConfig?.runtime ?? null;
    // Resume precedence: an explicit effect-supplied id → the manager's in-memory
    // tracked id → the server-pushed id → the durable timeline (latest finished
    // session for this agent, survives daemon restarts) → the base context.
    const sessionId =
      resumeSessionId ??
      this.resumeSessions.get(agentId) ??
      this.opts.timeline?.resumeSessionId(agentId, provider) ??
      base.config?.sessionId;
    const description = runtimeConfig?.instruction ?? base.config?.description ?? runtimeConfig?.agentName;
    const agentName = runtimeConfig?.agentName ?? base.config?.agentName;
    const agentHandle = runtimeConfig?.agentHandle ?? base.config?.agentHandle;
    const config: LaunchContext["config"] = { ...(base.config ?? {}), runtimeConfig, sessionId, description, agentName, agentHandle };
    // The driver owns system-prompt assembly — it knows its runtime's format,
    // notification style, and CLI contract. The daemon just calls it.
    const standingPrompt = base.standingPrompt || driver.buildSystemPrompt?.(config, agentId) || "";
    const ctx: LaunchContext = {
      ...base,
      prompt,
      standingPrompt,
      credentialProxy: base.credentialProxy ?? this.opts.credentialProxy,
      // The latest agent:wake's launchId (tracked in `this.launchIds`) — falls
      // back to whatever `baseContextFor` set, then undefined (cliTransport's
      // own "default" fallback). Without this, every real spawn left it
      // undefined, so every launch's voucher silently collided on the same
      // "default" voucher path (see plans/fix-credential-proxy-connection-leak.md).
      launchId: this.launchIds.get(agentId) ?? base.launchId,
      config,
    };

    if (!this.opts.sessionFactory && driver.createSession && !this.opts.sdkDriverDepsFor) {
      throw new Error(
        `AgentProcessManager: real spawn of "${agentId}" on in-process SDK runtime "${driver.id}" needs ` +
        "sdkDriverDepsFor — set ManagerRuntimeOpts.sdkDriverDepsFor, or pass a sessionFactory for tests.",
      );
    }
    if (!this.opts.sessionFactory && !driver.createSession && !ctx.credentialProxy) {
      throw new Error(
        `AgentProcessManager: real spawn of "${agentId}" needs a credentialProxy — ` +
        "set ManagerRuntimeOpts.credentialProxy (or baseContextFor's), or pass a sessionFactory for tests.",
      );
    }

    const session: ManagedSession = this.opts.sessionFactory
      ? this.opts.sessionFactory({ agentId, driver, ctx })
      : driver.createSession
        ? new SdkManagedSession(
          driver as Driver & { createSession: NonNullable<Driver["createSession"]> },
          ctx,
          this.opts.sdkDriverDepsFor!(ctx),
        )
        : (createChildProcessRuntimeSession(driver, ctx) as ChildProcessRuntimeSession);

    this.sessions.set(agentId, session);

    // Per-session flags.
    //   - hasEstablished: has this session ever emitted its handshake
    //     `runtime_event`? Once true, `error`/`exit` are session-level and
    //     don't invalidate the runtime.
    //   - hasReportedSpawnFailure: guards against multiple pre-establishment
    //     paths reporting the SAME failure (child_process emits both `error`
    //     and `exit` on ENOENT, plus `session.start().catch`). Only the FIRST
    //     path to see the failure gets to name the reason — subsequent paths
    //     no-op instead of clobbering a specific `ENOENT` with generic
    //     `pre_handshake_exit`.
    //   - suppressExitLog: set once this session's end has already been
    //     logged via a more specific reason (`turn_end` for a `per_turn`
    //     runtime that's about to exit on its own, or `stopped`/
    //     `terminate_stalled` from `applyEffect`) so the process's eventual
    //     `exit` event doesn't ALSO log a redundant/contradictory
    //     "session ended" line for the same termination.
    const state = { hasEstablished: false, hasReportedSpawnFailure: false, suppressExitLog: false, handshakeTimer: null as ReturnType<typeof setTimeout> | null, torndown: false, superseded: false };
    this.activeSpawnState.set(agentId, state);
    const clearHandshakeTimer = () => {
      if (state.handshakeTimer) {
        clearTimeout(state.handshakeTimer);
        state.handshakeTimer = null;
      }
    };
    const reportSpawnFailure = (
      reason: string,
      opts?: { message?: string; scope?: "spawn" | "handshake_timeout" },
    ) => {
      if (state.hasEstablished || state.hasReportedSpawnFailure) return;
      state.hasReportedSpawnFailure = true;
      this.log.warn("spawn failed", { agentId, runtime: driver.id, reason });
      this.opts.onRuntimeSpawnFailed?.(driver.id, reason);
      // Surface to the owner: a spawn that never handshakes is otherwise
      // web-silent (the runtime-health chip is per-runtime, not per-bot).
      this.emitErrorAudit(agentId, opts?.scope ?? "spawn", reason, opts?.message ?? `Launch failed (${reason})`);
    };

    // Timeline entries are opened on the DATA plane (the agent's inbox pull),
    // not here — the manager only annotates the agent's latest row.
    session.on("runtime_event", (e: unknown) => {
      if (!state.hasEstablished) {
        state.hasEstablished = true;
        // The handshake arrived — disarm the watchdog.
        clearHandshakeTimer();
      }
      // Fire on every runtime_event — the router's idempotence check on
      // `markRuntimeHealthy` (status already healthy + no lastError) collapses
      // this to nothing on the wire. Firing unconditionally avoids the trap
      // where session A established, session B failed and flipped the runtime
      // unhealthy, and A's ongoing runtime_events never heal it back.
      this.opts.onRuntimeSessionEstablished?.(driver.id);
      // A `per_turn` runtime handles exactly one turn per spawn and exits on
      // its own right after (see managerPolicy's onTurnEnd) — that upcoming
      // `exit` is expected, not a new termination, so don't double-log it.
      if ((e as { kind?: string })?.kind === "turn_end" && driver.lifecycle.kind === "per_turn") {
        state.suppressExitLog = true;
      }
      // Pass THIS session's own state so the error-audit gate can tell a
      // superseded (being-killed) session's death rattle from a live session's
      // genuine error — per-session identity, not agent-level status. A reborn
      // session gets a fresh `state` with `superseded=false`, so its startup
      // error surfaces even while the agent's reset window is still open.
      this.onRuntimeEvent(agentId, e, driver.id, state.superseded);
    });
    // Only ChildProcessRuntimeSession emits `stderr`; SdkManagedSession
    // doesn't, so this is harmless when the session is an SDK adapter.
    // Runtime CLIs (Claude Code, Codex, etc.) write auth prompts, rate-limit
    // errors, panics, and network hangs here — everything the daemon's
    // stream-json parser will NEVER see. Without this line, a gated agent
    // that goes silent is a black hole; with it, the underlying error lands
    // in the main daemon log next to the `gated busy message held` line and
    // the next incident is diagnosable.
    session.on("stderr", (...args: unknown[]) => {
      const raw = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
      const text = raw.length > STDERR_LOG_MAX_LEN ? raw.slice(0, STDERR_LOG_MAX_LEN) + "…" : raw;
      this.log.warn("runtime stderr", { agentId, runtime: driver.id, text });
    });
    // Child-process `error` (ENOENT etc.) — Node EE emits this before or in
    // parallel with `exit`. Without this subscriber the raw `error` would
    // become an unhandled EE emit.
    session.on("error", (...args: unknown[]) => {
      const err = args[0] as (NodeJS.ErrnoException & { code?: string }) | undefined;
      const code = err?.code ?? "spawn_error";
      reportSpawnFailure(String(code));
    });
    session.on("exit", (...args: unknown[]) => {
      clearHandshakeTimer();
      // Teardown-once guard: the handshake watchdog may have already torn this
      // spawn down (reported the failure, killed the process, dispatched
      // `exit`) and a fresh wake may have spawned a NEW session since. The
      // killed process's own late `exit` event must not run teardown again —
      // that would dispatch a spurious FSM `exit` that could clobber the new
      // session. NB: `stop()` (reset/model_switch/idle) deletes from
      // `this.sessions` BEFORE this exit fires, so a `this.sessions` identity
      // check would wrongly bail on that legitimate exit — guard on our own
      // per-spawn flag instead.
      if (state.torndown) return;
      state.torndown = true;
      const info = args[0] as { code?: number | null; signal?: string | null; reason?: string } | undefined;
      // A session that exits without ever emitting `runtime_event` is
      // treated as a pre-handshake failure too — covers runtimes whose
      // wrapper binary exits non-zero without a Node-level `error` event.
      // Guarded by `hasReportedSpawnFailure` so an ENOENT (already reported
      // via `error`) doesn't get overwritten with generic `pre_handshake_exit`.
      reportSpawnFailure("pre_handshake_exit");
      // Only an ESTABLISHED session "ended" — a pre-handshake exit is
      // already covered by the spawn-failed warning above. And only if this
      // termination wasn't already logged under a more specific reason (see
      // `suppressExitLog` above).
      if (state.hasEstablished && !state.suppressExitLog) {
        this.logSessionEnded(agentId, "exit");
        // An established session that dies with a non-zero code / on a signal
        // and WASN'T a deliberate stop (`reason !== "requested"`) is an
        // unexpected mid-run crash — surface it. A clean `code === 0` exit or
        // a requested stop is normal turn/lifecycle end, no error row.
        const abnormal =
          info?.reason !== "requested" &&
          ((typeof info?.code === "number" && info.code !== 0) || !!info?.signal);
        if (abnormal) {
          const detail = info?.signal ? `signal ${info.signal}` : `code ${info?.code}`;
          this.emitErrorAudit(agentId, "exit", "abnormal_exit", `Session ended unexpectedly (${detail})`);
        }
      }
      // Flush any reasoning block that never saw a following event before exit.
      this.flushThinkingAudit(agentId);
      this.sessions.delete(agentId);
      this.liveSessions.delete(agentId);
      if (this.activeSpawnState.get(agentId) === state) this.activeSpawnState.delete(agentId);
      this.dispatch({ type: "exit", agentId });
    });

    // Stamp the wake-prompt timestamp AT the last mile — right before the
    // driver's session sees the text — so the local-tz wall-clock the agent
    // reads reflects the moment its process is being handed the prompt, not
    // the moment the spawn effect was scheduled by the policy reducer. The
    // difference matters on cold starts where system-prompt assembly + child
    // wiring above adds tens/hundreds of ms.
    const stampedPrompt = this.stampNow(prompt);
    void Promise.resolve(session.start({ text: stampedPrompt, sessionId: ctx.config.sessionId }))
      .then(() => {
        // A concurrent stop()/terminate_stalled can race this in-flight
        // start() and finish first — its `exit` handler above already
        // deleted this session from `this.sessions` and dispatched
        // `{type: "exit"}`. If that happened, don't ALSO dispatch `spawned`:
        // that would revive the FSM into "running" for a session nobody
        // tracks anymore, wedging the agent (its inbox already drained into
        // this now-dead spawn) until the daemon restarts.
        if (this.sessions.get(agentId) !== session) return;
        this.dispatch({ type: "spawned", agentId, nowMs: this.now() });
        // Arm the handshake watchdog. The FSM just went `running`+`turnActive`
        // optimistically (managerPolicy's `spawned`), but the process hasn't
        // proven itself — a bad model can make the CLI HANG with no exit, no
        // stderr, no stdout, so none of the subscribers above ever fire and
        // the `onTick` stall watchdog excludes an empty-inbox gated agent. If
        // no `runtime_event` arrives within the deadline, treat it as a
        // pre-handshake failure: stop the process and return the FSM to idle.
        if (state.hasEstablished || state.hasReportedSpawnFailure) return;
        state.handshakeTimer = setTimeout(() => {
          state.handshakeTimer = null;
          if (state.hasEstablished || state.hasReportedSpawnFailure) return;
          if (this.sessions.get(agentId) !== session) return;
          reportSpawnFailure("handshake_timeout", {
            scope: "handshake_timeout",
            message: `No response ${Math.round(this.opts.handshakeTimeoutMs / 1000)}s after launch — the runtime may be misconfigured (e.g. an invalid model).`,
          });
          void Promise.resolve(session.stop({ reason: "handshake_timeout", forceAfterMs: SESSION_STOP_GRACE_MS })).catch(() => {});
          // Drop tracking + return the FSM to idle so the next wake can retry;
          // don't wait on the `exit` event, which a wedged process may never
          // emit. Mark `torndown` so the killed process's eventual late `exit`
          // is a no-op instead of a second, session-clobbering teardown.
          state.torndown = true;
          if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
          this.liveSessions.delete(agentId);
          if (this.activeSpawnState.get(agentId) === state) this.activeSpawnState.delete(agentId);
          this.dispatch({ type: "exit", agentId });
        }, this.opts.handshakeTimeoutMs);
      })
      .catch((err: unknown) => {
        // Synchronous throws inside driver.spawn() (e.g. child_process.spawn
        // throwing ENOENT before returning a subprocess) reach us here.
        // Same guard: whichever path saw the failure first names the reason.
        const code =
          (err as { code?: string } | undefined)?.code ??
          "spawn_threw";
        reportSpawnFailure(String(code));
        if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
        this.dispatch({ type: "exit", agentId });
      });
  }

  /**
   * The model in effect for an agent's current launch (`null` = runtime
   * default), for the `model` field of an `error` audit row — so the common
   * "switched to a bad model" failure names the culprit inline. Reads the same
   * resolved launch fields `doSpawn` logs, so it reflects what was actually
   * handed to the driver.
   */
  private currentModelFor(agentId: string): string | null {
    return resolveLaunchFieldsOrDefault(this.runtimeConfigs.get(agentId)).model ?? null;
  }

  /**
   * Emit an `error` audit row (launch/runtime failure the owner should see).
   * Reuses `errorDiagnostics` to classify + scrub the message. Best-effort and
   * never throws — an audit-emit failure must not cascade into the spawn/exit
   * path that called it. No-op when no audit sink is wired.
   */
  private emitErrorAudit(
    agentId: string,
    scope: "spawn" | "runtime" | "exit" | "handshake_timeout" | "model_switch" | "reset",
    code: string,
    rawMessage: string,
  ): void {
    if (!this.opts.onBotAuditEvent) return;
    const message = scrubRuntimeErrorDiagnosticText(rawMessage).slice(0, AUDIT_ERROR_MESSAGE_MAX_LEN);
    try {
      this.opts.onBotAuditEvent(agentId, {
        kind: "error",
        payload: { scope, code, message, model: this.currentModelFor(agentId) },
      }, {
        sessionId: this.liveSessions.get(agentId) ?? null,
        launchId: this.launchIds.get(agentId) ?? null,
      });
    } catch (err) {
      this.log.debug("audit emit failed (error)", { agentId, err: String(err) });
    }
  }

  /**
   * Emit the buffered reasoning block as a single `thinking` audit row, then
   * clear the buffer. No-op when nothing accumulated (empty deltas were never
   * buffered). Called before any non-thinking event and on session exit so a
   * block always flushes even if the turn ends without a following tool call.
   */
  private flushThinkingAudit(agentId: string): void {
    const buffered = this.thinkingBuffers.get(agentId);
    if (!buffered) return;
    this.thinkingBuffers.delete(agentId);
    if (!this.opts.onBotAuditEvent) return;
    const { text, truncated, chars } = truncateThinking(buffered);
    try {
      this.opts.onBotAuditEvent(agentId, {
        kind: "thinking",
        payload: { text, truncated, chars },
      }, {
        sessionId: this.liveSessions.get(agentId) ?? null,
        launchId: this.launchIds.get(agentId) ?? null,
      });
    } catch (err) {
      // Observational path (audit emit) — never re-throw, but leave a trail so
      // a silent failure isn't invisible if the emitter starts throwing.
      this.log.debug("audit emit failed (thinking)", { agentId, err: String(err) });
    }
  }

  private onRuntimeEvent(agentId: string, e: unknown, runtimeId: string, sessionSuperseded: boolean): void {
    const ev = e as { kind?: string; sessionId?: string; text?: string; name?: string; input?: unknown; message?: string };
    if (!ev?.kind) return;
    // A runtime-parsed `error` event (rate limit, auth failure, bad-model API
    // error, provider outage) is otherwise web-silent — the parser sees it,
    // the FSM shrugs, and the owner learns nothing. Emit an `error` audit row
    // so it lands in the bot's activity log. `hasEstablished` is already true
    // here (this fires from the `runtime_event` subscriber), so the scope is
    // `runtime`, not `spawn`.
    //
    // EXCEPT for the death rattle of a SUPERSEDED session: an intentional kill
    // (reset / nap / model_switch) interrupts the dying process mid-turn and it
    // emits a final error `result` that is teardown noise, not a fault.
    //
    // This gates on PER-SESSION identity (`sessionSuperseded`), not the
    // agent-level `resetting` flag. Batch C keeps `resetting` true across the
    // respawn until the reborn process reaches `running`, so the reborn session
    // is LIVE while `resetting` is still set — gating the audit on `resetting`
    // would swallow the reborn session's own genuine startup error (the exact
    // "healthy signal silenced" bug this plan attacks). And status can't
    // separate them either: an old process killed while still `starting` and a
    // reborn erroring while `starting` share the same status. Only session
    // IDENTITY distinguishes them: `restartAgent` marks the OUTGOING session's
    // state `superseded` before killing it, so its rattle is suppressed; the
    // reborn session has a fresh state (`superseded=false`), so its real error
    // surfaces. See plans/daemon-fsm-desync.md batch C (reader-C fix).
    if (ev.kind === "error" && !sessionSuperseded) {
      this.emitErrorAudit(agentId, "runtime", "runtime_error", ev.message ?? "Runtime error");
      // Stuck-reset correlation trace (plans/daemon-fsm-desync.md batch D):
      // PURELY ADDITIVE — this runs AFTER the error has already been decided to
      // surface (gate above unchanged), and only annotates. If this error fired
      // while the agent's reset window is wedged (`resetting` still true past
      // the reconcile threshold), leave a diagnostic line correlating the two:
      // an error emerging from a bot whose restart never converged is a
      // higher-signal event than a lone error, and the reconcile watchdog is
      // about to (or already did) escalate it. Never suppresses — a reborn's
      // genuine error keeps surfacing exactly as batch C made it.
      const agent = this.state.agents[agentId];
      if (
        agent?.resetting &&
        agent.resettingSince !== null &&
        this.now() - agent.resettingSince >= this.state.resetStuckThresholdMs
      ) {
        this.log.warn("runtime error during a stuck reset window", {
          agentId,
          resettingForMs: this.now() - agent.resettingSince,
          message: ev.message ?? "Runtime error",
        });
      }
    }
    // Bot audit hook — thinking + non-Bash tool_call, no correlation.
    // Context carries the sessionId/launchId learned so far this launch so
    // ws-do can persist them alongside each row (the plan's Data model calls
    // for both). `liveSessions` is populated on `session_init`; if this
    // event fires BEFORE the runtime has emitted its handshake, sessionId is
    // null and the row records the launch without a session id.
    if (this.opts.onBotAuditEvent) {
      if (ev.kind === "thinking" && typeof ev.text === "string") {
        // Accumulate; a delta-streaming driver emits many of these per block.
        // The flush happens at the next non-thinking event / turn / exit so one
        // reasoning block becomes one audit row, not one row per token.
        if (ev.text.length > 0) {
          this.thinkingBuffers.set(agentId, (this.thinkingBuffers.get(agentId) ?? "") + ev.text);
        }
      } else {
        // Any non-thinking event ends the current reasoning block — flush it
        // first so the audit log preserves thinking→action ordering.
        this.flushThinkingAudit(agentId);
        if (ev.kind === "tool_call" && typeof ev.name === "string") {
          const audit = extractToolAudit(ev.name, ev.input);
          if (!audit.suppressed) {
            const payload = audit.target !== undefined
              ? { name: audit.name, target: audit.target }
              : { name: audit.name };
            try {
              this.opts.onBotAuditEvent(agentId, {
                kind: "tool_call",
                payload,
              }, {
                sessionId: this.liveSessions.get(agentId) ?? null,
                launchId: this.launchIds.get(agentId) ?? null,
              });
            } catch (err) {
              this.log.debug("audit emit failed (tool_call)", { agentId, err: String(err) });
            }
          }
        }
      }
    }
    if (ev.kind === "session_init" && ev.sessionId) {
      this.dispatch({ type: "session", agentId, sessionId: ev.sessionId });
      this.liveSessions.set(agentId, ev.sessionId);
      this.opts.timeline?.setSession(agentId, ev.sessionId);
      this.opts.onAgentSession?.({
        agentId,
        sessionId: ev.sessionId,
        launchId: this.launchIds.get(agentId) ?? "",
      });
      this.log.info("agent session established", { agentId, sessionId: ev.sessionId, runtime: runtimeId });
    }
    // Accumulate the agent's text output onto its latest timeline entry, so the
    // log records "what the agent said" — the basis for using it as memory.
    if (ev.kind === "text" && typeof ev.text === "string" && ev.text.length > 0) {
      this.opts.timeline?.appendResponseToLatest(agentId, ev.text);
    }
    // Progress for stall detection — but content-free heartbeats
    // (Claude `stream_event` / `status`, Codex raw response items) don't
    // count. They keep firing during a wedged compaction and would mask
    // a real stall from `onTick`'s watchdog. An `error` event likewise isn't
    // progress: a runtime that errors then goes quiet must still trip the
    // stall watchdog rather than reset its progress clock on the way down.
    if (ev.kind !== "internal_progress" && ev.kind !== "error") {
      this.dispatch({ type: "progress", agentId, nowMs: this.now() });
    }
    // Forward every parsed event's kind for gated-steering phase tracking
    // (tool/compaction/review boundaries). No-ops in the reducer for kinds
    // it doesn't care about, aside from the diagnostics ring buffer.
    this.dispatch({ type: "runtime_signal", agentId, kind: ev.kind, nowMs: this.now() });
    if (ev.kind === "turn_end") {
      this.logSessionEnded(agentId, "turn_end");
      this.dispatch({ type: "turn_end", agentId, nowMs: this.now() });
    }
  }
}

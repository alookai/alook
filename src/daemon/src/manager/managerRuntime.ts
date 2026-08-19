/** Side-effect executor for the pure manager policy. */
import {
  reduceManager,
  createInitialManagerState,
  DEFAULT_STOPPING_STUCK_THRESHOLD_MS,
  type ManagerState,
  type ManagerEvent,
  type ManagerEffect,
  type AgentMsg,
  type AgentState,
  type AgentStatus,
  isActivelyWorking,
} from "./managerPolicy.js";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  DeliveryReceipt,
} from "@alook/agent-driver";
import type { HostLaunchContext } from "./hostContext.js";
import { runtimeModelName, type RuntimeConfig } from "../runtimeConfig.js";
import { scrubRuntimeErrorDiagnosticText } from "../runtime/errorDiagnostics.js";
import { buildCliSystemPrompt } from "../drivers/systemPrompt.js";
import { createLogger, type Logger } from "../logger.js";
import { nowLocalISO } from "../util/localTime.js";
import { randomUUID } from "node:crypto";

const SESSION_STOP_GRACE_MS = 2_000;

export type AgentActivityState = "idle" | "starting" | "running" | "stopping";

export type DaemonAgentSession = AgentSession<BuiltinBackendSpecs, BuiltinBackendId>;
type ManagedEvent = AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>;

type TraceTerminationCause = "runtime_error" | "killed_stalled" | "other";
type TraceSpawnFailureReason = "ENOENT" | "handshake_timeout" | "pre_handshake_exit" | "spawn_threw" | "other";
type TraceTerminationSemantics = "killed_stalled" | "idle_stop" | "force_exit" | "other";
type TraceAbortCause =
  | "start_threw"
  | "start_rejected"
  | "send_threw"
  | "spawn_failure"
  | "handshake_timeout"
  | "reset"
  | "nap"
  | "model_switch"
  | "requested_stop"
  | "shutdown"
  | "physical_exit"
  | "terminate_stalled"
  | "force_exit"
  | "other";

interface ActiveTurnSpan {
  traceTurnId: string;
  daemonTurnOrdinal: number;
  spawnOrdinal: number;
  turnOrdinal: number;
  launchIdSnapshot: string | null;
}

interface ActiveSpawnState {
  agentId: string;
  session: DaemonAgentSession | null;
  hasEstablished: boolean;
  hasReportedSpawnFailure: boolean;
  suppressExitLog: boolean;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  torndown: boolean;
  superseded: boolean;
  spawnFailureReason: string | null;
  terminationSemantics: string | null;
  spawnOrdinal: number;
  launchIdSnapshot: string | null;
  nextTurnOrdinal: number;
  activeSpan: ActiveTurnSpan | null;
}

interface TraceRecordBase {
  agentId: string;
  effects: string[];
  nowMs: number;
  timeIso: string;
}

interface TraceSpanMetadata {
  traceTurnId: string;
  daemonTurnOrdinal: number;
  spawnOrdinal: number;
  turnOrdinal: number;
  launchIdSnapshot: string | null;
}

interface FsmTraceRecord extends TraceRecordBase, Partial<TraceSpanMetadata> {
  recordKind: "fsm";
  event: ManagerEvent["type"];
  status: AgentStatus;
  turnActive: boolean;
  inbox: number;
  lastDeliverAt: number | null;
  lastProgressAt: number;
  idleSince: number | null;
  resetting: boolean;
  resettingSince: number | null;
  stoppingSince: number | null;
  apmPhase: "idle";
  sinceProgressMs: number;
  sinceDeliverMs: number | null;
  sinceStoppingMs: number | null;
  endReason?: "errored";
  terminationCause?: TraceTerminationCause;
  exitCode?: number | null;
  exitSignal?: string | null;
  abnormal?: boolean;
  spawnFailureReason?: TraceSpawnFailureReason;
  terminationSemantics?: TraceTerminationSemantics;
}

type TurnSpanTraceRecord = TraceRecordBase &
  TraceSpanMetadata &
  (
    | { recordKind: "turn_span"; event: "turn_begin" }
    | {
        recordKind: "turn_span";
        event: "turn_end";
        outcome: "clean" | "errored";
        terminationCause?: TraceTerminationCause;
      }
    | { recordKind: "turn_span"; event: "turn_abort"; abortCause: TraceAbortCause }
  );

export type ManagerTraceRecord = FsmTraceRecord | TurnSpanTraceRecord;

function normalizeTerminationCause(value: unknown): TraceTerminationCause {
  return value === "runtime_error" || value === "killed_stalled" ? value : "other";
}

function normalizeAbortCause(value: unknown): TraceAbortCause {
  switch (value) {
    case "start_threw":
    case "start_rejected":
    case "send_threw":
    case "spawn_failure":
    case "handshake_timeout":
    case "reset":
    case "nap":
    case "model_switch":
    case "requested_stop":
    case "shutdown":
    case "physical_exit":
    case "terminate_stalled":
    case "force_exit":
      return value;
    default:
      return "other";
  }
}

function normalizeSpawnFailureReason(value: unknown): TraceSpawnFailureReason {
  switch (value) {
    case "ENOENT":
    case "handshake_timeout":
    case "pre_handshake_exit":
    case "spawn_threw":
      return value;
    default:
      return "other";
  }
}

function normalizeTerminationSemantics(value: unknown): TraceTerminationSemantics {
  switch (value) {
    case "killed_stalled":
    case "idle_stop":
    case "force_exit":
      return value;
    default:
      return "other";
  }
}

export type SessionFactory = (args: {
  agentId: string;
  ctx: HostLaunchContext;
  runtimeConfig: RuntimeConfig;
}) => DaemonAgentSession | Promise<DaemonAgentSession>;

export interface ManagerRuntimeOpts {
  driverFor: (agentId: string, runtimeConfig?: RuntimeConfig) => { readonly id: BuiltinBackendId };
  baseContextFor: (agentId: string) => Omit<HostLaunchContext, "prompt" | "config" | "standingPrompt"> & {
    standingPrompt?: string;
    config?: HostLaunchContext["config"];
  };
  sessionFactory?: SessionFactory;
  credentialProxy?: HostLaunchContext["credentialProxy"];
  staleThresholdMs?: number;
  idleTimeoutMs?: number;
  resetStuckThresholdMs?: number;
  stoppingStuckThresholdMs?: number;
  handshakeTimeoutMs?: number;
  tickIntervalMs?: number;
  now?: () => number;
  onAgentSession?: (info: { agentId: string; sessionId: string; launchId: string }) => void;
  onAgentActivity?: (info: { agentId: string; state: AgentActivityState }) => void;
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
  onAgentLocallyStopped?: (info: { agentId: string; reason: "stop" | "terminate_stalled" }) => void;
  onRuntimeRawLine?: (agentId: string, line: string) => void;
  onFsmTransition?: (rec: ManagerTraceRecord) => void;
  timeline?: TimelineRecorder;
  wakePromptFooter?: string;
  stampWakePromptTime?: boolean;
  onRuntimeSpawnFailed?: (runtimeId: string, reason: string) => void;
  onRuntimeSessionEstablished?: (runtimeId: string) => void;
  logger?: Logger;
}

export interface TimelineRecorder {
  setSession(agentId: string, sessionId: string): void;
  appendResponseToLatest(agentId: string, text: string): void;
  resumeSessionId(agentId: string, provider: string | null): string | null;
  forgetSession(agentId: string, barrierType?: "reset_session" | "nap"): void;
}

const THINKING_MAX_BYTES = 4096;
const AUDIT_ERROR_MESSAGE_MAX_LEN = 2000;

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
 * attempt because OpenAI-style tool-call `arguments` can reach this layer as
 * a stringified JSON blob when a normalizer passes the raw value through. If the parse
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
 * (Anthropic, cursor, opencode, pi, and codex — the
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
// The agent invokes the CLI two ways, both authoritative-`cli_invocation`
// sources the tool_call must suppress:
//   - the injected env var: `$ALOOK_CLI …` / `${ALOOK_CLI} …` (the form the
//     system prompt now teaches — an absolute path that dodges PATH; see
//     spawnEnv `<PREFIX>_CLI` / systemPrompt), and
//   - the bare name `alook …` (legacy / any agent that still types it).
// `<PREFIX>_CLI` is `${DEFAULT_CLI_CONFIG.envPrefix}_CLI` = `ALOOK_CLI`.
const ALOOK_CLI_ENV_VAR = "ALOOK_CLI";
const ALOOK_SHELL_INVOCATION_RE = new RegExp(
  `^(?:alook|\\$\\{?${ALOOK_CLI_ENV_VAR}\\}?)(\\s|$)`,
);

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
 * backend-agnostic tool_call extractor. Given a runtime-raw `(name, input)`
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
  private readonly sessions = new Map<string, DaemonAgentSession>();
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
   * Several drivers (codex and pi) stream thinking token-by-token; we
   * buffer the deltas and flush ONE audit row at the next non-thinking event /
   * turn boundary / exit, instead of a D1 insert+prune per token. Block-based
   * drivers (claude, cursor) emit one full-text event → one row, unchanged.
   */
  private readonly thinkingBuffers = new Map<string, string>();
  /**
   * agentId → the current spawn's per-session end-tracking and trace ownership,
   * shared
   * between `doSpawn`'s closure (turn_end / exit) and `applyEffect` (stop /
   * terminate_stalled) — see `logSessionEnded`'s `suppressExitLog` handling.
   */
  private readonly activeSpawnState = new Map<string, ActiveSpawnState>();
  private readonly traceProcessNonce = randomUUID();
  private nextSpawnOrdinal = 1;
  private nextDaemonTurnOrdinal = 1;
  private nextDeliveryOrdinal = 1;
  /**
   * agentId → why the current turn ended NON-cleanly, buffered until the
   * trailing `turn_end` reads+clears it. Two symmetric marker points feed it
   * (Cecilia 架构#352 / Claudette #353 — key on CAUSE, never on bare `status`,
   * so a voluntary idle-timeout `stop` that also flips `stopping` is never
   * misread as a crash):
   *   - `runtime_error`: a runtime `error` event mid-turn, set ONLY in the
   *     `!sessionSuperseded` branch (an intentional reset/nap death-rattle never
   *     marks). Free-text `detail` stays on the existing policy/audit path and
   *     is never serialized to the local trace.
   *   - `killed_stalled`: the `terminate_stalled` effect (the stall watchdog
   *     SIGKILLing a wedged turn — Blair's actual case). By construction, no
   *     dependence on whether the runtime emits a trailing error rattle.
   * At the trailing `turn_end` this becomes `endReason:"errored"` (the binary
   * can-rewake judgement) + `terminationCause` (the cause, for B2 policy
   * branching). A kill's marker is authoritative: if a `killed_stalled` marker
   * is present, a following `runtime_error` rattle must NOT downgrade it (the
   * kill is the real cause; the rattle is its side effect). Cleared on the
   * `exit` teardown too, so a hard exit with no trailing turn_end can't leak a
   * stale marker onto the next turn (B1 3a). See
   * plans/daemon-runtime-error-rewake.md.
   */
  private readonly nonCleanEndMarker = new Map<
    string,
    { cause: "runtime_error" | "killed_stalled"; detail?: string }
  >();
  private readonly opts: Required<
    Omit<
      ManagerRuntimeOpts,
      | "sessionFactory"
      | "now"
      | "credentialProxy"
      | "onAgentSession"
      | "onAgentActivity"
      | "onBotAuditEvent"
      | "onAgentLocallyStopped"
      | "onRuntimeRawLine"
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
      | "onAgentSession"
      | "onAgentActivity"
      | "onBotAuditEvent"
      | "onAgentLocallyStopped"
      | "onRuntimeRawLine"
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
    this.dispatch({ type: "register", agentId });
  }

  /**
   * Inbound message for an agent → drives spawn/steer/queue per policy.
   * Returns whether the wake produced any executable effect (spawn/send).
   * `false` means the message was only coalesced into the inbox
   * with nothing dispatched toward a process — benign for the queue-and-drain
   * cases (starting/stopping/reset-window/per-turn), pathological for a
   * deaf-but-`running` agent that will never drain. The router uses this for a
   * daemon-local honest-ack diagnostic; it does NOT change the wire ack status.
   * See plans/daemon-fsm-desync.md batch B.
   */
  deliver(agentId: string, message: AgentMsg): boolean {
    const normalized = message.id
      ? message
      : {
          ...message,
          id: message.seq !== undefined
            ? `${agentId}:source:${message.seq}`
            : `${agentId}:synthetic:${this.nextDeliveryOrdinal++}`,
        };
    const effects = this.dispatch({ type: "wake", agentId, message: normalized, nowMs: this.now() });
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
   * about to kill the logical session, so a `send` toward it (via `deliver`
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
      abortCause: opts.barrierType === "nap" ? "nap" : "reset",
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
      abortCause: "reset" | "nap" | "model_switch";
      /** Human label for logs so a restart failure reads as reset vs model switch. */
      opName: string;
    },
  ): Promise<void> {
    this.register(agentId, { runtimeConfig: opts.runtimeConfig, launchId: opts.launchId });
    if (opts.forgetSession) this.forgetSession(agentId, opts.barrierType ?? "reset_session");
    this.abortCurrentTurn(agentId, opts.abortCause);
    this.markResetting(agentId);
    const status = this.state.agents[agentId]?.status;
    if (status === "idle") {
      try {
        this.deliver(agentId, {
          id: `${opts.launchId}:${opts.abortCause}:rewake`,
          text: opts.rewakePrompt,
        });
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
    this.enqueueRewake(agentId, {
      id: `${opts.launchId}:${opts.abortCause}:rewake`,
      text: opts.rewakePrompt,
    });
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
      abortCause: "model_switch",
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
    this.abortCurrentTurn(agentId, "requested_stop");
    await session.stop({ reason: "owner_request", forceAfterMs: SESSION_STOP_GRACE_MS });
    this.sessions.delete(agentId);
  }

  async stopAll(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const entries = [...this.sessions.entries()];
    for (const [agentId] of entries) this.abortCurrentTurn(agentId, "shutdown");
    await Promise.all(entries.map(([, session]) =>
      Promise.resolve(session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS })),
    ));
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

  /**
   * Slim per-agent FSM projection for the `daemon status` snapshot file (batch
   * E2). Metadata only — NO message content, NO PII. Exposes BOTH the raw FSM
   * `status` AND the `derivedActivity` (the running/idle display) so a reader
   * can tell apart the three idle-looking states the frontend's coarse marker
   * conflates: between-turns idle (running + !turnActive), a real turn in
   * flight, and a wedge (climbing `sinceProgressMs` / non-null `stoppingSince`).
   * `nowMs` is passed in so the caller stamps a single consistent `writtenAt`.
   * See plans/daemon-fsm-desync.md batch E2.
   */
  statusProjection(nowMs: number): Array<{
    agentId: string;
    status: AgentStatus;
    derivedActivity: AgentActivityState;
    turnActive: boolean;
    inbox: number;
    sinceProgressMs: number;
    stoppingSince: number | null;
  }> {
    return Object.values(this.state.agents).map((a) => ({
      agentId: a.agentId,
      status: a.status,
      derivedActivity: this.deriveActivity(a),
      turnActive: a.turnActive,
      inbox: a.inbox.length,
      sinceProgressMs: nowMs - a.lastProgressAt,
      stoppingSince: a.stoppingSince,
    }));
  }

  /* --------------------------------------------------------------- */
  /* Core dispatch: reduce → apply effects                            */
  /* --------------------------------------------------------------- */

  private emitTrace(rec: ManagerTraceRecord): void {
    if (!this.opts.onFsmTransition) return;
    try {
      this.opts.onFsmTransition(rec);
    } catch {
      // Trace is strictly read-only. A broken sink cannot change reducer or
      // runtime-call behavior, nor can it leave a lifecycle span half-closed.
    }
  }

  private traceOwnerFor(agentId: string, captured?: ActiveSpawnState): ActiveSpawnState | undefined {
    if (captured) return captured.agentId === agentId ? captured : undefined;
    const owner = this.activeSpawnState.get(agentId);
    return owner && this.sessions.get(agentId) === owner.session ? owner : undefined;
  }

  private openTurn(owner: ActiveSpawnState): ActiveTurnSpan {
    if (owner.activeSpan) return owner.activeSpan;
    const daemonTurnOrdinal = this.nextDaemonTurnOrdinal++;
    const span: ActiveTurnSpan = {
      traceTurnId: `${owner.launchIdSnapshot ?? this.traceProcessNonce}:${daemonTurnOrdinal}`,
      daemonTurnOrdinal,
      spawnOrdinal: owner.spawnOrdinal,
      turnOrdinal: owner.nextTurnOrdinal++,
      launchIdSnapshot: owner.launchIdSnapshot,
    };
    owner.activeSpan = span;
    const nowMs = this.now();
    this.emitTrace({
      recordKind: "turn_span",
      agentId: owner.agentId,
      event: "turn_begin",
      ...span,
      effects: [],
      nowMs,
      timeIso: new Date(nowMs).toISOString(),
    });
    return span;
  }

  private closeTurn(
    owner: ActiveSpawnState,
    expectedSpan: ActiveTurnSpan | null,
    close:
      | { event: "turn_end"; outcome: "clean" | "errored"; terminationCause?: TraceTerminationCause }
      | { event: "turn_abort"; abortCause: TraceAbortCause },
  ): boolean {
    if (!expectedSpan || owner.activeSpan !== expectedSpan) return false;
    // Clear before invoking the sink: throw/re-entry can never close twice.
    owner.activeSpan = null;
    const nowMs = this.now();
    const base = {
      recordKind: "turn_span" as const,
      agentId: owner.agentId,
      ...expectedSpan,
      effects: [],
      nowMs,
      timeIso: new Date(nowMs).toISOString(),
    };
    if (close.event === "turn_end") {
      this.emitTrace({
        ...base,
        event: "turn_end",
        outcome: close.outcome,
        ...(close.terminationCause ? { terminationCause: close.terminationCause } : {}),
      });
    } else {
      this.emitTrace({
        ...base,
        event: "turn_abort",
        abortCause: normalizeAbortCause(close.abortCause),
      });
    }
    return true;
  }

  private abortCurrentTurn(agentId: string, cause: TraceAbortCause): void {
    const owner = this.traceOwnerFor(agentId);
    if (owner) this.closeTurn(owner, owner.activeSpan, { event: "turn_abort", abortCause: cause });
  }

  private dispatch(event: ManagerEvent, capturedOwner?: ActiveSpawnState): ManagerEffect[] {
    const before = this.deriveActivitySnapshot(this.state);
    const { state, effects } = reduceManager(this.state, event);
    this.state = state;
    const eventAgentId = (event as { agentId?: string }).agentId;
    const closingOwner =
      event.type === "turn_end" && eventAgentId
        ? this.traceOwnerFor(eventAgentId, capturedOwner)
        : undefined;
    const closingSpan = closingOwner?.activeSpan ?? null;
    // FSM transition trace (plans/daemon-fsm-desync.md): pure observability, no
    // behavior change. Emits one record per reduce so a wedge that leaves no
    // other log is reconstructable from the agent's FSM history
    // — the missing capability behind every "no log when it breaks" incident.
    // Guarded so it's a no-op unless a sink is wired (createDaemon opts).
    if (this.opts.onFsmTransition) {
      const emit = (agentId: string): void => {
        const a = this.state.agents[agentId];
        if (!a) return;
        const nowMs = this.now();
        const activeSpan = this.traceOwnerFor(agentId, capturedOwner)?.activeSpan ?? null;
        // Effects this dispatch produced FOR THIS agent (effects carry agentId,
        // so a tick that terminates one wedged agent attributes correctly).
        const myEffects = effects.filter((e) => (e as { agentId?: string }).agentId === agentId).map((e) => e.type);
        this.emitTrace({
          recordKind: "fsm",
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
          stoppingSince: a.stoppingSince,
          apmPhase: "idle",
          effects: myEffects,
          nowMs,
          timeIso: new Date(nowMs).toISOString(),
          ...(activeSpan ? activeSpan : {}),
          // Derived watchdog inputs — the ONLY way to judge, per wedge, WHY no
          // watchdog fired: `sinceProgressMs` is `stalled`/`suspectedDeaf`'s
          // "no progress for how long" (if it keeps getting reset small on a
          // wedged agent, lastProgressAt is being bumped by stray progress =
          // the anchor is unusable — the exit-1 decision). `sinceDeliverMs` is
          // suspectedDeaf's half (null when no deliver ever happened = its
          // blind spot). `sinceStoppingMs` is the stopping-stuck backstop's
          // clock (null unless in `stopping`) — how close it is to `force_exit`,
          // so a stopping-wedge is legible in the trace instead of inferred from
          // a bare `status=stopping` streak. See plans/daemon-fsm-desync.md.
          sinceProgressMs: nowMs - a.lastProgressAt,
          sinceDeliverMs: a.lastDeliverAt === null ? null : nowMs - a.lastDeliverAt,
          sinceStoppingMs: a.stoppingSince === null ? null : nowMs - a.stoppingSince,
          // Non-clean-turn tag, carried on the `turn_end` event itself (not agent
          // state). Spread so a clean turn_end / any other event omits the keys
          // entirely rather than emitting explicit undefineds. B1.
          ...(event.type === "turn_end" && (event as { endReason?: "errored" }).endReason === "errored"
            ? {
                endReason: "errored" as const,
                terminationCause: normalizeTerminationCause(
                  (event as { terminationCause?: unknown }).terminationCause,
                ),
              }
            : {}),
          // Raw physical exit fact, carried on the `exit` event (not agent
          // state). Spread on exit only so non-exit events omit the keys. T1 —
          // makes a hard exit distinguishable from a clean one in the trace.
          ...(event.type === "exit"
            ? {
                exitCode: (event as { exitCode?: number | null }).exitCode ?? null,
                exitSignal: (event as { exitSignal?: string | null }).exitSignal ?? null,
                abnormal: (event as { abnormal?: boolean }).abnormal ?? false,
                // Launch-failure reason (T2). Included only when present so a
                // normal exit row stays free of the key.
                ...((event as { spawnFailureReason?: string | null }).spawnFailureReason != null
                  ? {
                      spawnFailureReason: normalizeSpawnFailureReason(
                        (event as { spawnFailureReason?: unknown }).spawnFailureReason,
                      ),
                    }
                  : {}),
                // Recovery semantic (T3). Included only when present — a plain
                // runtime exit has none.
                ...((event as { terminationSemantics?: string | null }).terminationSemantics != null
                  ? {
                      terminationSemantics: normalizeTerminationSemantics(
                        (event as { terminationSemantics?: unknown }).terminationSemantics,
                      ),
                    }
                  : {}),
              }
            : {}),
        });
      };
      if (eventAgentId) {
        // Agent-scoped event (wake / spawned / turn_end / …).
        emit(eventAgentId);
      } else if (event.type === "tick") {
        // A tick carries no agentId but the reducer evaluates EVERY agent's
        // watchdogs — fan out so each agent's per-tick watchdog inputs + any
        // effect (or its ABSENCE) are on record. This is what makes "did the
        // tick run and why did stalled not fire" answerable (exit-3).
        for (const id of Object.keys(this.state.agents)) emit(id);
      }
    }
    // Trace-only lifecycle close: never enters the reducer. It occurs after the
    // FSM row (which still carries the active id) and before any queued effect
    // can open the next turn.
    if (closingOwner && closingSpan) {
      const errored = (event as { endReason?: unknown }).endReason === "errored";
      this.closeTurn(
        closingOwner,
        closingSpan,
        errored
          ? {
              event: "turn_end",
              outcome: "errored",
              terminationCause: normalizeTerminationCause(
                (event as { terminationCause?: unknown }).terminationCause,
              ),
            }
          : { event: "turn_end", outcome: "clean" },
      );
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
        this.doSpawn(effect.agentId, effect.messages, effect.resumeSessionId);
        break;
      case "send": {
        const session = this.sessions.get(effect.agentId);
        // Stamp at the moment the text hits `session.send`, not earlier —
        // between effect creation and this call the event loop can drain other
        // dispatches, and we want the timestamp to match the agent's arrival.
        const input = {
          id: effect.message.id!,
          kind: "user" as const,
          text: this.stampNow(this.withFooter(effect.message.text)),
          sequence: effect.message.seq,
        };
        if (session) {
          const owner = this.activeSpawnState.get(effect.agentId);
          const exactOwner = owner?.session === session ? owner : undefined;
          const associatedSpan = exactOwner
            ? effect.mode === "idle"
              ? this.openTurn(exactOwner)
              : exactOwner.activeSpan
            : null;
          let sent: ReturnType<DaemonAgentSession["send"]>;
          try {
            sent = session.send(input);
          } catch (error) {
            if (exactOwner) {
              this.closeTurn(exactOwner, associatedSpan, {
                event: "turn_abort",
                abortCause: "send_threw",
              });
            }
            throw error;
          }
          void Promise.resolve(sent).then((receipt) => {
            if (
              !exactOwner
              || exactOwner.torndown
              || this.sessions.get(effect.agentId) !== session
              || this.activeSpawnState.get(effect.agentId) !== exactOwner
            ) return;
            if (receipt.status === "rejected") {
              this.closeTurn(exactOwner, associatedSpan, {
                event: "turn_abort",
                abortCause: "send_threw",
              });
              this.dispatch({
                type: "delivery_rejected",
                agentId: effect.agentId,
                message: effect.message,
                mode: effect.mode,
              }, exactOwner);
              this.emitErrorAudit(
                effect.agentId,
                "runtime",
                receipt.error?.code ?? receipt.reason,
                receipt.error?.message ?? `Delivery rejected (${receipt.reason})`,
              );
              void session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
            }
          }).catch((error) => {
            if (
              !exactOwner
              || exactOwner.torndown
              || this.sessions.get(effect.agentId) !== session
              || this.activeSpawnState.get(effect.agentId) !== exactOwner
            ) return;
            this.closeTurn(exactOwner, associatedSpan, {
              event: "turn_abort",
              abortCause: "send_threw",
            });
            this.dispatch({
              type: "delivery_rejected",
              agentId: effect.agentId,
              message: effect.message,
              mode: effect.mode,
            }, exactOwner);
            this.emitErrorAudit(effect.agentId, "runtime", "send_failed", String(error));
            void session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
          });
        } else {
          this.dispatch({
            type: "delivery_rejected",
            agentId: effect.agentId,
            message: effect.message,
            mode: effect.mode,
          });
        }
        this.log.info("steering message sent to running agent", { agentId: effect.agentId, mode: effect.mode });
        break;
      }
      case "stop":
      case "terminate_stalled": {
        const session = this.sessions.get(effect.agentId);
        const spawnState = this.activeSpawnState.get(effect.agentId);
        if (effect.type === "terminate_stalled" && spawnState) {
          this.closeTurn(spawnState, spawnState.activeSpan, {
            event: "turn_abort",
            abortCause: "terminate_stalled",
          });
        }
        void session?.stop({
          reason: effect.type === "stop" ? "idle_timeout" : "stalled",
          forceAfterMs: SESSION_STOP_GRACE_MS,
        });
        // The stop we just issued will make the underlying process emit its
        // own `exit` shortly after — suppress that follow-up log so a single
        // termination doesn't produce two contradictory "session ended" lines.
        if (spawnState) spawnState.suppressExitLog = true;
        // `terminate_stalled` is the stall watchdog SIGKILLing a wedged turn —
        // an INVOLUNTARY kill (Blair's case). Mark it by cause so the trailing
        // turn_end tags `killed_stalled`, independent of whether the runtime
        // emits a death-rattle error. `stop` (voluntary idle-timeout) does NOT
        // mark — that's a clean end (Cecilia 架构#352 red line 2). See B1.
        if (effect.type === "terminate_stalled") {
          this.nonCleanEndMarker.set(effect.agentId, { cause: "killed_stalled" });
        }
        // T3: record the recovery SEMANTIC of this stop on the per-spawn state so
        // the trailing exit (via the exit listener, where state is still alive)
        // carries it into the trace. Split by effect.type — the two share this
        // branch but mean opposite things: `terminate_stalled` = stall watchdog
        // SIGKILL (killed_stalled, same word as B1's turn_end-path cause — one
        // concept, one token); voluntary `stop` = idle-timeout hibernation
        // (idle_stop). Conflating them would re-create the "stall-kill
        // impersonates idle" bug in the trace. Purely additive semantic layer
        // over the physical exit fact (exitSignal/etc), never overwriting it —
        // and NOTHING reads it for policy (kept out of B2's rewake gate, which
        // reads terminationCause on turn_end only). See
        // plans/daemon-trace-completeness-charter.md T3.
        if (spawnState) {
          spawnState.terminationSemantics = effect.type === "terminate_stalled" ? "killed_stalled" : "idle_stop";
        }
        this.logSessionEnded(effect.agentId, effect.type === "stop" ? "stopped" : "terminate_stalled");
        this.opts.onAgentLocallyStopped?.({ agentId: effect.agentId, reason: effect.type });
        break;
      }
      case "force_exit": {
        // Stopping-stuck black-hole escape (plans/daemon-fsm-desync.md batch L3):
        // the agent sat in `stopping` past the threshold because the `exit` a
        // prior stop/terminate expected never came. Force the FSM out.
        //
        // (1) Best-effort kill the process so we don't leak an orphan, via a
        //     three-way fallback (batch F):
        //     - session handle present → stop() it (the normal path);
        //     - handle gone but we recorded its pid at spawn → killProcessTree
        //       the pid directly. This is the case that caused this wedge
        //       (batch G / Hypothesis A: the map entry was cleared while the OS
        //       process lived on) — now we can actually reap the orphan instead
        //       of only warning. killProcessTree self-guards a dead/invalid pid.
        //     - neither (SDK in-process session: no OS pid) → genuinely
        //       unkillable, so warn (honest, not a fake kill).
        //     DIAGNOSTIC (batch G): log which branch we took + that the session
        //     handle was absent, so the proximate no-op root (why sessions map
        //     lost the entry) has a durable data point at each real occurrence.
        const session = this.sessions.get(effect.agentId);
        const state = this.activeSpawnState.get(effect.agentId);
        if (state) {
          this.closeTurn(state, state.activeSpan, {
            event: "turn_abort",
            abortCause: "force_exit",
          });
        }
        if (session) {
          void Promise.resolve(
            session.stop({ reason: "stalled", forceAfterMs: SESSION_STOP_GRACE_MS }),
          ).catch(() => {});
        } else {
          this.log.warn("force_exit: logical session handle is already absent", {
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
        // Clear the killed_stalled marker set at (1249) — this force_exit IS its
        // trailing terminal event. The `session.on("exit")` clear (~:1569) can't
        // do it on this path: force_exit set `torndown` (the late real exit
        // bails at the torndown early-return) AND deleted activeSpawnState (its
        // `=== state` guard then fails). Without this, the leaked marker gets
        // consumed by the NEXT healthy reborn turn's turn_end (~:1842) and
        // mislabels that turn `killed_stalled` in the trace/audit — a forensic
        // lie, not a behavior bug, but it corrupts post-force_exit trace reads.
        this.nonCleanEndMarker.delete(effect.agentId);
        this.opts.onAgentLocallyStopped?.({ agentId: effect.agentId, reason: "terminate_stalled" });
        // (3) Synthetic `exit` → the normal onExit recovery (drain-respawn or
        //     settle idle; enterStable clears stoppingSince). Universal backstop:
        //     works whether or not we could kill the process.
        //     T3: `terminationSemantics` is set INLINE here, not via the state
        //     marker — activeSpawnState was already deleted at (2) above, so the
        //     marker is unreadable by the time this synthetic exit dispatches.
        //     Labels this as the stopping-stuck black-hole escape (force_exit),
        //     otherwise the synthetic exit is a bare, unexplained exit in trace.
        this.dispatch({ type: "exit", agentId: effect.agentId, terminationSemantics: "force_exit" });
        break;
      }
    }
  }

  private logSessionEnded(agentId: string, reason: "turn_end" | "stopped" | "terminate_stalled" | "exit"): void {
    this.log.info("agent session ended", { agentId, sessionId: this.liveSessions.get(agentId) ?? "", reason });
  }

  private doSpawn(agentId: string, messages: AgentMsg[], resumeSessionId: string | null): void {
    const [first, ...pending] = messages;
    if (!first) throw new Error(`AgentProcessManager: spawn for ${agentId} has no command`);
    const prompt = this.withFooter(first.text);
    const driver = this.opts.driverFor(agentId, this.runtimeConfigs.get(agentId));
    const base = this.opts.baseContextFor(agentId);
    const configuredRuntime = this.runtimeConfigs.get(agentId) ?? base.config?.runtimeConfig;
    this.log.info("spawning agent", {
      agentId,
      runtime: driver.id,
      model: runtimeModelName(configuredRuntime) ?? "default",
    });
    if (!this.opts.sessionFactory) {
      throw new Error("AgentProcessManager: a public AgentSession factory is required");
    }

    const runtimeConfig = configuredRuntime ?? ({
      version: 1,
      runtime: driver.id,
      model: { kind: "default" },
      mode: { kind: "default" },
    } as RuntimeConfig);
    const provider = runtimeConfig.runtime;
    const sessionId =
      resumeSessionId ??
      this.resumeSessions.get(agentId) ??
      this.opts.timeline?.resumeSessionId(agentId, provider) ??
      base.config?.sessionId;
    const description = runtimeConfig.instruction ?? base.config?.description ?? runtimeConfig.agentName;
    const agentName = runtimeConfig.agentName ?? base.config?.agentName;
    const agentHandle = runtimeConfig.agentHandle ?? base.config?.agentHandle;
    const config: HostLaunchContext["config"] = {
      ...(base.config ?? {}),
      runtimeConfig,
      sessionId,
      description,
      agentName,
      agentHandle,
    };
    const standingPrompt = base.standingPrompt || buildCliSystemPrompt(config);
    const ctx: HostLaunchContext = {
      ...base,
      prompt,
      standingPrompt,
      credentialProxy: base.credentialProxy ?? this.opts.credentialProxy,
      launchId: this.launchIds.get(agentId) ?? base.launchId,
      config,
    };

    const state: ActiveSpawnState = {
      agentId,
      session: null,
      hasEstablished: false,
      hasReportedSpawnFailure: false,
      suppressExitLog: false,
      handshakeTimer: null,
      torndown: false,
      superseded: false,
      spawnFailureReason: null,
      terminationSemantics: null,
      spawnOrdinal: this.nextSpawnOrdinal++,
      launchIdSnapshot: typeof ctx.launchId === "string" && ctx.launchId.length > 0 ? ctx.launchId : null,
      nextTurnOrdinal: 1,
      activeSpan: null,
    };
    this.activeSpawnState.set(agentId, state);

    const clearHandshakeTimer = () => {
      if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
      state.handshakeTimer = null;
    };
    const reportSpawnFailure = (
      reason: string,
      options?: { message?: string; scope?: "spawn" | "handshake_timeout" },
    ) => {
      if (state.hasEstablished || state.hasReportedSpawnFailure) return;
      state.hasReportedSpawnFailure = true;
      state.spawnFailureReason = reason;
      this.closeTurn(state, state.activeSpan, {
        event: "turn_abort",
        abortCause: options?.scope === "handshake_timeout" ? "handshake_timeout" : "spawn_failure",
      });
      this.log.warn("spawn failed", { agentId, runtime: driver.id, reason });
      this.opts.onRuntimeSpawnFailed?.(driver.id, reason);
      this.emitErrorAudit(
        agentId,
        options?.scope ?? "spawn",
        reason,
        options?.message ?? `Launch failed (${reason})`,
      );
    };
    const teardown = (result: AgentSessionResult) => {
      clearHandshakeTimer();
      if (state.torndown) return;
      state.torndown = true;
      const failedStart = result.outcome === "failed_to_start";
      if (failedStart) reportSpawnFailure(result.error.code || "failed_to_start");
      if (!state.hasEstablished && !failedStart) reportSpawnFailure("pre_handshake_exit");
      this.closeTurn(state, state.activeSpan, {
        event: "turn_abort",
        abortCause: failedStart ? "spawn_failure" : "physical_exit",
      });
      const exitCode = "exitCode" in result ? result.exitCode ?? null : null;
      const exitSignal = "signal" in result ? result.signal ?? null : null;
      // This trace field is the raw physical exit fact, not the logical-session
      // result category. A code-0 process exit can still be logically
      // unexpected (`crashed` closes the long-lived session), while remaining
      // physically clean and therefore `abnormal:false` here.
      const requested = "requested" in result && result.requested === true;
      const abnormal = !requested && (exitSignal !== null || (exitCode !== null && exitCode !== 0));
      if (state.hasEstablished && !state.suppressExitLog) {
        this.logSessionEnded(agentId, "exit");
        if (abnormal) {
          const detail = exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`;
          this.emitErrorAudit(agentId, "exit", "abnormal_exit", `Session ended unexpectedly (${detail})`);
        }
      }
      this.flushThinkingAudit(agentId);
      if (state.session && this.sessions.get(agentId) === state.session) this.sessions.delete(agentId);
      this.liveSessions.delete(agentId);
      if (this.activeSpawnState.get(agentId) === state) {
        this.activeSpawnState.delete(agentId);
        this.nonCleanEndMarker.delete(agentId);
      }
      this.dispatch({
        type: "exit",
        agentId,
        exitCode,
        exitSignal,
        abnormal,
        spawnFailureReason: state.spawnFailureReason,
        terminationSemantics: state.terminationSemantics,
      }, state);
    };
    const onEvent = (event: ManagedEvent) => {
      if (state.torndown) return;
      if (event.type === "session_failed" && !state.hasEstablished) {
        reportSpawnFailure(event.error.code || "failed_to_start", { message: event.error.message });
      }
      if (event.type === "session_started") {
        state.hasEstablished = true;
        clearHandshakeTimer();
        this.opts.onRuntimeSessionEstablished?.(driver.id);
      }
      this.onAgentEvent(agentId, event, driver.id, state);
    };
    const attach = (session: DaemonAgentSession) => {
      if (state.torndown || this.activeSpawnState.get(agentId) !== state) {
        void session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
        return;
      }
      state.session = session;
      this.sessions.set(agentId, session);
      void (async () => {
        try {
          for await (const event of session.events) onEvent(event as ManagedEvent);
        } catch (error) {
          reportSpawnFailure("event_stream_failed", { message: String(error) });
        }
      })();
      void session.closed.then(teardown, (error) => {
        reportSpawnFailure("session_closed_rejected", { message: String(error) });
        this.dispatch({ type: "exit", agentId, spawnFailureReason: state.spawnFailureReason }, state);
      });

      const startedSpan = this.openTurn(state);
      const commandId = first.id!;
      let startResult: Promise<DeliveryReceipt>;
      try {
        startResult = session.start({
          id: commandId,
          kind: "user",
          text: this.stampNow(prompt),
          sequence: first.seq,
        });
      } catch (error) {
        this.closeTurn(state, startedSpan, { event: "turn_abort", abortCause: "start_threw" });
        throw error;
      }
      void startResult.then((receipt) => {
        if (this.sessions.get(agentId) !== session || state.torndown) return;
        if (receipt?.status === "rejected") {
          const reason = receipt.error?.code ?? receipt.reason;
          reportSpawnFailure(reason, { message: receipt.error?.message });
          void session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
          return;
        }
        this.dispatch({ type: "spawned", agentId, nowMs: this.now() }, state);
        void (async () => {
          for (const message of pending) {
            if (state.torndown || this.sessions.get(agentId) !== session || this.activeSpawnState.get(agentId) !== state) {
              return;
            }
            const queuedReceipt = await session.send({
              id: message.id!,
              kind: "user",
              text: this.stampNow(this.withFooter(message.text)),
              sequence: message.seq,
            });
            if (state.torndown || this.sessions.get(agentId) !== session || this.activeSpawnState.get(agentId) !== state) {
              return;
            }
            if (queuedReceipt.status === "rejected") {
              this.dispatch({ type: "delivery_rejected", agentId, message, mode: "busy" }, state);
              this.emitErrorAudit(
                agentId,
                "runtime",
                queuedReceipt.error?.code ?? queuedReceipt.reason,
                queuedReceipt.error?.message ?? `Delivery rejected (${queuedReceipt.reason})`,
              );
              void session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
              return;
            }
          }
        })().catch((error) => this.emitErrorAudit(agentId, "runtime", "send_failed", String(error)));
        if (state.hasEstablished || state.hasReportedSpawnFailure) return;
        state.handshakeTimer = setTimeout(() => {
          state.handshakeTimer = null;
          if (state.hasEstablished || state.hasReportedSpawnFailure || state.torndown) return;
          if (this.sessions.get(agentId) !== session) return;
          reportSpawnFailure("handshake_timeout", {
            scope: "handshake_timeout",
            message: `No response ${Math.round(this.opts.handshakeTimeoutMs / 1000)}s after launch — the runtime may be misconfigured (e.g. an invalid model).`,
          });
          state.suppressExitLog = true;
          void session.stop({ reason: "stalled", forceAfterMs: SESSION_STOP_GRACE_MS });
        }, this.opts.handshakeTimeoutMs);
      }).catch((error: unknown) => {
        this.closeTurn(state, startedSpan, { event: "turn_abort", abortCause: "start_rejected" });
        const code = (error as { code?: string } | undefined)?.code ?? "spawn_threw";
        reportSpawnFailure(String(code), { message: String(error) });
      });
    };
    const failedOpen = (error: unknown) => {
      reportSpawnFailure(
        (error as { code?: string } | undefined)?.code ?? "open_failed",
        { message: String(error) },
      );
      if (this.activeSpawnState.get(agentId) === state) this.activeSpawnState.delete(agentId);
      this.dispatch({ type: "exit", agentId, spawnFailureReason: state.spawnFailureReason }, state);
    };

    let created: ReturnType<SessionFactory>;
    try {
      created = this.opts.sessionFactory({
        agentId,
        ctx,
        runtimeConfig,
      });
    } catch (error) {
      // Preserve the synchronous factory-failure contract: restartAgent owns
      // the gate-clearing exit dispatch and propagates the failure to its
      // caller. Promise rejections still use failedOpen above because they can
      // only arrive after doSpawn has returned.
      if (this.activeSpawnState.get(agentId) === state) this.activeSpawnState.delete(agentId);
      throw error;
    }
    if (created && typeof (created as Promise<DaemonAgentSession>).then === "function") {
      void Promise.resolve(created).then(attach, failedOpen);
    } else {
      try {
        attach(created as DaemonAgentSession);
      } catch (error) {
        // A synchronously throwing session.start is a public open failure, not
        // a factory-construction failure. Report and settle it without leaking
        // the implementation exception through deliver().
        failedOpen(error);
      }
    }
  }

  private currentModelFor(agentId: string): string | null {
    return runtimeModelName(this.runtimeConfigs.get(agentId)) ?? null;
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

  private onAgentEvent(
    agentId: string,
    event: ManagedEvent,
    runtimeId: BuiltinBackendId,
    owner: ActiveSpawnState,
  ): void {
    if (event.type === "session_closed") return;

    const sessionSuperseded = owner.superseded;
    const errorMessage = event.type === "session_failed"
      ? event.error.message
      : event.type === "turn_completed" && event.result.outcome === "failed"
        ? event.result.error.message
        : undefined;
    if (errorMessage !== undefined && !sessionSuperseded) {
      this.emitErrorAudit(agentId, "runtime", "runtime_error", errorMessage);
      if (this.nonCleanEndMarker.get(agentId)?.cause !== "killed_stalled") {
        this.nonCleanEndMarker.set(agentId, { cause: "runtime_error", detail: errorMessage });
      }
      const agent = this.state.agents[agentId];
      if (
        agent?.resetting &&
        agent.resettingSince !== null &&
        this.now() - agent.resettingSince >= this.state.resetStuckThresholdMs
      ) {
        this.log.warn("runtime error during a stuck reset window", {
          agentId,
          resettingForMs: this.now() - agent.resettingSince,
          message: errorMessage,
        });
      }
    }

    if (this.opts.onBotAuditEvent) {
      if (event.type === "thinking_delta") {
        if (event.text.length > 0) {
          this.thinkingBuffers.set(agentId, (this.thinkingBuffers.get(agentId) ?? "") + event.text);
        }
      } else {
        this.flushThinkingAudit(agentId);
        if (event.type === "tool_started") {
          const audit = extractToolAudit(event.name, event.input);
          if (!audit.suppressed) {
            const payload = audit.target !== undefined
              ? { name: audit.name, target: audit.target }
              : { name: audit.name };
            try {
              this.opts.onBotAuditEvent(agentId, { kind: "tool_call", payload }, {
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

    if (event.type === "session_started") {
      this.dispatch({ type: "session", agentId, sessionId: event.backendSessionId }, owner);
      this.liveSessions.set(agentId, event.backendSessionId);
      this.opts.timeline?.setSession(agentId, event.backendSessionId);
      this.opts.onAgentSession?.({
        agentId,
        sessionId: event.backendSessionId,
        launchId: this.launchIds.get(agentId) ?? "",
      });
      this.log.info("agent session established", {
        agentId,
        sessionId: event.backendSessionId,
        runtime: runtimeId,
      });
    }
    if (event.type === "text_delta" && event.text.length > 0) {
      this.opts.timeline?.appendResponseToLatest(agentId, event.text);
    }

    const contentFree = event.type === "internal_progress"
      || event.type === "session_failed"
      || event.type === "command_queued"
      || event.type === "command_accepted"
      || event.type === "command_failed"
      || event.type === "turn_started";
    if (!contentFree) this.dispatch({ type: "progress", agentId, nowMs: this.now() }, owner);

    const signalKind = (() => {
      switch (event.type) {
        case "session_started": return "session_init";
        case "thinking_delta": return "thinking";
        case "text_delta": return "text";
        case "tool_started": return "tool_call";
        case "tool_finished": return "tool_output";
        case "diagnostic": return "runtime_diagnostic";
        case "token_usage":
        case "rate_limits": return "telemetry";
        case "turn_completed": return "turn_end";
        case "session_failed": return "error";
        case "command_queued":
        case "command_accepted":
        case "command_failed":
        case "turn_started": return "internal_progress";
        default: return event.type;
      }
    })();
    this.dispatch({ type: "runtime_signal", agentId, kind: signalKind, nowMs: this.now() }, owner);

    if (event.type === "turn_completed") {
      this.logSessionEnded(agentId, "turn_end");
      const marker = this.nonCleanEndMarker.get(agentId);
      this.nonCleanEndMarker.delete(agentId);
      this.dispatch(
        marker !== undefined
          ? {
              type: "turn_end",
              agentId,
              nowMs: this.now(),
              endReason: "errored",
              terminationCause: marker.cause,
              errorDetail: marker.detail,
            }
          : { type: "turn_end", agentId, nowMs: this.now() },
        owner,
      );
    }
  }
}

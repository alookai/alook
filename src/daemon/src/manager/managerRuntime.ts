import {
  reduceManager,
  createInitialManagerState,
  DEFAULT_IDLE_RESET_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_STOPPING_STUCK_THRESHOLD_MS,
  type ManagerState,
  type ManagerEvent,
  type ManagerEffect,
  type AgentMsg,
  type AgentState,
  type AgentStatus,
  type NativeActivityKind,
  type RuntimePhase,
  isActivelyWorking,
} from "./managerPolicy.js";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionSnapshot,
  AgentSessionResult,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  DeliveryReceipt,
  RuntimeSettingsUpdateResult,
  ProviderQuotaObservation,
  TokenUsageDelta,
} from "@alook/agent-driver";
import type { HostLaunchContext } from "./hostContext.js";
import { runtimeModelName, type RuntimeConfig } from "../runtimeConfig.js";
import { scrubRuntimeErrorDiagnosticText } from "../runtime/errorDiagnostics.js";
import { buildCliSystemPrompt } from "../drivers/systemPrompt.js";
import { createLogger, type Logger } from "../logger.js";
import { nowLocalISO } from "../util/localTime.js";
import type { ResumeSessionResolution } from "../timeline/timeline.js";
import type { SystemEntryType } from "../timeline/types.js";
import { randomUUID } from "node:crypto";
import type { TimelineTurnOwner } from "../timeline/recorder.js";
const SESSION_STOP_GRACE_MS = 2_000;
export type AgentActivityState = "idle" | "starting" | "running" | "stopping";
export type DaemonAgentSession = AgentSession<BuiltinBackendSpecs, BuiltinBackendId>;
export type RuntimeConfigUpdateResult = "applied" | "deferred" | "saved_for_start" | "stale" | "idempotent";
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
interface PendingDeliveryTrace {
  sessionInstanceId: string;
  span: ActiveTurnSpan | null;
  mode: "busy" | "idle";
  driverObserved: boolean;
}
interface ActiveSpawnState {
  agentId: string;
  session: DaemonAgentSession | null;
  sessionInstanceId: string | null;
  hasEstablished: boolean;
  hasReportedSpawnFailure: boolean;
  suppressExitLog: boolean;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  torndown: boolean;
  superseded: boolean;
  discardEvents: boolean;
  stalledSessionIdAtLaunch: string | null;
  spawnFailureReason: string | null;
  terminationSemantics: string | null;
  spawnOrdinal: number;
  launchIdSnapshot: string | null;
  nextTurnOrdinal: number;
  activeSpan: ActiveTurnSpan | null;
  timelineTurnOwner: TimelineTurnOwner | null;
  pendingDeliverySpans: Map<string, PendingDeliveryTrace>;
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
  event: ManagerEvent["type"] | "root_work" | "turn_end";
  status: AgentStatus;
  turnId: string | null;
  turnActive: boolean;
  inbox: number;
  lastDeliverAt: number | null;
  lastProgressAt: number;
  lastNativeActivityAt: number;
  lastNativeActivityKind: NativeActivityKind | null;
  runtimePhase: RuntimePhase;
  backendTurnId: string | null;
  turnSilenceBudgetMs: number;
  nativeDeadlineAt: number | null;
  recoveryExtensionsUsed: number;
  idleSince: number | null;
  resetting: boolean;
  resettingSince: number | null;
  stoppingSince: number | null;
  deliveryPhase: AgentSessionSnapshot["diagnostics"]["deliveryPhase"];
  physicalOpenCount?: number;
  turnCount?: number;
  commandAdmissionCount?: number;
  commandAdmissionLatencyTotalMs?: number;
  queueDwellCount?: number;
  queueDwellTotalMs?: number;
  sseReconnectCount?: number;
  resumeOutcome?: "not_requested" | "pending" | "resumed" | "reset_required" | "failed";
  terminalOwnerKind?: "transport_request" | "vendor_message" | "prompt_invocation" | "lane_generation";
  sinceProgressMs: number;
  sinceNativeActivityMs: number;
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
  idleResetTimeoutMs?: number;
  resetStuckThresholdMs?: number;
  stoppingStuckThresholdMs?: number;
  handshakeTimeoutMs?: number;
  tickIntervalMs?: number;
  now?: () => number;
  onAgentSession?: (info: { agentId: string; sessionId: string; launchId: string }) => void;
  onAgentActivity?: (info: { agentId: string; state: AgentActivityState }) => void;
  onTokenUsage?: (info: { agentId: string; backendId: BuiltinBackendId; usage: TokenUsageDelta }) => void;
  onProviderQuota?: (info: { agentId: string; backendId: BuiltinBackendId; quota: ProviderQuotaObservation }) => void;
  onBotAuditEvent?: (
    agentId: string,
    event:
      | { kind: "tool_call"; payload: { name: string; target?: string } }
      | { kind: "thinking"; payload: { text: string; truncated: boolean; chars: number } }
      | { kind: "session_reset"; payload: { trigger: "idle_timeout" } }
      | {
          kind: "error";
          payload: {
            scope: "spawn" | "runtime" | "exit" | "handshake_timeout" | "model_switch" | "reset";
            code: string;
            message: string;
            model: string | null;
          };
        },
    context: {
      sessionId: string | null;
      launchId: string | null;
      eventId?: string;
      occurredAt?: string;
    }
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
  barrierGeneration(agentId: string): number;
  beginTurn(agentId: string, owner: TimelineTurnOwner): void;
  recordAssistantMessage(agentId: string, owner: TimelineTurnOwner, text: string, truncated?: boolean): void;
  finalizeTurn(agentId: string, owner: TimelineTurnOwner): void;
  fenceSession(agentId: string): void;
  setSession(agentId: string, sessionId: string, sessionInstanceId?: string): boolean;
  resumeSessionId(agentId: string, provider: string | null): string | null;
  resolveResumeSession?(agentId: string, provider: string | null): ResumeSessionResolution;
  recordSessionStall?(agentId: string, sessionId: string): boolean;
  clearSessionStall?(agentId: string, sessionId: string): boolean;
  forgetSession(
    agentId: string,
    barrierType?: SystemEntryType,
    forgottenSessionId?: string,
    pendingIdleResetEvent?: { eventId: string; occurredAt: string },
  ): boolean;
}
const THINKING_MAX_BYTES = 4096;
const AUDIT_ERROR_MESSAGE_MAX_LEN = 2000;
const MAX_TARGET_CODE_UNITS = 200;
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
const ALOOK_CLI_ENV_VAR = "ALOOK_CLI";
const ALOOK_SHELL_INVOCATION_RE = new RegExp(
  `^(?:alook|\\$\\{?${ALOOK_CLI_ENV_VAR}\\}?)(\\s|$)`,
);
export function isAlookShellInvocation(command: string | undefined): boolean {
  if (!command) return false;
  return ALOOK_SHELL_INVOCATION_RE.test(command.trimStart());
}
export function truncateTargetToCodeUnits(s: string): string {
  if (s.length <= MAX_TARGET_CODE_UNITS) return s;
  let end = MAX_TARGET_CODE_UNITS - 1;
  const cu = s.charCodeAt(end - 1);
  if (cu >= 0xd800 && cu <= 0xdbff) end -= 1;
  return s.slice(0, end) + "…";
}
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
export function truncateThinking(
  text: string
): { text: string; truncated: boolean; chars: number } {
  const chars = [...text].length;
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= THINKING_MAX_BYTES) {
    return { text, truncated: false, chars };
  }
  let end = THINKING_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const truncatedText = buf.subarray(0, end).toString("utf8");
  return { text: truncatedText, truncated: true, chars };
}
export class AgentProcessManager {
  private state: ManagerState;
  private readonly sessions = new Map<string, DaemonAgentSession>();
  private readonly runtimeConfigs = new Map<string, RuntimeConfig>();
  private readonly appliedRuntimeConfigs = new Map<string, RuntimeConfig>();
  private readonly pendingRuntimeConfigUpdates = new Map<string, RuntimeConfig>();
  private readonly runtimeConfigApplyRunning = new Set<string>();
  private readonly resumeSessions = new Map<string, string>();
  private readonly launchIds = new Map<string, string>();
  private readonly liveSessions = new Map<string, string>();
  private readonly liveBackendIds = new Map<string, BuiltinBackendId>();
  private readonly activeSpawnState = new Map<string, ActiveSpawnState>();
  private readonly publishedAgentActivity = new Map<string, AgentActivityState>();
  private readonly traceProcessNonce = randomUUID();
  private nextSpawnOrdinal = 1;
  private nextDaemonTurnOrdinal = 1;
  private nextDeliveryOrdinal = 1;
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
      | "onTokenUsage"
      | "onProviderQuota"
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
      | "onTokenUsage"
      | "onProviderQuota"
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
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      idleResetTimeoutMs: DEFAULT_IDLE_RESET_TIMEOUT_MS,
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
      this.opts.idleResetTimeoutMs,
    );
  }
  register(agentId: string, launch?: {
    runtimeConfig?: RuntimeConfig;
    sessionId?: string;
    launchId?: string;
    applyRuntimeConfig?: boolean;
  }): void {
    const runtimeConfigAcceptance = launch?.runtimeConfig
      ? this.acceptRuntimeConfig(agentId, launch.runtimeConfig)
      : undefined;
    if (launch?.sessionId) this.resumeSessions.set(agentId, launch.sessionId);
    if (launch?.launchId) this.launchIds.set(agentId, launch.launchId);
    this.dispatch({ type: "register", agentId });
    const registered = this.state.agents[agentId];
    if (
      launch?.runtimeConfig
      && launch.applyRuntimeConfig !== false
      && (runtimeConfigAcceptance === "accepted" || this.pendingRuntimeConfigUpdates.has(agentId))
      && this.sessions.has(agentId)
      && registered
      && !isActivelyWorking(registered)
    ) {
      void this.convergeRuntimeConfig(agentId);
    }
  }

  async updateRuntimeConfig(agentId: string, config: RuntimeConfig): Promise<RuntimeConfigUpdateResult> {
    const accepted = this.acceptRuntimeConfig(agentId, config);
    if (accepted === "stale" || accepted === "idempotent") return accepted;
    const session = this.sessions.get(agentId);
    if (!session) {
      this.pendingRuntimeConfigUpdates.delete(agentId);
      return "saved_for_start";
    }
    const agent = this.state.agents[agentId];
    if (agent && (agent.turnActive || isActivelyWorking(agent))) return "deferred";
    return this.convergeRuntimeConfig(agentId);
  }

  private acceptRuntimeConfig(
    agentId: string,
    config: RuntimeConfig,
  ): "accepted" | "stale" | "idempotent" {
    const desired = this.runtimeConfigs.get(agentId);
    const revision = config.runtimeConfigRevision ?? 0;
    const desiredRevision = desired?.runtimeConfigRevision ?? 0;
    if (desired && revision < desiredRevision) return "stale";
    if (desired && revision === desiredRevision) {
      if (this.runtimeConfigTuple(desired) !== this.runtimeConfigTuple(config)) {
        throw new Error(`Conflicting runtime config for ${agentId} at revision ${revision}`);
      }
      this.runtimeConfigs.set(agentId, config);
      return "idempotent";
    }
    this.runtimeConfigs.set(agentId, config);
    this.pendingRuntimeConfigUpdates.set(agentId, config);
    return "accepted";
  }

  private runtimeConfigTuple(config: RuntimeConfig): string {
    return JSON.stringify({
      version: config.version,
      runtime: config.runtime,
      model: config.model,
      mode: config.mode,
      reasoningEffort: config.reasoningEffort ?? null,
      provider: config.provider ?? null,
      command: config.command ?? null,
      disallowedTools: config.disallowedTools ?? null,
      envVars: config.envVars ?? null,
    });
  }

  private runtimeLaunchTuple(config: RuntimeConfig): string {
    return JSON.stringify({
      version: config.version,
      runtime: config.runtime,
      model: config.model,
      mode: config.mode,
      provider: config.provider ?? null,
      command: config.command ?? null,
      disallowedTools: config.disallowedTools ?? null,
      envVars: config.envVars ?? null,
    });
  }

  private async convergeRuntimeConfig(
    agentId: string,
    restartOnFailure = true,
  ): Promise<RuntimeConfigUpdateResult> {
    if (this.runtimeConfigApplyRunning.has(agentId)) return "deferred";
    const session = this.sessions.get(agentId);
    if (!session) return "saved_for_start";
    this.runtimeConfigApplyRunning.add(agentId);
    try {
      while (this.sessions.get(agentId) === session) {
        const desired = this.pendingRuntimeConfigUpdates.get(agentId) ?? this.runtimeConfigs.get(agentId);
        if (!desired) return "idempotent";
        const desiredRevision = desired.runtimeConfigRevision ?? 0;
        const applied = this.appliedRuntimeConfigs.get(agentId);
        const appliedRevision = applied?.runtimeConfigRevision ?? -1;
        if (applied && desiredRevision <= appliedRevision) {
          this.pendingRuntimeConfigUpdates.delete(agentId);
          return desiredRevision === appliedRevision ? "idempotent" : "stale";
        }
        const canApplyNatively = applied
          && this.runtimeLaunchTuple(applied) === this.runtimeLaunchTuple(desired)
          && typeof session.updateSettings === "function";
        let result: RuntimeSettingsUpdateResult = { status: "unsupported" };
        if (canApplyNatively) {
          try {
            result = await session.updateSettings!({
              reasoningEffort: desired.reasoningEffort ?? null,
            });
          } catch (error) {
            this.log.warn("runtime config live apply threw; restarting at safe boundary", {
              agentId,
              revision: desiredRevision,
              error: String(error),
            });
            if (restartOnFailure) await this.restartForRuntimeConfig(agentId, session);
            return "saved_for_start";
          }
        }
        if (result.status !== "applied") {
          this.log.warn("runtime config live apply unavailable; restarting at safe boundary", {
            agentId,
            revision: desiredRevision,
            status: result.status,
            code: result.error?.code,
          });
          if (restartOnFailure) await this.restartForRuntimeConfig(agentId, session);
          return "saved_for_start";
        }
        this.appliedRuntimeConfigs.set(agentId, desired);
        if ((this.pendingRuntimeConfigUpdates.get(agentId)?.runtimeConfigRevision ?? -1) === desiredRevision) {
          this.pendingRuntimeConfigUpdates.delete(agentId);
        }
        const latestRevision = this.runtimeConfigs.get(agentId)?.runtimeConfigRevision ?? 0;
        if (latestRevision <= desiredRevision) {
          this.dispatch({ type: "runtime_config_applied", agentId });
          return "applied";
        }
      }
      return "saved_for_start";
    } finally {
      this.runtimeConfigApplyRunning.delete(agentId);
    }
  }

  private async restartForRuntimeConfig(agentId: string, session: DaemonAgentSession): Promise<void> {
    if (this.sessions.get(agentId) !== session) return;
    this.opts.timeline?.fenceSession(agentId);
    this.markResetting(agentId);
    await this.stop(agentId);
  }
  deliver(agentId: string, message: AgentMsg): boolean {
    const normalized = message.id
      ? message
      : {
          ...message,
          id: message.seq !== undefined
            ? `${agentId}:source:${message.seq}`
            : `${agentId}:synthetic:${this.nextDeliveryOrdinal++}`,
        };
    if (this.sessions.has(agentId) && this.pendingRuntimeConfigUpdates.has(agentId)) {
      this.dispatch({
        type: "runtime_config_queued",
        agentId,
        message: normalized,
      });
      return this.state.agents[agentId] !== undefined;
    }
    const effects = this.dispatch({ type: "wake", agentId, message: normalized, nowMs: this.now() });
    return effects.length > 0;
  }
  forgetSession(
    agentId: string,
    barrierType: "reset_session" | "nap" = "reset_session",
    forgottenSessionId?: string,
    pendingIdleResetEvent?: { eventId: string; occurredAt: string },
  ): boolean {
    if (!this.forgetSessionSources(
      agentId,
      barrierType,
      forgottenSessionId,
      pendingIdleResetEvent,
    )) return false;
    this.dispatch({ type: "reset_session", agentId });
    return true;
  }
  private forgetSessionSources(
    agentId: string,
    barrierType: SystemEntryType,
    forgottenSessionId?: string,
    pendingIdleResetEvent?: { eventId: string; occurredAt: string },
  ): boolean {
    const persisted = pendingIdleResetEvent
      ? this.opts.timeline?.forgetSession(
        agentId,
        barrierType,
        forgottenSessionId,
        pendingIdleResetEvent,
      )
      : this.opts.timeline?.forgetSession(agentId, barrierType, forgottenSessionId);
    if (persisted === false) return false;
    this.resumeSessions.delete(agentId);
    this.liveSessions.delete(agentId);
    return true;
  }
  enqueueRewake(agentId: string, message: AgentMsg): void {
    this.dispatch({ type: "rewake_after_reset", agentId, message });
  }
  markResetting(agentId: string): void {
    this.dispatch({ type: "begin_reset", agentId, nowMs: this.now() });
    const live = this.activeSpawnState.get(agentId);
    if (live) live.superseded = true;
  }
  async resetSession(
    agentId: string,
    opts: {
      runtimeConfig: RuntimeConfig;
      launchId: string;
      rewakePrompt: string;
      barrierType?: "reset_session" | "nap";
    },
  ): Promise<void> {
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
  private async restartAgent(
    agentId: string,
    opts: {
      runtimeConfig: RuntimeConfig;
      launchId: string;
      rewakePrompt: string;
      forgetSession: boolean;
      barrierType?: "reset_session" | "nap";
      abortCause: "reset" | "nap" | "model_switch";
      opName: string;
    },
  ): Promise<void> {
    if (opts.forgetSession && !this.forgetSession(agentId, opts.barrierType ?? "reset_session")) {
      this.log.error("resume control transition failed; reset aborted", { agentId, barrierType: opts.barrierType });
      this.emitErrorAudit(agentId, "reset", "resume_control_update_failed", "Reset aborted because resume control could not be persisted");
      throw new Error("Reset aborted because resume control could not be persisted");
    }
    this.register(agentId, {
      runtimeConfig: opts.runtimeConfig,
      launchId: opts.launchId,
      applyRuntimeConfig: false,
    });
    if (!opts.forgetSession) this.opts.timeline?.fenceSession(agentId);
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
    this.enqueueRewake(agentId, {
      id: `${opts.launchId}:${opts.abortCause}:rewake`,
      text: opts.rewakePrompt,
    });
    await this.stop(agentId);
  }
  async switchModel(
    agentId: string,
    opts: { runtimeConfig: RuntimeConfig; launchId: string; rewakePrompt: string },
  ): Promise<void> {
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
  async stop(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.abortCurrentTurn(agentId, "requested_stop");
    await session.stop({ reason: "owner_request", forceAfterMs: SESSION_STOP_GRACE_MS });
    if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
  }
  async stopAll(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const entries = [...this.sessions.entries()];
    for (const [agentId] of entries) this.abortCurrentTurn(agentId, "shutdown");
    await Promise.all(entries.map(async ([, session]) => {
      const receipt = await session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
      if (receipt.status === "already_stopping") await session.closed;
    }));
    this.sessions.clear();
  }
  snapshot(): ManagerState {
    return this.state;
  }
  /** Number of physical agent sessions currently owned by this manager. */
  runningAgentCount(): number {
    return this.sessions.size;
  }
  auditContext(agentId: string): { sessionId: string | null; launchId: string | null } {
    return {
      sessionId: this.liveSessions.get(agentId) ?? null,
      launchId: this.launchIds.get(agentId) ?? null,
    };
  }
  timelineTurnOwner(agentId: string): TimelineTurnOwner | null {
    const owner = this.traceOwnerFor(agentId);
    return owner?.timelineTurnOwner ? { ...owner.timelineTurnOwner } : null;
  }
  liveSessionReports(): Array<{ agentId: string; sessionId: string; launchId: string }> {
    return [...this.liveSessions.entries()].map(([agentId, sessionId]) => ({
      agentId,
      sessionId,
      launchId: this.launchIds.get(agentId) ?? "",
    }));
  }
  liveAgentActivities(): Array<{ agentId: string; state: AgentActivityState }> {
    return Object.entries(this.deriveActivitySnapshot(this.state)).map(([agentId, state]) => ({
      agentId,
      state,
    }));
  }
  agentActivity(agentId: string): AgentActivityState | null {
    const agent = this.state.agents[agentId];
    return agent ? this.deriveActivity(agent) : null;
  }
  agentBackendId(agentId: string): BuiltinBackendId | null {
    return this.liveBackendIds.get(agentId) ?? null;
  }
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
  private emitTrace(rec: ManagerTraceRecord): void {
    if (!this.opts.onFsmTransition) return;
    try {
      this.opts.onFsmTransition(rec);
    } catch {
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
    owner.activeSpan = null;
    const timelineTurnOwner = owner.timelineTurnOwner;
    owner.timelineTurnOwner = null;
    if (timelineTurnOwner) this.opts.timeline?.finalizeTurn(owner.agentId, timelineTurnOwner);
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
    const previousState = this.state;
    const { state, effects } = reduceManager(this.state, event);
    this.state = state;
    const eventAgentId = (event as { agentId?: string }).agentId;
    const closingOwner =
      event.type === "turn_completed" && eventAgentId && state !== previousState
        ? this.traceOwnerFor(eventAgentId, capturedOwner)
        : undefined;
    const closingSpan = closingOwner?.activeSpan ?? null;
    if (this.opts.onFsmTransition) {
      const emit = (agentId: string): void => {
        const a = this.state.agents[agentId];
        if (!a) return;
        const nowMs = this.now();
        const diagnostics = this.traceDiagnostics(agentId, capturedOwner);
        const activeSpan = this.traceOwnerFor(agentId, capturedOwner)?.activeSpan ?? null;
        const myEffects = effects.filter((e) => (e as { agentId?: string }).agentId === agentId).map((e) => e.type);
        this.emitTrace({
          recordKind: "fsm",
          agentId,
          event: event.type === "turn_work"
            ? "root_work"
            : event.type === "turn_completed"
              ? "turn_end"
              : event.type,
          status: a.status,
          turnId: a.turnId,
          turnActive: a.turnActive,
          inbox: a.inbox.length,
          lastDeliverAt: a.lastDeliverAt,
          lastProgressAt: a.lastProgressAt,
          lastNativeActivityAt: a.lastNativeActivityAt,
          lastNativeActivityKind: a.lastNativeActivityKind,
          runtimePhase: a.runtimePhase,
          backendTurnId: a.backendTurnId,
          turnSilenceBudgetMs: a.turnSilence.normalBudgetMs,
          nativeDeadlineAt:
            a.execution.lease.state === "active" || a.execution.lease.state === "suspect_active"
              ? a.execution.lease.nativeDeadlineAt
              : null,
          recoveryExtensionsUsed:
            a.execution.lease.state === "active" || a.execution.lease.state === "suspect_active"
              ? a.execution.lease.recoveryExtensionsUsed
              : 0,
          idleSince: a.idleSince,
          resetting: a.resetting,
          resettingSince: a.resettingSince,
          stoppingSince: a.stoppingSince,
          ...diagnostics,
          effects: myEffects,
          nowMs,
          timeIso: new Date(nowMs).toISOString(),
          ...(activeSpan ? activeSpan : {}),
          sinceProgressMs: nowMs - a.lastProgressAt,
          sinceNativeActivityMs: nowMs - a.lastNativeActivityAt,
          sinceDeliverMs: a.lastDeliverAt === null ? null : nowMs - a.lastDeliverAt,
          sinceStoppingMs: a.stoppingSince === null ? null : nowMs - a.stoppingSince,
          ...(event.type === "turn_completed" && (event as { endReason?: "errored" }).endReason === "errored"
            ? {
                endReason: "errored" as const,
                terminationCause: normalizeTerminationCause(
                  (event as { terminationCause?: unknown }).terminationCause,
                ),
              }
            : {}),
          ...(event.type === "exit"
            ? {
                exitCode: (event as { exitCode?: number | null }).exitCode ?? null,
                exitSignal: (event as { exitSignal?: string | null }).exitSignal ?? null,
                abnormal: (event as { abnormal?: boolean }).abnormal ?? false,
                ...((event as { spawnFailureReason?: string | null }).spawnFailureReason != null
                  ? {
                      spawnFailureReason: normalizeSpawnFailureReason(
                        (event as { spawnFailureReason?: unknown }).spawnFailureReason,
                      ),
                    }
                  : {}),
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
        emit(eventAgentId);
      } else if (event.type === "tick") {
        for (const id of Object.keys(this.state.agents)) emit(id);
      }
    }
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
    if (
      this.opts.onAgentActivity
      && event.type !== "admission_started"
      && event.type !== "admission_settled"
    ) {
      const after = this.deriveActivitySnapshot(state);
      for (const [agentId, activity] of Object.entries(after)) {
        if (!(agentId in before)) {
          this.publishedAgentActivity.set(agentId, activity);
          continue;
        }
        const previouslyPublished = this.publishedAgentActivity.get(agentId) ?? before[agentId];
        const publishable = event.type !== "spawned" || activity === "running";
        if (publishable && previouslyPublished !== activity) {
          this.opts.onAgentActivity({ agentId, state: activity });
          this.publishedAgentActivity.set(agentId, activity);
        }
      }
    }
    for (const effect of effects) this.applyEffect(effect);
    return effects;
  }
  private deriveActivitySnapshot(state: ManagerState): Record<string, AgentActivityState> {
    const snapshot: Record<string, AgentActivityState> = {};
    for (const [agentId, agent] of Object.entries(state.agents)) snapshot[agentId] = this.deriveActivity(agent);
    return snapshot;
  }
  private deriveActivity(agent: AgentState): AgentActivityState {
    if (agent.status === "running") return isActivelyWorking(agent) ? "running" : "idle";
    return agent.status;
  }
  private traceDiagnostics(agentId: string, capturedOwner?: ActiveSpawnState): Pick<
    FsmTraceRecord,
    | "deliveryPhase"
    | "physicalOpenCount"
    | "turnCount"
    | "commandAdmissionCount"
    | "commandAdmissionLatencyTotalMs"
    | "queueDwellCount"
    | "queueDwellTotalMs"
    | "sseReconnectCount"
    | "resumeOutcome"
    | "terminalOwnerKind"
  > {
    const owner = this.traceOwnerFor(agentId, capturedOwner);
    const snapshot = owner?.session?.snapshot();
    const pending = owner
      ? [...owner.pendingDeliverySpans.values()].find((delivery) => !delivery.driverObserved)
      : undefined;
    const snapshotDiagnostics = snapshot?.diagnostics;
    const deliveryPhase = pending
      ? pending.mode === "idle" ? "admission_wait" : "steering"
      : snapshotDiagnostics?.deliveryPhase ?? "idle";
    if (!snapshotDiagnostics) return { deliveryPhase };
    return { deliveryPhase, ...snapshotDiagnostics.metrics };
  }
  private withFooter(text: string): string {
    return this.opts.wakePromptFooter ? `${text}\n\n${this.opts.wakePromptFooter}` : text;
  }
  private stampNow(text: string): string {
    return this.opts.stampWakePromptTime ? `[${nowLocalISO()}] ${text}` : text;
  }
  private beginPendingDelivery(
    owner: ActiveSpawnState,
    commandId: string,
    message: AgentMsg,
    mode: "busy" | "idle",
    span: ActiveTurnSpan | null,
    requeueOnFailure = true,
  ): boolean {
    const sessionInstanceId = owner.sessionInstanceId;
    if (!sessionInstanceId || owner.pendingDeliverySpans.has(commandId)) return false;
    owner.pendingDeliverySpans.set(commandId, {
      sessionInstanceId,
      span,
      mode,
      driverObserved: false,
    });
    this.dispatch({
      type: "admission_started",
      agentId: owner.agentId,
      sessionInstanceId,
      commandId,
      exactAgentMsg: message,
      mode,
      requeueOnFailure,
      nowMs: this.now(),
    }, owner);
    return true;
  }
  private markPendingDeliveryObserved(owner: ActiveSpawnState, commandId: string): void {
    const pending = owner.pendingDeliverySpans.get(commandId);
    if (pending) pending.driverObserved = true;
  }
  private acknowledgePendingDelivery(owner: ActiveSpawnState, commandId: string): void {
    const pending = owner.pendingDeliverySpans.get(commandId);
    if (!pending) return;
    this.dispatch({
      type: "admission_acknowledged",
      agentId: owner.agentId,
      sessionInstanceId: pending.sessionInstanceId,
      commandId,
    }, owner);
  }
  private settlePendingDelivery(
    owner: ActiveSpawnState,
    commandId: string,
    outcome: "accepted" | "failed" = "failed",
  ): PendingDeliveryTrace | undefined {
    const pending = owner.pendingDeliverySpans.get(commandId);
    if (!pending) return undefined;
    owner.pendingDeliverySpans.delete(commandId);
    this.dispatch({
      type: "admission_settled",
      agentId: owner.agentId,
      sessionInstanceId: pending.sessionInstanceId,
      commandId,
      outcome,
    }, owner);
    return pending;
  }
  private applyEffect(effect: ManagerEffect): void {
    switch (effect.type) {
      case "spawn":
        this.doSpawn(effect.agentId, effect.messages, effect.resumeSessionId);
        break;
      case "send": {
        const session = this.sessions.get(effect.agentId);
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
          if (exactOwner) this.beginPendingDelivery(exactOwner, input.id, effect.message, effect.mode, associatedSpan);
          let sent: ReturnType<DaemonAgentSession["send"]>;
          try {
            sent = session.send(input);
            if (exactOwner) this.markPendingDeliveryObserved(exactOwner, input.id);
          } catch (error) {
            if (exactOwner) {
              this.settlePendingDelivery(exactOwner, input.id);
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
              if (!exactOwner.pendingDeliverySpans.has(input.id)) return;
              this.settlePendingDelivery(exactOwner, input.id);
              this.closeTurn(exactOwner, associatedSpan, {
                event: "turn_abort",
                abortCause: "send_threw",
              });
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
            if (!exactOwner.pendingDeliverySpans.has(input.id)) return;
            this.settlePendingDelivery(exactOwner, input.id);
            this.closeTurn(exactOwner, associatedSpan, {
              event: "turn_abort",
              abortCause: "send_threw",
            });
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
        const endedSessionId = this.liveSessions.get(effect.agentId) ?? "";
        if (effect.type === "terminate_stalled" && effect.recordSessionId) {
          const persisted = this.opts.timeline?.recordSessionStall?.(effect.agentId, effect.recordSessionId);
          if (persisted === false) {
            this.dispatch({
              type: "stall_control_failed",
              agentId: effect.agentId,
              sessionId: effect.recordSessionId,
              transition: "attempt",
            });
            this.log.error("stall recovery attempt was not persisted; termination deferred", {
              agentId: effect.agentId,
              sessionId: effect.recordSessionId,
            });
            this.emitErrorAudit(
              effect.agentId,
              "runtime",
              "resume_control_update_failed",
              "Stall termination deferred because the recovery attempt could not be persisted",
            );
            break;
          }
        }
        if (effect.type === "terminate_stalled" && effect.forgetSessionId) {
          const persisted = this.forgetSessionSources(effect.agentId, "stall_recovery", effect.forgetSessionId);
          if (!persisted) {
            this.dispatch({
              type: "stall_control_failed",
              agentId: effect.agentId,
              sessionId: effect.forgetSessionId,
              transition: "fence",
            });
            this.log.error("repeated-session fence was not persisted; termination deferred", {
              agentId: effect.agentId,
              sessionId: effect.forgetSessionId,
            });
            this.emitErrorAudit(
              effect.agentId,
              "runtime",
              "resume_control_update_failed",
              "Stall termination deferred because the exact session fence could not be persisted",
            );
            break;
          }
          if (spawnState) spawnState.discardEvents = true;
          this.log.warn("repeatedly stalled backend session fenced", {
            agentId: effect.agentId,
            sessionId: effect.forgetSessionId,
          });
        }
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
        if (spawnState) spawnState.suppressExitLog = true;
        if (effect.type === "terminate_stalled") {
          this.nonCleanEndMarker.set(effect.agentId, { cause: "killed_stalled" });
        }
        if (spawnState) {
          spawnState.terminationSemantics = effect.type === "terminate_stalled" ? "killed_stalled" : "idle_stop";
        }
        this.logSessionEnded(
          effect.agentId,
          effect.type === "stop" ? "stopped" : "terminate_stalled",
          endedSessionId,
        );
        this.opts.onAgentLocallyStopped?.({ agentId: effect.agentId, reason: effect.type });
        break;
      }
      case "clear_stall_recovery": {
        const persisted = this.opts.timeline?.clearSessionStall?.(effect.agentId, effect.sessionId);
        if (persisted === false) {
          this.dispatch({
            type: "stall_control_failed",
            agentId: effect.agentId,
            sessionId: effect.sessionId,
            transition: "clear",
          });
          this.log.error("stall recovery clear was not persisted; allowance remains consumed", {
            agentId: effect.agentId,
            sessionId: effect.sessionId,
          });
          this.emitErrorAudit(
            effect.agentId,
            "runtime",
            "resume_control_update_failed",
            "Stall recovery allowance remains consumed because its clear could not be persisted",
          );
        }
        break;
      }
      case "expire_admission": {
        const owner = this.activeSpawnState.get(effect.agentId);
        if (!owner || owner.sessionInstanceId !== effect.sessionInstanceId) break;
        for (const commandId of effect.commandIds) {
          owner.pendingDeliverySpans.delete(commandId);
        }
        this.closeTurn(owner, owner.activeSpan, { event: "turn_abort", abortCause: "send_threw" });
        owner.terminationSemantics = "killed_stalled";
        void owner.session?.stop({ reason: "stalled", forceAfterMs: SESSION_STOP_GRACE_MS });
        this.logSessionEnded(effect.agentId, "terminate_stalled");
        this.opts.onAgentLocallyStopped?.({ agentId: effect.agentId, reason: "terminate_stalled" });
        break;
      }
      case "requeue_delivery":
        this.dispatch({
          type: "delivery_rejected",
          agentId: effect.agentId,
          message: effect.message,
          mode: effect.mode,
        });
        break;
      case "reset_idle_session": {
        const spawnState = this.activeSpawnState.get(effect.agentId);
        const completion = {
          eventId: `bae_${randomUUID()}`,
          occurredAt: new Date(this.now()).toISOString(),
        };
        const persisted = this.forgetSession(
          effect.agentId,
          "reset_session",
          effect.sessionId,
          completion,
        );
        if (!persisted) {
          this.log.error("idle session reset barrier was not persisted; reset deferred", {
            agentId: effect.agentId,
            sessionId: effect.sessionId,
          });
          this.emitErrorAudit(
            effect.agentId,
            "reset",
            "resume_control_update_failed",
            "Idle session reset deferred because resume control could not be persisted",
          );
          break;
        }
        if (spawnState) spawnState.discardEvents = true;
        this.dispatch({ type: "idle_reset_committed", agentId: effect.agentId, nowMs: this.now() });
        if (this.opts.onBotAuditEvent) {
          try {
            this.opts.onBotAuditEvent(effect.agentId, {
              kind: "session_reset",
              payload: { trigger: "idle_timeout" },
            }, {
              sessionId: null,
              launchId: null,
              ...completion,
            });
          } catch (err) {
            this.log.debug("audit emit failed (idle session reset)", {
              agentId: effect.agentId,
              err: String(err),
            });
          }
        }
        this.log.info("idle agent session reset", {
          agentId: effect.agentId,
          sessionId: effect.sessionId,
        });
        break;
      }
      case "force_exit": {
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
        if (state) state.torndown = true;
        this.logSessionEnded(effect.agentId, "terminate_stalled");
        if (this.sessions.get(effect.agentId) === session) this.sessions.delete(effect.agentId);
        this.liveSessions.delete(effect.agentId);
        if (this.activeSpawnState.get(effect.agentId) === state) this.activeSpawnState.delete(effect.agentId);
        this.nonCleanEndMarker.delete(effect.agentId);
        this.opts.onAgentLocallyStopped?.({ agentId: effect.agentId, reason: "terminate_stalled" });
        this.dispatch({ type: "exit", agentId: effect.agentId, terminationSemantics: "force_exit" });
        break;
      }
    }
  }
  private logSessionEnded(
    agentId: string,
    reason: "turn_end" | "stopped" | "terminate_stalled" | "exit",
    sessionId = this.liveSessions.get(agentId) ?? "",
  ): void {
    this.log.info("agent session ended", { agentId, sessionId, reason });
  }
  private doSpawn(agentId: string, messages: AgentMsg[], resumeSessionId: string | null): void {
    const [first, ...pending] = messages;
    if (!first) throw new Error(`AgentProcessManager: spawn for ${agentId} has no command`);
    const prompt = this.withFooter(first.text);
    const driver = this.opts.driverFor(agentId, this.runtimeConfigs.get(agentId));
    this.liveBackendIds.set(agentId, driver.id);
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
    const timelineResolution = this.opts.timeline?.resolveResumeSession?.(agentId, provider);
    const timelineSessionId = timelineResolution?.kind === "session"
      ? timelineResolution.sessionId
      : timelineResolution === undefined
        ? this.opts.timeline?.resumeSessionId(agentId, provider)
        : null;
    const candidateSessionId =
      resumeSessionId ??
      this.resumeSessions.get(agentId) ??
      timelineSessionId ??
      base.config?.sessionId;
    const blockedByBarrier = timelineResolution?.kind === "barrier"
      && (
        timelineResolution.type !== "stall_recovery"
        || timelineResolution.forgottenSessionId === null
        || timelineResolution.forgottenSessionId === candidateSessionId
      );
    const blockedByExactFence = candidateSessionId !== undefined
      && timelineResolution?.fencedSessionId === candidateSessionId;
    const sessionId = blockedByBarrier || blockedByExactFence ? undefined : candidateSessionId;
    const stalledSessionIdAtLaunch = timelineResolution !== undefined
      && (timelineResolution.kind === "session" || timelineResolution.kind === "none")
      && timelineResolution.stalledSessionId === sessionId
      ? timelineResolution.stalledSessionId
      : null;
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
      sessionInstanceId: null,
      hasEstablished: false,
      hasReportedSpawnFailure: false,
      suppressExitLog: false,
      handshakeTimer: null,
      torndown: false,
      superseded: false,
      discardEvents: false,
      stalledSessionIdAtLaunch,
      spawnFailureReason: null,
      terminationSemantics: null,
      spawnOrdinal: this.nextSpawnOrdinal++,
      launchIdSnapshot: typeof ctx.launchId === "string" && ctx.launchId.length > 0 ? ctx.launchId : null,
      nextTurnOrdinal: 1,
      activeSpan: null,
      timelineTurnOwner: null,
      pendingDeliverySpans: new Map(),
    };
    const previousOwner = this.activeSpawnState.get(agentId);
    if (previousOwner && previousOwner !== state) {
      previousOwner.superseded = true;
    }
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
      const requested = "requested" in result && result.requested === true;
      const abnormal = !requested && (exitSignal !== null || (exitCode !== null && exitCode !== 0));
      if (state.hasEstablished && !state.suppressExitLog) {
        this.logSessionEnded(agentId, "exit");
        if (abnormal) {
          const detail = exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`;
          this.emitErrorAudit(agentId, "exit", "abnormal_exit", `Session ended unexpectedly (${detail})`);
        }
      }
      if (state.sessionInstanceId) {
        this.dispatch({ type: "session_closed", agentId, sessionInstanceId: state.sessionInstanceId }, state);
      }
      state.pendingDeliverySpans.clear();
      if (state.session && this.sessions.get(agentId) === state.session) this.sessions.delete(agentId);
      this.liveSessions.delete(agentId);
      if (this.activeSpawnState.get(agentId) === state) this.liveBackendIds.delete(agentId);
      if (this.activeSpawnState.get(agentId) === state) {
        this.appliedRuntimeConfigs.delete(agentId);
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
      if (state.discardEvents) {
        this.log.warn("ignored event from discarded backend session owner", { agentId, event: event.type });
        return;
      }
      if (event.type === "session_failed" && !state.hasEstablished) {
        reportSpawnFailure(event.error.code || "failed_to_start", { message: event.error.message });
      }
      if (event.type === "session_started") {
        const persisted = this.opts.timeline?.setSession(
          agentId,
          event.backendSessionId,
          event.sessionInstanceId,
        );
        if (persisted === false) {
          state.discardEvents = true;
          reportSpawnFailure("resume_control_update_failed", {
            message: "Backend session rejected because resume control could not be persisted",
          });
          void state.session?.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
          return;
        }
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
      state.sessionInstanceId = session.sessionInstanceId;
      this.sessions.set(agentId, session);
      this.appliedRuntimeConfigs.set(agentId, runtimeConfig);
      if (
        (this.pendingRuntimeConfigUpdates.get(agentId)?.runtimeConfigRevision ?? -1)
        <= (runtimeConfig.runtimeConfigRevision ?? 0)
      ) {
        this.pendingRuntimeConfigUpdates.delete(agentId);
      }
      this.dispatch({
        type: "attach_session",
        agentId,
        sessionInstanceId: session.sessionInstanceId,
        nowMs: this.now(),
        turnSilence: session.snapshot().diagnostics?.turnSilence,
      }, state);
      previousOwner?.pendingDeliverySpans.clear();
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
      this.beginPendingDelivery(state, commandId, first, "idle", startedSpan, false);
      let startResult: Promise<DeliveryReceipt>;
      try {
        startResult = session.start({
          id: commandId,
          kind: "user",
          text: this.stampNow(prompt),
          sequence: first.seq,
        });
        this.markPendingDeliveryObserved(state, commandId);
      } catch (error) {
        this.settlePendingDelivery(state, commandId);
        this.closeTurn(state, startedSpan, { event: "turn_abort", abortCause: "start_threw" });
        throw error;
      }
      void startResult.then((receipt) => {
        if (this.sessions.get(agentId) !== session || state.torndown) return;
        if (receipt?.status === "rejected") {
          this.settlePendingDelivery(state, commandId);
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
            this.beginPendingDelivery(state, message.id!, message, "busy", state.activeSpan);
            let queuedReceipt: DeliveryReceipt;
            try {
              const queuedResult = session.send({
                id: message.id!,
                kind: "user",
                text: this.stampNow(this.withFooter(message.text)),
                sequence: message.seq,
              });
              this.markPendingDeliveryObserved(state, message.id!);
              queuedReceipt = await queuedResult;
            } catch (error) {
              this.settlePendingDelivery(state, message.id!);
              if (!state.torndown && this.sessions.get(agentId) === session && this.activeSpawnState.get(agentId) === state) {
                this.emitErrorAudit(agentId, "runtime", "send_failed", String(error));
                void session.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
              }
              return;
            }
            if (state.torndown || this.sessions.get(agentId) !== session || this.activeSpawnState.get(agentId) !== state) {
              return;
            }
            if (queuedReceipt.status === "rejected") {
              if (!state.pendingDeliverySpans.has(message.id!)) return;
              this.settlePendingDelivery(state, message.id!);
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
      if (this.activeSpawnState.get(agentId) === state) this.activeSpawnState.delete(agentId);
      throw error;
    }
    if (created && typeof (created as Promise<DaemonAgentSession>).then === "function") {
      void Promise.resolve(created).then(attach, failedOpen);
    } else {
      try {
        attach(created as DaemonAgentSession);
      } catch (error) {
        failedOpen(error);
      }
    }
  }
  private currentModelFor(agentId: string): string | null {
    return runtimeModelName(this.runtimeConfigs.get(agentId)) ?? null;
  }
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
  private onAgentEvent(
    agentId: string,
    event: ManagedEvent,
    runtimeId: BuiltinBackendId,
    owner: ActiveSpawnState,
  ): void {
    if (event.type === "session_closed") return;
    if (!owner.sessionInstanceId || event.sessionInstanceId !== owner.sessionInstanceId) {
      this.log.warn("ignored event from stale session epoch", {
        agentId,
        event: event.type,
        expectedSessionInstanceId: owner.sessionInstanceId,
      });
      return;
    }
    if (
      owner.superseded
      && this.state.agents[agentId]?.execution.sessionInstanceId !== owner.sessionInstanceId
    ) {
      this.log.warn("ignored event from superseded session owner", { agentId, event: event.type });
      return;
    }
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
      if (event.type === "assistant_reasoning_completed" && event.text.length > 0) {
        const { text, truncated, chars } = truncateThinking(event.text);
        try {
          this.opts.onBotAuditEvent(agentId, {
            kind: "thinking",
            payload: { text, truncated: truncated || event.truncated, chars },
          }, {
            sessionId: this.liveSessions.get(agentId) ?? null,
            launchId: this.launchIds.get(agentId) ?? null,
          });
        } catch (err) {
          this.log.debug("audit emit failed (thinking)", { agentId, err: String(err) });
        }
      }
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
    if (event.type === "session_started") {
      this.dispatch({
        type: "backend_session",
        agentId,
        sessionId: event.backendSessionId,
        stalledBefore: owner.stalledSessionIdAtLaunch === event.backendSessionId,
      }, owner);
      this.liveSessions.set(agentId, event.backendSessionId);
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
    if (event.type === "token_usage") {
      this.opts.onTokenUsage?.({ agentId, backendId: runtimeId, usage: event.usage });
    }
    if (event.type === "rate_limits") {
      this.opts.onProviderQuota?.({ agentId, backendId: runtimeId, quota: event.quota });
    }
    if (event.type === "turn_started") {
      const timelineTurnOwner: TimelineTurnOwner = {
        sessionInstanceId: event.sessionInstanceId,
        rootTurnId: event.turnId,
        barrierGeneration: this.opts.timeline?.barrierGeneration(agentId) ?? 0,
      };
      owner.timelineTurnOwner = timelineTurnOwner;
      this.opts.timeline?.beginTurn(agentId, timelineTurnOwner);
    }
    if (event.type === "assistant_message_completed" && event.text.length > 0) {
      const timelineTurnOwner = owner.timelineTurnOwner;
      if (
        timelineTurnOwner
        && timelineTurnOwner.sessionInstanceId === event.sessionInstanceId
        && timelineTurnOwner.rootTurnId === event.turnId
      ) {
        this.opts.timeline?.recordAssistantMessage(
          agentId,
          timelineTurnOwner,
          event.text,
          event.truncated,
        );
      }
    }
    if (event.type === "command_queued") this.acknowledgePendingDelivery(owner, event.commandId);
    if (event.type === "command_accepted") this.settlePendingDelivery(owner, event.commandId, "accepted");
    if (event.type === "command_failed") {
      const pending = this.settlePendingDelivery(owner, event.commandId);
      if (pending && !sessionSuperseded && this.state.agents[agentId]?.status === "running") {
        this.closeTurn(owner, pending.span, { event: "turn_abort", abortCause: "send_threw" });
        this.emitErrorAudit(agentId, "runtime", event.error.code, event.error.message);
        void owner.session?.stop({ reason: "shutdown", forceAfterMs: SESSION_STOP_GRACE_MS });
      }
    }
    const rootWork = (() => {
      switch (event.type) {
        case "turn_started":
          return { type: "turn_started" as const, turnId: event.turnId, commandIds: event.commandIds };
        case "work_heartbeat":
        case "assistant_reasoning_completed":
        case "assistant_message_completed":
          return { type: "turn_work" as const, turnId: event.turnId };
        case "tool_started":
          return { type: "turn_tool_started" as const, turnId: event.turnId };
        case "tool_finished":
          return { type: "turn_tool_finished" as const, turnId: event.turnId };
        case "compaction_started":
        case "compaction_finished":
        case "review_started":
        case "review_finished":
          return { type: "turn_work" as const, turnId: event.turnId };
        case "internal_progress":
          return event.turnId ? { type: "turn_work" as const, turnId: event.turnId } : null;
        default:
          return null;
      }
    })();
    if (rootWork) {
      const wasActive = this.state.agents[agentId]?.turnActive === true;
      this.dispatch({
        ...rootWork,
        agentId,
        sessionInstanceId: event.sessionInstanceId,
        nowMs: this.now(),
      }, owner);
      if (!wasActive && this.state.agents[agentId]?.turnActive && !owner.activeSpan) this.openTurn(owner);
    }
    const nativeSignal = (() => {
      switch (event.type) {
        case "turn_started":
          return { kind: "turn_started" as const, phase: "inference" as const, turnId: event.turnId };
        case "backend_turn_started":
          return {
            kind: "backend_turn_started" as const,
            phase: "inference" as const,
            turnId: event.turnId,
            backendTurnId: event.backendTurnId,
          };
        case "assistant_reasoning_completed":
          return { kind: "thinking" as const, phase: "inference" as const, turnId: event.turnId };
        case "assistant_message_completed":
          return { kind: "text" as const, phase: "inference" as const, turnId: event.turnId };
        case "work_heartbeat":
          return { kind: "internal_progress" as const, phase: "inference" as const, turnId: event.turnId };
        case "tool_started":
          return { kind: "tool_call" as const, phase: "tool" as const, turnId: event.turnId };
        case "tool_finished":
          return { kind: "tool_output" as const, phase: "inference" as const, turnId: event.turnId };
        case "compaction_started":
        case "compaction_finished":
        case "review_started":
        case "review_finished":
        case "internal_progress":
          return event.turnId
            ? { kind: "internal_progress" as const, phase: "inference" as const, turnId: event.turnId }
            : null;
        case "recovery":
          return event.turnId
            ? {
                kind: "recovery" as const,
                phase: event.stage === "retrying" ? "recovery" as const : "inference" as const,
                recoveryStage: event.stage,
                turnId: event.turnId,
              }
            : null;
        case "turn_completed":
          return { kind: "turn_end" as const, phase: "terminal" as const, turnId: event.turnId };
        default:
          return null;
      }
    })();
    if (nativeSignal) {
      this.dispatch({
        type: "runtime_signal",
        agentId,
        sessionInstanceId: event.sessionInstanceId,
        ...nativeSignal,
        nowMs: this.now(),
      }, owner);
    }
    if (event.type === "turn_completed") {
      this.logSessionEnded(agentId, "turn_end");
      const marker = this.nonCleanEndMarker.get(agentId);
      this.nonCleanEndMarker.delete(agentId);
      const completionEvent: Extract<ManagerEvent, { type: "turn_completed" }> = marker !== undefined
        ? {
            type: "turn_completed",
            agentId,
            sessionInstanceId: event.sessionInstanceId,
            nowMs: this.now(),
            turnId: event.turnId,
            endReason: "errored",
            terminationCause: marker.cause,
            errorDetail: marker.detail,
          }
        : {
            type: "turn_completed",
            agentId,
            sessionInstanceId: event.sessionInstanceId,
            nowMs: this.now(),
            turnId: event.turnId,
          };
      if (this.pendingRuntimeConfigUpdates.has(agentId) && this.sessions.get(agentId) === owner.session) {
        void this.convergeRuntimeConfig(agentId, false).then((result) => {
          if (result === "saved_for_start" && owner.session) this.markResetting(agentId);
          this.dispatch(completionEvent, owner);
          if (result === "saved_for_start" && owner.session) {
            void this.restartForRuntimeConfig(agentId, owner.session);
          }
        }).catch((error) => {
          this.log.error("runtime config convergence failed", { agentId, error: String(error) });
          if (owner.session) this.markResetting(agentId);
          this.dispatch(completionEvent, owner);
          if (owner.session) void this.restartForRuntimeConfig(agentId, owner.session);
        });
        return;
      }
      this.dispatch(completionEvent, owner);
    }
  }
}

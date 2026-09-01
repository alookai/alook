import type { LogLevel } from "../logger.js";
import { scrubAgentDriverDiagnosticText } from "@alook/agent-driver/host";

type FieldRule =
  | { type: "string"; maxChars: number; values?: readonly string[]; scrub?: true; nullable?: true }
  | { type: "number"; integer: true; min: number; max: number }
  | { type: "boolean" }
  | { type: "string_array"; maxItems: number; maxChars: number; values?: readonly string[] };

export interface DaemonLogPolicyEntry {
  header: string;
  message: string;
  scope: "machine" | "target";
  fields: Readonly<Record<string, FieldRule>>;
}

const string = (maxChars: number, options: Omit<Extract<FieldRule, { type: "string" }>, "type" | "maxChars"> = {}): FieldRule =>
  ({ type: "string", maxChars, ...options });
const integer = (min: number, max: number): FieldRule => ({ type: "number", integer: true, min, max });
const stringArray = (maxItems: number, maxChars: number): FieldRule => ({ type: "string_array", maxItems, maxChars });
const AGENT = string(128);
const RUNTIME = string(64);
const ACK_CODES = ["bot_unknown", "bot_enroll_failed", "bot_runtime_missing", "internal_error"] as const;

export const DAEMON_LOG_DIAGNOSTIC_POLICY: readonly DaemonLogPolicyEntry[] = [
  { header: "@alook/daemon", message: "daemon startup", scope: "machine", fields: {
    machineId: string(128), version: string(128), healthyRuntimeIds: stringArray(128, 64), unhealthyRuntimeIds: stringArray(128, 64),
  } },
  { header: "@alook/daemon", message: "daemon up", scope: "machine", fields: {
    proxyProtocol: string(16, { values: ["http", "https", "unknown"] }),
    controlProtocol: string(16, { values: ["ws", "wss", "unknown"] }),
  } },
  { header: "@alook/daemon", message: "control plane OPEN", scope: "machine", fields: {} },
  { header: "@alook/daemon", message: "shutting down…", scope: "machine", fields: {} },
  { header: "@alook/daemon", message: "daemon teardown failed", scope: "machine", fields: { errorClass: string(64) } },
  { header: "@alook/daemon", message: "daemon ownership release failed", scope: "machine", fields: { errorClass: string(64) } },
  { header: "@alook/daemon", message: "uncaught exception", scope: "machine", fields: { errorClass: string(64) } },
  { header: "@alook/daemon", message: "unhandled rejection", scope: "machine", fields: { errorClass: string(64) } },
  { header: "@alook/daemon", message: "daemon runner initialization failed", scope: "machine", fields: { errorClass: string(64) } },
  { header: "@alook/daemon:ws", message: "control channel open", scope: "machine", fields: { attempt: integer(0, 1_000_000) } },
  { header: "@alook/daemon:ws", message: "resync sent", scope: "machine", fields: {
    ready: integer(0, 1_000_000), sessions: integer(0, 1_000_000), activities: integer(0, 1_000_000),
  } },
  { header: "@alook/daemon:ws", message: "control channel closed", scope: "machine", fields: { code: integer(0, 65_535) } },
  { header: "@alook/daemon:ws", message: "reconnecting", scope: "machine", fields: {
    attempt: integer(0, 1_000_000), delayMs: integer(0, 3_600_000),
  } },
  { header: "@alook/daemon:ws", message: "heartbeat pong timeout — forcing reconnect", scope: "machine", fields: {} },
  { header: "@alook/daemon:manager", message: "spawning agent", scope: "target", fields: {
    agentId: AGENT, runtime: RUNTIME, model: string(256, { scrub: true }),
  } },
  { header: "@alook/daemon:manager", message: "spawn failed", scope: "target", fields: {
    agentId: AGENT, runtime: RUNTIME, reason: string(64, { scrub: true }),
  } },
  { header: "@alook/daemon:manager", message: "runtime stderr", scope: "target", fields: {
    agentId: AGENT, runtime: RUNTIME, text: string(65_536, { scrub: true }),
  } },
  { header: "@alook/daemon:manager", message: "agent session established", scope: "target", fields: {
    agentId: AGENT, runtime: RUNTIME, sessionId: string(256, { scrub: true }),
  } },
  { header: "@alook/daemon:manager", message: "agent session ended", scope: "target", fields: {
    agentId: AGENT,
    reason: string(32, { values: ["turn_end", "stopped", "terminate_stalled", "exit"] }),
    sessionId: string(256, { scrub: true }),
  } },
  { header: "@alook/daemon:manager", message: "steering message sent to running agent", scope: "target", fields: {
    agentId: AGENT, mode: string(8, { values: ["busy", "idle"] }),
  } },
  { header: "@alook/daemon:manager", message: "gated busy message held", scope: "target", fields: {
    agentId: AGENT,
    reason: string(32, { values: ["mid_turn_wake", "tool_batch_complete", "compaction_finished", "review_finished"] }),
    blockedReason: string(32, { nullable: true, values: [
      "idle", "tool_wait", "tool_boundary", "assistant_continuation", "compacting", "reviewing", "error",
      "non_gated", "missing_session", "empty_inbox", "tool_boundary_flush_disabled", "outstanding_tool_uses",
    ] }),
  } },
  { header: "@alook/daemon:router", message: "agent:wake received", scope: "target", fields: { agentId: AGENT } },
  { header: "@alook/daemon:router", message: "agent:wake ack", scope: "target", fields: {
    agentId: AGENT, status: string(8, { values: ["ok", "error"] }), "error.code": string(32, { values: ACK_CODES }),
  } },
  { header: "@alook/daemon:router", message: "agent:stop received", scope: "target", fields: { agentId: AGENT } },
  { header: "@alook/daemon:router", message: "agent:stop ack", scope: "target", fields: {
    agentId: AGENT, status: string(8, { values: ["ok", "error"] }), "error.code": string(32, { values: ACK_CODES }),
  } },
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function canonicalTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeInteger(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function boundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

export function scrubDiagnosticText(value: string): string {
  let scrubbed = scrubAgentDriverDiagnosticText(value);
  const encoded = Buffer.from(scrubbed, "utf8");
  if (encoded.byteLength > 65_536) {
    let bytes = 0;
    const bounded: string[] = [];
    for (const codePoint of scrubbed) {
      const width = Buffer.byteLength(codePoint, "utf8");
      if (bytes + width > 65_536) break;
      bounded.push(codePoint);
      bytes += width;
    }
    scrubbed = bounded.join("");
  }
  return scrubbed;
}

function projectRule(value: unknown, rule: FieldRule): { ok: true; value: unknown } | { ok: false } {
  if (value === null && rule.type === "string" && rule.nullable) return { ok: true, value: null };
  switch (rule.type) {
    case "string":
      if (!boundedString(value, rule.maxChars) || (rule.values && !rule.values.includes(value))) return { ok: false };
      return { ok: true, value: rule.scrub ? scrubDiagnosticText(value) : value };
    case "number":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= rule.min && value <= rule.max
        ? { ok: true, value }
        : { ok: false };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false };
    case "string_array":
      if (!Array.isArray(value) || value.length > rule.maxItems) return { ok: false };
      if (!value.every((entry) => boundedString(entry, rule.maxChars) && (!rule.values || rule.values.includes(entry)))) return { ok: false };
      return { ok: true, value: [...value] };
  }
}

export function projectDaemonLogRow(value: unknown, targetAgentId: string): Record<string, unknown> | null {
  const row = object(value);
  if (!row || !canonicalTime(row.time) || !["debug", "info", "warn", "error"].includes(row.level as LogLevel)) return null;
  if (typeof row.header !== "string" || typeof row.message !== "string") return null;
  const policy = DAEMON_LOG_DIAGNOSTIC_POLICY.find((entry) => entry.header === row.header && entry.message === row.message);
  const fields = object(row.fields);
  if (!policy || !fields) return null;
  if (policy.scope === "target" && fields.agentId !== targetAgentId) return null;
  const projectedFields: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(policy.fields)) {
    if (!(key in fields) || fields[key] === undefined) continue;
    const projected = projectRule(fields[key], rule);
    if (!projected.ok) return null;
    projectedFields[key] = projected.value;
  }
  return {
    recordType: "daemon_log",
    timeMs: Date.parse(row.time),
    time: row.time,
    header: row.header,
    level: row.level,
    message: row.message,
    fields: projectedFields,
  };
}

const MANAGER_EVENTS = ["register", "wake", "spawned", "session", "root_work", "turn_end", "exit", "tick", "reset_session", "begin_reset", "rewake_after_reset", "runtime_signal", "stall_control_failed", "admission_started", "admission_settled"] as const;
const MANAGER_EFFECTS = ["spawn", "send", "stop", "terminate_stalled", "clear_stall_recovery", "force_exit", "gated_hold"] as const;
const AGENT_STATUSES = ["idle", "starting", "running", "stopping"] as const;
const DELIVERY_PHASES = ["idle", "admission_wait", "steering", "next_turn_queued", "compacting", "reviewing", "tool_wait", "working"] as const;
const RESUME_OUTCOMES = ["not_requested", "pending", "resumed", "reset_required", "failed"] as const;
const TERMINAL_OWNER_KINDS = ["transport_request", "vendor_message", "prompt_invocation", "lane_generation"] as const;
const TERMINATION_CAUSES = ["runtime_error", "killed_stalled", "other"] as const;
const SPAWN_FAILURE_REASONS = ["ENOENT", "handshake_timeout", "pre_handshake_exit", "spawn_threw", "other"] as const;
const TERMINATION_SEMANTICS = ["killed_stalled", "idle_stop", "force_exit", "other"] as const;
const ABORT_CAUSES = ["start_threw", "start_rejected", "send_threw", "spawn_failure", "handshake_timeout", "reset", "nap", "model_switch", "requested_stop", "shutdown", "physical_exit", "terminate_stalled", "force_exit", "other"] as const;
const NATIVE_ACTIVITY_KINDS = ["turn_started", "backend_turn_started", "thinking", "text", "tool_call", "tool_output", "internal_progress", "recovery", "turn_end"] as const;
const RUNTIME_PHASES = ["idle", "admission", "inference", "tool", "recovery", "terminal"] as const;
const EXIT_SIGNALS = new Set(["SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINFO", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGLOST", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "other"]);

function enumValue(value: unknown, values: readonly string[], bucket = false, maxChars = 64): string | null {
  if (!boundedString(value, maxChars)) return null;
  return values.includes(value) ? value : bucket ? "other" : null;
}

function copyInteger(row: Record<string, unknown>, output: Record<string, unknown>, key: string, options: { optional?: boolean; nullable?: boolean; min?: number } = {}): boolean {
  if (!(key in row) || row[key] === undefined) return options.optional === true;
  if (row[key] === null && options.nullable) { output[key] = null; return true; }
  if (!safeInteger(row[key], options.min ?? 0)) return false;
  output[key] = row[key];
  return true;
}

function copyFiniteNumber(row: Record<string, unknown>, output: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  output[key] = value;
  return true;
}

function copyString(row: Record<string, unknown>, output: Record<string, unknown>, key: string, maxChars: number, optional = false, nullable = false): boolean {
  if (!(key in row) || row[key] === undefined) return optional;
  if (row[key] === null && nullable) { output[key] = null; return true; }
  if (!boundedString(row[key], maxChars)) return false;
  output[key] = row[key];
  return true;
}

function copyScrubbedString(row: Record<string, unknown>, output: Record<string, unknown>, key: string, maxChars: number, optional = false, nullable = false): boolean {
  if (!copyString(row, output, key, maxChars, optional, nullable)) return false;
  if (typeof output[key] === "string") output[key] = scrubDiagnosticText(output[key] as string);
  return true;
}

function projectTraceBase(row: Record<string, unknown>, targetAgentId: string): Record<string, unknown> | null {
  if (row.agentId !== targetAgentId || !boundedString(row.agentId, 128) || !canonicalTime(row.timeIso)) return null;
  const output: Record<string, unknown> = { recordType: "fsm", recordKind: row.recordKind, agentId: row.agentId };
  if (!Array.isArray(row.effects) || row.effects.length > 32 || !row.effects.every((effect) => typeof effect === "string")) return null;
  output.effects = row.effects.filter((effect) => MANAGER_EFFECTS.includes(effect as typeof MANAGER_EFFECTS[number]));
  if (!copyInteger(row, output, "nowMs") || !copyString(row, output, "timeIso", 32)) return null;
  return output;
}

function projectOptionalSpanMetadata(row: Record<string, unknown>, output: Record<string, unknown>): boolean {
  return copyString(row, output, "traceTurnId", 1_024, true)
    && copyInteger(row, output, "daemonTurnOrdinal", { optional: true, min: 1 })
    && copyInteger(row, output, "spawnOrdinal", { optional: true, min: 1 })
    && copyInteger(row, output, "turnOrdinal", { optional: true, min: 1 })
    && copyString(row, output, "launchIdSnapshot", 1_024, true, true);
}

function projectFsm(row: Record<string, unknown>, targetAgentId: string): Record<string, unknown> | null {
  const output = projectTraceBase(row, targetAgentId);
  if (!output) return null;
  const event = enumValue(row.event, MANAGER_EVENTS);
  const status = enumValue(row.status, AGENT_STATUSES);
  const deliveryPhase = enumValue(row.deliveryPhase, DELIVERY_PHASES);
  if (!event || !status || !deliveryPhase || typeof row.turnActive !== "boolean" || typeof row.resetting !== "boolean") return null;
  Object.assign(output, { event, status, turnActive: row.turnActive });
  if (!copyInteger(row, output, "inbox")
    || !copyInteger(row, output, "lastDeliverAt", { nullable: true })
    || !copyInteger(row, output, "lastProgressAt")
    || !copyInteger(row, output, "idleSince", { nullable: true })) return null;
  if (!copyInteger(row, output, "lastNativeActivityAt", { optional: true })
    || !copyScrubbedString(row, output, "backendTurnId", 512, true, true)
    || !copyInteger(row, output, "turnSilenceBudgetMs", { optional: true })
    || !copyInteger(row, output, "nativeDeadlineAt", { optional: true, nullable: true })
    || !copyInteger(row, output, "recoveryExtensionsUsed", { optional: true })) return null;
  if ("lastNativeActivityKind" in row && row.lastNativeActivityKind !== undefined) {
    if (row.lastNativeActivityKind === null) output.lastNativeActivityKind = null;
    else {
      const kind = enumValue(row.lastNativeActivityKind, NATIVE_ACTIVITY_KINDS);
      if (!kind) return null;
      output.lastNativeActivityKind = kind;
    }
  }
  if ("runtimePhase" in row && row.runtimePhase !== undefined) {
    const phase = enumValue(row.runtimePhase, RUNTIME_PHASES);
    if (!phase) return null;
    output.runtimePhase = phase;
  }
  output.resetting = row.resetting;
  if (!copyInteger(row, output, "resettingSince", { nullable: true })
    || !copyInteger(row, output, "stoppingSince", { nullable: true })) return null;
  output.deliveryPhase = deliveryPhase;
  if (!copyInteger(row, output, "sinceProgressMs")
    || !copyInteger(row, output, "sinceNativeActivityMs", { optional: true })
    || !copyInteger(row, output, "sinceDeliverMs", { nullable: true })
    || !copyInteger(row, output, "sinceStoppingMs", { nullable: true })
    || !projectOptionalSpanMetadata(row, output)) return null;

  const metricKeys = [
    "physicalOpenCount",
    "turnCount",
    "commandAdmissionCount",
    "commandAdmissionLatencyTotalMs",
    "queueDwellCount",
    "queueDwellTotalMs",
    "sseReconnectCount",
  ] as const;
  const toolMetricKeys = [
    "outstandingToolUses",
    "anonymousOutstandingToolUses",
    "toolLifecycleMismatchCount",
  ] as const;
  const hasMetrics = metricKeys.some((key) => key in row || row[key] !== undefined)
    || toolMetricKeys.some((key) => key in row || row[key] !== undefined)
    || "resumeOutcome" in row
    || "terminalOwnerKind" in row;
  if (hasMetrics) {
    if (!metricKeys.every((key) => copyFiniteNumber(row, output, key))) return null;
    if (!toolMetricKeys.every((key) => copyInteger(row, output, key, { optional: true }))) return null;
    const resumeOutcome = enumValue(row.resumeOutcome, RESUME_OUTCOMES);
    const terminalOwnerKind = enumValue(row.terminalOwnerKind, TERMINAL_OWNER_KINDS);
    if (!resumeOutcome || !terminalOwnerKind) return null;
    output.resumeOutcome = resumeOutcome;
    output.terminalOwnerKind = terminalOwnerKind;
  }

  if ("endReason" in row && row.endReason !== undefined) {
    if (event !== "turn_end" || row.endReason !== "errored") return null;
    output.endReason = "errored";
  }
  if ("terminationCause" in row && row.terminationCause !== undefined) {
    if (event !== "turn_end") return null;
    const cause = enumValue(row.terminationCause, TERMINATION_CAUSES, true);
    if (!cause) return null;
    output.terminationCause = cause;
  }
  if ("exitCode" in row && row.exitCode !== undefined) {
    if (event !== "exit" || !copyInteger(row, output, "exitCode", { nullable: true, optional: true })) return null;
  }
  if ("exitSignal" in row && row.exitSignal !== undefined) {
    if (event !== "exit") return null;
    if (row.exitSignal === null) output.exitSignal = null;
    else if (!boundedString(row.exitSignal, 64)) return null;
    else output.exitSignal = EXIT_SIGNALS.has(row.exitSignal) ? row.exitSignal : "other";
  }
  if ("abnormal" in row && row.abnormal !== undefined) {
    if (event !== "exit") return null;
    if (typeof row.abnormal !== "boolean") return null;
    output.abnormal = row.abnormal;
  }
  for (const [key, values] of [["spawnFailureReason", SPAWN_FAILURE_REASONS], ["terminationSemantics", TERMINATION_SEMANTICS]] as const) {
    if (!(key in row) || row[key] === undefined) continue;
    if (event !== "exit") return null;
    const projected = enumValue(row[key], values, true);
    if (!projected) return null;
    output[key] = projected;
  }
  return output;
}

function projectTurnSpan(row: Record<string, unknown>, targetAgentId: string): Record<string, unknown> | null {
  const output = projectTraceBase(row, targetAgentId);
  if (!output) return null;
  const event = enumValue(row.event, ["turn_begin", "turn_end", "turn_abort"]);
  if (!event || !copyString(row, output, "traceTurnId", 1_024)
    || !copyInteger(row, output, "daemonTurnOrdinal", { min: 1 })
    || !copyInteger(row, output, "spawnOrdinal", { min: 1 })
    || !copyInteger(row, output, "turnOrdinal", { min: 1 })
    || !copyString(row, output, "launchIdSnapshot", 1_024, false, true)) return null;
  output.event = event;
  if (event === "turn_end") {
    const outcome = enumValue(row.outcome, ["clean", "errored"]);
    if (!outcome) return null;
    output.outcome = outcome;
    if ("terminationCause" in row && row.terminationCause !== undefined) {
      if (outcome !== "errored") return null;
      const cause = enumValue(row.terminationCause, TERMINATION_CAUSES, true);
      if (!cause) return null;
      output.terminationCause = cause;
    }
  } else if (event === "turn_abort") {
    const cause = enumValue(row.abortCause, ABORT_CAUSES, true);
    if (!cause) return null;
    output.abortCause = cause;
  }
  return output;
}

export function projectFsmTraceRow(value: unknown, targetAgentId: string): Record<string, unknown> | null {
  const row = object(value);
  if (!row) return null;
  if (row.recordKind === "fsm") return projectFsm(row, targetAgentId);
  if (row.recordKind === "turn_span") return projectTurnSpan(row, targetAgentId);
  return null;
}

export function projectStatusRow(value: unknown, targetAgentId: string): Record<string, unknown> | null {
  const row = object(value);
  if (!row || !safeInteger(row.writtenAt) || !Array.isArray(row.agents)) return null;
  const agent = row.agents.map(object).find((entry) => entry?.agentId === targetAgentId);
  if (!agent || !boundedString(agent.agentId, 128)) return null;
  const status = enumValue(agent.status, AGENT_STATUSES);
  const derivedActivity = enumValue(agent.derivedActivity, AGENT_STATUSES);
  if (!status || !derivedActivity || typeof agent.turnActive !== "boolean") return null;
  const output: Record<string, unknown> = {
    recordType: "status",
    timeMs: row.writtenAt,
    agentId: agent.agentId,
    status,
    derivedActivity,
    turnActive: agent.turnActive,
  };
  if (!copyInteger(agent, output, "inbox")
    || !copyInteger(agent, output, "sinceProgressMs")
    || !copyInteger(agent, output, "stoppingSince", { nullable: true })) return null;
  return output;
}

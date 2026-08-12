import { describe, expect, it, vi } from "vitest";

type FieldRule =
  | { type: "string"; maxChars: number; values?: readonly string[]; scrub?: true; nullable?: true }
  | { type: "number"; integer: true; min: number; max: number }
  | { type: "boolean" }
  | { type: "string_array"; maxItems: number; maxChars: number; values?: readonly string[] };

interface DaemonLogPolicyEntry {
  header: string;
  message: string;
  scope: "machine" | "target";
  fields: Readonly<Record<string, FieldRule>>;
}

interface PrivacyPolicyModule {
  DAEMON_LOG_DIAGNOSTIC_POLICY: readonly DaemonLogPolicyEntry[];
  projectFsmTraceRow(value: unknown, targetAgentId: string): Record<string, unknown> | null;
  projectDaemonLogRow(value: unknown, targetAgentId: string): Record<string, unknown> | null;
  projectStatusRow(value: unknown, targetAgentId: string): Record<string, unknown> | null;
  scrubDiagnosticText(value: string): string;
}

async function loadSubject(): Promise<PrivacyPolicyModule> {
  return vi.importActual<PrivacyPolicyModule>("./privacyPolicy.js");
}

const EXPECTED_APM_PHASES = [
  "idle",
  "tool_wait",
  "tool_boundary",
  "assistant_continuation",
  "compacting",
  "reviewing",
  "error",
] as const;

const EXPECTED_MANAGER_EVENTS = [
  "register",
  "wake",
  "spawned",
  "session",
  "progress",
  "turn_end",
  "exit",
  "tick",
  "reset_session",
  "begin_reset",
  "rewake_after_reset",
  "runtime_signal",
] as const;

const EXPECTED_MANAGER_EFFECTS = ["spawn", "send", "stop", "terminate_stalled", "force_exit", "gated_hold"] as const;
const EXPECTED_AGENT_STATUSES = ["idle", "starting", "running", "stopping"] as const;
const EXPECTED_DERIVED_ACTIVITIES = ["idle", "starting", "running", "stopping"] as const;
const EXPECTED_TURN_OUTCOMES = ["clean", "errored"] as const;
const EXPECTED_TURN_SPAN_EVENTS = ["turn_begin", "turn_end", "turn_abort"] as const;
const EXPECTED_TERMINATION_CAUSES = ["runtime_error", "killed_stalled", "other"] as const;
const EXPECTED_SPAWN_FAILURE_REASONS = ["ENOENT", "handshake_timeout", "pre_handshake_exit", "spawn_threw", "other"] as const;
const EXPECTED_TERMINATION_SEMANTICS = ["killed_stalled", "idle_stop", "force_exit", "other"] as const;
const EXPECTED_ABORT_CAUSES = [
  "start_threw",
  "start_rejected",
  "send_threw",
  "spawn_failure",
  "handshake_timeout",
  "reset",
  "nap",
  "model_switch",
  "requested_stop",
  "shutdown",
  "physical_exit",
  "terminate_stalled",
  "force_exit",
  "other",
] as const;
const EXPECTED_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const EXPECTED_EXIT_SIGNALS = [
  "SIGABRT",
  "SIGALRM",
  "SIGBREAK",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINFO",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGLOST",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
  "other",
] as const;

type ProjectionFieldRule = (
  | { type: "string"; maxChars: number; nullable?: true }
  | { type: "integer"; min: number; max: number; nullable?: true }
  | { type: "boolean" }
  | { type: "timestamp" }
  | { type: "enum"; values: readonly string[]; maxChars?: number; nullable?: true; unknownBucket?: "other" }
  | { type: "enum_array"; values: readonly string[]; maxItems: number; dropUnknown: true }
) & { optional?: true };

const FSM_FIELD_RULES: Readonly<Record<string, ProjectionFieldRule>> = {
  recordKind: { type: "enum", values: ["fsm"] },
  agentId: { type: "string", maxChars: 128 },
  event: { type: "enum", values: EXPECTED_MANAGER_EVENTS },
  status: { type: "enum", values: EXPECTED_AGENT_STATUSES },
  turnActive: { type: "boolean" },
  inbox: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  lastDeliverAt: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
  lastProgressAt: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  idleSince: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
  resetting: { type: "boolean" },
  resettingSince: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
  stoppingSince: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
  apmPhase: { type: "enum", values: EXPECTED_APM_PHASES },
  effects: { type: "enum_array", values: EXPECTED_MANAGER_EFFECTS, maxItems: 32, dropUnknown: true },
  nowMs: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  timeIso: { type: "timestamp" },
  sinceProgressMs: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  sinceDeliverMs: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
  sinceStoppingMs: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
  traceTurnId: { type: "string", maxChars: 1_024, optional: true },
  daemonTurnOrdinal: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER, optional: true },
  spawnOrdinal: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER, optional: true },
  turnOrdinal: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER, optional: true },
  launchIdSnapshot: { type: "string", maxChars: 1_024, nullable: true, optional: true },
  endReason: { type: "enum", values: ["errored"], optional: true },
  terminationCause: { type: "enum", values: EXPECTED_TERMINATION_CAUSES, maxChars: 64, unknownBucket: "other", optional: true },
  exitCode: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true, optional: true },
  exitSignal: { type: "enum", values: EXPECTED_EXIT_SIGNALS, maxChars: 64, nullable: true, unknownBucket: "other", optional: true },
  abnormal: { type: "boolean", optional: true },
  spawnFailureReason: { type: "enum", values: EXPECTED_SPAWN_FAILURE_REASONS, maxChars: 64, unknownBucket: "other", optional: true },
  terminationSemantics: { type: "enum", values: EXPECTED_TERMINATION_SEMANTICS, maxChars: 64, unknownBucket: "other", optional: true },
};

const TURN_SPAN_FIELD_RULES: Readonly<Record<string, ProjectionFieldRule>> = {
  recordKind: { type: "enum", values: ["turn_span"] },
  agentId: { type: "string", maxChars: 128 },
  event: { type: "enum", values: EXPECTED_TURN_SPAN_EVENTS },
  effects: { type: "enum_array", values: EXPECTED_MANAGER_EFFECTS, maxItems: 32, dropUnknown: true },
  nowMs: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  timeIso: { type: "timestamp" },
  traceTurnId: { type: "string", maxChars: 1_024 },
  daemonTurnOrdinal: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER },
  spawnOrdinal: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER },
  turnOrdinal: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER },
  launchIdSnapshot: { type: "string", maxChars: 1_024, nullable: true },
  outcome: { type: "enum", values: EXPECTED_TURN_OUTCOMES, optional: true },
  terminationCause: { type: "enum", values: EXPECTED_TERMINATION_CAUSES, maxChars: 64, unknownBucket: "other", optional: true },
  abortCause: { type: "enum", values: EXPECTED_ABORT_CAUSES, maxChars: 64, unknownBucket: "other", optional: true },
};

const STATUS_FIELD_RULES: Readonly<Record<string, ProjectionFieldRule>> = {
  writtenAt: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  agentId: { type: "string", maxChars: 128 },
  status: { type: "enum", values: EXPECTED_AGENT_STATUSES },
  derivedActivity: { type: "enum", values: EXPECTED_DERIVED_ACTIVITIES },
  turnActive: { type: "boolean" },
  inbox: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  sinceProgressMs: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER },
  stoppingSince: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
};

const EXPECTED_POLICY: ReadonlyArray<{
  header: string;
  message: string;
  scope: "machine" | "target";
  fields: Readonly<Record<string, FieldRule>>;
}> = [
  {
    header: "@alook/daemon",
    message: "daemon startup",
    scope: "machine",
    fields: {
      machineId: { type: "string", maxChars: 128 },
      version: { type: "string", maxChars: 128 },
      healthyRuntimeIds: { type: "string_array", maxItems: 128, maxChars: 64 },
      unhealthyRuntimeIds: { type: "string_array", maxItems: 128, maxChars: 64 },
    },
  },
  {
    header: "@alook/daemon",
    message: "daemon up",
    scope: "machine",
    fields: {
      proxyProtocol: { type: "string", maxChars: 16, values: ["http", "https", "unknown"] },
      controlProtocol: { type: "string", maxChars: 16, values: ["ws", "wss", "unknown"] },
    },
  },
  { header: "@alook/daemon", message: "control plane OPEN", scope: "machine", fields: {} },
  { header: "@alook/daemon", message: "shutting down…", scope: "machine", fields: {} },
  { header: "@alook/daemon", message: "daemon teardown failed", scope: "machine", fields: { errorClass: { type: "string", maxChars: 64 } } },
  { header: "@alook/daemon", message: "daemon ownership release failed", scope: "machine", fields: { errorClass: { type: "string", maxChars: 64 } } },
  { header: "@alook/daemon", message: "uncaught exception", scope: "machine", fields: { errorClass: { type: "string", maxChars: 64 } } },
  { header: "@alook/daemon", message: "unhandled rejection", scope: "machine", fields: { errorClass: { type: "string", maxChars: 64 } } },
  { header: "@alook/daemon", message: "daemon runner initialization failed", scope: "machine", fields: { errorClass: { type: "string", maxChars: 64 } } },
  { header: "@alook/daemon:ws", message: "control channel open", scope: "machine", fields: { attempt: { type: "number", integer: true, min: 0, max: 1_000_000 } } },
  {
    header: "@alook/daemon:ws",
    message: "resync sent",
    scope: "machine",
    fields: {
      ready: { type: "number", integer: true, min: 0, max: 1_000_000 },
      sessions: { type: "number", integer: true, min: 0, max: 1_000_000 },
      activities: { type: "number", integer: true, min: 0, max: 1_000_000 },
    },
  },
  { header: "@alook/daemon:ws", message: "control channel closed", scope: "machine", fields: { code: { type: "number", integer: true, min: 0, max: 65_535 } } },
  {
    header: "@alook/daemon:ws",
    message: "reconnecting",
    scope: "machine",
    fields: {
      attempt: { type: "number", integer: true, min: 0, max: 1_000_000 },
      delayMs: { type: "number", integer: true, min: 0, max: 3_600_000 },
    },
  },
  { header: "@alook/daemon:ws", message: "heartbeat pong timeout — forcing reconnect", scope: "machine", fields: {} },
  {
    header: "@alook/daemon:manager",
    message: "spawning agent",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      runtime: { type: "string", maxChars: 64 },
      model: { type: "string", maxChars: 256, scrub: true },
    },
  },
  {
    header: "@alook/daemon:manager",
    message: "spawn failed",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      runtime: { type: "string", maxChars: 64 },
      reason: { type: "string", maxChars: 64, scrub: true },
    },
  },
  {
    header: "@alook/daemon:manager",
    message: "runtime stderr",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      runtime: { type: "string", maxChars: 64 },
      text: { type: "string", maxChars: 65_536, scrub: true },
    },
  },
  {
    header: "@alook/daemon:manager",
    message: "agent session established",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      runtime: { type: "string", maxChars: 64 },
      sessionId: { type: "string", maxChars: 256, scrub: true },
    },
  },
  {
    header: "@alook/daemon:manager",
    message: "agent session ended",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      reason: { type: "string", maxChars: 32, values: ["turn_end", "stopped", "terminate_stalled", "exit"] },
      sessionId: { type: "string", maxChars: 256, scrub: true },
    },
  },
  {
    header: "@alook/daemon:manager",
    message: "steering message sent to running agent",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      mode: { type: "string", maxChars: 8, values: ["busy", "idle"] },
    },
  },
  {
    header: "@alook/daemon:manager",
    message: "gated busy message held",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      reason: { type: "string", maxChars: 32, values: ["mid_turn_wake", "tool_batch_complete", "compaction_finished", "review_finished"] },
      blockedReason: {
        type: "string",
        maxChars: 32,
        nullable: true,
        values: [
          "idle",
          "tool_wait",
          "tool_boundary",
          "assistant_continuation",
          "compacting",
          "reviewing",
          "error",
          "non_gated",
          "missing_session",
          "empty_inbox",
          "tool_boundary_flush_disabled",
          "outstanding_tool_uses",
        ],
      },
    },
  },
  { header: "@alook/daemon:router", message: "agent:wake received", scope: "target", fields: { agentId: { type: "string", maxChars: 128 } } },
  {
    header: "@alook/daemon:router",
    message: "agent:wake ack",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      status: { type: "string", maxChars: 8, values: ["ok", "error"] },
      "error.code": { type: "string", maxChars: 32, values: ["bot_unknown", "bot_enroll_failed", "bot_runtime_missing", "internal_error"] },
    },
  },
  { header: "@alook/daemon:router", message: "agent:stop received", scope: "target", fields: { agentId: { type: "string", maxChars: 128 } } },
  {
    header: "@alook/daemon:router",
    message: "agent:stop ack",
    scope: "target",
    fields: {
      agentId: { type: "string", maxChars: 128 },
      status: { type: "string", maxChars: 8, values: ["ok", "error"] },
      "error.code": { type: "string", maxChars: 32, values: ["bot_unknown", "bot_enroll_failed", "bot_runtime_missing", "internal_error"] },
    },
  },
];

function baseFsm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordKind: "fsm",
    agentId: "target-agent",
    event: "wake",
    status: "running",
    turnActive: true,
    inbox: 2,
    lastDeliverAt: 100,
    lastProgressAt: 110,
    idleSince: null,
    resetting: false,
    resettingSince: null,
    stoppingSince: null,
    apmPhase: "idle",
    effects: ["spawn", "send", "unknown-effect"],
    nowMs: 120,
    timeIso: "1970-01-01T00:00:00.120Z",
    sinceProgressMs: 10,
    sinceDeliverMs: 20,
    sinceStoppingMs: null,
    traceTurnId: "launch_1:1",
    daemonTurnOrdinal: 1,
    spawnOrdinal: 2,
    turnOrdinal: 3,
    launchIdSnapshot: "launch_1",
    ...overrides,
  };
}

function baseTurnSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordKind: "turn_span",
    event: "turn_begin",
    agentId: "target-agent",
    effects: [],
    nowMs: 100,
    timeIso: "1970-01-01T00:00:00.100Z",
    traceTurnId: "launch:1",
    daemonTurnOrdinal: 1,
    spawnOrdinal: 1,
    turnOrdinal: 1,
    launchIdSnapshot: "launch",
    ...overrides,
  };
}

function fsmWithField(field: string, value: unknown): Record<string, unknown> {
  const context = ["endReason", "terminationCause"].includes(field)
    ? { event: "turn_end", endReason: "errored", terminationCause: "runtime_error" }
    : ["exitCode", "exitSignal", "abnormal", "spawnFailureReason", "terminationSemantics"].includes(field)
      ? { event: "exit", exitCode: null, exitSignal: null, abnormal: false }
      : {};
  return baseFsm({ ...context, [field]: value });
}

function turnSpanWithField(field: string, value: unknown): Record<string, unknown> {
  const context = ["outcome", "terminationCause"].includes(field)
    ? { event: "turn_end", outcome: "errored", terminationCause: "runtime_error" }
    : field === "abortCause"
      ? { event: "turn_abort", abortCause: "reset" }
      : {};
  return baseTurnSpan({ ...context, [field]: value });
}

function invalidProjectionValues(rule: ProjectionFieldRule): unknown[] {
  switch (rule.type) {
    case "string":
      return [1, "x".repeat(rule.maxChars + 1)];
    case "integer":
      return ["1", rule.min - 1, rule.max + 1, rule.min + 0.5, Number.POSITIVE_INFINITY];
    case "boolean":
      return ["true", 1];
    case "timestamp":
      return [0, "1970-01-01", "1970-01-01T00:00:00.000Z trailing", "not-a-time"];
    case "enum":
      return [
        1,
        ...(rule.unknownBucket ? [] : ["HOSTILE_ENUM_VALUE"]),
        ...(rule.maxChars ? ["x".repeat(rule.maxChars + 1)] : []),
      ];
    case "enum_array":
      return ["not-an-array", Array.from({ length: rule.maxItems + 1 }, () => rule.values[0])];
  }
}

function statusInput(
  agentOverrides: Record<string, unknown> = {},
  writtenAt: unknown = 500,
): Record<string, unknown> {
  return {
    writtenAt,
    agents: [{
      agentId: "target-agent",
      status: "idle",
      derivedActivity: "idle",
      turnActive: false,
      inbox: 0,
      sinceProgressMs: 20,
      stoppingSince: null,
      ...agentOverrides,
    }],
  };
}

describe("B2c privacy policy", () => {
  it("freezes the exact daemon-log tuples and complete field rules", async () => {
    const api = await loadSubject();
    expect(api.DAEMON_LOG_DIAGNOSTIC_POLICY).toEqual(EXPECTED_POLICY);
  });

  it("rebuilds FSM rows from a second allowlist and never spreads hostile fields", async () => {
    const api = await loadSubject();
    const projected = api.projectFsmTraceRow(baseFsm({
      prompt: "PROMPT_LEAK_SENTINEL",
      text: "SEND_LEAK_SENTINEL",
      response: "RESPONSE_LEAK_SENTINEL",
      thinking: "THINKING_LEAK_SENTINEL",
      toolInput: "TOOL_LEAK_SENTINEL",
      errorDetail: "ERROR_LEAK_SENTINEL",
      recentEvents: ["RECENT_LEAK_SENTINEL"],
      unknown: { nested: "UNKNOWN_LEAK_SENTINEL" },
    }), "target-agent");

    expect(projected).toEqual({
      recordType: "fsm",
      recordKind: "fsm",
      agentId: "target-agent",
      event: "wake",
      status: "running",
      turnActive: true,
      inbox: 2,
      lastDeliverAt: 100,
      lastProgressAt: 110,
      idleSince: null,
      resetting: false,
      resettingSince: null,
      stoppingSince: null,
      apmPhase: "idle",
      effects: ["spawn", "send"],
      nowMs: 120,
      timeIso: "1970-01-01T00:00:00.120Z",
      sinceProgressMs: 10,
      sinceDeliverMs: 20,
      sinceStoppingMs: null,
      traceTurnId: "launch_1:1",
      daemonTurnOrdinal: 1,
      spawnOrdinal: 2,
      turnOrdinal: 3,
      launchIdSnapshot: "launch_1",
    });
    expect(JSON.stringify(projected)).not.toMatch(/PROMPT_LEAK|SEND_LEAK|RESPONSE_LEAK|THINKING_LEAK|TOOL_LEAK|ERROR_LEAK|RECENT_LEAK|UNKNOWN_LEAK/);

    for (const apmPhase of EXPECTED_APM_PHASES) {
      expect(api.projectFsmTraceRow(baseFsm({ apmPhase }), "target-agent"), apmPhase).toMatchObject({ apmPhase });
    }
    for (const event of EXPECTED_MANAGER_EVENTS) {
      expect(api.projectFsmTraceRow(baseFsm({ event }), "target-agent"), event).toMatchObject({ event });
    }
    for (const effect of EXPECTED_MANAGER_EFFECTS) {
      expect(api.projectFsmTraceRow(baseFsm({ effects: [effect] }), "target-agent"), effect).toMatchObject({ effects: [effect] });
    }
    for (const status of EXPECTED_AGENT_STATUSES) {
      expect(api.projectFsmTraceRow(baseFsm({ status }), "target-agent"), status).toMatchObject({ status });
    }
    expect(api.projectFsmTraceRow(baseFsm({ effects: ["HOSTILE_EFFECT"] }), "target-agent")).toMatchObject({ effects: [] });

    const minimalFsm = baseFsm({ event: "register", effects: [] });
    for (const field of ["traceTurnId", "daemonTurnOrdinal", "spawnOrdinal", "turnOrdinal", "launchIdSnapshot"]) {
      delete minimalFsm[field];
    }
    const projectedMinimal = api.projectFsmTraceRow(minimalFsm, "target-agent");
    expect(projectedMinimal).toMatchObject({ recordType: "fsm", recordKind: "fsm", event: "register", effects: [] });
    for (const field of ["traceTurnId", "daemonTurnOrdinal", "spawnOrdinal", "turnOrdinal", "launchIdSnapshot"]) {
      expect(projectedMinimal).not.toHaveProperty(field);
    }

    const ordinaryExit = api.projectFsmTraceRow(baseFsm({ event: "exit", exitCode: 0, exitSignal: null, abnormal: false }), "target-agent");
    expect(ordinaryExit).toMatchObject({ event: "exit", exitCode: 0, exitSignal: null, abnormal: false });
    expect(ordinaryExit).not.toHaveProperty("spawnFailureReason");
    expect(ordinaryExit).not.toHaveProperty("terminationSemantics");
  });

  it("freezes FSM/span outcome and cause enums plus bounded physical-exit metadata", async () => {
    const api = await loadSubject();
    const begin = api.projectFsmTraceRow(baseTurnSpan(), "target-agent");
    expect(begin).toMatchObject({ recordType: "fsm", recordKind: "turn_span", event: "turn_begin" });

    for (const outcome of EXPECTED_TURN_OUTCOMES) {
      expect(api.projectFsmTraceRow(baseTurnSpan({
        event: "turn_end",
        outcome,
        ...(outcome === "errored" ? { terminationCause: "runtime_error" } : {}),
      }), "target-agent"), outcome).toMatchObject({ event: "turn_end", outcome });
    }
    for (const terminationCause of EXPECTED_TERMINATION_CAUSES) {
      expect(api.projectFsmTraceRow(baseTurnSpan({ event: "turn_end", outcome: "errored", terminationCause }), "target-agent"), terminationCause)
        .toMatchObject({ event: "turn_end", outcome: "errored", terminationCause });
      expect(api.projectFsmTraceRow(baseFsm({ event: "turn_end", endReason: "errored", terminationCause }), "target-agent"), terminationCause)
        .toMatchObject({ event: "turn_end", endReason: "errored", terminationCause });
    }
    for (const abortCause of EXPECTED_ABORT_CAUSES) {
      expect(api.projectFsmTraceRow(baseTurnSpan({ event: "turn_abort", abortCause }), "target-agent"), abortCause)
        .toMatchObject({ event: "turn_abort", abortCause });
    }
    for (const spawnFailureReason of EXPECTED_SPAWN_FAILURE_REASONS) {
      expect(api.projectFsmTraceRow(baseFsm({ event: "exit", spawnFailureReason }), "target-agent"), spawnFailureReason)
        .toMatchObject({ event: "exit", spawnFailureReason });
    }
    for (const terminationSemantics of EXPECTED_TERMINATION_SEMANTICS) {
      expect(api.projectFsmTraceRow(baseFsm({ event: "exit", terminationSemantics }), "target-agent"), terminationSemantics)
        .toMatchObject({ event: "exit", terminationSemantics });
    }
    for (const exitCode of [null, 0, 137] as const) {
      expect(api.projectFsmTraceRow(baseFsm({ event: "exit", exitCode }), "target-agent"), `exitCode=${String(exitCode)}`)
        .toMatchObject({ event: "exit", exitCode });
    }
    for (const exitSignal of [null, ...EXPECTED_EXIT_SIGNALS] as const) {
      expect(api.projectFsmTraceRow(baseFsm({ event: "exit", exitSignal }), "target-agent"), `exitSignal=${String(exitSignal)}`)
        .toMatchObject({ event: "exit", exitSignal });
    }
    for (const abnormal of [false, true] as const) {
      expect(api.projectFsmTraceRow(baseFsm({ event: "exit", abnormal }), "target-agent"), `abnormal=${String(abnormal)}`)
        .toMatchObject({ event: "exit", abnormal });
    }

    expect(api.projectFsmTraceRow(baseTurnSpan({
      event: "turn_end",
      outcome: "errored",
      terminationCause: "HOSTILE_CAUSE_TEXT",
      errorDetail: "HOSTILE_ERROR_TEXT",
    }), "target-agent")).toMatchObject({ terminationCause: "other" });
    expect(api.projectFsmTraceRow(baseTurnSpan({ event: "turn_abort", abortCause: "HOSTILE_ABORT_TEXT" }), "target-agent"))
      .toMatchObject({ abortCause: "other" });
    expect(api.projectFsmTraceRow(baseFsm({ event: "exit", spawnFailureReason: "HOSTILE_SPAWN_REASON" }), "target-agent"))
      .toMatchObject({ spawnFailureReason: "other" });
    expect(api.projectFsmTraceRow(baseFsm({ event: "exit", terminationSemantics: "HOSTILE_EXIT_SEMANTIC" }), "target-agent"))
      .toMatchObject({ terminationSemantics: "other" });
    expect(api.projectFsmTraceRow(baseFsm({ event: "exit", exitSignal: "HOSTILE_SIGNAL" }), "target-agent"))
      .toMatchObject({ exitSignal: "other" });
    expect(JSON.stringify([
      api.projectFsmTraceRow(baseTurnSpan({ event: "turn_end", outcome: "errored", terminationCause: "HOSTILE_CAUSE_TEXT" }), "target-agent"),
      api.projectFsmTraceRow(baseTurnSpan({ event: "turn_abort", abortCause: "HOSTILE_ABORT_TEXT" }), "target-agent"),
      api.projectFsmTraceRow(baseFsm({ event: "exit", spawnFailureReason: "HOSTILE_SPAWN_REASON", terminationSemantics: "HOSTILE_EXIT_SEMANTIC" }), "target-agent"),
    ])).not.toContain("HOSTILE");

    for (const [field, rule] of Object.entries(TURN_SPAN_FIELD_RULES)) {
      if (rule.type === "enum_array") {
        for (const invalid of invalidProjectionValues(rule)) {
          expect(api.projectFsmTraceRow(turnSpanWithField(field, invalid), "target-agent"), `span.${field}=${JSON.stringify(invalid)}`)
            .toBeNull();
        }
        expect(api.projectFsmTraceRow(turnSpanWithField(field, ["HOSTILE_EFFECT"]), "target-agent"))
          .toMatchObject({ [field]: [] });
        continue;
      }
      for (const invalid of invalidProjectionValues(rule)) {
        expect(api.projectFsmTraceRow(turnSpanWithField(field, invalid), "target-agent"), `span.${field}=${JSON.stringify(invalid)}`)
          .toBeNull();
      }
      if (rule.type === "integer") {
        expect(api.projectFsmTraceRow(turnSpanWithField(field, rule.min), "target-agent"), `span.${field}=min`)
          .toMatchObject({ [field]: rule.min });
      }
      if (rule.type === "string" && field !== "agentId") {
        const bounded = "x".repeat(rule.maxChars);
        expect(api.projectFsmTraceRow(turnSpanWithField(field, bounded), "target-agent"), `span.${field}=maxChars`)
          .toMatchObject({ [field]: bounded });
      }
      if ("nullable" in rule && rule.nullable) {
        expect(api.projectFsmTraceRow(turnSpanWithField(field, null), "target-agent"), `span.${field}=null`)
          .toMatchObject({ [field]: null });
      }
      if (rule.type === "enum" && rule.unknownBucket) {
        expect(api.projectFsmTraceRow(turnSpanWithField(field, "HOSTILE_ENUM_VALUE"), "target-agent"), `span.${field}=bucket`)
          .toMatchObject({ [field]: "other" });
      }
    }
  });

  it("enforces the test-owned FSM field-rule table and fails closed on every invalid shape", async () => {
    const api = await loadSubject();
    expect(api.projectFsmTraceRow(baseFsm({ agentId: "second-agent" }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseFsm({ recordKind: "unknown" }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseFsm({ event: "HOSTILE_EVENT" }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseFsm({ status: "HOSTILE_STATUS" }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseFsm({ apmPhase: "working" }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseFsm({ apmPhase: "HOSTILE_APM_PHASE" }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseFsm({ nowMs: Number.POSITIVE_INFINITY }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseFsm({ traceTurnId: "x".repeat(1025) }), "target-agent")).toBeNull();
    const boundedAgentId = "a".repeat(128);
    expect(api.projectFsmTraceRow(baseFsm({ agentId: boundedAgentId }), boundedAgentId)).toMatchObject({ agentId: boundedAgentId });
    const oversizedAgentId = "a".repeat(129);
    expect(api.projectFsmTraceRow(baseFsm({ agentId: oversizedAgentId }), oversizedAgentId)).toBeNull();

    for (const [field, rule] of Object.entries(FSM_FIELD_RULES)) {
      if (rule.type === "enum_array") {
        for (const invalid of invalidProjectionValues(rule)) {
          expect(api.projectFsmTraceRow(fsmWithField(field, invalid), "target-agent"), `${field}=${JSON.stringify(invalid)}`).toBeNull();
        }
        expect(api.projectFsmTraceRow(fsmWithField(field, ["HOSTILE_EFFECT"]), "target-agent"), `${field}=unknown`)
          .toMatchObject({ [field]: [] });
        continue;
      }
      for (const invalid of invalidProjectionValues(rule)) {
        expect(api.projectFsmTraceRow(fsmWithField(field, invalid), "target-agent"), `${field}=${JSON.stringify(invalid)}`).toBeNull();
      }
      if (rule.type === "integer") {
        expect(api.projectFsmTraceRow(fsmWithField(field, rule.min), "target-agent"), `${field}=min`)
          .toMatchObject({ [field]: rule.min });
      }
      if (rule.type === "string" && field !== "agentId") {
        const bounded = "x".repeat(rule.maxChars);
        expect(api.projectFsmTraceRow(fsmWithField(field, bounded), "target-agent"), `${field}=maxChars`)
          .toMatchObject({ [field]: bounded });
      }
      if (rule.type === "boolean") {
        for (const value of [false, true]) {
          expect(api.projectFsmTraceRow(fsmWithField(field, value), "target-agent"), `${field}=${String(value)}`)
            .toMatchObject({ [field]: value });
        }
      }
      if ("nullable" in rule && rule.nullable) {
        expect(api.projectFsmTraceRow(fsmWithField(field, null), "target-agent"), `${field}=null`)
          .toMatchObject({ [field]: null });
      }
      if (rule.type === "enum" && rule.unknownBucket) {
        expect(api.projectFsmTraceRow(fsmWithField(field, "HOSTILE_ENUM_VALUE"), "target-agent"), `${field}=bucket`)
          .toMatchObject({ [field]: "other" });
      }
      if (rule.optional) {
        const withoutOptional = fsmWithField(field, rule.type === "enum" ? rule.values[0] : undefined);
        delete withoutOptional[field];
        expect(api.projectFsmTraceRow(withoutOptional, "target-agent"), `${field}=omitted`).not.toBeNull();
      }
    }

    expect(api.projectFsmTraceRow(baseTurnSpan({ event: "turn_end", outcome: "HOSTILE_OUTCOME" }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseTurnSpan({ event: "turn_end", outcome: "errored", terminationCause: 1 }), "target-agent")).toBeNull();
    expect(api.projectFsmTraceRow(baseTurnSpan({ event: "turn_abort", abortCause: 1 }), "target-agent")).toBeNull();
  });

  it("requires an exact daemon-log tuple before agentId can grant admission", async () => {
    const api = await loadSubject();
    const unknown = {
      time: "2026-08-12T12:00:00.000Z",
      header: "@alook/daemon:manager",
      level: "warn",
      message: "user controlled event",
      fields: { agentId: "target-agent", text: "UNKNOWN_TUPLE_LEAK" },
    };
    expect(api.projectDaemonLogRow(unknown, "target-agent")).toBeNull();
    expect(api.projectDaemonLogRow({ ...unknown, header: "@alook/daemon:evil", message: "runtime stderr" }, "target-agent")).toBeNull();
  });

  it("drops other-bot stderr even when its text forges a target agent field", async () => {
    const api = await loadSubject();
    const row = {
      time: "2026-08-12T12:00:00.000Z",
      header: "@alook/daemon:manager",
      level: "warn",
      message: "runtime stderr",
      fields: {
        agentId: "second-agent",
        runtime: "claude",
        text: "SECOND_BOT_SECRET\n{\"agentId\":\"target-agent\"} cmk_secret Bearer token /Users/private",
      },
    };
    expect(api.projectDaemonLogRow(row, "target-agent")).toBeNull();
  });

  it("keeps disclosed target stderr but scrubs credentials, authorization, vouchers, and absolute paths", async () => {
    const api = await loadSubject();
    const row = {
      time: "2026-08-12T12:00:00.000Z",
      header: "@alook/daemon:manager",
      level: "warn",
      message: "runtime stderr",
      fields: {
        agentId: "target-agent",
        runtime: "claude",
        text: "provider failed cmk_ABC123 cmt_XYZ crk_RECONNECT Authorization: Bearer topsecret voucher=/tmp/voucher-token /Users/alice/project /home/bob/work C:\\Users\\alice\\secret \\\\server\\share\\private",
        prompt: "PROMPT_EXTRA_LEAK",
        authorization: "AUTH_EXTRA_LEAK",
        otherBotId: "second-agent",
      },
    };
    const projected = api.projectDaemonLogRow(row, "target-agent");
    const encoded = JSON.stringify(projected);

    expect(projected).toMatchObject({
      recordType: "daemon_log",
      header: "@alook/daemon:manager",
      message: "runtime stderr",
      fields: { agentId: "target-agent", runtime: "claude" },
    });
    expect(encoded).toContain("provider failed");
    expect(encoded).not.toMatch(/cmk_|cmt_|crk_|topsecret|voucher-token|\/Users\/alice|\/home\/bob|C:\\\\Users\\\\alice|server\\\\share|PROMPT_EXTRA|AUTH_EXTRA|second-agent/);
  });

  it("drops every non-allowlisted field from every admitted daemon tuple", async () => {
    const api = await loadSubject();
    for (const entry of EXPECTED_POLICY) {
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(entry.fields).map(([field, rule]) => {
        if (field === "agentId") return [field, "target-agent"];
        if (rule.type === "number") return [field, rule.min];
        if (rule.type === "boolean") return [field, true];
        if (rule.type === "string_array") return [field, [rule.values?.[0] ?? "safe"]];
        return [field, rule.values?.[0] ?? "safe"];
      }));
      Object.assign(fields, {
        prompt: "PROMPT_EXTRA_LEAK",
        authorization: "AUTH_EXTRA_LEAK",
        recentEvents: ["RECENT_EXTRA_LEAK"],
        arbitrary: "ARBITRARY_EXTRA_LEAK",
      });
      const projected = api.projectDaemonLogRow({
        time: "2026-08-12T12:00:00.000Z",
        header: entry.header,
        level: "info",
        message: entry.message,
        fields,
      }, "target-agent");
      expect(projected, `${entry.header} ${entry.message}`).not.toBeNull();
      const encoded = JSON.stringify(projected);
      expect(encoded).not.toMatch(/PROMPT_EXTRA|AUTH_EXTRA|RECENT_EXTRA|ARBITRARY_EXTRA/);
      expect(Object.keys((projected?.fields ?? {}) as object).sort()).toEqual(Object.keys(entry.fields).sort());
    }
  });

  it("fails closed for every daemon-log field-rule type, enum, and length violation", async () => {
    const api = await loadSubject();
    const validValue = (key: string, rule: FieldRule): unknown => {
      if (key === "agentId") return "target-agent";
      if (rule.type === "number") return rule.min;
      if (rule.type === "boolean") return true;
      if (rule.type === "string_array") return [rule.values?.[0] ?? "safe"];
      return rule.values?.[0] ?? "safe";
    };
    const invalidValues = (rule: FieldRule): unknown[] => {
      switch (rule.type) {
        case "number":
          return ["1", rule.min - 1, rule.max + 1, rule.min + 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
        case "boolean":
          return ["true", 1];
        case "string":
          return [
            1,
            "x".repeat(rule.maxChars + 1),
            ...(rule.values ? ["NOT_AN_ALLOWLISTED_ENUM"] : []),
          ];
        case "string_array":
          return [
            "not-an-array",
            Array.from({ length: rule.maxItems + 1 }, () => rule.values?.[0] ?? "safe"),
            ["x".repeat(rule.maxChars + 1)],
            ...(rule.values ? [["NOT_AN_ALLOWLISTED_ENUM"]] : []),
          ];
      }
    };

    for (const entry of EXPECTED_POLICY) {
      const validFields = Object.fromEntries(Object.entries(entry.fields).map(([key, rule]) => [key, validValue(key, rule)]));
      for (const [key, rule] of Object.entries(entry.fields)) {
        for (const invalid of invalidValues(rule)) {
          const row = {
            time: "2026-08-12T12:00:00.000Z",
            header: entry.header,
            level: "info",
            message: entry.message,
            fields: { ...validFields, [key]: invalid },
          };
          expect(
            api.projectDaemonLogRow(row, "target-agent"),
            `${entry.header} ${entry.message} ${key}=${JSON.stringify(invalid)}`,
          ).toBeNull();
        }
      }
    }
  });

  it("accepts only canonical timestamps and fixed log levels", async () => {
    const api = await loadSubject();
    const valid = {
      time: "2026-08-12T12:00:00.000Z",
      header: "@alook/daemon:manager",
      level: "warn",
      message: "runtime stderr",
      fields: { agentId: "target-agent", runtime: "claude", text: "safe" },
    };
    for (const level of EXPECTED_LOG_LEVELS) {
      expect(api.projectDaemonLogRow({ ...valid, level }, "target-agent"), level).toMatchObject({
        time: valid.time,
        level,
      });
    }
    expect(api.projectDaemonLogRow({
      time: valid.time,
      header: "@alook/daemon:router",
      level: "info",
      message: "agent:wake ack",
      fields: { agentId: "target-agent", status: "ok" },
    }, "target-agent")).toMatchObject({ fields: { agentId: "target-agent", status: "ok" } });
    expect(api.projectDaemonLogRow({
      time: valid.time,
      header: "@alook/daemon:ws",
      level: "warn",
      message: "control channel closed",
      fields: {},
    }, "target-agent")).toMatchObject({ fields: {} });
    for (const time of [
      0,
      "2026-08-12",
      "2026-08-12T12:00:00Z trailing",
      "not-a-time",
      "99999-01-01T00:00:00.000Z",
    ]) {
      expect(api.projectDaemonLogRow({ ...valid, time }, "target-agent"), `time=${String(time)}`).toBeNull();
    }
    for (const level of ["trace", "fatal", "INFO", 1, null]) {
      expect(api.projectDaemonLogRow({ ...valid, level }, "target-agent"), `level=${String(level)}`).toBeNull();
    }
  });

  it("keeps target mismatch as an independent fail-closed gate", async () => {
    const api = await loadSubject();
    expect(api.projectDaemonLogRow({
      time: "2026-08-12T12:00:00.000Z",
      header: "@alook/daemon:manager",
      level: "warn",
      message: "runtime stderr",
      fields: { agentId: "second-agent", runtime: "claude", text: "otherwise-valid" },
    }, "target-agent")).toBeNull();
  });

  it("projects only the target status with an exact bounded field set", async () => {
    const api = await loadSubject();
    const projected = api.projectStatusRow({
      writtenAt: 500,
      agents: [
        {
          agentId: "second-agent",
          status: "running",
          derivedActivity: "running",
          turnActive: true,
          inbox: 99,
          sinceProgressMs: 1,
          stoppingSince: null,
          secret: "SECOND_STATUS_SECRET",
        },
        {
          agentId: "target-agent",
          status: "idle",
          derivedActivity: "idle",
          turnActive: false,
          inbox: 0,
          sinceProgressMs: 20,
          stoppingSince: null,
          prompt: "TARGET_STATUS_EXTRA",
        },
      ],
      hostname: "HOSTNAME_LEAK",
      env: { TOKEN: "ENV_LEAK" },
      workdir: "/Users/alice/project",
    }, "target-agent");

    expect(projected).toEqual({
      recordType: "status",
      timeMs: 500,
      agentId: "target-agent",
      status: "idle",
      derivedActivity: "idle",
      turnActive: false,
      inbox: 0,
      sinceProgressMs: 20,
      stoppingSince: null,
    });
    expect(JSON.stringify(projected)).not.toMatch(/second-agent|SECOND_STATUS|TARGET_STATUS|HOSTNAME|ENV_LEAK|\/Users\/alice/);

    for (const status of EXPECTED_AGENT_STATUSES) {
      expect(api.projectStatusRow(statusInput({ status }), "target-agent"), status).toMatchObject({ status });
    }
    for (const derivedActivity of EXPECTED_DERIVED_ACTIVITIES) {
      expect(api.projectStatusRow(statusInput({ derivedActivity }), "target-agent"), derivedActivity)
        .toMatchObject({ derivedActivity });
    }
  });

  it("enforces the test-owned status field-rule table", async () => {
    const api = await loadSubject();
    const boundedAgentId = "a".repeat(128);
    expect(api.projectStatusRow({
      writtenAt: 500,
      agents: [{
        agentId: boundedAgentId,
        status: "idle",
        derivedActivity: "idle",
        turnActive: false,
        inbox: 0,
        sinceProgressMs: 20,
        stoppingSince: null,
      }],
    }, boundedAgentId)).toMatchObject({ agentId: boundedAgentId });
    const oversizedAgentId = "a".repeat(129);
    expect(api.projectStatusRow({
      writtenAt: 500,
      agents: [{
        agentId: oversizedAgentId,
        status: "idle",
        derivedActivity: "idle",
        turnActive: false,
        inbox: 0,
        sinceProgressMs: 20,
        stoppingSince: null,
      }],
    }, oversizedAgentId)).toBeNull();

    for (const [field, rule] of Object.entries(STATUS_FIELD_RULES)) {
      for (const invalid of invalidProjectionValues(rule)) {
        const input = field === "writtenAt" ? statusInput({}, invalid) : statusInput({ [field]: invalid });
        expect(api.projectStatusRow(input, "target-agent"), `${field}=${JSON.stringify(invalid)}`).toBeNull();
      }
      if (rule.type === "integer") {
        const input = field === "writtenAt" ? statusInput({}, rule.min) : statusInput({ [field]: rule.min });
        expect(api.projectStatusRow(input, "target-agent"), `${field}=min`).toMatchObject({
          [field === "writtenAt" ? "timeMs" : field]: rule.min,
        });
      }
      if (rule.type === "boolean") {
        for (const value of [false, true]) {
          expect(api.projectStatusRow(statusInput({ [field]: value }), "target-agent"), `${field}=${String(value)}`)
            .toMatchObject({ [field]: value });
        }
      }
      if ("nullable" in rule && rule.nullable) {
        expect(api.projectStatusRow(statusInput({ [field]: null }), "target-agent"), `${field}=null`)
          .toMatchObject({ [field]: null });
      }
    }
  });

  it("scrubber is deterministic, bounded, and never emits the original secret/path", async () => {
    const api = await loadSubject();
    const hostile = `${"x".repeat(70_000)} cmk_TOP Authorization: Bearer SECRET /Users/alice/private C:\\Users\\alice\\secret \\\\server\\share\\private`;
    const first = api.scrubDiagnosticText(hostile);
    const second = api.scrubDiagnosticText(hostile);
    expect(first).toBe(second);
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(first).not.toMatch(/cmk_TOP|SECRET|\/Users\/alice|C:\\Users\\alice|\\\\server\\share/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { PassThrough } from "stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentProcessManager,
  truncateThinking,
  canonicalToolName,
  extractToolAudit,
  isAlookShellInvocation,
  truncateTargetToCodeUnits,
  type SessionFactory,
} from "./managerRuntime.js";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  BuiltinBackendSpecs,
  DeliveryReceipt,
} from "@alook/agent-driver";
import type { AdapterEvent } from "@alook/agent-driver/adapter-author";
import { createBuiltinAgentDriverRegistry } from "@alook/agent-driver/adapter-author";
import type { AgentBackend as Driver } from "../drivers/index.js";
import type { HostLaunchContext as LaunchContext } from "./hostContext.js";
import type { RuntimeConfig } from "../runtimeConfig.js";
import type { Logger } from "../logger.js";
import { createTimelineRecorder } from "../timeline/recorder.js";

/** Stub logger — records calls per level for assertions. */
function stubLogger(): Logger & { calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> } {
  const calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const logger = {
    calls,
    debug: (m: string, ...d: unknown[]) => calls.debug.push([m, d]),
    info: (m: string, ...d: unknown[]) => calls.info.push([m, d]),
    warn: (m: string, ...d: unknown[]) => calls.warn.push([m, d]),
    error: (m: string, ...d: unknown[]) => calls.error.push([m, d]),
    child: () => logger,
  };
  return logger;
}

// Minimal driver — the manager only reads .id and .lifecycle here (via register).
function fakeDriver(id: string): Driver {
  return {
    id,
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" } as never,
    session: { recovery: "resume_or_fresh" } as never,
    model: { detectedModelsVerifiedAs: "launchable", toLaunchSpec: () => ({ args: [] }) } as never,
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    probe: () => ({ status: "healthy" as const, version: "test" }),
    spawn: async () => ({ process: {} as never }),
    parseLine: () => [],
    encodeStdinMessage: () => null,
    buildSystemPrompt: () => "",
  } as unknown as Driver;
}

function controllableChildDriver(id: string): { driver: Driver; stdout: PassThrough; parseLine: ReturnType<typeof vi.fn> } {
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
  const parseLine = vi.fn(() => []);
  const driver = {
    ...fakeDriver(id),
    lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" },
    spawn: async () => ({ process: proc }),
    parseLine,
  } as unknown as Driver;
  return { driver, stdout, parseLine };
}

// Fake session with manual EE that we can emit into from tests.
type TestAgentSession = AgentSession<BuiltinBackendSpecs, "codex">;
interface FakeSession extends TestAgentSession {
  fire(evt: string, ...args: unknown[]): Promise<void>;
  pushAgentEvent(event: Omit<AgentEvent<BuiltinBackendSpecs, "codex">, "sequence" | "sessionInstanceId" | "at">): Promise<void>;
  startResolver?: () => void;
  startRejector?: (err: unknown) => void;
}

function fakeSession(sessionInstanceId = "test-instance"): FakeSession {
  type Event = AgentEvent<BuiltinBackendSpecs, "codex">;
  const queued: Event[] = [];
  const waiters: Array<(value: IteratorResult<Event>) => void> = [];
  let sequence = 0;
  let resolveClosed!: (result: AgentSessionResult) => void;
  const closed = new Promise<AgentSessionResult>((resolve) => { resolveClosed = resolve; });
  const push = (payload: Omit<Event, "sequence" | "sessionInstanceId" | "at">) => {
    const event = {
      ...payload,
      sequence: ++sequence,
      sessionInstanceId,
      at: Date.now(),
    } as Event;
    const waiter = waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else queued.push(event);
  };
  const s = {
    backend: "codex",
    capabilities: {} as TestAgentSession["capabilities"],
    sessionInstanceId,
    events: {
      maxBufferedBytes: 4_194_304 as const,
      [Symbol.asyncIterator]() {
        return {
          next: () => queued.length > 0
            ? Promise.resolve({ done: false as const, value: queued.shift()! })
            : new Promise<IteratorResult<Event>>((resolve) => waiters.push(resolve)),
        };
      },
    },
    closed,
    start(message: { id: string }) {
      return new Promise((resolve, reject) => {
        s.startResolver = () => {
          push({ type: "command_accepted", commandId: message.id, turnId: "test-turn", delivery: "prompt" } as never);
          push({ type: "turn_started", turnId: "test-turn", commandIds: [message.id] } as never);
          resolve({
            status: "accepted",
            delivery: "prompt",
            commandId: message.id,
            turnId: "test-turn",
          });
        };
        s.startRejector = reject;
      });
    },
    async send(message: { id: string }) {
      push({ type: "command_accepted", commandId: message.id, turnId: "test-turn", delivery: "steer" } as never);
      push({ type: "turn_started", turnId: "test-turn", commandIds: [message.id] } as never);
      return {
        status: "accepted" as const,
        delivery: "steer" as const,
        commandId: message.id,
        turnId: "test-turn",
      };
    },
    async interrupt() { return { status: "not_running" as const }; },
    async stop() { return { status: "accepted" as const, requestId: "test-stop" }; },
    snapshot() {
      return {
        sessionInstanceId,
        state: "working" as const,
        queuedCommands: [],
        lastEventSequence: sequence,
      };
    },
    async invokeExtension() {
      return { ok: false as const, error: { category: "internal" as const, code: "unsupported", message: "unsupported", retryable: false } };
    },
    async pushAgentEvent(event) {
      push(event as never);
      await Promise.resolve();
      await Promise.resolve();
    },
    async fire(evt: string, ...args: unknown[]) {
      if (evt === "runtime_event") {
        const event = args[0] as { kind: string; sessionId?: string; text?: string; name?: string; input?: unknown; message?: string; source?: string; itemType?: string; payloadBytes?: number };
        const turnId = "test-turn";
        switch (event.kind) {
          case "session_init":
            push({ type: "session_started", backendSessionId: event.sessionId ?? "test-session" } as never);
            break;
          case "thinking": push({ type: "assistant_reasoning_completed", turnId, text: event.text ?? "", truncated: false } as never); break;
          case "text": push({ type: "assistant_message_completed", turnId, text: event.text ?? "", truncated: false } as never); break;
          case "tool_call": push({ type: "tool_started", turnId, name: event.name ?? "unknown", input: (event.input ?? null) as never } as never); break;
          case "tool_output": push({ type: "tool_finished", turnId, name: event.name ?? "unknown" } as never); break;
          case "compaction_started":
          case "compaction_finished":
          case "review_started":
          case "review_finished": push({ type: event.kind, turnId } as never); break;
          case "internal_progress": push({ type: "internal_progress", turnId, source: event.source, itemType: event.itemType, payloadBytes: event.payloadBytes } as never); break;
          case "error": push({ type: "session_failed", error: { category: "process", code: "runtime_error", message: event.message ?? "Runtime error", retryable: true } } as never); break;
          case "turn_end": push({ type: "turn_completed", turnId, commandIds: ["test-start"], result: { outcome: "success", backendSessionId: event.sessionId ?? "test-session" } } as never); break;
          default: push({ type: "internal_progress", turnId, source: "test", itemType: event.kind } as never);
        }
      } else if (evt === "error") {
        const error = args[0] as { code?: string; message?: string } | undefined;
        push({ type: "session_failed", error: { category: "process", code: error?.code ?? "spawn_error", message: error?.message ?? error?.code ?? "spawn error", retryable: true } } as never);
      } else if (evt === "stderr") {
        push({ type: "diagnostic", severity: "warning", source: "codex", message: String(args[0] ?? "") } as never);
      } else if (evt === "exit") {
        const info = args[0] as { code?: number | null; signal?: string | null; reason?: string } | undefined;
        const result: AgentSessionResult = info?.reason === "requested"
          ? { outcome: "stopped", requested: true, exitCode: info.code ?? null, signal: info.signal ?? null, cleanup: { status: "released" } }
          : (info?.code ?? null) === 0 && (info?.signal ?? null) === null
            ? { outcome: "crashed", requested: false, exitCode: 0, signal: null, cleanup: { status: "released" } }
          : { outcome: "crashed", requested: false, exitCode: info?.code ?? null, signal: info?.signal ?? null, cleanup: { status: "released" } };
        resolveClosed(result);
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  } as unknown as FakeSession;
  return s;
}

function sessionFactoryFor(session: FakeSession): SessionFactory {
  return () => session;
}

function fireManagedError(
  mgr: AgentProcessManager,
  message: string,
  superseded: boolean,
): void {
  const internal = mgr as unknown as {
    activeSpawnState: Map<string, { superseded: boolean }>;
    onAgentEvent(
      agentId: string,
      event: AgentEvent<BuiltinBackendSpecs, "codex">,
      runtimeId: "codex",
      owner: { superseded: boolean },
    ): void;
  };
  if (!internal.activeSpawnState.has("a1")) mgr.deliver("a1", { seq: 1, text: "hello" });
  const owner = internal.activeSpawnState.get("a1")!;
  owner.superseded = superseded;
  internal.onAgentEvent("a1", {
    type: "session_failed",
    error: { category: "process", code: "runtime_error", message, retryable: true },
    sequence: 1,
    sessionInstanceId: "test-instance",
    at: Date.now(),
  }, "codex", owner);
}

function fireManagedTurnFailure(
  mgr: AgentProcessManager,
  message: string,
): void {
  const internal = mgr as unknown as {
    activeSpawnState: Map<string, { superseded: boolean }>;
    onAgentEvent(
      agentId: string,
      event: AgentEvent<BuiltinBackendSpecs, "codex">,
      runtimeId: "codex",
      owner: { superseded: boolean },
    ): void;
  };
  if (!internal.activeSpawnState.has("a1")) mgr.deliver("a1", { seq: 1, text: "hello" });
  const owner = internal.activeSpawnState.get("a1")!;
  internal.onAgentEvent("a1", {
    type: "turn_completed",
    turnId: "test-turn",
    commandIds: ["test-start"],
    result: {
      outcome: "failed",
      error: { category: "process", code: "runtime_error", message, retryable: true },
    },
    sequence: 1,
    sessionInstanceId: "test-instance",
    at: Date.now(),
  }, "codex", owner);
}

function bindFactorySession(
  _args: Parameters<SessionFactory>[0],
  session: FakeSession,
): FakeSession {
  return session;
}

function makeManager(opts: { logger?: Logger; tickIntervalMs?: number; idleTimeoutMs?: number; idleResetTimeoutMs?: number; staleThresholdMs?: number; resetStuckThresholdMs?: number; handshakeTimeoutMs?: number; now?: () => number; onBotAuditEvent?: (agentId: string, event: unknown, context: { sessionId: string | null; launchId: string | null }) => void } = {}) {
  const session = fakeSession();
  const factory = sessionFactoryFor(session);
  const onRuntimeSpawnFailed = vi.fn();
  const onRuntimeSessionEstablished = vi.fn();
  const mgr = new AgentProcessManager({
    driverFor: () => fakeDriver("codex"),
    baseContextFor: () => ({
      workingDirectory: "/tmp",
      agentId: "a1",
      standingPrompt: "",
      config: {} as LaunchContext["config"],
      credentialProxy: {} as LaunchContext["credentialProxy"],
    }),
    sessionFactory: factory,
    onRuntimeSpawnFailed,
    onRuntimeSessionEstablished,
    onBotAuditEvent: opts.onBotAuditEvent as never,
    ...opts,
  });
  mgr.register("a1");
  return { mgr, session, onRuntimeSpawnFailed, onRuntimeSessionEstablished };
}

function exactTimelineLifecycleStub() {
  return {
    barrierGeneration: () => 0,
    beginTurn: vi.fn(),
    recordAssistantMessage: vi.fn(),
    finalizeTurn: vi.fn(),
    fenceSession: vi.fn(),
  };
}

describe("AgentProcessManager — idle session reset", () => {
  it("persists an exact reset barrier and clears the local session without waking an idle agent", () => {
    const forgetSession = vi.fn(() => true);
    const sessionFactory = vi.fn();
    const onBotAuditEvent = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory,
      timeline: { ...exactTimelineLifecycleStub(), forgetSession } as never,
      now: () => 123,
      onBotAuditEvent,
    });
    mgr.register("a1");
    const internal = mgr as unknown as { applyEffect(effect: object): void };

    internal.applyEffect({ type: "reset_idle_session", agentId: "a1", sessionId: "sess-old" });

    const completion = forgetSession.mock.calls[0]![3];
    expect(forgetSession).toHaveBeenCalledWith(
      "a1",
      "reset_session",
      "sess-old",
      { eventId: expect.stringMatching(/^bae_/), occurredAt: "1970-01-01T00:00:00.123Z" },
    );
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(onBotAuditEvent).toHaveBeenCalledOnce();
    expect(onBotAuditEvent).toHaveBeenCalledWith(
      "a1",
      { kind: "session_reset", payload: { trigger: "idle_timeout" } },
      { sessionId: null, launchId: null, ...completion },
    );
    expect(mgr.snapshot().agents.a1).toMatchObject({ status: "idle", sessionId: null, idleSince: null });
  });

  it("defers the reset and leaves state retryable when the barrier cannot be persisted", () => {
    const logger = stubLogger();
    const forgetSession = vi.fn(() => false);
    const onBotAuditEvent = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      timeline: { ...exactTimelineLifecycleStub(), forgetSession } as never,
      logger,
      onBotAuditEvent,
    });
    mgr.register("a1");
    const before = mgr.snapshot();
    const internal = mgr as unknown as { applyEffect(effect: object): void };

    internal.applyEffect({ type: "reset_idle_session", agentId: "a1", sessionId: "sess-old" });
    internal.applyEffect({ type: "reset_idle_session", agentId: "a1", sessionId: "sess-old" });

    expect(forgetSession).toHaveBeenCalledTimes(2);
    expect(
      onBotAuditEvent.mock.calls.filter(([, event]) => event.kind === "session_reset"),
    ).toHaveLength(0);
    expect(
      onBotAuditEvent.mock.calls.filter(([, event]) => event.kind === "error"),
    ).toHaveLength(2);
    expect(mgr.snapshot()).toBe(before);
    expect(logger.calls.error.map(([message]) => message)).toEqual([
      "idle session reset barrier was not persisted; reset deferred",
      "idle session reset barrier was not persisted; reset deferred",
    ]);
  });

  it("fences the old spawn owner before stop so a late session_started cannot restore the reset session", async () => {
    const session = fakeSession("idle-reset-instance");
    session.stop = vi.fn(session.stop.bind(session));
    const setSession = vi.fn(() => true);
    const forgetSession = vi.fn(() => true);
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: sessionFactoryFor(session),
      timeline: {
        ...exactTimelineLifecycleStub(),
        setSession,
        forgetSession,
        resumeSessionId: () => null,
      } as never,
      now: () => 123,
    });
    mgr.register("a1");
    mgr.deliver("a1", { id: "first", text: "hello" });
    session.startResolver?.();
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-old" });
    await session.fire("runtime_event", { kind: "turn_end", sessionId: "sess-old" });
    expect(mgr.snapshot().agents.a1).toMatchObject({ sessionId: "sess-old", idleSince: 123 });

    const internal = mgr as unknown as {
      applyEffect(effect: object): void;
      activeSpawnState: Map<string, { discardEvents: boolean }>;
    };
    internal.applyEffect({ type: "reset_idle_session", agentId: "a1", sessionId: "sess-old" });

    expect(forgetSession).toHaveBeenCalledWith(
      "a1",
      "reset_session",
      "sess-old",
      { eventId: expect.stringMatching(/^bae_/), occurredAt: "1970-01-01T00:00:00.123Z" },
    );
    expect(internal.activeSpawnState.get("a1")?.discardEvents).toBe(true);
    expect(session.stop).toHaveBeenCalledWith({ reason: "idle_timeout", forceAfterMs: 2_000 });
    expect(mgr.snapshot().agents.a1.sessionId).toBeNull();
    expect(setSession).toHaveBeenCalledTimes(1);

    await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-old" });

    expect(setSession).toHaveBeenCalledTimes(1);
    expect(mgr.snapshot().agents.a1.sessionId).toBeNull();
  });
});

function recordObservedTurn(
  recorder: ReturnType<typeof createTimelineRecorder>,
  agentId: string,
  rootTurnId: string,
  messages: Parameters<ReturnType<typeof createTimelineRecorder>["recordInboxPull"]>[2],
): void {
  const owner = {
    sessionInstanceId: `fixture-${rootTurnId}`,
    rootTurnId,
    barrierGeneration: recorder.barrierGeneration(agentId),
  };
  recorder.beginTurn(agentId, owner);
  recorder.recordInboxPull(agentId, owner, messages);
  recorder.finalizeTurn(agentId, owner);
}

describe("AgentProcessManager — repeated backend-session stall recovery", () => {
  it("rejects a backend session before publishing it when setSession cannot persist control", async () => {
    const session = fakeSession("set-session-control-failure");
    session.stop = vi.fn(session.stop.bind(session));
    const onAgentSession = vi.fn();
    const onRuntimeSessionEstablished = vi.fn();
    const onRuntimeSpawnFailed = vi.fn();
    const manager = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (hooks) => bindFactorySession(hooks, session),
      timeline: {
        ...exactTimelineLifecycleStub(),
        setSession: () => false,
        resumeSessionId: () => null,
        recordSessionStall: () => true,
        clearSessionStall: () => true,
        forgetSession: () => true,
      },
      onAgentSession,
      onRuntimeSessionEstablished,
      onRuntimeSpawnFailed,
    });
    manager.register("a1");
    manager.deliver("a1", { id: "set-failure", text: "hello" });
    session.startResolver?.();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-uncommitted" });

    expect(session.stop).toHaveBeenCalledWith({ reason: "shutdown", forceAfterMs: 2_000 });
    expect(onAgentSession).not.toHaveBeenCalled();
    expect(onRuntimeSessionEstablished).not.toHaveBeenCalled();
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "resume_control_update_failed");
    expect(manager.snapshot().agents.a1.sessionId).toBeNull();
  });

  it("defers a first stall termination when the durable attempt transition fails", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const session = fakeSession("attempt-control-failure");
      session.stop = vi.fn(session.stop.bind(session));
      const onBotAuditEvent = vi.fn();
      let controlWritable = false;
      const recordSessionStall = vi.fn(() => controlWritable);
      const manager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        timeline: {
          ...exactTimelineLifecycleStub(),
          setSession: () => true,
          resumeSessionId: () => null,
          recordSessionStall,
          clearSessionStall: () => true,
          forgetSession: () => true,
        },
        onBotAuditEvent,
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
      });
      manager.start();
      manager.register("a1");
      manager.deliver("a1", { id: "attempt-failure", text: "hello" });
      session.startResolver?.();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });

      now = 100;
      await vi.advanceTimersByTimeAsync(5);
      expect(session.stop).not.toHaveBeenCalled();
      expect(manager.snapshot().agents.a1).toMatchObject({
        status: "running",
        sessionId: "sess-poison",
        stalledSessionId: null,
        stoppingSince: null,
      });
      expect(onBotAuditEvent).toHaveBeenCalledWith(
        "a1",
        expect.objectContaining({
          kind: "error",
          payload: expect.objectContaining({ code: "resume_control_update_failed" }),
        }),
        expect.anything(),
      );

      controlWritable = true;
      now = 105;
      await vi.advanceTimersByTimeAsync(5);
      expect(recordSessionStall).toHaveBeenCalledTimes(2);
      expect(session.stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
      expect(manager.snapshot().agents.a1).toMatchObject({
        status: "stopping",
        stalledSessionId: "sess-poison",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers a repeated stall termination and restores the exact session when fencing fails", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const session = fakeSession("fence-control-failure");
      session.stop = vi.fn(session.stop.bind(session));
      let controlWritable = false;
      const forgetSession = vi.fn(() => controlWritable);
      const manager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        timeline: {
          ...exactTimelineLifecycleStub(),
          setSession: () => true,
          resumeSessionId: () => "sess-poison",
          resolveResumeSession: () => ({
            kind: "session",
            sessionId: "sess-poison",
            stalledSessionId: "sess-poison",
            fencedSessionId: null,
          }),
          recordSessionStall: () => true,
          clearSessionStall: () => true,
          forgetSession,
        },
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
      });
      manager.start();
      manager.register("a1");
      manager.deliver("a1", { id: "fence-failure", text: "hello" });
      session.startResolver?.();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });

      now = 100;
      await vi.advanceTimersByTimeAsync(5);
      expect(session.stop).not.toHaveBeenCalled();
      expect(manager.snapshot().agents.a1).toMatchObject({
        status: "running",
        sessionId: "sess-poison",
        stalledSessionId: "sess-poison",
        stoppingSince: null,
      });

      controlWritable = true;
      now = 105;
      await vi.advanceTimersByTimeAsync(5);
      expect(forgetSession).toHaveBeenCalledTimes(2);
      expect(session.stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
      expect(manager.snapshot().agents.a1).toMatchObject({
        status: "stopping",
        sessionId: null,
        stalledSessionId: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the allowance consumed when its durable clear transition fails", async () => {
    const session = fakeSession("clear-control-failure");
    const clearSessionStall = vi.fn(() => false);
    const manager = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (hooks) => bindFactorySession(hooks, session),
      timeline: {
        ...exactTimelineLifecycleStub(),
        setSession: () => true,
        resumeSessionId: () => "sess-poison",
        resolveResumeSession: () => ({
          kind: "session",
          sessionId: "sess-poison",
          stalledSessionId: "sess-poison",
          fencedSessionId: null,
        }),
        recordSessionStall: () => true,
        clearSessionStall,
        forgetSession: () => true,
      },
    });
    manager.register("a1");
    manager.deliver("a1", { id: "clear-failure", text: "hello" });
    session.startResolver?.();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });
    await session.fire("runtime_event", { kind: "turn_end", sessionId: "sess-poison" });

    expect(clearSessionStall).toHaveBeenCalledWith("a1", "sess-poison");
    expect(manager.snapshot().agents.a1.stalledSessionId).toBe("sess-poison");
  });

  for (const barrierType of ["reset_session", "nap"] as const) {
    it(`aborts ${barrierType} before spawn/stop when its control transition fails`, async () => {
      const sessionFactory = vi.fn(() => fakeSession());
      const manager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory,
        timeline: {
          ...exactTimelineLifecycleStub(),
          setSession: () => true,
          resumeSessionId: () => null,
          recordSessionStall: () => true,
          clearSessionStall: () => true,
          forgetSession: () => false,
        },
      });
      await expect(manager.resetSession("a1", {
        runtimeConfig: {
          version: 1,
          runtime: "codex",
          model: { kind: "default" },
          mode: { kind: "default" },
        },
        launchId: "control-failure",
        rewakePrompt: "rewake",
        barrierType,
      })).rejects.toThrow("resume control could not be persisted");
      expect(sessionFactory).not.toHaveBeenCalled();
      expect(manager.snapshot().agents.a1).toBeUndefined();
    });
  }

  it("allows a genuinely different server session after an exact-session fence", async () => {
    const timelineDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stall-new-session-"));
    try {
      const writer = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
      });
      writer.forgetSession("a1", "stall_recovery", "sess-poison");
      const reader = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
      });
      let launch: LaunchContext | undefined;
      const session = fakeSession("different-session");
      const manager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: { sessionId: "sess-poison" } as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => {
          launch = hooks.ctx;
          return bindFactorySession(hooks, session);
        },
        timeline: reader,
      });
      manager.register("a1", { sessionId: "sess-fresh" });
      manager.deliver("a1", { id: "fresh-candidate", seq: 1, text: "fresh" });
      expect(launch?.config.sessionId).toBe("sess-fresh");
      await manager.stopAll();
    } finally {
      fs.rmSync(timelineDir, { recursive: true, force: true });
    }
  });

  it("rejects a stale fenced server candidate after a newer healthy timeline session", async () => {
    const timelineDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stall-stale-after-fresh-"));
    try {
      const writer = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
      });
      writer.forgetSession("a1", "stall_recovery", "sess-poison");
      writer.setSession("a1", "sess-healthy");
      recordObservedTurn(writer, "a1", "healthy-after-fence", [{
        seq: "#1",
        channel: "/test/general",
        sender: "@tester#0001",
        content: { text: "healthy" },
        time: new Date().toISOString(),
      }]);
      const reader = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
      });
      expect(reader.resolveResumeSession("a1", "codex")).toEqual({
        kind: "session",
        sessionId: "sess-healthy",
        stalledSessionId: null,
        fencedSessionId: "sess-poison",
      });

      let launch: LaunchContext | undefined;
      const session = fakeSession("fresh-after-stale");
      const manager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: { sessionId: "sess-poison" } as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => {
          launch = hooks.ctx;
          return bindFactorySession(hooks, session);
        },
        timeline: reader,
      });
      manager.register("a1", { sessionId: "sess-poison" });
      manager.deliver("a1", { id: "stale-candidate", seq: 2, text: "must fresh-start" });
      expect(launch?.config.sessionId).toBeUndefined();
      await manager.stopAll();
    } finally {
      fs.rmSync(timelineDir, { recursive: true, force: true });
    }
  });

  it("a durable clean marker replenishes the allowance after manager reconstruction", async () => {
    vi.useFakeTimers();
    const timelineDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stall-clean-restart-"));
    try {
      let now = 0;
      const writer = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
        now: () => new Date(now),
      });
      writer.setSession("a1", "sess-healthy");
      recordObservedTurn(writer, "a1", "healthy-clean-marker", [{
        seq: "#1",
        channel: "/test/general",
        sender: "@tester#0001",
        content: { text: "healthy" },
        time: new Date(now).toISOString(),
      }]);
      writer.recordSessionStall("a1", "sess-healthy");
      writer.clearSessionStall("a1", "sess-healthy");

      const reader = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
        now: () => new Date(now),
      });
      const session = fakeSession("clean-restart");
      session.stop = vi.fn(session.stop.bind(session));
      const manager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        timeline: reader,
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
      });
      manager.start();
      manager.register("a1", { sessionId: "sess-healthy" });
      manager.deliver("a1", { id: "healthy-retry", seq: 2, text: "next" });
      session.startResolver?.();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-healthy" });
      expect(manager.snapshot().agents.a1.stalledSessionId).toBeNull();

      now = 100;
      await vi.advanceTimersByTimeAsync(5);
      expect(manager.snapshot().agents.a1.sessionId).toBe("sess-healthy");
      expect(reader.resolveResumeSession("a1", "codex")).toEqual({
        kind: "session",
        sessionId: "sess-healthy",
        stalledSessionId: "sess-healthy",
        fencedSessionId: null,
      });
      await manager.stopAll();
    } finally {
      fs.rmSync(timelineDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("restores a marker-only allowance against a stale server/base session candidate", async () => {
    vi.useFakeTimers();
    const timelineDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stall-marker-only-"));
    try {
      let now = 0;
      const writer = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
        now: () => new Date(now),
      });
      writer.recordSessionStall("a1", "sess-poison");

      // Rebuild the recorder with no in-memory map and no ordinary session row.
      const reader = createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
        now: () => new Date(now),
      });
      expect(reader.resolveResumeSession("a1", "codex")).toEqual({
        kind: "none",
        stalledSessionId: "sess-poison",
        fencedSessionId: null,
      });
      const session = fakeSession("marker-only-restart");
      session.stop = vi.fn(session.stop.bind(session));
      const manager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: { sessionId: "sess-poison" } as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        timeline: reader,
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
      });
      manager.start();
      manager.register("a1", { sessionId: "sess-poison" });
      manager.deliver("a1", { id: "marker-only-wake", seq: 1, text: "resume" });
      session.startResolver?.();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });
      expect(manager.snapshot().agents.a1.stalledSessionId).toBe("sess-poison");

      now = 100;
      await vi.advanceTimersByTimeAsync(5);
      expect(manager.snapshot().agents.a1.sessionId).toBeNull();
      expect(reader.resolveResumeSession("a1", "codex")).toEqual({
        kind: "barrier",
        type: "stall_recovery",
        forgottenSessionId: "sess-poison",
        fencedSessionId: "sess-poison",
      });
      await manager.stopAll();
    } finally {
      fs.rmSync(timelineDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("restores the consumed allowance after rebuilding both manager and timeline recorder", async () => {
    vi.useFakeTimers();
    const timelineDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stall-restart-"));
    try {
      let now = 0;
      const makeRecorder = () => createTimelineRecorder({
        timelineDirFor: () => timelineDir,
        providerFor: () => "codex",
        now: () => new Date(now),
      });
      const firstSession = fakeSession("before-daemon-restart");
      firstSession.stop = vi.fn(firstSession.stop.bind(firstSession));
      const firstRecorder = makeRecorder();
      const firstManager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => bindFactorySession(hooks, firstSession),
        timeline: firstRecorder,
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
      });
      firstManager.start();
      firstManager.register("a1", { sessionId: "sess-poison" });
      firstManager.deliver("a1", { id: "wake-before-restart", seq: 1, text: "first" });
      firstSession.startResolver?.();
      await firstSession.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });
      recordObservedTurn(firstRecorder, "a1", "before-daemon-restart", [{
        seq: "#1",
        channel: "/test/general",
        sender: "@tester#0001",
        content: { text: "first" },
        time: new Date(now).toISOString(),
      }]);
      now = 100;
      await vi.advanceTimersByTimeAsync(5);
      expect(firstRecorder.resolveResumeSession("a1", "codex")).toEqual({
        kind: "session",
        sessionId: "sess-poison",
        stalledSessionId: "sess-poison",
        fencedSessionId: null,
      });
      await firstManager.stopAll();

      // New objects model a real daemon process restart: no AgentState or
      // recorder map survives; only the local timeline directory is reused.
      const secondSession = fakeSession("after-daemon-restart");
      secondSession.stop = vi.fn(secondSession.stop.bind(secondSession));
      const secondRecorder = makeRecorder();
      const secondManager = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: { sessionId: "sess-poison" } as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => bindFactorySession(hooks, secondSession),
        timeline: secondRecorder,
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
      });
      secondManager.start();
      secondManager.register("a1", { sessionId: "sess-poison" });
      secondManager.deliver("a1", { id: "wake-after-restart", seq: 2, text: "second" });
      secondSession.startResolver?.();
      await secondSession.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });
      expect(secondManager.snapshot().agents.a1.stalledSessionId).toBe("sess-poison");

      now = 200;
      await vi.advanceTimersByTimeAsync(5);
      expect(secondSession.stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
      expect(secondManager.snapshot().agents.a1.sessionId).toBeNull();
      expect(secondRecorder.resolveResumeSession("a1", "codex")).toEqual({
        kind: "barrier",
        type: "stall_recovery",
        forgottenSessionId: "sess-poison",
        fencedSessionId: "sess-poison",
      });
      await secondManager.stopAll();
    } finally {
      fs.rmSync(timelineDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("resumes once, then durably fences the poisoned session across every fallback source", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const sessions: FakeSession[] = [];
      const launches: LaunchContext[] = [];
      let resolution = {
        kind: "session" as const,
        sessionId: "sess-poison",
        stalledSessionId: null,
        fencedSessionId: null,
      } as
        | {
            kind: "session";
            sessionId: string;
            stalledSessionId: string | null;
            fencedSessionId: string | null;
          }
        | {
            kind: "barrier";
            type: "stall_recovery";
            forgottenSessionId: string | null;
            fencedSessionId: string | null;
          };
      const setSession = vi.fn();
      const recordSessionStall = vi.fn((_agentId: string, sessionId: string) => {
        resolution = { kind: "session", sessionId, stalledSessionId: sessionId, fencedSessionId: null };
      });
      const forgetSession = vi.fn((_agentId: string, type?: string, forgottenSessionId?: string) => {
        resolution = {
          kind: "barrier",
          type: "stall_recovery",
          forgottenSessionId: forgottenSessionId ?? null,
          fencedSessionId: forgottenSessionId ?? null,
        };
      });
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: { sessionId: "sess-poison" } as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => {
          launches.push(hooks.ctx);
          const session = fakeSession(`instance-${sessions.length + 1}`);
          session.stop = vi.fn(session.stop.bind(session));
          sessions.push(session);
          return bindFactorySession(hooks, session);
        },
        timeline: {
          ...exactTimelineLifecycleStub(),
          setSession,
          resumeSessionId: () => resolution.kind === "session" ? resolution.sessionId : null,
          resolveResumeSession: () => resolution,
          recordSessionStall,
          clearSessionStall: vi.fn(),
          forgetSession,
        },
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
      });
      mgr.start();
      mgr.register("a1", { sessionId: "sess-poison" });
      mgr.deliver("a1", { id: "wake-1", seq: 1, text: "first" });
      sessions[0]!.startResolver?.();
      await sessions[0]!.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });

      now = 100;
      await vi.advanceTimersByTimeAsync(5);
      expect(sessions[0]!.stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
      expect(recordSessionStall).toHaveBeenCalledWith("a1", "sess-poison");
      expect(forgetSession).not.toHaveBeenCalled();

      await sessions[0]!.fire("runtime_event", { kind: "turn_end" });
      mgr.deliver("a1", { id: "wake-2", seq: 2, text: "second" });
      await sessions[0]!.fire("exit", { code: 0, reason: "requested" });
      expect(launches[1]!.config.sessionId).toBe("sess-poison");
      sessions[1]!.startResolver?.();
      await sessions[1]!.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });

      now = 200;
      await vi.advanceTimersByTimeAsync(5);
      expect(forgetSession).toHaveBeenCalledWith("a1", "stall_recovery", "sess-poison");
      expect(mgr.snapshot().agents.a1.sessionId).toBeNull();

      // A death-rattle session event from the fenced owner must not repopulate
      // either the runtime cache or timeline after the barrier was written.
      await sessions[1]!.fire("runtime_event", { kind: "session_init", sessionId: "sess-poison" });
      expect(setSession).toHaveBeenCalledTimes(2);

      // Model the next server wake still carrying its stale session id. The
      // durable barrier must also beat register(), timeline, and base config.
      mgr.register("a1", { sessionId: "sess-poison" });
      mgr.deliver("a1", { id: "wake-3", seq: 3, text: "third" });
      await sessions[1]!.fire("exit", { code: 0, reason: "requested" });
      expect(launches[2]!.config.sessionId).toBeUndefined();
      expect(sessions).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentProcessManager — runtime health callbacks", () => {
  it("ENOENT `error` followed by `exit` reports the failure ONCE with the specific code", async () => {
    const { mgr, session, onRuntimeSpawnFailed } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    // child_process emits `error` first (with ENOENT), then `exit`.
    await session.fire("error", { code: "ENOENT" });
    await session.fire("exit");

    expect(onRuntimeSpawnFailed).toHaveBeenCalledTimes(1);
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "ENOENT");
  });

  it("session.start().catch after `error` does NOT re-report — first path wins", async () => {
    const { mgr, session, onRuntimeSpawnFailed } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("error", { code: "ENOENT" });
    session.startRejector?.({ code: "spawn_threw" });
    // Let the .catch microtask drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(onRuntimeSpawnFailed).toHaveBeenCalledTimes(1);
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "ENOENT");
  });

  it("`exit` alone (no `error`) reports as pre_handshake_exit", async () => {
    const { mgr, session, onRuntimeSpawnFailed } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("exit");

    expect(onRuntimeSpawnFailed).toHaveBeenCalledTimes(1);
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "pre_handshake_exit");
  });

  it("runtime_event marks the session established AND heals the runtime; subsequent error is session-level (no spawn-failed)", async () => {
    const { mgr, session, onRuntimeSpawnFailed, onRuntimeSessionEstablished } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "text", text: "hi" });
    await session.fire("error", { code: "EPIPE" });
    await session.fire("exit");

    expect(onRuntimeSessionEstablished).toHaveBeenCalledWith("codex");
    expect(onRuntimeSpawnFailed).not.toHaveBeenCalled();
  });

  it("heals runtime health only from the typed session_started event", async () => {
    const { mgr, session, onRuntimeSessionEstablished } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "text", text: "one" });
    await session.fire("runtime_event", { kind: "text", text: "two" });
    await session.fire("runtime_event", { kind: "text", text: "three" });

    expect(onRuntimeSessionEstablished).not.toHaveBeenCalled();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    expect(onRuntimeSessionEstablished).toHaveBeenCalledTimes(1);
  });
});

describe("AgentProcessManager — raw runtime line tap (P0-1)", () => {
  it("keeps raw child-process parsing behind the injected logical-session boundary", async () => {
    const { driver, stdout, parseLine } = controllableChildDriver("codex");
    const session = fakeSession();
    const onRuntimeRawLine = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => driver,
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "agent_a",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (hooks) => bindFactorySession(hooks, session),
      onRuntimeRawLine,
    });
    mgr.register("agent_a");
    mgr.deliver("agent_a", { seq: 1, text: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    stdout.write('{"vendor":"field"}\n');

    expect(onRuntimeRawLine).not.toHaveBeenCalled();
    expect(parseLine).not.toHaveBeenCalled();
  });

  it("does not attach the child stdout tap to a custom session factory", async () => {
    const session = fakeSession();
    const sessionFactory = vi.fn(() => session);
    const onRuntimeRawLine = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("custom"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "agent_a",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory,
      onRuntimeRawLine,
    });
    mgr.register("agent_a");
    mgr.deliver("agent_a", { seq: 1, text: "hello" });

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(onRuntimeRawLine).not.toHaveBeenCalled();
  });
});

describe("AgentProcessManager — logging", () => {
  it("logs info on spawn start with agentId + runtime", async () => {
    const logger = stubLogger();
    const { mgr } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    expect(
      logger.calls.info.some(
        ([m, d]) => m === "spawning agent" && (d[0] as any).agentId === "a1" && (d[0] as any).runtime === "codex",
      ),
    ).toBe(true);
  });

  it("logs info on session established (session_init) with agentId/sessionId/runtime", async () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });

    expect(
      logger.calls.info.some(
        ([m, d]) =>
          m === "agent session established" &&
          (d[0] as any).agentId === "a1" &&
          (d[0] as any).sessionId === "s1" &&
          (d[0] as any).runtime === "codex",
      ),
    ).toBe(true);
  });

  it("logs warn on a pre-handshake spawn failure (ENOENT)", async () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("error", { code: "ENOENT" });
    await session.fire("exit");

    expect(
      logger.calls.warn.some(
        ([m, d]) => m === "spawn failed" && (d[0] as any).agentId === "a1" && (d[0] as any).reason === "ENOENT",
      ),
    ).toBe(true);
  });

  it("logs info on session ended with reason=turn_end", async () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "turn_end" });

    expect(
      logger.calls.info.some(
        ([m, d]) =>
          m === "agent session ended" && (d[0] as any).reason === "turn_end" && (d[0] as any).sessionId === "s1",
      ),
    ).toBe(true);
  });

  it("logs info on session ended with reason=exit for an ESTABLISHED session's process exit", async () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("exit");

    expect(
      logger.calls.info.some(
        ([m, d]) => m === "agent session ended" && (d[0] as any).reason === "exit" && (d[0] as any).sessionId === "s1",
      ),
    ).toBe(true);
  });

  it("does NOT log session-ended for a pre-handshake exit (already a spawn-failed warning)", async () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("exit");

    expect(logger.calls.info.some(([m]) => m === "agent session ended")).toBe(false);
  });

  it("logs one logical turn end without observing a backend's hidden physical exit", async () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger }); // fakeDriver's lifecycle.kind is "per_turn"
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "turn_end" });
    const ended = logger.calls.info.filter(([m]) => m === "agent session ended");
    expect(ended).toHaveLength(1);
    expect((ended[0]![1][0] as any).reason).toBe("turn_end");
  });

});

describe("AgentProcessManager — launchId threading", () => {
  // Regression test: `doSpawn` used to leave `ctx.launchId` as whatever
  // `baseContextFor` returned (almost always undefined, since no host wires
  // it there) instead of the launchId tracked from the latest agent:wake —
  // every real spawn's voucher silently collided on cliTransport's "default"
  // fallback path (see plans/fix-credential-proxy-connection-leak.md).
  it("passes the latest agent:wake's launchId into the spawned driver's LaunchContext", async () => {
    let capturedCtx: LaunchContext | undefined;
    const factory: SessionFactory = (hooks) => {
      const { ctx } = hooks;
      capturedCtx = ctx;
      return bindFactorySession(hooks, fakeSession());
    };
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: factory,
      onRuntimeSpawnFailed: vi.fn(),
      onRuntimeSessionEstablished: vi.fn(),
    });
    mgr.register("a1", { launchId: "wake-launch-42" });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    expect(capturedCtx?.launchId).toBe("wake-launch-42");
  });

  it("falls back to baseContextFor's launchId when no wake launchId is tracked", async () => {
    let capturedCtx: LaunchContext | undefined;
    const factory: SessionFactory = (hooks) => {
      const { ctx } = hooks;
      capturedCtx = ctx;
      return bindFactorySession(hooks, fakeSession());
    };
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        launchId: "base-fallback",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: factory,
      onRuntimeSpawnFailed: vi.fn(),
      onRuntimeSessionEstablished: vi.fn(),
    });
    mgr.register("a1"); // no launch metadata at all
    mgr.deliver("a1", { seq: 1, text: "hello" });

    expect(capturedCtx?.launchId).toBe("base-fallback");
  });
});

describe("AgentProcessManager — session race conditions", () => {
  // Regression test: a `stop()`/`terminate_stalled` effect can race a
  // still-in-flight `session.start()` and win — its `exit` handler runs
  // first, deleting the session from the manager's map and dispatching
  // `{type: "exit"}` (FSM → idle) — all BEFORE the original `start()` call
  // finally resolves. Without an identity check, `doSpawn`'s `.then()`
  // would still unconditionally dispatch `{type: "spawned"}` afterward,
  // reviving the FSM into "running" for a session nobody tracks anymore —
  // any later wake would then just queue forever behind a dead spawn
  // instead of triggering a fresh one.
  it("a stop that races and wins against an in-flight start() does not let start()'s later resolution revive the FSM into 'running'", async () => {
    const logger = stubLogger();
    const sessions: FakeSession[] = [];
    const factory: SessionFactory = (hooks) => {
      const s = fakeSession();
      sessions.push(s);
      return bindFactorySession(hooks, s);
    };
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: factory,
      logger,
    });
    mgr.register("a1");

    mgr.deliver("a1", { seq: 1, text: "hello" }); // spawns sessions[0]; start() left pending
    const session1 = sessions[0]!;

    // The race: exit fires (as it would from a stop()/terminate_stalled
    // effect) WHILE start() is still pending.
    await session1.fire("exit");
    // Only now does the slow start() finally resolve.
    session1.startResolver?.();
    await Promise.resolve();
    await Promise.resolve();

    // A later wake must trigger a genuinely fresh spawn.
    mgr.deliver("a1", { seq: 2, text: "are you there" });

    expect(sessions).toHaveLength(2);
    const spawnLogs = logger.calls.info.filter(([m]) => m === "spawning agent");
    expect(spawnLogs).toHaveLength(2);
  });

  it.each(["reset", "model_switch"] as const)(
    "%s keeps an exit-driven replacement session when the old stop resolves late",
    async (restartKind) => {
      let now = 0;
      const oldSession = fakeSession("restart-race-old");
      const replacementSession = fakeSession("restart-race-new");
      const created: FakeSession[] = [];
      const factory: SessionFactory = () => {
        const session = created.length === 0 ? oldSession : replacementSession;
        created.push(session);
        return session;
      };
      let releaseOldStop!: () => void;
      vi.spyOn(oldSession, "stop").mockImplementation(() => new Promise((resolve) => {
        releaseOldStop = () => resolve({ status: "accepted", requestId: "restart-race-stop" });
      }));
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: factory,
        now: () => now,
        resetStuckThresholdMs: 100,
      });
      const runtimeConfig: RuntimeConfig = {
        version: 1,
        runtime: "codex",
        model: { kind: "default" },
        mode: { kind: "default" },
      };
      const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

      mgr.register("a1", { runtimeConfig, launchId: "wake-launch" });
      mgr.deliver("a1", { seq: 1, text: "before restart" });
      oldSession.startResolver?.();
      await flush();
      expect(mgr.snapshot().agents.a1).toMatchObject({ status: "running", resetting: false });

      const restart = restartKind === "reset"
        ? mgr.resetSession("a1", { runtimeConfig, launchId: "restart-launch", rewakePrompt: "rewake" })
        : mgr.switchModel("a1", { runtimeConfig, launchId: "restart-launch", rewakePrompt: "rewake" });

      await oldSession.fire("exit", { reason: "requested", code: 0, signal: null });
      await flush();
      expect(created).toEqual([oldSession, replacementSession]);

      releaseOldStop();
      await restart;
      replacementSession.startResolver?.();
      await flush();
      expect(mgr.snapshot().agents.a1).toMatchObject({ status: "running", resetting: false });

      const send = vi.spyOn(replacementSession, "send");
      mgr.deliver("a1", { seq: 2, text: "after restart" });
      expect(send).toHaveBeenCalledTimes(1);
      await replacementSession.fire("runtime_event", { kind: "turn_end" });

      now = 1_000;
      const effects = (mgr as unknown as {
        dispatch(event: { type: "tick"; nowMs: number }): Array<{ type: string }>;
      }).dispatch({ type: "tick", nowMs: now });
      expect(effects.map((effect) => effect.type)).not.toContain("terminate_stalled");
      expect(effects.map((effect) => effect.type)).not.toContain("force_exit");
      expect(mgr.snapshot().agents.a1).toMatchObject({ status: "running", resetting: false });
    },
  );

  it("does NOT double-log session-ended when the process exit follows an explicit stop/terminate_stalled", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const logger = stubLogger();
      const { mgr, session } = makeManager({ logger, now: () => currentTime, tickIntervalMs: 5, staleThresholdMs: 100 });
      mgr.start();
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });

      currentTime = 200;
      await vi.advanceTimersByTimeAsync(10);
      // The stall watchdog issued session.stop() — simulate the underlying
      // process actually exiting shortly after.
      await session.fire("exit");

      const ended = logger.calls.info.filter(([m]) => m === "agent session ended");
      expect(ended).toHaveLength(1);
      expect((ended[0]![1][0] as any).reason).toBe("terminate_stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs info on session ended with reason=terminate_stalled from the stall watchdog", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const logger = stubLogger();
      const { mgr, session } = makeManager({ logger, now: () => currentTime, tickIntervalMs: 5, staleThresholdMs: 100 });
      mgr.start();
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });

      currentTime = 200;
      await vi.advanceTimersByTimeAsync(10);

      expect(
        logger.calls.info.some(
          ([m, d]) =>
            m === "agent session ended" &&
            (d[0] as any).reason === "terminate_stalled" &&
            (d[0] as any).sessionId === "s1",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews only the exact root lease from payload-free heartbeats and stalls when they stop", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const { mgr, session } = makeManager({ now: () => currentTime, tickIntervalMs: 5 });
      const baseSnapshot = session.snapshot.bind(session);
      session.snapshot = () => ({
        ...baseSnapshot(),
        diagnostics: {
          deliveryPhase: "working",
          turnSilence: {
            nativeIdleTimeoutMs: 80,
            daemonGraceMs: 20,
            recoveryGraceMs: 50,
            maxRecoveryExtensions: 1,
            normalBudgetMs: 100,
          },
          metrics: {
            physicalOpenCount: 1,
            turnCount: 1,
            commandAdmissionCount: 1,
            commandAdmissionLatencyTotalMs: 0,
            queueDwellCount: 0,
            queueDwellTotalMs: 0,
            sseReconnectCount: 0,
            resumeOutcome: "not_requested",
            terminalOwnerKind: "transport_request",
          },
        },
      });
      const stop = vi.spyOn(session, "stop");
      mgr.start();
      mgr.deliver("a1", { id: "heartbeat-stall", seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await Promise.resolve();

      currentTime = 90;
      await session.pushAgentEvent({ type: "work_heartbeat", turnId: "test-turn" });
      expect(mgr.snapshot().agents.a1).toMatchObject({
        lastNativeActivityAt: 90,
        lastNativeActivityKind: "internal_progress",
        runtimePhase: "inference",
      });
      expect(mgr.snapshot().agents.a1.execution.lease).toMatchObject({ nativeDeadlineAt: 190 });

      currentTime = 189;
      await vi.advanceTimersByTimeAsync(5);
      expect(stop).not.toHaveBeenCalled();
      currentTime = 190;
      await vi.advanceTimersByTimeAsync(5);
      expect(stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects stale heartbeat ownership and maps complete semantic events to typed native evidence", async () => {
    let currentTime = 0;
    const { mgr, session } = makeManager({ now: () => currentTime });
    mgr.deliver("a1", { id: "typed-evidence", seq: 1, text: "hello" });
    session.startResolver?.();
    await Promise.resolve();
    await Promise.resolve();
    const internal = mgr as unknown as {
      activeSpawnState: Map<string, object>;
      onAgentEvent(agentId: string, event: AgentEvent<BuiltinBackendSpecs, "codex">, runtimeId: "codex", owner: object): void;
    };
    const owner = internal.activeSpawnState.get("a1")!;

    currentTime = 40;
    internal.onAgentEvent("a1", {
      type: "work_heartbeat",
      turnId: "test-turn",
      sequence: 100,
      sessionInstanceId: "stale-epoch",
      at: currentTime,
    }, "codex", owner);
    await session.pushAgentEvent({ type: "work_heartbeat", turnId: "child-turn" });
    await session.pushAgentEvent({
      type: "diagnostic",
      turnId: "test-turn",
      severity: "info",
      source: "test",
      message: "observational only",
    });
    expect(mgr.snapshot().agents.a1).toMatchObject({
      lastNativeActivityAt: 0,
      lastNativeActivityKind: "turn_started",
    });

    await session.pushAgentEvent({
      type: "assistant_reasoning_completed",
      turnId: "test-turn",
      text: "reasoning",
      truncated: false,
    });
    expect(mgr.snapshot().agents.a1).toMatchObject({
      lastNativeActivityAt: 40,
      lastNativeActivityKind: "thinking",
    });
    currentTime = 50;
    await session.pushAgentEvent({
      type: "assistant_message_completed",
      turnId: "test-turn",
      text: "answer",
      truncated: false,
    });
    expect(mgr.snapshot().agents.a1).toMatchObject({
      lastNativeActivityAt: 50,
      lastNativeActivityKind: "text",
    });
    await mgr.stopAll();
  });

  it("does not let turn-scoped telemetry or diagnostics refresh the native silence deadline", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const { mgr, session } = makeManager({ now: () => currentTime, tickIntervalMs: 5 });
      const baseSnapshot = session.snapshot.bind(session);
      session.snapshot = () => ({
        ...baseSnapshot(),
        diagnostics: {
          deliveryPhase: "working",
          turnSilence: {
            nativeIdleTimeoutMs: 80,
            daemonGraceMs: 20,
            recoveryGraceMs: 50,
            maxRecoveryExtensions: 1,
            normalBudgetMs: 100,
          },
          metrics: {
            physicalOpenCount: 1,
            turnCount: 1,
            commandAdmissionCount: 1,
            commandAdmissionLatencyTotalMs: 0,
            queueDwellCount: 0,
            queueDwellTotalMs: 0,
            sseReconnectCount: 0,
            resumeOutcome: "not_requested",
            terminalOwnerKind: "transport_request",
          },
        },
      });
      const stop = vi.spyOn(session, "stop");
      mgr.start();
      mgr.deliver("a1", { id: "telemetry-stall", seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await Promise.resolve();

      currentTime = 90;
      await session.pushAgentEvent({
        type: "diagnostic",
        turnId: "test-turn",
        severity: "info",
        source: "heartbeat",
        message: "still here",
      } as never);
      await session.pushAgentEvent({
        type: "rate_limits",
        turnId: "test-turn",
        source: "account",
        details: { remaining: 1 },
      } as never);
      await session.pushAgentEvent({
        type: "token_usage",
        turnId: "test-turn",
        source: "account",
        usage: {},
        details: { sampled: true },
      } as never);

      expect(mgr.snapshot().agents.a1).toMatchObject({
        lastNativeActivityAt: 0,
        lastNativeActivityKind: "turn_started",
      });
      currentTime = 100;
      await vi.advanceTimersByTimeAsync(5);
      expect(stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
      expect(mgr.snapshot().agents.a1.status).toBe("stopping");
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps backend retry activity to one bounded recovery extension", async () => {
    let currentTime = 0;
    const { mgr, session } = makeManager({ now: () => currentTime });
    const baseSnapshot = session.snapshot.bind(session);
    session.snapshot = () => ({
      ...baseSnapshot(),
      diagnostics: {
        deliveryPhase: "working",
        turnSilence: {
          nativeIdleTimeoutMs: 80,
          daemonGraceMs: 20,
          recoveryGraceMs: 50,
          maxRecoveryExtensions: 1,
          normalBudgetMs: 100,
        },
        metrics: {
          physicalOpenCount: 1,
          turnCount: 1,
          commandAdmissionCount: 1,
          commandAdmissionLatencyTotalMs: 0,
          queueDwellCount: 0,
          queueDwellTotalMs: 0,
          sseReconnectCount: 0,
          resumeOutcome: "not_requested",
          terminalOwnerKind: "transport_request",
        },
      },
    });
    mgr.deliver("a1", { id: "retry", seq: 1, text: "hello" });
    session.startResolver?.();
    await Promise.resolve();
    await Promise.resolve();

    currentTime = 90;
    await session.pushAgentEvent({
      type: "recovery",
      turnId: "test-turn",
      stage: "retrying",
      source: "codex_stream",
    } as never);
    expect(mgr.snapshot().agents.a1).toMatchObject({
      lastNativeActivityAt: 90,
      lastNativeActivityKind: "recovery",
      runtimePhase: "recovery",
    });
    expect(mgr.snapshot().agents.a1.execution.lease).toMatchObject({
      nativeDeadlineAt: 140,
      recoveryExtensionsUsed: 1,
    });

    currentTime = 135;
    await session.pushAgentEvent({
      type: "recovery",
      turnId: "test-turn",
      stage: "recovered",
      source: "pi_auto_retry",
    } as never);
    expect(mgr.snapshot().agents.a1).toMatchObject({
      lastNativeActivityAt: 135,
      lastNativeActivityKind: "recovery",
      runtimePhase: "inference",
    });
    expect(mgr.snapshot().agents.a1.execution.lease).toMatchObject({
      nativeDeadlineAt: 235,
      recoveryExtensionsUsed: 1,
    });

    currentTime = 200;
    await session.pushAgentEvent({
      type: "recovery",
      turnId: "test-turn",
      stage: "retrying",
      source: "codex_stream",
    } as never);
    expect(mgr.snapshot().agents.a1.execution.lease).toMatchObject({
      nativeDeadlineAt: 235,
      recoveryExtensionsUsed: 1,
    });
    await mgr.stopAll();
  });

  it("turn-correlated internal progress renews the execution lease after a false terminal", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const logger = stubLogger();
      const { mgr, session } = makeManager({ logger, now: () => currentTime, tickIntervalMs: 5, staleThresholdMs: 100 });
      mgr.start();
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      currentTime = 10;
      await session.fire("runtime_event", { kind: "turn_end" });
      expect(mgr.snapshot().agents.a1).toMatchObject({ turnActive: false, idleSince: 10 });

      currentTime = 50;
      await session.fire("runtime_event", { kind: "internal_progress", source: "claude_system", itemType: "stream_event" });
      currentTime = 150;
      await session.fire("runtime_event", { kind: "internal_progress", source: "claude_system", itemType: "stream_event" });

      currentTime = 200;
      await vi.advanceTimersByTimeAsync(10);

      expect(mgr.snapshot().agents.a1).toMatchObject({ status: "running", turnActive: true, idleSince: null });
      expect(logger.calls.info.some(([m, d]) => m === "agent session ended" && (d[0] as any).reason === "terminate_stalled")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs info on session ended with reason=stopped from the idle-hibernation tick", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const logger = stubLogger();
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      const factory: SessionFactory = (hooks) => bindFactorySession(hooks, session);
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: factory,
        logger,
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
      });
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" });

      mgr.start();
      currentTime = 100;
      await vi.advanceTimersByTimeAsync(10);

      expect(
        logger.calls.info.some(
          ([m, d]) =>
            m === "agent session ended" && (d[0] as any).reason === "stopped" && (d[0] as any).sessionId === "s1",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force_exits an agent wedged in `stopping` when its stop produced no exit (batch L3 black-hole escape)", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const stopSpy = vi.fn();
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      session.stop = stopSpy; // spy: was the process asked to die?
      // A live session handle is present → force_exit takes the kill path
      // (session.stop), not the orphan-warn path.
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        stoppingStuckThresholdMs: 100,
      });
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" });
      mgr.start();

      // Idle-timeout tick → status=stopping, issues a stop. Crucially we DO NOT
      // fire the session's `exit` — the wedge: stop was requested, exit never came.
      currentTime = 100;
      await vi.advanceTimersByTimeAsync(10);
      const stopCallsAfterIdle = stopSpy.mock.calls.length; // idle-timeout stop

      // Now sit in `stopping` past the stopping-stuck threshold with NO exit.
      currentTime = 300; // 300 - 100(stoppingSince) = 200 >= 100
      await vi.advanceTimersByTimeAsync(10);

      // force_exit fired: the handler force-killed (a 2nd stop) AND dispatched a
      // synthetic exit that drove the FSM out of `stopping`.
      expect(stopSpy.mock.calls.length).toBeGreaterThan(stopCallsAfterIdle);
      expect(mgr.snapshot().agents["a1"]?.status).not.toBe("stopping");
    } finally {
      vi.useRealTimers();
    }
  });

  it("force_exit delegates bounded teardown to the logical session without reading a pid", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      const stopSpy = vi.fn().mockRejectedValue(new Error("stop rejected"));
      session.stop = stopSpy;
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        stoppingStuckThresholdMs: 100,
      });
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" });
      mgr.start();
      currentTime = 100;
      await vi.advanceTimersByTimeAsync(10); // → stopping

      currentTime = 300;
      await vi.advanceTimersByTimeAsync(10); // → force_exit through AgentSession.stop

      expect(stopSpy).toHaveBeenCalled();
      expect(mgr.snapshot().agents["a1"]?.status).not.toBe("stopping"); // escaped via synthetic exit
    } finally {
      vi.useRealTimers();
    }
  });

  it("force_exit with neither session handle nor recorded pid warns and does not crash (SDK-style)", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const logger = stubLogger();
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession(); // no pid set → getter returns undefined → recorded pid stays null
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        logger,
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        stoppingStuckThresholdMs: 100,
      });
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" });
      mgr.start();
      currentTime = 100;
      await vi.advanceTimersByTimeAsync(10); // → stopping
      (mgr as unknown as { sessions: Map<string, unknown> }).sessions.delete("a1"); // no handle
      currentTime = 300;
      await vi.advanceTimersByTimeAsync(10); // → force_exit: no session, no pid

      // Warned about the unkillable orphan, and still escaped stopping (no crash).
      expect(logger.calls.warn.some(([m]) => typeof m === "string" && m.includes("logical session handle is already absent"))).toBe(true);
      expect(mgr.snapshot().agents["a1"]?.status).not.toBe("stopping");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentProcessManager — onAgentActivity (derived activity reporting)", () => {
  it.each(["turn-before-spawn", "spawn-before-turn"] as const)(
    "publishes one running edge without a transient idle when admission order is %s",
    async (order) => {
      const session = fakeSession(`activity-${order}`);
      const onAgentActivity = vi.fn();
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        onAgentActivity,
      });
      const dispatch = (event: Record<string, unknown>) => (
        mgr as unknown as { dispatch(value: unknown): void }
      ).dispatch(event);

      mgr.register("a1");
      mgr.deliver("a1", { id: "root", text: "hello" });
      expect(onAgentActivity.mock.calls.map((call) => call[0])).toEqual([
        { agentId: "a1", state: "starting" },
      ]);

      const turnStarted = {
        type: "turn_started",
        agentId: "a1",
        sessionInstanceId: session.sessionInstanceId,
        turnId: "root-turn",
        commandIds: ["root"],
        nowMs: 1,
      };
      if (order === "turn-before-spawn") {
        dispatch(turnStarted);
        dispatch({ type: "spawned", agentId: "a1", nowMs: 2 });
      } else {
        dispatch({ type: "spawned", agentId: "a1", nowMs: 1 });
        dispatch({
          type: "admission_settled",
          agentId: "a1",
          sessionInstanceId: session.sessionInstanceId,
          commandId: "root",
          outcome: "accepted",
        });
        dispatch(turnStarted);
      }

      expect(onAgentActivity.mock.calls.map((call) => call[0])).toEqual([
        { agentId: "a1", state: "starting" },
        { agentId: "a1", state: "running" },
      ]);
    },
  );

  it("fires exactly once per real derived transition — the turn_end→idle transition fires once, not re-fired while the FSM stays running until hibernation", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
        supportsStdinNotification: true,
        busyDeliveryMode: "direct",
      } as Driver;
      const session = fakeSession();
      const factory: SessionFactory = (hooks) => bindFactorySession(hooks, session);
      const onAgentActivity = vi.fn();
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: factory,
        onAgentActivity,
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
      });
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hello" }); // idle -> starting
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // spawned -> running
      await session.fire("runtime_event", { kind: "turn_end" }); // running,turnActive=false -> derived idle

      mgr.start();
      currentTime = 100; // past idleTimeoutMs — FSM flips running->stopping via hibernation
      await vi.advanceTimersByTimeAsync(10);

      // turn_end's derived "idle" already fired once; the later hibernation
      // stop flips the raw FSM status to "stopping" — a real derived
      // transition too — but must NOT re-fire a second "idle".
      expect(onAgentActivity.mock.calls.map((c) => c[0])).toEqual([
        { agentId: "a1", state: "starting" },
        { agentId: "a1", state: "running" },
        { agentId: "a1", state: "idle" },
        { agentId: "a1", state: "stopping" },
      ]);
      expect(onAgentActivity.mock.calls.filter((c) => c[0].state === "idle")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("full cycle on a persistent agent — wake, spawned, turn_end, re-wake, turn_end — fires the right derived state at each step", async () => {
    const persistentDriver = {
      ...fakeDriver("codex"),
      lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      supportsStdinNotification: true,
      busyDeliveryMode: "direct",
    } as Driver;
    const session = fakeSession();
    const factory: SessionFactory = (hooks) => bindFactorySession(hooks, session);
    const onAgentActivity = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => persistentDriver,
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: factory,
      onAgentActivity,
    });
    mgr.register("a1");
    mgr.deliver("a1", { seq: 1, text: "hello" }); // idle -> starting
    session.startResolver?.();
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // -> running
    await session.fire("runtime_event", { kind: "turn_end" }); // -> idle (derived)

    mgr.deliver("a1", { seq: 2, text: "second turn" }); // re-wake: running,turnActive=false -> running
    await session.fire("runtime_event", { kind: "turn_end" }); // -> idle again

    expect(onAgentActivity.mock.calls.map((c) => c[0])).toEqual([
      { agentId: "a1", state: "starting" },
      { agentId: "a1", state: "running" },
      { agentId: "a1", state: "idle" },
      { agentId: "a1", state: "running" },
      { agentId: "a1", state: "idle" },
    ]);
  });

  it("liveAgentActivities / agentActivity report the DERIVED state (running while a turn is in flight, idle once it ends) — the level-triggered source for resync + heartbeat re-assert", async () => {
    const persistentDriver = {
      ...fakeDriver("codex"),
      lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      supportsStdinNotification: true,
      busyDeliveryMode: "direct",
    } as Driver;
    const session = fakeSession();
    const mgr = new AgentProcessManager({
      driverFor: () => persistentDriver,
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (hooks) => bindFactorySession(hooks, session),
    });
    mgr.register("a1");
    // register alone: known but not running ⇒ idle.
    expect(mgr.agentActivity("a1")).toBe("idle");

    mgr.deliver("a1", { seq: 1, text: "hello" });
    session.startResolver?.();
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // -> running, turnActive
    expect(mgr.agentActivity("a1")).toBe("running");
    expect(mgr.liveAgentActivities()).toEqual([{ agentId: "a1", state: "running" }]);

    await session.fire("runtime_event", { kind: "turn_end" }); // running, !turnActive, empty inbox -> idle
    expect(mgr.agentActivity("a1")).toBe("idle");
    expect(mgr.liveAgentActivities()).toEqual([{ agentId: "a1", state: "idle" }]);

    // Unknown agent has no derivable activity.
    expect(mgr.agentActivity("nope")).toBeNull();
  });

  it("a tick that stalls/hibernates two different agents at once fires onAgentActivity for both", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
        supportsStdinNotification: true,
        busyDeliveryMode: "direct",
      } as Driver;
      const sessionA = fakeSession();
      const sessionB = fakeSession();
      const factory: SessionFactory = (hooks) => bindFactorySession(
        hooks,
        hooks.agentId === "a1" ? sessionA : sessionB,
      );
      const onAgentActivity = vi.fn();
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: (agentId: string) => ({
          workingDirectory: "/tmp",
          agentId,
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: factory,
        onAgentActivity,
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
      });
      mgr.register("a1");
      mgr.register("b1");
      mgr.deliver("a1", { seq: 1, text: "hello" });
      mgr.deliver("b1", { seq: 1, text: "hello" });
      sessionA.startResolver?.();
      sessionB.startResolver?.();
      await Promise.resolve();
      await sessionA.fire("runtime_event", { kind: "session_init", sessionId: "sa" });
      await sessionA.fire("runtime_event", { kind: "turn_end" });
      await sessionB.fire("runtime_event", { kind: "session_init", sessionId: "sb" });
      await sessionB.fire("runtime_event", { kind: "turn_end" });
      onAgentActivity.mockClear();

      mgr.start();
      currentTime = 100; // both past idleTimeoutMs
      await vi.advanceTimersByTimeAsync(10);

      // Hibernation flips both agents' FSM status to "stopping" in the SAME
      // tick — the derived value changes for both (idle -> stopping), so a
      // single dispatch must fire onAgentActivity for each independently.
      expect(onAgentActivity.mock.calls.map((c) => c[0])).toEqual(
        expect.arrayContaining([
          { agentId: "a1", state: "stopping" },
          { agentId: "b1", state: "stopping" },
        ]),
      );
      expect(onAgentActivity).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("register alone (no wake) never fires onAgentActivity", async () => {
    const onAgentActivity = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (hooks) => bindFactorySession(hooks, fakeSession()),
      onAgentActivity,
    });
    mgr.register("a1");
    expect(onAgentActivity).not.toHaveBeenCalled();
  });
});

describe("truncateThinking", () => {
  it("returns text unchanged when under the byte budget", async () => {
    const { text, truncated, chars } = truncateThinking("short");
    expect(text).toBe("short");
    expect(truncated).toBe(false);
    expect(chars).toBe(5);
  });

  it("truncates > 4KB text and reports the original char count", async () => {
    const long = "a".repeat(5000);
    const { text, truncated, chars } = truncateThinking(long);
    expect(truncated).toBe(true);
    expect(chars).toBe(5000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("never splits a multi-byte UTF-8 sequence", async () => {
    // Build a string whose 4096-byte boundary lands inside a 4-byte emoji.
    // Each 😀 is 4 bytes. 1023 emojis = 4092 bytes; add "a" to get to 4093;
    // then more emojis to push past 4096 mid-glyph.
    const emoji = "😀";
    const prefix = "a".repeat(4093) + emoji + emoji + emoji;
    const { text } = truncateThinking(prefix);
    // The returned string must be decodable — i.e. no replacement chars
    // introduced by a mid-codepoint cut. `Buffer.from(text, "utf8")` and
    // reading it back should round-trip.
    expect(text).toBe(Buffer.from(text, "utf8").toString("utf8"));
  });
});

describe("AgentProcessManager — bot audit event emission", () => {
  it("contains audit observer failures for reasoning and tool-start events", async () => {
    const logger = stubLogger();
    const onBotAuditEvent = vi.fn(() => { throw new Error("observer failed"); });
    const { mgr, session } = makeManager({ logger, onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await expect(session.fire("runtime_event", { kind: "thinking", text: "completed reasoning" }))
      .resolves.toBeUndefined();
    await expect(session.fire("runtime_event", { kind: "tool_call", name: "Read", input: { file_path: "/x" } }))
      .resolves.toBeUndefined();

    expect(logger.calls.debug.map(([message]) => message)).toEqual(expect.arrayContaining([
      "audit emit failed (thinking)",
      "audit emit failed (tool_call)",
    ]));
  });

  it("emits completed reasoning with truncated+chars fields immediately", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "thinking", text: "think about it" });

    expect(onBotAuditEvent).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({
        kind: "thinking",
        payload: expect.objectContaining({
          text: "think about it",
          truncated: false,
          chars: 14,
        }),
      }),
      expect.objectContaining({ sessionId: null, launchId: null })
    );
  });

  it("emits one bounded audit row per completed reasoning item and drops empty items", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "thinking", text: "" });
    await session.fire("runtime_event", { kind: "thinking", text: "let me count" });
    await session.fire("runtime_event", { kind: "thinking", text: "" });

    const thinkingCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "thinking"
    );
    expect(thinkingCalls).toHaveLength(1);
    expect(thinkingCalls[0]![1]).toEqual(
      expect.objectContaining({
        kind: "thinking",
        payload: expect.objectContaining({ text: "let me count", chars: 12 }),
      })
    );
  });

  it("emits `tool_call` with canonical name + resolved target", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "tool_call", name: "Read", input: { file_path: "/etc/passwd" } });

    expect(onBotAuditEvent).toHaveBeenCalledWith(
      "a1",
      { kind: "tool_call", payload: { name: "read", target: "/etc/passwd" } },
      expect.objectContaining({ sessionId: null, launchId: null })
    );
  });

  it("carries sessionId (populated after session_init) into the context arg", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s_abc" });
    await session.fire("runtime_event", { kind: "tool_call", name: "Read", input: { file_path: "/x" } });

    expect(onBotAuditEvent).toHaveBeenCalledWith(
      "a1",
      { kind: "tool_call", payload: { name: "read", target: "/x" } },
      { sessionId: "s_abc", launchId: null }
    );
  });

  it("DROPS bash-family tool_call whose command is `alook <sub>` for BOTH capitalized and lowercase names", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", {
      kind: "tool_call",
      name: "Bash",
      input: { command: "alook inbox pull --max 5" },
    });
    await session.fire("runtime_event", {
      kind: "tool_call",
      name: "bash",
      input: { command: "  alook message send @gus hi" },
    });
    await session.fire("runtime_event", {
      kind: "tool_call",
      name: "Bash",
      input: { command: "alook" },
    });
    await session.fire("runtime_event", {
      kind: "tool_call",
      name: "shell",
      input: { command: "alook inbox pull" },
    });

    const bashCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call"
    );
    expect(bashCalls).toHaveLength(0);
  });

  it("EMITS bash tool_call for non-alook shell work with canonical `bash` name + target", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "rm -rf /tmp/xxx" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "bash", input: { command: "sed -i '' '/pattern/d' todo.md" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "echo -n > todo.md" } });

    const bashCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call"
    );
    expect(bashCalls).toHaveLength(3);
    for (const call of bashCalls) {
      expect((call![1] as { payload: { name: string } }).payload.name).toBe("bash");
    }
    expect((bashCalls[0]![1] as { payload: { target?: string } }).payload.target).toBe("rm -rf /tmp/xxx");
    expect((bashCalls[1]![1] as { payload: { target?: string } }).payload.target).toBe("sed -i '' '/pattern/d' todo.md");
    expect((bashCalls[2]![1] as { payload: { target?: string } }).payload.target).toBe("echo -n > todo.md");
  });

  it("truncates a long Bash target to <= 200 chars with an ellipsis", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    const long = "echo " + "x".repeat(400);
    await session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: long } });

    const [call] = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call",
    );
    const target = (call![1] as { payload: { target?: string } }).payload.target!;
    expect(target.length).toBeLessThanOrEqual(200);
    expect(target.endsWith("…")).toBe(true);
  });

  it("emits bash tool_call without `target` when input has no command string", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: {} });

    const [call] = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call",
    );
    expect((call![1] as { payload: unknown }).payload).toEqual({ name: "bash" });
  });

  it("canonicalizes tool names on tool_calls (Edit → edit, MultiEdit → edit, Grep → grep, Glob → glob) with resolved target", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "tool_call", name: "Edit", input: { file_path: "/x" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "Write", input: { file_path: "/y" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "MultiEdit", input: { file_path: "/z" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "Grep", input: { pattern: "TODO" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "Glob", input: { pattern: "**/*.ts" } });

    const payloads = onBotAuditEvent.mock.calls
      .filter(([, ev]) => (ev as { kind?: string })?.kind === "tool_call")
      .map(([, ev]) => (ev as { payload: { name: string; target?: string } }).payload);
    expect(payloads).toEqual([
      { name: "edit", target: "/x" },
      { name: "write", target: "/y" },
      { name: "edit", target: "/z" },
      { name: "grep", target: "TODO" },
      { name: "glob", target: "**/*.ts" },
    ]);
  });

  it("does NOT emit for non-audit event kinds (session_init, text, turn_end)", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "text", text: "hi human" });
    await session.fire("runtime_event", { kind: "turn_end" });

    expect(onBotAuditEvent).not.toHaveBeenCalled();
  });

  it("payload never contains extra fields beyond {name, target?} (T11)", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "tool_call", name: "Edit", input: { file_path: "/x", oldText: "a", newText: "b", edits: [] } });
    await session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "rm x", stdin: "secret" } });

    const payloads = onBotAuditEvent.mock.calls
      .filter(([, ev]) => (ev as { kind?: string })?.kind === "tool_call")
      .map(([, ev]) => (ev as { payload: Record<string, unknown> }).payload);
    for (const p of payloads) {
      const keys = Object.keys(p);
      for (const k of keys) expect(["name", "target"]).toContain(k);
    }
  });
});

describe("AgentProcessManager — error audit emission", () => {
  it("emits an `error` row on a pre-handshake exit (spawn scope)", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("exit");

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]![1] as { payload: { scope: string; code: string } }).payload).toEqual(
      expect.objectContaining({ scope: "spawn", code: "pre_handshake_exit" }),
    );
  });

  it("emits an `error` row for a runtime `{kind:'error'}` event (runtime scope) and does NOT count it as progress", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    // Establish first so the error is session-level (runtime), not spawn.
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "error", message: "rate limited: 429 Too Many Requests" });

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    const payload = (errCalls[0]![1] as { payload: { scope: string; code: string; message: string } }).payload;
    expect(payload.scope).toBe("runtime");
    expect(payload.code).toBe("runtime_error");
    expect(payload.message).toContain("429");
  });

  it("emits the failed turn result message as a runtime error", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr } = makeManager({ onBotAuditEvent });
    fireManagedTurnFailure(mgr, "turn failed after the provider stopped");

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]![1] as { payload: { message: string } }).payload.message)
      .toContain("turn failed after the provider stopped");
  });

  it("does NOT emit a `runtime_error` row for the death rattle of a session an intentional kill superseded", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    // Establish, then enter the reset/nap kill window before the dying
    // process fires its interrupted-turn "death rattle" error. `markResetting`
    // marks THIS live session's per-session state `superseded`, so the gate
    // suppresses its rattle by session identity (not the agent-level reset
    // flag) — the reborn session, a fresh state, would still surface its own.
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    mgr.markResetting("a1");
    await session.fire("runtime_event", { kind: "error", message: "turn interrupted" });

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(0);
  });

  it("DOES emit a `runtime_error` for a REBORN (non-superseded) session's error even while the agent's reset window is still open — batch C reader-C fix", async () => {
    // Batch C keeps `resetting` open across the respawn until the reborn
    // process reaches `running`, so the reborn session is live while the reset
    // window is still open. Gating the audit on the agent-level reset window
    // would swallow the reborn session's OWN genuine error. The gate instead
    // keys on per-session identity: only a SUPERSEDED (outgoing/killed)
    // session's rattle is suppressed. A reborn session gets a fresh state
    // (`superseded=false`), so its real error must SURFACE.
    //
    // The fake harness reuses one session object; we assert the gate's
    // behavior directly by driving the typed event consumer with the reborn session's
    // (non-superseded) identity — mirroring what the real per-session
    // subscriber closure passes.
    const onBotAuditEvent = vi.fn();
    const { mgr } = makeManager({ onBotAuditEvent });

    // Reborn session identity → superseded=false (the subscriber passes its own
    // session state's flag). A genuine startup error must be audited.
    fireManagedError(mgr, "reborn hit a rate limit", false);

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]![1] as { payload: { message: string } }).payload.message).toContain("rate limit");
  });

  it("does NOT emit for a SUPERSEDED session's death rattle (the outgoing session an intentional kill interrupted) — batch C reader-C fix", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr } = makeManager({ onBotAuditEvent });
    // Superseded session identity → its interrupted-turn error is teardown
    // noise, suppressed regardless of the agent's status.
    fireManagedError(mgr, "turn interrupted", true);

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(0);
  });

  it("adds a stuck-reset correlation trace for a reborn error while the reset window is wedged — WITHOUT suppressing the error (batch D)", async () => {
    // Batch D: the stuck-reset trace is purely additive. A reborn (non-
    // superseded) session's genuine error must STILL surface as an audit row
    // (batch C's 命门, unchanged); on top of that, if the agent's reset window
    // has been stuck past the reconcile threshold, a diagnostic `warn` line
    // correlates the error with the wedged reset. The gate judge is untouched.
    let clock = 0;
    const onBotAuditEvent = vi.fn();
    const logger = stubLogger();
    const { mgr } = makeManager({ onBotAuditEvent, logger, now: () => clock, resetStuckThresholdMs: 100 });

    // Put the agent into a reset window that has aged past the threshold.
    mgr.deliver("a1", { seq: 1, text: "hello" });
    clock = 10;
    mgr.markResetting("a1"); // resetting=true, resettingSince=10
    clock = 200; // now - resettingSince = 190 >= 100 → stuck

    // Reborn (superseded=false) error fires while the window is wedged.
    fireManagedError(mgr, "reborn hit a rate limit", false);

    // 命门: the error STILL surfaces (additive trace never suppresses).
    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    // AND the correlation trace fired.
    expect(logger.calls.warn.some(([m]) => m === "runtime error during a stuck reset window")).toBe(true);
  });

  it("does NOT add the stuck-reset trace for a reborn error when the reset window is NOT stuck (batch D)", async () => {
    let clock = 0;
    const onBotAuditEvent = vi.fn();
    const logger = stubLogger();
    const { mgr } = makeManager({ onBotAuditEvent, logger, now: () => clock, resetStuckThresholdMs: 100 });

    mgr.deliver("a1", { seq: 1, text: "hello" });
    clock = 10;
    mgr.markResetting("a1"); // resettingSince=10
    clock = 50; // now - resettingSince = 40 < 100 → NOT stuck

    fireManagedError(mgr, "reborn hit a rate limit", false);

    // Error still surfaces (it's a real reborn error), but no stuck-reset trace.
    expect(onBotAuditEvent.mock.calls.filter(([, ev]) => (ev as { kind?: string })?.kind === "error")).toHaveLength(1);
    expect(logger.calls.warn.some(([m]) => m === "runtime error during a stuck reset window")).toBe(false);
  });

  it("scrubs secrets out of an error message before it becomes an audit row", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", {
      kind: "error",
      message: 'auth failed sk-ant-abc123DEF456 OPENAI_API_KEY=provider-secret {"apiKey":"json-secret"} Authorization: Basic basic-secret at /Users/Alice Smith/private key.json?token=query-secret',
    });

    const errCall = onBotAuditEvent.mock.calls.find(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    const message = (errCall![1] as { payload: { message: string } }).payload.message;
    expect(message).not.toMatch(/sk-ant-abc123DEF456|provider-secret|json-secret|basic-secret|Alice Smith|private key|query-secret/);
    expect(message).toContain("[redacted-token]");
  });
});

describe("AgentProcessManager — handshake watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("terminates a session that never handshakes, emits an `error` row, and returns the FSM to idle", async () => {
    const onBotAuditEvent = vi.fn();
    const session = fakeSession();
    const stopSpy = vi.fn(() => session.fire("exit", { reason: "requested" }));
    session.stop = stopSpy as never;
    const onRuntimeSpawnFailed = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (hooks) => bindFactorySession(hooks, session),
      onRuntimeSpawnFailed,
      onBotAuditEvent: onBotAuditEvent as never,
      handshakeTimeoutMs: 1000,
    });
    mgr.register("a1");
    mgr.deliver("a1", { seq: 1, text: "hello" });

    // start() resolves → `spawned` dispatched → watchdog armed. Drain microtasks.
    session.startResolver?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mgr.snapshot().agents["a1"]?.status).toBe("running");

    // No handshake ever arrives; the deadline elapses.
    await vi.advanceTimersByTimeAsync(1000);

    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "handshake_timeout");
    expect(stopSpy).toHaveBeenCalledTimes(1);
    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]![1] as { payload: { scope: string } }).payload.scope).toBe("handshake_timeout");
    // FSM returned to idle so a subsequent wake can retry.
    expect(mgr.snapshot().agents["a1"]?.status).toBe("idle");
  });

  it("does NOT fire when the handshake arrives before the deadline", async () => {
    const onBotAuditEvent = vi.fn();
    const stopSpy = vi.fn();
    const session = fakeSession();
    session.stop = stopSpy as never;
    const onRuntimeSpawnFailed = vi.fn();
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (hooks) => bindFactorySession(hooks, session),
      onRuntimeSpawnFailed,
      onBotAuditEvent: onBotAuditEvent as never,
      handshakeTimeoutMs: 1000,
    });
    mgr.register("a1");
    mgr.deliver("a1", { seq: 1, text: "hello" });
    session.startResolver?.();
    await Promise.resolve();
    await Promise.resolve();

    // Handshake lands well within the window.
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    vi.advanceTimersByTime(1000);

    expect(onRuntimeSpawnFailed).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(0);
  });
});

describe("canonicalToolName", () => {
  it("canonicalizes bash/shell to bash (case-insensitive)", async () => {
    expect(canonicalToolName("Bash")).toBe("bash");
    expect(canonicalToolName("bash")).toBe("bash");
    expect(canonicalToolName("BASH")).toBe("bash");
    expect(canonicalToolName("shell")).toBe("bash");
  });
  it("canonicalizes file-target tools", async () => {
    expect(canonicalToolName("Read")).toBe("read");
    expect(canonicalToolName("read")).toBe("read");
    expect(canonicalToolName("Edit")).toBe("edit");
    expect(canonicalToolName("MultiEdit")).toBe("edit");
    expect(canonicalToolName("file_change")).toBe("edit");
    expect(canonicalToolName("Write")).toBe("write");
    expect(canonicalToolName("LS")).toBe("ls");
    expect(canonicalToolName("NotebookEdit")).toBe("notebook_edit");
  });
  it("canonicalizes pattern tools", async () => {
    expect(canonicalToolName("Grep")).toBe("grep");
    expect(canonicalToolName("Glob")).toBe("glob");
    expect(canonicalToolName("Find")).toBe("find");
  });
  it("canonicalizes web + todo tools", async () => {
    expect(canonicalToolName("WebSearch")).toBe("web_search");
    expect(canonicalToolName("web_search")).toBe("web_search");
    expect(canonicalToolName("WebFetch")).toBe("web_fetch");
    expect(canonicalToolName("TodoWrite")).toBe("todo_write");
  });
  it("falls through to lowercase for unknown names", async () => {
    expect(canonicalToolName("mcp_search")).toBe("mcp_search");
    expect(canonicalToolName("Frobnicate")).toBe("frobnicate");
    expect(canonicalToolName("collab_tool_call")).toBe("collab_tool_call");
  });
});

describe("extractToolAudit — shell class", () => {
  it("Anthropic Bash + non-alook command yields {name: 'bash', target, suppressed: false}", async () => {
    expect(extractToolAudit("Bash", { command: "rm -rf tmp" })).toEqual({
      name: "bash",
      target: "rm -rf tmp",
      suppressed: false,
    });
  });
  it("pi lowercase bash + non-alook command yields the same shape", async () => {
    expect(extractToolAudit("bash", { command: "sed -i '' '/x/d' todo.md" })).toEqual({
      name: "bash",
      target: "sed -i '' '/x/d' todo.md",
      suppressed: false,
    });
  });
  it("suppresses alook invocations for capitalized Bash", async () => {
    expect(extractToolAudit("Bash", { command: "alook inbox pull" }).suppressed).toBe(true);
  });
  it("suppresses alook invocations for lowercase bash (pi)", async () => {
    expect(extractToolAudit("bash", { command: "alook" }).suppressed).toBe(true);
  });
  it("suppresses even with leading whitespace (raw command trimmed for the check)", async () => {
    expect(extractToolAudit("Bash", { command: "  alook  message send" }).suppressed).toBe(true);
  });
  it("codex shell (string command) — driver already unwrapped params.item", async () => {
    expect(extractToolAudit("shell", { command: "pnpm test" })).toEqual({
      name: "bash",
      target: "pnpm test",
      suppressed: false,
    });
  });
  it("codex shell (array command) — joined with spaces, noisy-but-honest form", async () => {
    expect(extractToolAudit("shell", { command: ["bash", "-lc", "rm -rf tmp"] })).toEqual({
      name: "bash",
      target: "bash -lc rm -rf tmp",
      suppressed: false,
    });
  });
  it("codex shell array wrapping `alook …` inside `bash -lc` does NOT suppress — outer shell is real work", async () => {
    const out = extractToolAudit("shell", { command: ["bash", "-lc", "alook inbox pull"] });
    expect(out.suppressed).toBe(false);
    expect(out.name).toBe("bash");
    expect(out.target).toBe("bash -lc alook inbox pull");
  });
});

describe("extractToolAudit — file-target class", () => {
  it("Anthropic Read → file_path", async () => {
    expect(extractToolAudit("Read", { file_path: "/etc/passwd" })).toEqual({
      name: "read",
      target: "/etc/passwd",
      suppressed: false,
    });
  });
  it("pi read → path", async () => {
    expect(extractToolAudit("read", { path: "AGENTS.md" })).toEqual({
      name: "read",
      target: "AGENTS.md",
      suppressed: false,
    });
  });
  it("Edit picks file_path, ignoring other keys", async () => {
    expect(extractToolAudit("Edit", { file_path: "src/foo.ts", oldText: "x", newText: "y" })).toEqual({
      name: "edit",
      target: "src/foo.ts",
      suppressed: false,
    });
  });
  it("pi edit → path", async () => {
    expect(extractToolAudit("edit", { path: "plans/x.md", edits: [] })).toEqual({
      name: "edit",
      target: "plans/x.md",
      suppressed: false,
    });
  });
  it("Write / pi write → file_path / path", async () => {
    expect(extractToolAudit("Write", { file_path: "x.md", content: "..." }).target).toBe("x.md");
    expect(extractToolAudit("write", { path: "x.md", content: "..." }).target).toBe("x.md");
  });
  it("MultiEdit → edit + file_path (semantic collapse)", async () => {
    expect(extractToolAudit("MultiEdit", { file_path: "x.ts", edits: [] })).toEqual({
      name: "edit",
      target: "x.ts",
      suppressed: false,
    });
  });
  it("NotebookEdit → notebook_path", async () => {
    expect(extractToolAudit("NotebookEdit", { notebook_path: "nb.ipynb" })).toEqual({
      name: "notebook_edit",
      target: "nb.ipynb",
      suppressed: false,
    });
  });
  it("LS → path", async () => {
    expect(extractToolAudit("LS", { path: "src/" })).toEqual({
      name: "ls",
      target: "src/",
      suppressed: false,
    });
  });
  it("codex file_change → edit + adapter-flattened ordered paths", async () => {
    expect(extractToolAudit("file_change", { path: "a.ts, b.ts" })).toEqual({
      name: "edit",
      target: "a.ts, b.ts",
      suppressed: false,
    });
  });
});

describe("extractToolAudit — pattern class", () => {
  it("Grep with pattern + path picks pattern", async () => {
    expect(extractToolAudit("Grep", { pattern: "TODO", path: "src/" }).target).toBe("TODO");
  });
  it("pi grep with pattern only", async () => {
    expect(extractToolAudit("grep", { pattern: "TODO" }).target).toBe("TODO");
  });
  it("Glob picks pattern", async () => {
    expect(extractToolAudit("Glob", { pattern: "**/*.tsx" }).target).toBe("**/*.tsx");
  });
  it("find picks pattern", async () => {
    expect(extractToolAudit("find", { pattern: "*.ts", path: "src" }).target).toBe("*.ts");
  });
  it("grep falls back to path when no pattern is set", async () => {
    expect(extractToolAudit("grep", { path: "src" }).target).toBe("src");
  });
});

describe("extractToolAudit — fallthrough / MCP / web", () => {
  it("WebFetch → url", async () => {
    expect(extractToolAudit("WebFetch", { url: "https://example.com" })).toEqual({
      name: "web_fetch",
      target: "https://example.com",
      suppressed: false,
    });
  });
  it("mcp_search stays as mcp_search + query target", async () => {
    expect(extractToolAudit("mcp_search", { query: "foo" })).toEqual({
      name: "mcp_search",
      target: "foo",
      suppressed: false,
    });
  });
  it("web_search → query", async () => {
    expect(extractToolAudit("web_search", { query: "cats" })).toEqual({
      name: "web_search",
      target: "cats",
      suppressed: false,
    });
  });
  it("collab_tool_call → name (from input.name)", async () => {
    expect(extractToolAudit("collab_tool_call", { name: "x" }).target).toBe("x");
  });
  it("TodoWrite → no target", async () => {
    expect(extractToolAudit("TodoWrite", { todos: [] })).toEqual({
      name: "todo_write",
      suppressed: false,
    });
  });
  it("Unknown tool falls through as lowercased name + no target", async () => {
    expect(extractToolAudit("Frobnicate", {})).toEqual({
      name: "frobnicate",
      suppressed: false,
    });
  });
});

describe("extractToolAudit — non-object input guard", () => {
  it("null / undefined / string / number / array — all return no target without throwing", async () => {
    expect(extractToolAudit("Bash", null)).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", undefined)).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", "raw string")).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", 42)).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", ["a", "b"])).toEqual({ name: "bash", suppressed: false });
  });
  it("stringified-JSON recovery: input is a JSON string that decodes to a record", async () => {
    expect(extractToolAudit("Bash", '{"command":"rm -rf tmp"}')).toEqual({
      name: "bash",
      target: "rm -rf tmp",
      suppressed: false,
    });
  });
  it("invalid JSON string — no throw, returns no target", async () => {
    expect(extractToolAudit("Bash", "not json{")).toEqual({ name: "bash", suppressed: false });
  });
  it("JSON string that decodes to a non-object — no throw, returns no target", async () => {
    expect(extractToolAudit("Bash", "42")).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", '["a","b"]')).toEqual({ name: "bash", suppressed: false });
  });
});

describe("truncateTargetToCodeUnits", () => {
  it("passes short strings through unchanged", async () => {
    expect(truncateTargetToCodeUnits("hello")).toBe("hello");
  });
  it("truncates a 300-unit ASCII string to <=200 units + ellipsis", async () => {
    const out = truncateTargetToCodeUnits("a".repeat(300));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });
  it("emoji-heavy: never emits a lone surrogate + round-trips clean UTF-8", async () => {
    const emoji = "😀";
    const s = emoji.repeat(200);
    const out = truncateTargetToCodeUnits(s);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
  });
});

describe("isAlookShellInvocation", () => {
  it("matches `alook <sub>` and bare `alook`", async () => {
    expect(isAlookShellInvocation("alook")).toBe(true);
    expect(isAlookShellInvocation("alook inbox pull")).toBe(true);
    expect(isAlookShellInvocation("  alook message send")).toBe(true);
  });
  it("matches the `$ALOOK_CLI` env-var form the system prompt now teaches", async () => {
    expect(isAlookShellInvocation("$ALOOK_CLI inbox pull")).toBe(true);
    expect(isAlookShellInvocation("${ALOOK_CLI} message send")).toBe(true);
    expect(isAlookShellInvocation("$ALOOK_CLI")).toBe(true);
    expect(isAlookShellInvocation("  $ALOOK_CLI nap")).toBe(true);
  });
  it("does NOT match commands that merely mention alook", async () => {
    expect(isAlookShellInvocation("rm alook.log")).toBe(false);
    expect(isAlookShellInvocation("echo alook")).toBe(false);
    expect(isAlookShellInvocation("alookalike")).toBe(false);
    // A different env var that merely starts with the same prefix must not match.
    expect(isAlookShellInvocation("$ALOOK_CLIENT foo")).toBe(false);
  });
  it("returns false for missing input", async () => {
    expect(isAlookShellInvocation(undefined)).toBe(false);
    expect(isAlookShellInvocation("")).toBe(false);
  });
});

describe("extractToolAudit — driver coverage matrix", () => {
  const cases: Array<{ driver: string; rawName: string; rawInput: unknown; expected: { name: string; target?: string; suppressed: boolean } }> = [
    { driver: "claude", rawName: "Bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "claude", rawName: "Read", rawInput: { file_path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "claude", rawName: "Edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "claude", rawName: "MultiEdit", rawInput: { file_path: "/y" }, expected: { name: "edit", target: "/y", suppressed: false } },
    { driver: "claude", rawName: "Write", rawInput: { file_path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "claude", rawName: "Grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },
    { driver: "claude", rawName: "Glob", rawInput: { pattern: "**/*" }, expected: { name: "glob", target: "**/*", suppressed: false } },
    { driver: "claude", rawName: "LS", rawInput: { path: "/src" }, expected: { name: "ls", target: "/src", suppressed: false } },
    { driver: "claude", rawName: "NotebookEdit", rawInput: { notebook_path: "nb.ipynb" }, expected: { name: "notebook_edit", target: "nb.ipynb", suppressed: false } },
    { driver: "claude", rawName: "WebSearch", rawInput: { query: "cats" }, expected: { name: "web_search", target: "cats", suppressed: false } },
    { driver: "claude", rawName: "WebFetch", rawInput: { url: "https://x" }, expected: { name: "web_fetch", target: "https://x", suppressed: false } },
    { driver: "claude", rawName: "TodoWrite", rawInput: { todos: [] }, expected: { name: "todo_write", suppressed: false } },

    { driver: "cursor", rawName: "Bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },

    { driver: "pi", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "pi", rawName: "read", rawInput: { path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "pi", rawName: "edit", rawInput: { path: "/x", edits: [] }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "pi", rawName: "write", rawInput: { path: "/x", content: "" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "pi", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },
    { driver: "pi", rawName: "find", rawInput: { pattern: "*.ts" }, expected: { name: "find", target: "*.ts", suppressed: false } },
    { driver: "pi", rawName: "ls", rawInput: { path: "/src" }, expected: { name: "ls", target: "/src", suppressed: false } },

    { driver: "codex", rawName: "shell", rawInput: { command: "pnpm test" }, expected: { name: "bash", target: "pnpm test", suppressed: false } },
    { driver: "codex", rawName: "shell", rawInput: { command: ["bash", "-lc", "rm tmp"] }, expected: { name: "bash", target: "bash -lc rm tmp", suppressed: false } },
    { driver: "codex", rawName: "file_change", rawInput: { path: "a.ts, b.ts" }, expected: { name: "edit", target: "a.ts, b.ts", suppressed: false } },
    { driver: "codex", rawName: "web_search", rawInput: { query: "cats" }, expected: { name: "web_search", target: "cats", suppressed: false } },
    { driver: "codex", rawName: "mcp_search", rawInput: { query: "foo" }, expected: { name: "mcp_search", target: "foo", suppressed: false } },
    { driver: "codex", rawName: "collab_tool_call", rawInput: { name: "x" }, expected: { name: "collab_tool_call", target: "x", suppressed: false } },

    { driver: "generic-json", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "generic-json", rawName: "read", rawInput: { path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "generic-json", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "generic-json", rawName: "write", rawInput: { path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "generic-json", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },

    { driver: "generic-lowercase", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "generic-lowercase", rawName: "read", rawInput: { path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "generic-lowercase", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "generic-lowercase", rawName: "write", rawInput: { path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "generic-lowercase", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },

    { driver: "opencode", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "opencode", rawName: "read", rawInput: { file_path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "opencode", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "opencode", rawName: "write", rawInput: { file_path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "opencode", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },

    { driver: "generic-string-input", rawName: "bash", rawInput: '{"command":"rm tmp"}', expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "generic-file-path", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "generic-file-path", rawName: "read", rawInput: { file_path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "generic-file-path", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "generic-file-path", rawName: "write", rawInput: { file_path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "generic-file-path", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },
  ];
  it.each(cases)("$driver × $rawName produces canonical shape", ({ rawName, rawInput, expected }) => {
    expect(extractToolAudit(rawName, rawInput)).toEqual(expected);
  });
});

describe("onBotAuditEvent — integration through onRuntimeEvent (T9/T10)", () => {
  it("emits canonical lowercase name for every driver × tool combo", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    const combos: Array<{ name: string; input: unknown; expect: { name: string; target?: string } }> = [
      { name: "Bash", input: { command: "rm" }, expect: { name: "bash", target: "rm" } },
      { name: "bash", input: { command: "rm" }, expect: { name: "bash", target: "rm" } },
      { name: "Read", input: { file_path: "x" }, expect: { name: "read", target: "x" } },
      { name: "read", input: { path: "x" }, expect: { name: "read", target: "x" } },
      { name: "Edit", input: { file_path: "x" }, expect: { name: "edit", target: "x" } },
      { name: "edit", input: { path: "x" }, expect: { name: "edit", target: "x" } },
      { name: "Grep", input: { pattern: "TODO" }, expect: { name: "grep", target: "TODO" } },
      { name: "shell", input: { command: "pnpm test" }, expect: { name: "bash", target: "pnpm test" } },
      { name: "file_change", input: { path: "a.ts, b.ts" }, expect: { name: "edit", target: "a.ts, b.ts" } },
    ];

    for (const c of combos) {
      await session.fire("runtime_event", { kind: "tool_call", name: c.name, input: c.input });
    }

    const payloads = onBotAuditEvent.mock.calls
      .filter(([, ev]) => (ev as { kind?: string })?.kind === "tool_call")
      .map(([, ev]) => (ev as { payload: { name: string; target?: string } }).payload);
    expect(payloads).toEqual(combos.map((c) => c.expect));
  });

  it("alook-shell suppression fires for Bash, pi bash, AND codex shell", async () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    await session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "alook inbox pull" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "bash", input: { command: "alook" } });
    await session.fire("runtime_event", { kind: "tool_call", name: "shell", input: { command: "alook message send" } });

    const toolCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call"
    );
    expect(toolCalls).toHaveLength(0);
  });
});

// FSM transition trace (plans/daemon-fsm-desync.md): pure-observability hook
// used to make a wedge that logs nothing else reconstructable. Two guarantees:
// it fires per dispatch with the fields the wedge-triage needs, and it does NOT
// change behavior (effects identical whether or not the hook is wired).
describe("AgentProcessManager — onFsmTransition trace (observability, zero behavior change)", () => {
  function makeWithTrace(trace?: (rec: Record<string, unknown>) => void) {
    const session = fakeSession();
    const sessions = [session];
    let sessionIndex = 0;
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
      sessionFactory: () => {
        const next = sessions[sessionIndex] ?? fakeSession();
        if (!sessions[sessionIndex]) sessions.push(next);
        sessionIndex += 1;
        return next;
      },
      onFsmTransition: trace as never,
    });
    mgr.register("a1");
    return { mgr, session, sessions };
  }

  it("fires once per agent-scoped dispatch with the wedge-triage fields", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hello" });
    expect(recs.length).toBeGreaterThan(0);
    const wake = recs.find((r) => r.event === "wake");
    expect(wake).toBeTruthy();
    // Every field the triage needs to split the three "why no watchdog" exits.
    for (const k of ["agentId", "event", "status", "turnActive", "inbox", "lastDeliverAt", "lastProgressAt", "resetting", "resettingSince", "deliveryPhase", "effects", "nowMs"]) {
      expect(wake).toHaveProperty(k);
    }
    expect(wake!.agentId).toBe("a1");
    expect(Array.isArray(wake!.effects)).toBe(true);
  });

  it("uses manager pending mode only before admission reaches the driver, then projects authoritative snapshot diagnostics", async () => {
    const recs: Record<string, unknown>[] = [];
    const session = fakeSession();
    const baseSnapshot = session.snapshot.bind(session);
    session.snapshot = () => ({
      ...baseSnapshot(),
      diagnostics: {
        deliveryPhase: "compacting",
        metrics: {
          physicalOpenCount: 1,
          turnCount: 2,
          commandAdmissionCount: 3,
          commandAdmissionLatencyTotalMs: 12.5,
          queueDwellCount: 4,
          queueDwellTotalMs: 8.5,
          sseReconnectCount: 6,
          resumeOutcome: "resumed",
          terminalOwnerKind: "transport_request",
        },
      },
    });
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
      sessionFactory: sessionFactoryFor(session),
      onFsmTransition: ((row: Record<string, unknown>) => recs.push(row)) as never,
    });
    mgr.register("a1");
    mgr.deliver("a1", { seq: 1, text: "hello" });
    await vi.waitFor(() => expect(session.startResolver).toBeTypeOf("function"));

    expect(recs.find((row) => row.event === "admission_started")).toMatchObject({
      deliveryPhase: "admission_wait",
    });
    await session.pushAgentEvent({ type: "internal_progress", turnId: "test-turn", source: "test" });
    expect(recs.filter((row) => row.event === "runtime_signal").at(-1)).toMatchObject({
      deliveryPhase: "compacting",
      physicalOpenCount: 1,
      turnCount: 2,
      commandAdmissionCount: 3,
      commandAdmissionLatencyTotalMs: 12.5,
      queueDwellCount: 4,
      queueDwellTotalMs: 8.5,
      sseReconnectCount: 6,
      resumeOutcome: "resumed",
      terminalOwnerKind: "transport_request",
    });
    expect(recs.some((row) => "apmPhase" in row)).toBe(false);
    session.startResolver?.();
    await Promise.resolve();
  });

  it("does NOT change behavior — the observed effect sequence is identical with and without the hook", async () => {
    // deliver() returns a boolean (produced-effect), so compare the effect
    // SEQUENCE the trace observed instead: it reflects exactly what the reducer
    // emitted. A wired hook must not perturb that sequence.
    const seq: string[][] = [];
    const withHook = makeWithTrace((r) => seq.push(r.effects as string[]));
    const produced1 = withHook.mgr.deliver("a1", { seq: 1, text: "hi" });
    const without = makeWithTrace(undefined);
    const produced2 = without.mgr.deliver("a1", { seq: 1, text: "hi" });
    // Same producedEffect result …
    expect(produced1).toBe(produced2);
    // … and the wake dispatch emitted a spawn (single-flight from idle),
    // observed identically through the trace.
    expect(seq.some((effs) => effs.includes("spawn"))).toBe(true);
  });

  it("fans out a per-agent record on every TICK with derived watchdog inputs (so 'why no watchdog fired' is answerable)", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      const session = fakeSession();
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start(); // arm the tick timer
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      recs.length = 0;
      now = 50;
      await vi.advanceTimersByTimeAsync(10); // fires ticks
      const tickRecs = recs.filter((r) => r.event === "tick" && r.agentId === "a1");
      expect(tickRecs.length).toBeGreaterThan(0);
      // The derived inputs that let triage judge WHY a watchdog didn't fire.
      const t = tickRecs[0];
      expect(t).toHaveProperty("sinceProgressMs");
      expect(t).toHaveProperty("sinceDeliverMs");
      expect(typeof t.sinceProgressMs).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries stoppingSince + sinceStoppingMs — null while not stopping, populated once in `stopping` (batch H)", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        idleTimeoutMs: 50, // drive into `stopping` via idle-timeout
        stoppingStuckThresholdMs: 1_000_000, // huge so it does NOT force_exit during this test — we just want the stopping snapshot
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" });

      // While running/idle-not-stopping, the field is null.
      const runningRec = recs.find((r) => r.status === "running");
      expect(runningRec).toBeTruthy();
      expect(runningRec!.stoppingSince).toBeNull();
      expect(runningRec!.sinceStoppingMs).toBeNull();

      recs.length = 0;
      now = 100; // past idleTimeout=50 → idle-hibernation tick sets status=stopping, stoppingSince=100
      await vi.advanceTimersByTimeAsync(10);
      const stoppingRec = recs.find((r) => r.status === "stopping" && r.agentId === "a1");
      expect(stoppingRec).toBeTruthy();
      expect(stoppingRec!.stoppingSince).toBe(100);
      expect(typeof stoppingRec!.sinceStoppingMs).toBe("number"); // now - 100, populated
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- B1: crashed-turn tag (plans/daemon-runtime-error-rewake.md) ----------
  // The trailing turn_end after a mid-turn `error` carries `endReason:"errored"`
  // + `errorDetail` into the trace, so a crashed turn is externally
  // distinguishable from a clean nap/idle (red line 7). B1 only RECORDS it —
  // onTurnEnd behavior is unchanged (verified in the "clean" case below).

  it("a mid-turn error then turn_end stamps fixed metadata but drops free-text errorDetail", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    // Genuinely interrupt the turn: an `error` event (as the normalizer emits
    // from an is_error result) FOLLOWED by the trailing turn_end.
    await session.fire("runtime_event", { kind: "error", message: "boom: model overloaded" });
    await session.fire("runtime_event", { kind: "turn_end" });

    const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
    expect(turnEnd).toBeTruthy();
    expect(turnEnd!.endReason).toBe("errored");
    expect(turnEnd!.terminationCause).toBe("runtime_error");
    expect(turnEnd!.errorDetail).toBeUndefined();
  });

  it("a CLEAN turn_end (no preceding error/kill) carries no endReason/terminationCause/errorDetail (byte-for-byte the old row)", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "turn_end" });

    const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
    expect(turnEnd).toBeTruthy();
    expect(turnEnd!.endReason).toBeUndefined();
    expect(turnEnd!.terminationCause).toBeUndefined();
    expect(turnEnd!.errorDetail).toBeUndefined();
  });

  it("an intentional-kill (superseded) death-rattle error does NOT tag its turn_end errored (red line 5 — reset/nap is not a crash)", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    // Enter the reset/nap kill window, THEN the dying process rattles. The
    // marker is gated by the same `!sessionSuperseded` as the audit, so it must
    // NOT set — a nap must stay indistinguishable-from-clean, not read as crash.
    mgr.markResetting("a1");
    await session.fire("runtime_event", { kind: "error", message: "turn interrupted" });
    await session.fire("runtime_event", { kind: "turn_end" });

    const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
    expect(turnEnd).toBeTruthy();
    expect(turnEnd!.endReason).toBeUndefined();
    expect(turnEnd!.terminationCause).toBeUndefined();
  });

  it("a mid-turn error followed by a hard exit (no turn_end) clears the marker so the NEXT turn is not mis-tagged (3a marker-leak guard)", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session, sessions } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    // Error with NO trailing turn_end, then a hard process exit (bypasses the
    // normalizer) — the marker would otherwise leak in the map.
    await session.fire("runtime_event", { kind: "error", message: "crashed hard" });
    await session.fire("exit");

    // A fresh wake spawns a new session; its clean turn_end must NOT inherit the
    // stale marker.
    recs.length = 0;
    mgr.deliver("a1", { seq: 2, text: "again" });
    const rebornSession = sessions[1]!;
    await rebornSession.fire("runtime_event", { kind: "session_init", sessionId: "s2" });
    await rebornSession.fire("runtime_event", { kind: "turn_end" });

    const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
    expect(turnEnd).toBeTruthy();
    expect(turnEnd!.endReason).toBeUndefined();
    expect(turnEnd!.terminationCause).toBeUndefined();
  });

  it("red line 6 — a REAL stall (no progress past threshold → terminate_stalled) tags the turn_end killed_stalled, NOT injected error (Blair's actual case)", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      // Default fakeDriver (per_turn) satisfies the `stalled` predicate's first
      // sub-clause — the same setup the proven "terminate_stalled from the stall
      // watchdog" test uses. We only add the trace sink.
      const session = fakeSession();
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100, // wedge → terminate_stalled after 100ms of no progress
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      // Turn is in flight (turnActive) and makes NO progress. No error injected —
      // this is a genuine hang, exactly Blair's case.
      now = 200; // past staleThreshold=100 → stalled watchdog fires terminate_stalled
      await vi.advanceTimersByTimeAsync(10);
      const killTick = recs.find((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("terminate_stalled"));
      expect(killTick).toBeTruthy(); // the stall kill actually fired

      // The SIGKILL makes the process emit its trailing turn_end (no error
      // rattle needed — that's the whole point of keying on cause, not rattle).
      recs.length = 0;
      await session.fire("runtime_event", { kind: "turn_end" });
      const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
      expect(turnEnd).toBeTruthy();
      expect(turnEnd!.endReason).toBe("errored");
      expect(turnEnd!.terminationCause).toBe("killed_stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("force_exit clears the killed_stalled marker so it does NOT leak onto the next reborn turn's turn_end", async () => {
    // Regression: terminate_stalled sets nonCleanEndMarker=killed_stalled. If the
    // kill's stop() produces no exit, stoppingStuck escalates force_exit — whose
    // teardown must clear the marker. Otherwise the leaked marker is consumed by
    // the NEXT (healthy, reborn) turn's turn_end and mislabels it killed_stalled
    // (a forensic lie that corrupted our codex-wedge trace read).
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      // stop() never drives an exit → the terminate_stalled kill wedges in
      // `stopping` → stoppingStuck escalates force_exit (the path that leaks).
      const stopSpy = vi.fn();
      const session = fakeSession();
      const rebornSession = fakeSession();
      session.stop = stopSpy;
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"), // per_turn — same stall setup as the killed_stalled test above
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (() => {
          let index = 0;
          const sessions = [session, rebornSession];
          return (hooks: Parameters<SessionFactory>[0]) => bindFactorySession(hooks, sessions[index++]!);
        })(),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
        stoppingStuckThresholdMs: 100,
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      // Turn is in flight (turnActive) and makes NO progress → terminate_stalled
      // sets killed_stalled marker. (Same trigger as the killed_stalled test.)
      now = 200;
      await vi.advanceTimersByTimeAsync(10);
      expect(recs.find((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("terminate_stalled"))).toBeTruthy();
      // stop() produced no exit → sit in stopping past stoppingStuck → force_exit.
      now = 500;
      await vi.advanceTimersByTimeAsync(10);
      expect(recs.find((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("force_exit"))).toBeTruthy();

      // A later wake opens a fresh logical session. The reborn turn runs and
      // ends CLEANLY. Its turn_end must NOT inherit the leaked marker.
      mgr.deliver("a1", { seq: 2, text: "reborn" });
      rebornSession.startResolver?.();
      await Promise.resolve();
      recs.length = 0;
      await rebornSession.fire("runtime_event", { kind: "session_init", sessionId: "s2" });
      await rebornSession.fire("runtime_event", { kind: "turn_end" });
      const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
      expect(turnEnd).toBeTruthy();
      // The whole point: marker was cleared at force_exit, so this healthy turn
      // is a CLEAN end — no leaked killed_stalled.
      expect(turnEnd!.terminationCause).toBeUndefined();
      expect(turnEnd!.endReason).not.toBe("errored");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a VOLUNTARY idle-timeout stop (which also flips status→stopping) does NOT produce a tagged turn_end (red line 2 — cause, not bare status)", async () => {
    // Cecilia's "don't treat 'not seen' as 'won't happen'": idle-hibernation's
    // `stop(idle_timeout)` flips status→stopping too, but it is a CLEAN end. We
    // key on the terminate_stalled EFFECT, not on status, so no marker is set →
    // any turn_end around a voluntary stop stays untagged.
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        idleTimeoutMs: 50, // idle → voluntary stop(idle_timeout), flips stopping
        stoppingStuckThresholdMs: 1_000_000, // don't force_exit during the test
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" }); // clean end → idle
      recs.length = 0;
      now = 100; // past idleTimeout=50 → idle-hibernation issues a voluntary stop
      await vi.advanceTimersByTimeAsync(10);
      const stoppingRec = recs.find((r) => r.status === "stopping" && r.agentId === "a1");
      expect(stoppingRec).toBeTruthy(); // it DID flip stopping (voluntary)
      // No terminate_stalled marker was set, so no tagged turn_end can appear.
      const tagged = recs.find((r) => r.event === "turn_end" && r.endReason === "errored");
      expect(tagged).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- T1: hard-exit physical fact into trace (daemon-trace-completeness-charter) ----
  // A hard exit (segfault/OOM/external SIGKILL) bypasses the normalizer, emits no
  // turn_end, and would otherwise be indistinguishable from a clean exit in the
  // trace. T1 threads the raw physical fact (exitCode/exitSignal/abnormal) onto
  // the exit event → trace. Physical fact only; onExit behavior UNCHANGED.

  it("T1 — an established session's exit on a signal records exitSignal + abnormal=true on the trace exit row", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // hasEstablished
    // Hard death on SIGKILL, NOT a requested stop → abnormal physical fact.
    await session.fire("exit", { signal: "SIGKILL", reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitSignal).toBe("SIGKILL");
    expect(exitRec!.exitCode).toBeNull();
    expect(exitRec!.abnormal).toBe(true);
  });

  it("T1 — an established session's non-zero code exit records exitCode + abnormal=true", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("exit", { code: 137, reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitCode).toBe(137);
    expect(exitRec!.exitSignal).toBeNull();
    expect(exitRec!.abnormal).toBe(true);
  });

  it("T1 — a clean code-0 exit records abnormal=false (distinguishable from a crash in the trace)", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("exit", { code: 0, reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitCode).toBe(0);
    expect(exitRec!.abnormal).toBe(false);
  });

  it("T1 — a deliberate stop (reason=requested) records the physical fact but abnormal=false", async () => {
    // A requested stop that still died on a signal (SIGTERM grace → the process
    // exits): the physical fact (signal) is recorded, but it's NOT abnormal —
    // reason==="requested" gates that. So trace shows how it died without
    // mislabeling an intentional stop as a crash.
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("exit", { signal: "SIGTERM", reason: "requested" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitSignal).toBe("SIGTERM");
    expect(exitRec!.abnormal).toBe(false);
  });

  it("T1 — the exit physical fact is READ-ONLY: abnormal exit and clean exit produce the SAME onExit respawn/idle decision (Claudette #382)", async () => {
    // With a queued inbox, onExit respawns (spawn effect); with empty inbox it
    // settles idle. That decision keys on inbox.length ONLY — the new
    // exitCode/exitSignal/abnormal fields must NOT change the branch.
    async function exitEffectsFor(exitInfo: Record<string, unknown>, queueBefore: boolean): Promise<string[]> {
      const recs: Record<string, unknown>[] = [];
      const { mgr, session } = makeWithTrace((r) => recs.push(r));
      mgr.deliver("a1", { seq: 1, text: "hi" });
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      if (queueBefore) mgr.deliver("a1", { seq: 2, text: "queued" }); // inbox non-empty at exit
      recs.length = 0;
      await session.fire("exit", exitInfo);
      const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
      return (exitRec!.effects as string[]) ?? [];
    }
    // Empty inbox: idle (no spawn), identical for abnormal vs clean.
    expect(await exitEffectsFor({ signal: "SIGKILL", reason: "runtime_exit" }, false)).toEqual(
      await exitEffectsFor({ code: 0, reason: "runtime_exit" }, false),
    );
    // Queued inbox: respawn (spawn), identical for abnormal vs clean.
    expect(await exitEffectsFor({ signal: "SIGKILL", reason: "runtime_exit" }, true)).toEqual(
      await exitEffectsFor({ code: 0, reason: "runtime_exit" }, true),
    );
  });

  // ---- T2: launch-failure reason into trace (audit↔trace two-skins closure) ----
  // A spawn that never establishes (ENOENT / pre_handshake_exit / handshake_timeout
  // / spawn_threw) previously reached the web audit but dispatched a BARE exit —
  // in the trace it was indistinguishable from a clean exit. T2 carries the
  // failure reason (same value as the audit) onto the exit event → trace.

  it("T2 — a pre-handshake exit records spawnFailureReason on the trace exit row", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    // Exit with NO prior runtime_event (never established) → pre_handshake_exit.
    await session.fire("exit");

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.spawnFailureReason).toBe("pre_handshake_exit");
  });

  it("T2 — an ENOENT spawn error carries that exact reason (same string as the web audit) into the trace", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("error", { code: "ENOENT" });
    await session.fire("exit");

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.spawnFailureReason).toBe("ENOENT");
  });

  it("T2 — a normal established exit carries NO spawnFailureReason", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // established
    await session.fire("exit", { code: 0, reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.spawnFailureReason).toBeUndefined();
  });

  it("T2 no-leak (Claudette #398) — a spawn failure then a SUCCESSFUL spawn + clean exit: the clean exit carries NO stale spawnFailureReason", async () => {
    // Guards the per-spawn `state` isolation: the failure reason lives on the
    // spawn's own `state` object (fresh each doSpawn), so a later spawn's exit
    // can't inherit it. This assertion would also catch a regression to a
    // per-agent map that forgot to clear (the B1 3a leak class).
    const recs: Record<string, unknown>[] = [];
    // Fresh session per spawn so the second (successful) launch is a real new
    // session, exercising a real second doSpawn with its own `state`.
    const sessions: FakeSession[] = [];
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
      sessionFactory: (hooks) => {
        const s = fakeSession();
        sessions.push(s);
        return bindFactorySession(hooks, s);
      },
      onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
    });
    mgr.register("a1");

    // Spawn #1: fails pre-handshake.
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await sessions[0]!.fire("exit"); // → pre_handshake_exit, agent back to idle

    // Spawn #2: succeeds (establishes), then exits cleanly.
    recs.length = 0;
    mgr.deliver("a1", { seq: 2, text: "again" });
    await sessions[1]!.fire("runtime_event", { kind: "session_init", sessionId: "s2" });
    await sessions[1]!.fire("exit", { code: 0, reason: "runtime_exit" });

    const cleanExit = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(cleanExit).toBeTruthy();
    expect(cleanExit!.spawnFailureReason).toBeUndefined(); // no stale reason from spawn #1
  });

  // ---- T3: recovery-transition semantics into trace ----
  // A stall-kill that exits WITHOUT a turn_end is physically identical to a
  // clean idle-timeout stop (reason=requested, signal set, abnormal=false); a
  // force_exit synthetic exit is bare. T3 layers a `terminationSemantics` label
  // (killed_stalled / idle_stop / force_exit) ON TOP of the physical fact —
  // never overwriting it, and read by NO policy (kept out of B2's gate).

  it("T3 — terminate_stalled then its real exit records terminationSemantics=killed_stalled", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      const session = fakeSession();
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      now = 200; // past staleThreshold → terminate_stalled (sets the semantic marker)
      await vi.advanceTimersByTimeAsync(10);
      // The killed process's real exit (via the exit listener, where state lives).
      recs.length = 0;
      await session.fire("exit", { signal: "SIGKILL", reason: "requested" });

      const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
      expect(exitRec).toBeTruthy();
      expect(exitRec!.terminationSemantics).toBe("killed_stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("T3 — a VOLUNTARY idle-timeout stop's real exit records idle_stop, NOT killed_stalled (mis-label guard, Claudette #407)", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        stoppingStuckThresholdMs: 1_000_000, // don't force_exit during the test
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" }); // clean end → idle
      now = 100; // past idleTimeout → voluntary stop (sets idle_stop, NOT killed_stalled)
      await vi.advanceTimersByTimeAsync(10);
      recs.length = 0;
      await session.fire("exit", { signal: "SIGTERM", reason: "requested" });

      const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
      expect(exitRec).toBeTruthy();
      expect(exitRec!.terminationSemantics).toBe("idle_stop");
      expect(exitRec!.terminationSemantics).not.toBe("killed_stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("T3 — force_exit's synthetic exit records terminationSemantics=force_exit and does NOT pollute the physical fields (Claudette #407)", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      session.stop = vi.fn(); // swallow the stop so no real exit fires — force wedge
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        stoppingStuckThresholdMs: 100,
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "turn_end" });
      now = 100; // idle-timeout → stopping (stop swallowed, no exit)
      await vi.advanceTimersByTimeAsync(10);
      recs.length = 0;
      now = 300; // stopping-stuck past threshold → force_exit synthetic exit
      await vi.advanceTimersByTimeAsync(10);

      const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
      expect(exitRec).toBeTruthy();
      expect(exitRec!.terminationSemantics).toBe("force_exit");
      // Physical layer NOT polluted by the semantic label (synthetic exit has no
      // real code/signal): abnormal false, code/signal null.
      expect(exitRec!.abnormal).toBe(false);
      expect(exitRec!.exitCode).toBeNull();
      expect(exitRec!.exitSignal).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T3 — a plain runtime exit (no recovery) carries NO terminationSemantics", async () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("exit", { code: 0, reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.terminationSemantics).toBeUndefined();
  });
});

describe("T1 — abnormal-exit user audit stays gated (no nap-noise on deliberate kill)", () => {
  it("a deliberate stop (suppressExitLog) records the physical fact in trace but emits NO user-facing abnormal_exit audit", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const recs: Record<string, unknown>[] = [];
      const onBotAuditEvent = vi.fn();
      const session = fakeSession();
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: (hooks) => bindFactorySession(hooks, session),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 100,
        onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
        onBotAuditEvent: onBotAuditEvent as never,
      });
      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.startResolver?.();
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      // Stall → terminate_stalled sets suppressExitLog before the kill.
      now = 200;
      await vi.advanceTimersByTimeAsync(10);
      // The killed process exits on a signal (a requested/deliberate stop path).
      await session.fire("exit", { signal: "SIGKILL", reason: "requested" });

      // Trace: the physical fact IS recorded (forensics needs it).
      const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
      expect(exitRec).toBeTruthy();
      expect(exitRec!.exitSignal).toBe("SIGKILL");
      // User audit: NO abnormal_exit row — a deliberate kill must not look like a
      // fault in the user's activity (the nap-noise bug must not reappear here).
      const abnormalAudits = onBotAuditEvent.mock.calls.filter(
        ([, ev]) => (ev as { kind?: string; payload?: { code?: string } })?.payload?.code === "abnormal_exit",
      );
      expect(abnormalAudits).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

type B1TraceRow = Record<string, unknown>;

const B1_RUNTIME_CONFIG: RuntimeConfig = {
  version: 1,
  runtime: "codex",
  model: { kind: "named", name: "test-model" },
  mode: { kind: "default" },
};

function b1PersistentDriver(): Driver {
  return {
    ...fakeDriver("codex"),
    lifecycle: {
      kind: "persistent",
      start: "immediate",
      exit: "natural",
      inFlightWake: "queue",
      stdin: "direct",
    } as never,
  } as Driver;
}

function b1GatedDriver(): Driver {
  return {
    ...fakeDriver("codex"),
    lifecycle: {
      kind: "persistent",
      start: "immediate",
      exit: "natural",
      inFlightWake: "queue",
      stdin: "gated",
    } as never,
  } as Driver;
}

function b1Session(order: string[], name = "s", turnId = "test-turn"): FakeSession {
  const session = fakeSession();
  session.start = vi.fn(async (input: { id: string; text: string }) => {
    order.push(`${name}:start:${input.text}`);
    void session.pushAgentEvent({ type: "command_accepted", commandId: input.id, turnId, delivery: "prompt" });
    void session.pushAgentEvent({ type: "turn_started", turnId, commandIds: [input.id] });
    return { status: "accepted" as const, delivery: "prompt" as const, commandId: input.id, turnId };
  });
  session.send = vi.fn(async (input: { id: string; text: string }) => {
    order.push(`${name}:send:${input.text}`);
    void session.pushAgentEvent({ type: "command_accepted", commandId: input.id, turnId, delivery: "steer" });
    void session.pushAgentEvent({ type: "turn_started", turnId, commandIds: [input.id] });
    return { status: "accepted" as const, delivery: "steer" as const, commandId: input.id, turnId };
  });
  session.stop = vi.fn(async (opts?: { reason?: string }) => {
    order.push(`${name}:stop:${opts?.reason ?? ""}`);
    return { status: "accepted" as const, requestId: "test-stop" };
  });
  return session;
}

function b1Manager(opts: {
  trace?: (row: B1TraceRow) => void;
  sessions?: FakeSession[];
  driver?: Driver;
  launchId?: string | null;
  now?: () => number;
  handshakeTimeoutMs?: number;
  tickIntervalMs?: number;
  staleThresholdMs?: number;
  stoppingStuckThresholdMs?: number;
  onRuntimeSpawnFailed?: (runtimeId: string, reason: string) => void;
} = {}) {
  const sessions = opts.sessions ?? [b1Session([])];
  let index = 0;
  const mgr = new AgentProcessManager({
    driverFor: () => opts.driver ?? b1PersistentDriver(),
    baseContextFor: () => ({
      workingDirectory: "/tmp",
      agentId: "a1",
      standingPrompt: "",
      config: {} as LaunchContext["config"],
      credentialProxy: {} as LaunchContext["credentialProxy"],
    }),
    sessionFactory: (hooks) => bindFactorySession(hooks, sessions[index++]!),
    onFsmTransition: opts.trace as never,
    now: opts.now,
    ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}),
    ...(opts.tickIntervalMs !== undefined ? { tickIntervalMs: opts.tickIntervalMs } : {}),
    ...(opts.staleThresholdMs !== undefined ? { staleThresholdMs: opts.staleThresholdMs } : {}),
    ...(opts.stoppingStuckThresholdMs !== undefined
      ? { stoppingStuckThresholdMs: opts.stoppingStuckThresholdMs }
      : {}),
    onRuntimeSpawnFailed: opts.onRuntimeSpawnFailed,
  });
  if (opts.launchId === null) mgr.register("a1");
  else mgr.register("a1", { launchId: opts.launchId ?? "launch-a" });
  return { mgr, sessions };
}

function b1SpanRows(rows: B1TraceRow[], event?: "turn_begin" | "turn_end" | "turn_abort"): B1TraceRow[] {
  return rows.filter((row) => row.recordKind === "turn_span" && (event === undefined || row.event === event));
}

function b1CallProjection(session: FakeSession): Record<"start" | "send" | "stop", unknown[][]> {
  const callsOf = (fn: unknown): unknown[][] =>
    (fn as { mock: { calls: unknown[][] } }).mock.calls.map((args) => [...args]);
  return {
    start: callsOf(session.start),
    send: callsOf(session.send),
    stop: callsOf(session.stop),
  };
}

function b1FsmEffectProjection(rows: B1TraceRow[]): Array<{
  agentId: unknown;
  event: unknown;
  effects: unknown;
}> {
  return rows
    // Pre-B1 rows are unstamped; B1 stamps them `fsm`. In either shape, every
    // non-span trace row belongs to the FSM projection under comparison.
    .filter((row) => row.recordKind !== "turn_span")
    .map((row) => ({ agentId: row.agentId, event: row.event, effects: row.effects }));
}

describe("B1 red gate — daemon-owned turn span lifecycle", () => {
  it("opens at the start/send last mile, reuses busy, increments persistent turn ordinal, and closes before the next begin", async () => {
    const order: string[] = [];
    const rows: B1TraceRow[] = [];
    const session = b1Session(order);
    const { mgr } = b1Manager({
      sessions: [session],
      trace: (row) => {
        rows.push(row);
        if (row.recordKind === "turn_span") order.push(`trace:${String(row.event)}:${String(row.turnOrdinal)}`);
      },
    });

    mgr.deliver("a1", { seq: 1, text: "first" });
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "session-a" });
    mgr.deliver("a1", { seq: 2, text: "busy" });
    await session.fire("runtime_event", { kind: "turn_end" });
    mgr.deliver("a1", { seq: 3, text: "idle-second" });
    await session.fire("runtime_event", { kind: "turn_end" });

    const begins = b1SpanRows(rows, "turn_begin");
    const ends = b1SpanRows(rows, "turn_end");
    expect(begins).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(begins.map((row) => row.traceTurnId)).toEqual(["launch-a:1", "launch-a:2"]);
    expect(begins.map((row) => row.turnOrdinal)).toEqual([1, 2]);
    expect(rows.filter((row) => row.event === "runtime_signal" && row.traceTurnId === "launch-a:1").length).toBeGreaterThan(0);
    expect(order.indexOf("trace:turn_begin:1")).toBeLessThan(order.indexOf("s:start:first"));
    expect(order.indexOf("trace:turn_end:1")).toBeLessThan(order.indexOf("trace:turn_begin:2"));
    expect(order.filter((entry) => entry.includes("send:busy"))).toHaveLength(1);
  });

  it("keeps a queued next-turn command inside the same logical-session span boundary", async () => {
    const order: string[] = [];
    const rows: B1TraceRow[] = [];
    const first = b1Session(order, "a");
    const second = b1Session(order, "b");
    const { mgr } = b1Manager({
      sessions: [first, second],
      driver: fakeDriver("codex"),
      trace: (row) => {
        rows.push(row);
        if (row.recordKind === "turn_span") order.push(`trace:${String(row.event)}:${String(row.daemonTurnOrdinal)}`);
      },
    });

    mgr.deliver("a1", { seq: 1, text: "first" });
    await Promise.resolve();
    mgr.deliver("a1", { seq: 2, text: "queued" });
    await first.fire("runtime_event", { kind: "turn_end" });
    await first.fire("exit", { code: 0, reason: "runtime_exit" });
    await Promise.resolve();

    const begins = b1SpanRows(rows, "turn_begin");
    const ends = b1SpanRows(rows, "turn_end");
    expect(begins).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(order.filter((entry) => entry.startsWith("b:start:"))).toHaveLength(0);
  });

  it("uses the process nonce fallback only when launchId is absent", async () => {
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    const { mgr } = b1Manager({ sessions: [session], launchId: null, trace: (row) => rows.push(row) });
    mgr.deliver("a1", { seq: 1, text: "no launch" });

    const begin = b1SpanRows(rows, "turn_begin")[0];
    expect(begin).toBeTruthy();
    expect(begin!.launchIdSnapshot).toBeNull();
    expect(begin!.traceTurnId).toMatch(/^[0-9a-f-]+:1$/);
    expect(begin!.daemonTurnOrdinal).toBe(1);
    expect(begin!.spawnOrdinal).toBe(1);
  });

  it("records clean, runtime-error, and unknown turn-end outcomes with fixed semantics", async () => {
    const cleanRows: B1TraceRow[] = [];
    const cleanSession = b1Session([]);
    const { mgr: cleanManager } = b1Manager({
      sessions: [cleanSession],
      trace: (row) => cleanRows.push(row),
    });
    cleanManager.deliver("a1", { seq: 1, text: "clean" });
    await Promise.resolve();
    await cleanSession.fire("runtime_event", { kind: "session_init", sessionId: "clean-session" });
    await cleanSession.fire("runtime_event", { kind: "turn_end" });

    const cleanEnd = b1SpanRows(cleanRows, "turn_end")[0];
    expect(cleanEnd).toBeTruthy();
    expect(cleanEnd!.outcome).toBe("clean");
    expect(cleanEnd!.terminationCause).toBeUndefined();

    const errorRows: B1TraceRow[] = [];
    const errorSession = b1Session([]);
    const { mgr: errorManager } = b1Manager({
      sessions: [errorSession],
      trace: (row) => errorRows.push(row),
    });
    errorManager.deliver("a1", { seq: 1, text: "error" });
    await Promise.resolve();
    await errorSession.fire("runtime_event", { kind: "session_init", sessionId: "error-session" });
    await errorSession.fire("runtime_event", { kind: "error", message: "HOSTILE_RUNTIME_DETAIL_220b" });
    await errorSession.fire("runtime_event", { kind: "turn_end" });

    const errorEnd = b1SpanRows(errorRows, "turn_end")[0];
    expect(errorEnd).toBeTruthy();
    expect(errorEnd!.outcome).toBe("errored");
    expect(errorEnd!.terminationCause).toBe("runtime_error");

    const unknownRows: B1TraceRow[] = [];
    const unknownSession = b1Session([]);
    const { mgr: unknownManager } = b1Manager({
      sessions: [unknownSession],
      trace: (row) => unknownRows.push(row),
    });
    unknownManager.deliver("a1", { seq: 1, text: "unknown" });
    await Promise.resolve();
    await Promise.resolve();
    (unknownManager as unknown as { dispatch(event: unknown): void }).dispatch({
      type: "turn_completed",
      agentId: "a1",
      sessionInstanceId: "test-instance",
      turnId: "test-turn",
      nowMs: 1,
      endReason: "errored",
      terminationCause: "HOSTILE_UNKNOWN_CAUSE_832a",
    });

    const unknownEnd = b1SpanRows(unknownRows, "turn_end")[0];
    expect(unknownEnd).toBeTruthy();
    expect(unknownEnd!.outcome).toBe("errored");
    expect(unknownEnd!.terminationCause).toBe("other");
    expect(JSON.stringify(unknownRows)).not.toContain("HOSTILE_UNKNOWN_CAUSE_832a");
  });

  it("annotates active tick/root_work/runtime_signal rows and leaves tail diagnostics observational", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const rows: B1TraceRow[] = [];
      const session = b1Session([]);
      const { mgr } = b1Manager({
        sessions: [session],
        trace: (row) => rows.push(row),
        now: () => now,
        tickIntervalMs: 5,
      });
      mgr.start();
      mgr.deliver("a1", { seq: 1, text: "active" });
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      await session.fire("runtime_event", { kind: "text", text: "root work" });
      now = 1_005;
      await vi.advanceTimersByTimeAsync(5);

      const begin = b1SpanRows(rows, "turn_begin")[0];
      expect(begin).toBeTruthy();
      const activeId = begin!.traceTurnId;
      for (const event of ["root_work", "runtime_signal", "tick"]) {
        expect(rows.some((row) => row.event === event && row.traceTurnId === activeId)).toBe(true);
      }

      await session.fire("runtime_event", { kind: "turn_end" });
      const close = b1SpanRows(rows, "turn_end")[0];
      expect(close!.traceTurnId).toBe(activeId);
      rows.length = 0;

      now = 1_010;
      await vi.advanceTimersByTimeAsync(5);
      await session.fire("stderr", "tail diagnostic");
      await session.fire("exit", { code: 0, reason: "runtime_exit" });
      expect(rows.some((row) => ["tick", "runtime_signal", "exit"].includes(String(row.event)))).toBe(true);
      expect(rows.every((row) => row.traceTurnId === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("B1 red gate — strict read-only trace sink", () => {
  async function scenario(trace?: (row: B1TraceRow) => void) {
    const calls: string[] = [];
    const session = b1Session(calls);
    const { mgr } = b1Manager({ sessions: [session], trace, now: () => 1_700_000_000_000 });
    mgr.deliver("a1", { seq: 1, text: "one" });
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "turn_end" });
    mgr.deliver("a1", { seq: 2, text: "two" });
    await mgr.stop("a1");
    return { state: mgr.snapshot(), calls, runtimeCalls: b1CallProjection(session) };
  }

  it("absent, collecting, and throwing sinks preserve identical state and runtime calls", async () => {
    const absent = await scenario();
    const collected: B1TraceRow[] = [];
    const collecting = await scenario((row) => collected.push(row));
    const throwAfterRecording: B1TraceRow[] = [];
    let throwing: Awaited<ReturnType<typeof scenario>> | undefined;
    let thrown: unknown;
    try {
      throwing = await scenario((row) => {
        throwAfterRecording.push(row);
        throw new Error("trace sink exploded");
      });
    } catch (error) {
      thrown = error;
    }

    const collectingEffects = b1FsmEffectProjection(collected);
    const throwingEffects = b1FsmEffectProjection(throwAfterRecording);
    expect(collectingEffects.length).toBeGreaterThan(0);
    expect(throwingEffects).toEqual(collectingEffects);
    expect(thrown).toBeUndefined();
    expect(collecting).toEqual(absent);
    expect(throwing).toEqual(absent);
    expect(absent.runtimeCalls.start).toHaveLength(1);
    expect(absent.runtimeCalls.send).toHaveLength(1);
    expect(absent.runtimeCalls.stop).toHaveLength(1);
    expect(b1SpanRows(collected, "turn_begin").length).toBeGreaterThan(0);
  });
});

describe("B1 red gate — exact-once terminal matrix", () => {
  const requestedCases: Array<{
    name: string;
    cause: string;
    run: (mgr: AgentProcessManager) => Promise<void>;
  }> = [
    { name: "requested stop", cause: "requested_stop", run: (mgr) => mgr.stop("a1") },
    { name: "shutdown", cause: "shutdown", run: (mgr) => mgr.stopAll() },
    {
      name: "reset",
      cause: "reset",
      run: (mgr) => mgr.resetSession("a1", { runtimeConfig: B1_RUNTIME_CONFIG, launchId: "launch-b", rewakePrompt: "reset" }),
    },
    {
      name: "nap",
      cause: "nap",
      run: (mgr) => mgr.resetSession("a1", { runtimeConfig: B1_RUNTIME_CONFIG, launchId: "launch-b", rewakePrompt: "nap", barrierType: "nap" }),
    },
    {
      name: "model switch",
      cause: "model_switch",
      run: (mgr) => mgr.switchModel("a1", { runtimeConfig: B1_RUNTIME_CONFIG, launchId: "launch-b", rewakePrompt: "switch" }),
    },
  ];

  for (const terminal of requestedCases) {
    it(`${terminal.name} aborts the active span once before the existing stop path`, async () => {
      const rows: B1TraceRow[] = [];
      const order: string[] = [];
      const session = b1Session(order);
      const { mgr } = b1Manager({
        sessions: [session],
        trace: (row) => {
          rows.push(row);
          if (row.recordKind === "turn_span" && row.event === "turn_abort") {
            order.push(`trace:turn_abort:${String(row.abortCause)}`);
          }
        },
      });
      mgr.deliver("a1", { seq: 1, text: "active" });
      await Promise.resolve();
      await terminal.run(mgr);

      const aborts = b1SpanRows(rows, "turn_abort");
      expect(aborts).toHaveLength(1);
      expect(aborts[0]!.abortCause).toBe(terminal.cause);
      const abortIndex = order.indexOf(`trace:turn_abort:${terminal.cause}`);
      const stopIndex = order.findIndex((entry) => entry.startsWith("s:stop:"));
      expect(abortIndex).toBeGreaterThan(-1);
      expect(stopIndex).toBeGreaterThan(-1);
      expect(abortIndex).toBeLessThan(stopIndex);
    });
  }

  it("shutdown joins a session cleanup that was already stopping", async () => {
    const session = b1Session([]);
    let finishCleanup!: (result: AgentSessionResult) => void;
    const cleanupFinished = new Promise<AgentSessionResult>((resolve) => {
      finishCleanup = resolve;
    });
    Object.defineProperty(session, "closed", { value: cleanupFinished });
    session.stop = vi.fn(async () => ({
      status: "already_stopping" as const,
      requestId: "cleanup-in-flight",
    }));
    const { mgr } = b1Manager({ sessions: [session] });
    mgr.deliver("a1", { seq: 1, text: "active Cursor turn" });
    await Promise.resolve();

    let shutdownSettled = false;
    const shutdown = mgr.stopAll().then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.stop).toHaveBeenCalledWith({ reason: "shutdown", forceAfterMs: 2_000 });
    expect(shutdownSettled).toBe(false);

    finishCleanup({
      outcome: "stopped",
      requested: true,
      exitCode: null,
      signal: null,
      cleanup: { status: "released" },
    });
    await shutdown;
    expect(shutdownSettled).toBe(true);
  });

  it("physical exit aborts once and its duplicate late exit cannot close again", async () => {
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    const { mgr } = b1Manager({ sessions: [session], trace: (row) => rows.push(row) });
    mgr.deliver("a1", { seq: 1, text: "active" });
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("exit", { signal: "SIGKILL", reason: "runtime_exit" });
    await session.fire("exit", { signal: "SIGKILL", reason: "runtime_exit" });

    const aborts = b1SpanRows(rows, "turn_abort");
    expect(aborts).toHaveLength(1);
    expect(aborts[0]!.abortCause).toBe("physical_exit");
  });

  it("start synchronous throw aborts once and reports the public open failure", async () => {
    const rows: B1TraceRow[] = [];
    const error = new Error("unique-start-sync-secret");
    const session = b1Session([]);
    session.start = vi.fn(() => {
      throw error;
    });
    const { mgr } = b1Manager({ sessions: [session], trace: (row) => rows.push(row) });

    expect(() => mgr.deliver("a1", { seq: 1, text: "active" })).not.toThrow();
    const aborts = b1SpanRows(rows, "turn_abort");
    expect(aborts).toHaveLength(1);
    expect(aborts[0]!.abortCause).toBe("start_threw");
  });

  it("start promise rejection closes in the existing rejection branch exactly once", async () => {
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    session.start = vi.fn(() => Promise.reject(new Error("unique-start-reject-secret")));
    const { mgr } = b1Manager({ sessions: [session], trace: (row) => rows.push(row) });
    mgr.deliver("a1", { seq: 1, text: "active" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const aborts = b1SpanRows(rows, "turn_abort");
    expect(aborts).toHaveLength(1);
    expect(aborts[0]!.abortCause).toBe("start_rejected");
  });

  it("a rejected start receipt reports the public reason and stops the session", async () => {
    const session = b1Session([]);
    session.start = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "runtime_unavailable" as const,
      error: { category: "process" as const, code: "start_denied", message: "denied", retryable: true },
    }));
    const onRuntimeSpawnFailed = vi.fn();
    const { mgr } = b1Manager({ sessions: [session], onRuntimeSpawnFailed });
    mgr.deliver("a1", { seq: 1, text: "active" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "start_denied");
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("drains messages queued during start and audits a rejected queued receipt", async () => {
    const session = fakeSession();
    session.send = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "closed" as const,
      error: { category: "process" as const, code: "queued_denied", message: "closed", retryable: true },
    }));
    const { mgr } = b1Manager({ sessions: [session] });
    const internal = mgr as unknown as {
      doSpawn(agentId: string, messages: Array<{ id: string; seq: number; text: string }>, resumeSessionId: null): void;
    };
    internal.doSpawn("a1", [
      { id: "first", seq: 1, text: "first" },
      { id: "queued", seq: 2, text: "queued" },
    ], null);
    session.startResolver?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it("audits a queued send promise rejection without leaking it", async () => {
    const session = fakeSession();
    session.send = vi.fn(() => Promise.reject(new Error("queued send rejected")));
    const { mgr } = b1Manager({ sessions: [session] });
    const internal = mgr as unknown as {
      doSpawn(agentId: string, messages: Array<{ id: string; seq: number; text: string }>, resumeSessionId: null): void;
    };
    internal.doSpawn("a1", [
      { id: "first", seq: 1, text: "first" },
      { id: "queued", seq: 2, text: "queued" },
    ], null);
    session.startResolver?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it("stops a session whose asynchronous factory resolves after its spawn state was superseded", async () => {
    let resolveFactory!: (session: FakeSession) => void;
    const created = new Promise<FakeSession>((resolve) => { resolveFactory = resolve; });
    const session = b1Session([]);
    const mgr = new AgentProcessManager({
      driverFor: () => b1PersistentDriver(),
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (() => created) as SessionFactory,
    });
    mgr.register("a1", { launchId: "launch-a" });
    mgr.deliver("a1", { seq: 1, text: "first" });
    const internal = mgr as unknown as { activeSpawnState: Map<string, object> };
    internal.activeSpawnState.delete("a1");
    resolveFactory(session);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.stop).toHaveBeenCalledWith({ reason: "shutdown", forceAfterMs: 2_000 });
    expect(session.start).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected receipt", () => Promise.resolve({
      status: "rejected" as const,
      reason: "closed" as const,
      error: { category: "process" as const, code: "send_denied", message: "closed", retryable: true },
    })],
    ["rejected promise", () => Promise.reject(new Error("send rejected"))],
  ] as const)("%s from an established send closes the active turn once", async (_name, send) => {
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    const { mgr } = b1Manager({ sessions: [session], trace: (row) => rows.push(row) });
    mgr.deliver("a1", { seq: 1, text: "first" });
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.send = vi.fn(send);
    mgr.deliver("a1", { seq: 2, text: "second" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.send).toHaveBeenCalledTimes(1);
    expect(b1SpanRows(rows, "turn_abort").filter((row) => row.abortCause === "send_threw")).toHaveLength(1);
  });

  it("reports an event-stream rejection and a closed-promise rejection", async () => {
    const eventFailure = b1Session([]);
    Object.defineProperty(eventFailure, "events", {
      value: {
        maxBufferedBytes: 4_194_304,
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error("event stream rejected")) };
        },
      },
    });
    const eventFailureReported = vi.fn();
    const { mgr: eventMgr } = b1Manager({ sessions: [eventFailure], onRuntimeSpawnFailed: eventFailureReported });
    eventMgr.deliver("a1", { seq: 1, text: "event failure" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventFailureReported).toHaveBeenCalledWith("codex", "event_stream_failed");

    const closeFailure = b1Session([]);
    Object.defineProperty(closeFailure, "closed", { value: Promise.reject(new Error("closed rejected")) });
    const closeFailureReported = vi.fn();
    const { mgr: closeMgr } = b1Manager({ sessions: [closeFailure], onRuntimeSpawnFailed: closeFailureReported });
    closeMgr.deliver("a1", { seq: 1, text: "close failure" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeFailureReported).toHaveBeenCalledWith("codex", "session_closed_rejected");
  });

  it("maps only turn activity into runtime signals and excludes telemetry/diagnostics", async () => {
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    const { mgr } = b1Manager({ sessions: [session], trace: (row) => rows.push(row) });
    mgr.deliver("a1", { seq: 1, text: "active" });
    await Promise.resolve();
    const internal = mgr as unknown as {
      activeSpawnState: Map<string, object>;
      onAgentEvent(agentId: string, event: AgentEvent<BuiltinBackendSpecs, "codex">, runtimeId: "codex", owner: object): void;
    };
    const owner = internal.activeSpawnState.get("a1")!;
    const baselineSignals = rows.filter((row) => row.event === "runtime_signal").length;
    let sequence = 100;
    const publish = (event: object) => internal.onAgentEvent("a1", {
      ...event,
      sequence: ++sequence,
      sessionInstanceId: "test-instance",
      at: Date.now(),
    } as never, "codex", owner);
    publish({ type: "tool_started", turnId: "test-turn", name: "Read", input: {} });
    publish({ type: "tool_finished", turnId: "test-turn", name: "Read" });
    publish({ type: "diagnostic", severity: "warning", source: "codex", message: "warning" });
    publish({ type: "token_usage", turnId: "test-turn", source: "codex", usage: {}, details: {} });
    publish({ type: "rate_limits", turnId: "test-turn", source: "codex", details: {} });
    publish({ type: "work_heartbeat", turnId: "test-turn" });
    publish({
      type: "assistant_reasoning_completed",
      turnId: "test-turn",
      text: "reasoning",
      truncated: false,
    });
    publish({
      type: "assistant_message_completed",
      turnId: "test-turn",
      text: "answer",
      truncated: false,
    });
    publish({ type: "command_queued", commandId: "queued", reason: "runtime_busy" });
    publish({ type: "command_accepted", commandId: "accepted", turnId: "test-turn", delivery: "steer" });
    publish({
      type: "command_failed",
      commandId: "failed",
      error: { category: "process", code: "failed", message: "failed", retryable: true },
    });
    publish({ type: "turn_started", turnId: "test-turn", commandIds: ["accepted"] });

    expect(rows.filter((row) => row.event === "runtime_signal")).toHaveLength(baselineSignals + 6);
  });

  it("keeps tail telemetry observational while turn-correlated work can recover a false terminal", async () => {
    const session = b1Session([], "s", "root-turn");
    const { mgr } = b1Manager({ sessions: [session] });
    mgr.deliver("a1", { id: "root-command", seq: 1, text: "active" });
    await Promise.resolve();
    const internal = mgr as unknown as {
      activeSpawnState: Map<string, object>;
      onAgentEvent(agentId: string, event: AgentEvent<BuiltinBackendSpecs, "codex">, runtimeId: "codex", owner: object): void;
    };
    const owner = internal.activeSpawnState.get("a1")!;
    let sequence = 200;
    const publish = (event: object) => internal.onAgentEvent("a1", {
      ...event,
      sequence: ++sequence,
      sessionInstanceId: "test-instance",
      at: Date.now(),
    } as never, "codex", owner);

    publish({ type: "turn_started", turnId: "root-turn", commandIds: ["root-command"] });
    publish({
      type: "turn_completed",
      turnId: "root-turn",
      commandIds: ["root-command"],
      result: { outcome: "success", backendSessionId: "s1" },
    });
    const idleSince = mgr.snapshot().agents.a1.idleSince;
    expect(mgr.snapshot().agents.a1).toMatchObject({ turnActive: false, turnId: "root-turn" });

    publish({ type: "diagnostic", turnId: "root-turn", severity: "warning", source: "codex", message: "tail" });
    publish({ type: "token_usage", turnId: "root-turn", source: "codex", usage: {}, details: {} });
    publish({ type: "rate_limits", source: "codex", details: {} });
    expect(mgr.snapshot().agents.a1).toMatchObject({ turnActive: false, idleSince });

    publish({ type: "internal_progress", turnId: "root-turn", source: "codex", itemType: "root-work" });
    expect(mgr.snapshot().agents.a1).toMatchObject({ turnActive: true, turnId: "root-turn", idleSince: null });
  });

  it("requeues a later asynchronous command_failed exactly once by delivery id", async () => {
    const session = b1Session([]);
    const { mgr } = b1Manager({ sessions: [session] });
    mgr.deliver("a1", { id: "first", seq: 1, text: "first" });
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.send = vi.fn(async () => ({ status: "queued" as const, reason: "unsafe_boundary" as const, commandId: "later" }));
    mgr.deliver("a1", { id: "later", seq: 2, text: "later" });
    await Promise.resolve();

    const internal = mgr as unknown as {
      activeSpawnState: Map<string, object>;
      onAgentEvent(agentId: string, event: AgentEvent<BuiltinBackendSpecs, "codex">, runtimeId: "codex", owner: object): void;
    };
    const owner = internal.activeSpawnState.get("a1")!;
    const failed = {
      type: "command_failed",
      commandId: "later",
      turnId: "test-turn",
      error: { category: "process", code: "delivery_failed", message: "failed", retryable: true },
      sequence: 300,
      sessionInstanceId: "test-instance",
      at: Date.now(),
    } as const;
    internal.onAgentEvent("a1", failed as never, "codex", owner);
    internal.onAgentEvent("a1", { ...failed, sequence: 301 } as never, "codex", owner);

    expect(mgr.snapshot().agents.a1.inbox).toEqual([{ id: "later", seq: 2, text: "later" }]);
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("does not expire a driver-acknowledged next-turn queue while the active root keeps making progress", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const rows: B1TraceRow[] = [];
      const session = b1Session([], "cursor", "root-turn");
      const { mgr } = b1Manager({
        sessions: [session],
        driver: fakeDriver("cursor"),
        trace: (row) => rows.push(row),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 50,
      });
      mgr.start();
      mgr.deliver("a1", { id: "root", seq: 1, text: "root" });
      await Promise.resolve();
      await Promise.resolve();

      session.send = vi.fn(async (input: { id: string }) => {
        void session.pushAgentEvent({
          type: "command_queued",
          commandId: input.id,
          reason: "runtime_busy",
        });
        return { status: "queued" as const, reason: "runtime_busy" as const, commandId: input.id };
      });

      now = 10;
      mgr.deliver("a1", { id: "next", seq: 2, text: "next" });
      await Promise.resolve();
      await Promise.resolve();
      expect(mgr.snapshot().agents.a1.pendingAdmissions).toHaveLength(1);

      // The queued command is waiting for Cursor's next-turn boundary, while
      // the original root is demonstrably healthy. Its queue dwell may exceed
      // the generic admission watchdog without turning into a send stall.
      now = 55;
      await session.pushAgentEvent({
        type: "internal_progress",
        turnId: "root-turn",
        source: "cursor",
      });
      now = 70;
      await vi.advanceTimersByTimeAsync(10);

      expect(mgr.snapshot().agents.a1.status).toBe("running");
      expect(mgr.snapshot().agents.a1.pendingAdmissions).toHaveLength(1);
      expect(session.stop).not.toHaveBeenCalled();
      expect(rows.some((row) =>
        Array.isArray(row.effects) && (row.effects as string[]).includes("expire_admission")
      )).toBe(false);

      await mgr.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not terminate a long tool wait hidden by a next-turn queue, but resumes ordinary stall detection", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let deliveryPhase: "working" | "tool_wait" | "next_turn_queued" = "working";
      const rows: B1TraceRow[] = [];
      const session = b1Session([], "cursor", "root-turn");
      const baseSnapshot = session.snapshot.bind(session);
      session.snapshot = () => ({
        ...baseSnapshot(),
        diagnostics: {
          deliveryPhase,
          metrics: {
            physicalOpenCount: 1,
            turnCount: 1,
            commandAdmissionCount: 1,
            commandAdmissionLatencyTotalMs: 0,
            queueDwellCount: 0,
            queueDwellTotalMs: 0,
            sseReconnectCount: 0,
            resumeOutcome: "fresh",
            terminalOwnerKind: "transport_request",
          },
        },
      });
      const { mgr } = b1Manager({
        sessions: [session],
        driver: fakeDriver("cursor"),
        trace: (row) => rows.push(row),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 50,
      });
      mgr.start();
      mgr.deliver("a1", { id: "root", seq: 1, text: "run a long command" });
      await Promise.resolve();
      await Promise.resolve();
      expect(mgr.snapshot().agents.a1).toMatchObject({ status: "running", turnActive: true });

      await session.pushAgentEvent({
        type: "tool_started",
        turnId: "root-turn",
        callId: "long-call",
        name: "Shell",
        input: { command: "long-running" },
      });
      deliveryPhase = "tool_wait";
      session.send = vi.fn(async (input: { id: string }) => {
        deliveryPhase = "next_turn_queued";
        void session.pushAgentEvent({
          type: "command_queued",
          commandId: input.id,
          reason: "runtime_busy",
        });
        return { status: "queued" as const, reason: "runtime_busy" as const, commandId: input.id };
      });
      now = 10;
      mgr.deliver("a1", { id: "next", seq: 2, text: "handle this next" });
      await Promise.resolve();
      await Promise.resolve();
      expect(mgr.snapshot().agents.a1.pendingAdmissions).toMatchObject([
        { commandId: "next", driverAcknowledged: true },
      ]);

      // The single diagnostics phase is now the queue overlay, not tool_wait.
      // The independently fenced tool lifecycle must keep the legitimate long
      // command alive beyond the generic root-silence threshold.
      now = 60;
      await vi.advanceTimersByTimeAsync(10);
      expect(mgr.snapshot().agents.a1.status).toBe("running");
      expect(mgr.snapshot().agents.a1.pendingAdmissions).toHaveLength(1);
      expect(session.stop).not.toHaveBeenCalled();
      expect(rows.some((row) =>
        row.deliveryPhase === "next_turn_queued"
        && Array.isArray(row.effects)
        && (row.effects as string[]).includes("terminate_stalled")
      )).toBe(false);

      // Finishing the tool removes the blocker and counts as root work. Do not
      // turn this into a global watchdog bypass: ordinary silence after that
      // point must still hit the existing threshold exactly once.
      now = 65;
      await session.pushAgentEvent({
        type: "tool_finished",
        turnId: "root-turn",
        callId: "long-call",
        name: "Shell",
      });
      deliveryPhase = "working";
      now = 120;
      await vi.advanceTimersByTimeAsync(10);
      expect(mgr.snapshot().agents.a1.status).toBe("stopping");
      expect(session.stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
      expect(rows.filter((row) =>
        Array.isArray(row.effects) && (row.effects as string[]).includes("terminate_stalled")
      )).toHaveLength(1);

      await mgr.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  for (const mode of ["idle", "busy"] as const) {
    it(`${mode} send synchronous throw aborts once and rethrows without another send`, async () => {
      const rows: B1TraceRow[] = [];
      const error = new Error(`unique-send-${mode}-secret`);
      const session = b1Session([]);
      const { mgr } = b1Manager({ sessions: [session], trace: (row) => rows.push(row) });
      mgr.deliver("a1", { seq: 1, text: "first" });
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      if (mode === "idle") await session.fire("runtime_event", { kind: "turn_end" });
      session.send = vi.fn(() => {
        throw error;
      });

      expect(() => mgr.deliver("a1", { seq: 2, text: "throw" })).toThrow(error);
      expect(session.send).toHaveBeenCalledTimes(1);
      const aborts = b1SpanRows(rows, "turn_abort");
      expect(aborts.length).toBeGreaterThan(0);
      expect(aborts.at(-1)!.abortCause).toBe("send_threw");
      expect(aborts.filter((row) => row.abortCause === "send_threw")).toHaveLength(1);
    });
  }

  it("handshake timeout aborts once before the session's terminal close", async () => {
    vi.useFakeTimers();
    try {
      const rows: B1TraceRow[] = [];
      const session = b1Session([]);
      const { mgr } = b1Manager({
        sessions: [session],
        trace: (row) => rows.push(row),
        handshakeTimeoutMs: 100,
      });
      mgr.deliver("a1", { seq: 1, text: "active" });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(101);
      await session.fire("exit", { reason: "requested" });

      const aborts = b1SpanRows(rows, "turn_abort");
      expect(aborts).toHaveLength(1);
      expect(aborts[0]!.abortCause).toBe("handshake_timeout");
      const exit = rows.find((row) => row.recordKind === "fsm" && row.event === "exit");
      expect(exit!.traceTurnId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminate_stalled then force_exit emits one abort total", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const rows: B1TraceRow[] = [];
      const session = b1Session([]);
      session.stop = vi.fn();
      const { mgr } = b1Manager({
        sessions: [session],
        driver: fakeDriver("codex"),
        trace: (row) => rows.push(row),
        now: () => now,
        tickIntervalMs: 5,
        staleThresholdMs: 50,
        stoppingStuckThresholdMs: 50,
      });
      mgr.start();
      mgr.deliver("a1", { seq: 1, text: "active" });
      await Promise.resolve();
      await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      now = 100;
      await vi.advanceTimersByTimeAsync(10);
      now = 200;
      await vi.advanceTimersByTimeAsync(60);

      const aborts = b1SpanRows(rows, "turn_abort");
      expect(aborts).toHaveLength(1);
      expect(aborts[0]!.abortCause).toBe("terminate_stalled");
      expect(rows.some((row) => Array.isArray(row.effects) && (row.effects as string[]).includes("force_exit"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("B1 red gate — stale owner isolation", () => {
  it("old launch callbacks and a late deferred start rejection never borrow or close the replacement span", async () => {
    const rows: B1TraceRow[] = [];
    const first = fakeSession();
    const second = b1Session([], "b");
    const { mgr } = b1Manager({ sessions: [first, second], trace: (row) => rows.push(row), launchId: "launch-a" });
    mgr.deliver("a1", { seq: 1, text: "first" });
    await mgr.resetSession("a1", { runtimeConfig: B1_RUNTIME_CONFIG, launchId: "launch-b", rewakePrompt: "reborn" });
    await first.fire("exit", { signal: "SIGTERM", reason: "requested" });
    await Promise.resolve();

    const begins = b1SpanRows(rows, "turn_begin");
    expect(begins).toHaveLength(2);
    const replacementId = begins[1]!.traceTurnId;
    rows.length = 0;
    await first.fire("runtime_event", { kind: "text", text: "late old output" });
    await first.fire("runtime_event", { kind: "turn_end" });
    first.startRejector!(new Error("HOSTILE_LATE_START_REJECTION_19cf"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staleRows = [...rows];
    expect(
      staleRows.every((row) => row.traceTurnId !== replacementId),
      JSON.stringify(staleRows),
    ).toBe(true);
    expect(
      b1SpanRows(rows).filter(
        (row) => row.traceTurnId === replacementId && (row.event === "turn_end" || row.event === "turn_abort"),
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain("HOSTILE_LATE_START_REJECTION_19cf");

    await second.fire("runtime_event", { kind: "turn_end" });
    const replacementCloses = b1SpanRows(rows).filter((row) => row.traceTurnId === replacementId && (row.event === "turn_end" || row.event === "turn_abort"));
    expect(replacementCloses).toHaveLength(1);
  });
});

describe("AgentProcessManager — defensive owner fences", () => {
  it("drops stale and superseded public events before state mutation", () => {
    const logger = stubLogger();
    const { mgr } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });
    const internal = mgr as unknown as {
      activeSpawnState: Map<string, { sessionInstanceId: string | null; superseded: boolean }>;
      onAgentEvent(agentId: string, event: object, runtimeId: "codex", owner: object): void;
    };
    const owner = internal.activeSpawnState.get("a1")!;
    owner.sessionInstanceId = "test-instance";
    internal.onAgentEvent("a1", {
      type: "assistant_reasoning_completed", turnId: "turn", text: "stale", truncated: false, sequence: 1,
      sessionInstanceId: "stale-instance", at: Date.now(),
    }, "codex", owner);
    owner.superseded = true;
    (mgr as unknown as { state: { agents: { a1: { execution: { sessionInstanceId: string } } } } })
      .state.agents.a1.execution.sessionInstanceId = "replacement-instance";
    internal.onAgentEvent("a1", {
      type: "assistant_reasoning_completed", turnId: "turn", text: "superseded", truncated: false, sequence: 2,
      sessionInstanceId: "test-instance", at: Date.now(),
    }, "codex", owner);
    expect(logger.calls.warn.map(([message]) => message)).toEqual([
      "ignored event from stale session epoch",
      "ignored event from superseded session owner",
    ]);
  });

  it.each(["resolve", "reject"] as const)("ignores a stale send promise %s", async (outcome) => {
    const session = b1Session([]);
    const { mgr } = b1Manager({ sessions: [session] });
    mgr.deliver("a1", { id: "first", seq: 1, text: "first" });
    await Promise.resolve();
    let resolve!: (receipt: DeliveryReceipt) => void;
    let reject!: (error: unknown) => void;
    session.send = vi.fn(() => new Promise<DeliveryReceipt>((yes, no) => {
      resolve = yes;
      reject = no;
    }));
    mgr.deliver("a1", { id: "later", seq: 2, text: "later" });
    const internal = mgr as unknown as { activeSpawnState: Map<string, { torndown: boolean }> };
    internal.activeSpawnState.get("a1")!.torndown = true;
    if (outcome === "resolve") {
      resolve({ status: "rejected", reason: "closed" });
    } else {
      reject(new Error("late rejection"));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(session.stop).not.toHaveBeenCalled();
  });

  it("rejects a send with no attached session and expires owned admissions", async () => {
    const { mgr, session } = makeManager();
    const internal = mgr as unknown as {
      applyEffect(effect: object): void;
      activeSpawnState: Map<string, {
        sessionInstanceId: string | null;
        pendingDeliverySpans: Map<string, object>;
        terminationSemantics: string | null;
      }>;
    };
    internal.applyEffect({
      type: "send", agentId: "a1", message: { id: "missing", seq: 1, text: "missing" }, mode: "busy",
    });
    mgr.deliver("a1", { id: "first", seq: 2, text: "first" });
    session.stop = vi.fn(session.stop);
    const owner = internal.activeSpawnState.get("a1")!;
    owner.sessionInstanceId = "test-instance";
    owner.pendingDeliverySpans.set("expired", { sessionInstanceId: "test-instance", span: null });
    internal.applyEffect({
      type: "expire_admission", agentId: "a1", sessionInstanceId: "test-instance", commandIds: ["expired"],
    });
    expect(owner.pendingDeliverySpans.has("expired")).toBe(false);
    expect(owner.terminationSemantics).toBe("killed_stalled");
    expect(session.stop).toHaveBeenCalledWith({ reason: "stalled", forceAfterMs: 2_000 });
  });

  it("marks a previous spawn owner superseded before replacing it", () => {
    const mgr = new AgentProcessManager({
      driverFor: () => b1PersistentDriver(),
      baseContextFor: () => ({
        workingDirectory: "/tmp", agentId: "a1", standingPrompt: "",
        config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
      sessionFactory: (() => new Promise<FakeSession>(() => {})) as SessionFactory,
    });
    mgr.register("a1");
    const internal = mgr as unknown as {
      doSpawn(agentId: string, messages: Array<{ id: string; seq: number; text: string }>, resumeSessionId: null): void;
      activeSpawnState: Map<string, { superseded: boolean }>;
    };
    internal.doSpawn("a1", [{ id: "one", seq: 1, text: "one" }], null);
    const first = internal.activeSpawnState.get("a1")!;
    internal.doSpawn("a1", [{ id: "two", seq: 2, text: "two" }], null);
    expect(first.superseded).toBe(true);
  });

  it("abandons queued startup delivery when dispatch replaces its owner", async () => {
    const session = fakeSession();
    session.send = vi.fn(session.send);
    const { mgr } = b1Manager({ sessions: [session] });
    const internal = mgr as unknown as {
      doSpawn(agentId: string, messages: Array<{ id: string; seq: number; text: string }>, resumeSessionId: null): void;
      dispatch(event: { type: string }, owner?: object): void;
      activeSpawnState: Map<string, object>;
    };
    const dispatch = internal.dispatch.bind(mgr);
    vi.spyOn(internal, "dispatch").mockImplementation((event, owner) => {
      dispatch(event, owner);
      if (event.type === "spawned") internal.activeSpawnState.delete("a1");
    });
    internal.doSpawn("a1", [
      { id: "first", seq: 1, text: "first" },
      { id: "queued", seq: 2, text: "queued" },
    ], null);
    session.startResolver?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.send).not.toHaveBeenCalled();
  });

  it("abandons a queued receipt that settles after owner teardown", async () => {
    const session = fakeSession();
    session.stop = vi.fn(session.stop);
    let resolve!: (receipt: DeliveryReceipt) => void;
    session.send = vi.fn(() => new Promise<DeliveryReceipt>((done) => { resolve = done; }));
    const { mgr } = b1Manager({ sessions: [session] });
    const internal = mgr as unknown as {
      doSpawn(agentId: string, messages: Array<{ id: string; seq: number; text: string }>, resumeSessionId: null): void;
      activeSpawnState: Map<string, { torndown: boolean }>;
    };
    internal.doSpawn("a1", [
      { id: "first", seq: 1, text: "first" },
      { id: "queued", seq: 2, text: "queued" },
    ], null);
    session.startResolver?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.send).toHaveBeenCalledOnce();
    internal.activeSpawnState.get("a1")!.torndown = true;
    resolve({ status: "accepted", delivery: "steer", commandId: "queued", turnId: "test-turn" });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.stop).not.toHaveBeenCalled();
  });

  it("audits an unexpected queued-delivery orchestration failure", async () => {
    const session = fakeSession();
    const { mgr } = b1Manager({ sessions: [session] });
    const internal = mgr as unknown as {
      doSpawn(agentId: string, messages: Array<{ id: string; seq: number; text: string }>, resumeSessionId: null): void;
      beginPendingDelivery(...args: unknown[]): void;
      emitErrorAudit(...args: unknown[]): void;
    };
    const begin = internal.beginPendingDelivery.bind(mgr);
    let calls = 0;
    vi.spyOn(internal, "beginPendingDelivery").mockImplementation((...args) => {
      if (++calls === 2) throw new Error("queued orchestration failed");
      begin(...args);
    });
    const audit = vi.spyOn(internal, "emitErrorAudit");
    internal.doSpawn("a1", [
      { id: "first", seq: 1, text: "first" },
      { id: "queued", seq: 2, text: "queued" },
    ], null);
    session.startResolver?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audit).toHaveBeenCalledWith("a1", "runtime", "send_failed", "Error: queued orchestration failed");
  });
});

describe("B1 red gate — privacy normalization and coherent time", () => {
  it("drops hostile prompt/error detail, normalizes unknown spawn reason, and preserves the audit callback input", async () => {
    const rows: B1TraceRow[] = [];
    const onRuntimeSpawnFailed = vi.fn();
    const session = b1Session([]);
    const { mgr } = b1Manager({
      sessions: [session],
      trace: (row) => rows.push(row),
      onRuntimeSpawnFailed,
    });
    const prompt = "UNIQUE_PROMPT_SECRET_8f26";
    const hostileCode = "UNIQUE_RAW_REASON_SECRET_71ac";
    mgr.deliver("a1", { seq: 1, text: prompt });
    await session.fire("error", { code: hostileCode, message: "UNIQUE_DETAIL_SECRET_5d44" });
    await session.fire("exit");

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain(hostileCode);
    expect(serialized).not.toContain("UNIQUE_DETAIL_SECRET_5d44");
    expect(serialized).not.toContain("errorDetail");
    const exit = rows.find((row) => row.event === "exit");
    expect(exit!.spawnFailureReason).toBe("other");
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", hostileCode);
  });

  it("drops send/response/thinking/tool and gated-hold detail at every producer boundary", async () => {
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    const { mgr } = b1Manager({
      sessions: [session],
      driver: b1GatedDriver(),
      trace: (row) => rows.push(row),
    });
    const secrets = {
      prompt: "HOSTILE_INITIAL_PROMPT_ea31",
      send: "HOSTILE_SEND_TEXT_581b",
      response: "HOSTILE_RESPONSE_TEXT_98ac",
      thinking: "HOSTILE_THINKING_TEXT_1d7f",
      tool: "HOSTILE_TOOL_PAYLOAD_6c23",
      recentEvent: "HOSTILE_RECENT_EVENT_47bd",
    };

    mgr.deliver("a1", { seq: 1, text: secrets.prompt });
    await Promise.resolve();
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "text", text: secrets.response });
    await session.fire("runtime_event", { kind: "thinking", text: secrets.thinking });
    await session.fire("runtime_event", {
      kind: "tool_call",
      name: "Read",
      input: { file_path: secrets.tool, nested: { raw: secrets.tool } },
    });
    await session.fire("runtime_event", { kind: secrets.recentEvent, text: secrets.response });
    mgr.deliver("a1", { seq: 2, text: secrets.send });

    expect(rows.some((row) => Array.isArray(row.effects) && (row.effects as string[]).includes("gated_hold"))).toBe(false);
    const serialized = JSON.stringify(rows);
    for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("mid_turn_wake");
    expect(serialized).not.toContain("recentEvents");
  });

  it("normalizes unknown termination semantics without leaking the raw token", async () => {
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    const { mgr } = b1Manager({ sessions: [session], trace: (row) => rows.push(row) });
    mgr.deliver("a1", { seq: 1, text: "active" });
    await Promise.resolve();
    (mgr as unknown as { dispatch(event: unknown): void }).dispatch({
      type: "exit",
      agentId: "a1",
      terminationSemantics: "HOSTILE_TERMINATION_SEMANTIC_03cc",
    });

    const exit = rows.find((row) => row.recordKind === "fsm" && row.event === "exit");
    expect(exit).toBeTruthy();
    expect(exit!.terminationSemantics).toBe("other");
    expect(JSON.stringify(rows)).not.toContain("HOSTILE_TERMINATION_SEMANTIC_03cc");
  });

  it("derives every row timeIso from that row's single nowMs sample", async () => {
    let tick = 0;
    const rows: B1TraceRow[] = [];
    const session = b1Session([]);
    const { mgr } = b1Manager({
      sessions: [session],
      trace: (row) => rows.push(row),
      now: () => Date.UTC(2026, 0, 1) + tick++,
    });
    mgr.deliver("a1", { seq: 1, text: "time" });
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    await session.fire("runtime_event", { kind: "turn_end" });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.timeIso).toBe(new Date(row.nowMs as number).toISOString());
    }
  });
});

describe("Codex root event ownership — subagent completion isolation", () => {
  it("ignores multiple child completions while the parent keeps working past idle timeout, then hibernates after the true root completion", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const session = fakeSession();
      const adapter = createBuiltinAgentDriverRegistry().get("codex").createAdapter();
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"),
        baseContextFor: () => ({
          workingDirectory: "/tmp",
          agentId: "a1",
          standingPrompt: "",
          config: {} as LaunchContext["config"],
          credentialProxy: {} as LaunchContext["credentialProxy"],
        }),
        sessionFactory: sessionFactoryFor(session),
        now: () => now,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        staleThresholdMs: 1_000,
      });

      const publishNormalized = async (events: readonly AdapterEvent[]) => {
        for (const event of events) {
          if (event.kind === "session_init") {
            await session.pushAgentEvent({ type: "session_started", backendSessionId: event.sessionId });
          } else if (event.kind === "assistant_reasoning_completed") {
            await session.pushAgentEvent({ type: "assistant_reasoning_completed", turnId: "test-turn", text: event.text, truncated: false });
          } else if (event.kind === "tool_call") {
            await session.pushAgentEvent({ type: "tool_started", turnId: "test-turn", name: event.name, input: event.input as never });
          } else if (event.kind === "tool_output") {
            await session.pushAgentEvent({ type: "tool_finished", turnId: "test-turn", name: event.name });
          } else if (event.kind === "turn_end") {
            await session.pushAgentEvent({
              type: "turn_completed",
              turnId: "test-turn",
              commandIds: ["root-command"],
              result: { outcome: "success", backendSessionId: event.sessionId ?? "root-thread" },
            });
          }
        }
      };
      const notify = (method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", method, params });

      mgr.start();
      mgr.register("a1");
      mgr.deliver("a1", { id: "root-command", text: "work" });
      session.startResolver?.();
      await Promise.resolve();
      await publishNormalized(adapter.normalizeLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "root-thread" } } })));
      await publishNormalized(adapter.normalizeLine(notify("turn/started", {
        threadId: "root-thread",
        turn: { id: "root-turn", status: "inProgress" },
      })));

      for (let child = 1; child <= 3; child += 1) {
        const events = adapter.normalizeLine(notify("turn/completed", {
          threadId: `child-thread-${child}`,
          turn: { id: `child-turn-${child}`, status: "completed" },
        }));
        expect(events).toEqual([]);
        await publishNormalized(events);
        now += 40;
        await publishNormalized(adapter.normalizeLine(notify(child % 2 === 0 ? "item/completed" : "item/started", {
          threadId: "root-thread",
          turnId: "root-turn",
          item: { type: "commandExecution" },
        })));
        await vi.advanceTimersByTimeAsync(40);
        expect(mgr.snapshot().agents.a1).toMatchObject({ status: "running", turnActive: true });
      }

      await publishNormalized(adapter.normalizeLine(notify("turn/completed", {
        threadId: "root-thread",
        turn: { id: "root-turn", status: "completed" },
      })));
      expect(mgr.snapshot().agents.a1).toMatchObject({ status: "running", turnActive: false });
      now += 60;
      await vi.advanceTimersByTimeAsync(60);
      expect(mgr.snapshot().agents.a1.status).toBe("stopping");
    } finally {
      vi.useRealTimers();
    }
  });
});

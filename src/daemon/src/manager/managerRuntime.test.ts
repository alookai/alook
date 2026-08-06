import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { PassThrough } from "stream";
import {
  AgentProcessManager,
  truncateThinking,
  canonicalToolName,
  extractToolAudit,
  isAlookShellInvocation,
  truncateTargetToCodeUnits,
  type ManagedSession,
  type SessionFactory,
} from "./managerRuntime.js";
import { SdkRuntimeSession, type SdkSessionHandle } from "../runtime/sdkRuntimeSession.js";
import type { Driver, LaunchContext, SdkDriverDeps } from "../types.js";
import type { Logger } from "../logger.js";

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
interface FakeSession extends ManagedSession {
  fire(evt: string, ...args: unknown[]): void;
  startResolver?: () => void;
  startRejector?: (err: unknown) => void;
}

function fakeSession(): FakeSession {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const s: FakeSession = {
    on(event, cb) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    start() {
      return new Promise<void>((resolve, reject) => {
        s.startResolver = resolve;
        s.startRejector = reject;
      });
    },
    send() { },
    stop() { },
    get currentSessionId() {
      return null;
    },
    fire(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) cb(...args);
    },
  };
  return s;
}

function makeManager(opts: { logger?: Logger; tickIntervalMs?: number; idleTimeoutMs?: number; staleThresholdMs?: number; resetStuckThresholdMs?: number; handshakeTimeoutMs?: number; now?: () => number; onBotAuditEvent?: (agentId: string, event: unknown, context: { sessionId: string | null; launchId: string | null }) => void } = {}) {
  const session = fakeSession();
  const factory: SessionFactory = () => session;
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

describe("AgentProcessManager — runtime health callbacks", () => {
  it("ENOENT `error` followed by `exit` reports the failure ONCE with the specific code", () => {
    const { mgr, session, onRuntimeSpawnFailed } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    // child_process emits `error` first (with ENOENT), then `exit`.
    session.fire("error", { code: "ENOENT" });
    session.fire("exit");

    expect(onRuntimeSpawnFailed).toHaveBeenCalledTimes(1);
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "ENOENT");
  });

  it("session.start().catch after `error` does NOT re-report — first path wins", async () => {
    const { mgr, session, onRuntimeSpawnFailed } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("error", { code: "ENOENT" });
    session.startRejector?.({ code: "spawn_threw" });
    // Let the .catch microtask drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(onRuntimeSpawnFailed).toHaveBeenCalledTimes(1);
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "ENOENT");
  });

  it("`exit` alone (no `error`) reports as pre_handshake_exit", () => {
    const { mgr, session, onRuntimeSpawnFailed } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("exit");

    expect(onRuntimeSpawnFailed).toHaveBeenCalledTimes(1);
    expect(onRuntimeSpawnFailed).toHaveBeenCalledWith("codex", "pre_handshake_exit");
  });

  it("runtime_event marks the session established AND heals the runtime; subsequent error is session-level (no spawn-failed)", () => {
    const { mgr, session, onRuntimeSpawnFailed, onRuntimeSessionEstablished } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "text", text: "hi" });
    session.fire("error", { code: "EPIPE" });
    session.fire("exit");

    expect(onRuntimeSessionEstablished).toHaveBeenCalledWith("codex");
    expect(onRuntimeSpawnFailed).not.toHaveBeenCalled();
  });

  it("fires onRuntimeSessionEstablished on EVERY runtime_event so a parallel session can heal the map", () => {
    const { mgr, session, onRuntimeSessionEstablished } = makeManager();
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "text", text: "one" });
    session.fire("runtime_event", { kind: "text", text: "two" });
    session.fire("runtime_event", { kind: "text", text: "three" });

    // Called on every event — router idempotence collapses to one wire frame.
    expect(onRuntimeSessionEstablished).toHaveBeenCalledTimes(3);
  });
});

describe("AgentProcessManager — raw runtime line tap (P0-1)", () => {
  it("adds agent identity before the default child-process session parses the line", async () => {
    const { driver, stdout, parseLine } = controllableChildDriver("codex");
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
      onRuntimeRawLine,
    });
    mgr.register("agent_a");
    mgr.deliver("agent_a", { seq: 1, text: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    stdout.write('{"vendor":"field"}\n');

    expect(onRuntimeRawLine).toHaveBeenCalledWith("agent_a", '{"vendor":"field"}');
    expect(parseLine).toHaveBeenCalledWith('{"vendor":"field"}');
  });

  it("does not attach the child stdout tap to a custom session factory", () => {
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
  it("logs info on spawn start with agentId + runtime", () => {
    const logger = stubLogger();
    const { mgr } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    expect(
      logger.calls.info.some(
        ([m, d]) => m === "spawning agent" && (d[0] as any).agentId === "a1" && (d[0] as any).runtime === "codex",
      ),
    ).toBe(true);
  });

  it("logs info on session established (session_init) with agentId/sessionId/runtime", () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });

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

  it("logs warn on a pre-handshake spawn failure (ENOENT)", () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("error", { code: "ENOENT" });
    session.fire("exit");

    expect(
      logger.calls.warn.some(
        ([m, d]) => m === "spawn failed" && (d[0] as any).agentId === "a1" && (d[0] as any).reason === "ENOENT",
      ),
    ).toBe(true);
  });

  it("logs info on session ended with reason=turn_end", () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("runtime_event", { kind: "turn_end" });

    expect(
      logger.calls.info.some(
        ([m, d]) =>
          m === "agent session ended" && (d[0] as any).reason === "turn_end" && (d[0] as any).sessionId === "s1",
      ),
    ).toBe(true);
  });

  it("logs info on session ended with reason=exit for an ESTABLISHED session's process exit", () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("exit");

    expect(
      logger.calls.info.some(
        ([m, d]) => m === "agent session ended" && (d[0] as any).reason === "exit" && (d[0] as any).sessionId === "s1",
      ),
    ).toBe(true);
  });

  it("does NOT log session-ended for a pre-handshake exit (already a spawn-failed warning)", () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("exit");

    expect(logger.calls.info.some(([m]) => m === "agent session ended")).toBe(false);
  });

  it("does NOT double-log session-ended when a per_turn runtime's natural post-turn_end exit fires (turn_end already logged)", () => {
    const logger = stubLogger();
    const { mgr, session } = makeManager({ logger }); // fakeDriver's lifecycle.kind is "per_turn"
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("runtime_event", { kind: "turn_end" });
    // The per_turn process exits on its own right after turn_end — this
    // must NOT produce a second, contradictory "session ended" line.
    session.fire("exit");

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
  it("passes the latest agent:wake's launchId into the spawned driver's LaunchContext", () => {
    let capturedCtx: LaunchContext | undefined;
    const factory: SessionFactory = ({ ctx }) => {
      capturedCtx = ctx;
      return fakeSession();
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

  it("falls back to baseContextFor's launchId when no wake launchId is tracked", () => {
    let capturedCtx: LaunchContext | undefined;
    const factory: SessionFactory = ({ ctx }) => {
      capturedCtx = ctx;
      return fakeSession();
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
    const factory: SessionFactory = () => {
      const s = fakeSession();
      sessions.push(s);
      return s;
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
    session1.fire("exit");
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });

      currentTime = 200;
      await vi.advanceTimersByTimeAsync(10);
      // The stall watchdog issued session.stop() — simulate the underlying
      // process actually exiting shortly after.
      session.fire("exit");

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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });

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

  it("internal_progress heartbeats do NOT refresh the stall watchdog — a compacting agent that only emits stream_event pings still gets terminated at the threshold", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const logger = stubLogger();
      const { mgr, session } = makeManager({ logger, now: () => currentTime, tickIntervalMs: 5, staleThresholdMs: 100 });
      mgr.start();
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });

      // Simulate Claude going into compaction and emitting only heartbeats.
      // Without the fix these keep bumping lastProgressAt and the stall never
      // fires; with the fix they're ignored for stall purposes.
      currentTime = 50;
      session.fire("runtime_event", { kind: "compaction_started" });
      currentTime = 80;
      session.fire("runtime_event", { kind: "internal_progress", source: "claude_system", itemType: "stream_event" });
      currentTime = 150;
      session.fire("runtime_event", { kind: "internal_progress", source: "claude_system", itemType: "stream_event" });

      // 200ms since spawn (t=0), 120ms since compaction_started's real
      // progress event. Threshold is 100ms → watchdog must fire.
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
      const factory: SessionFactory = () => session;
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      session.fire("runtime_event", { kind: "turn_end" });

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
        sessionFactory: () => session,
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        stoppingStuckThresholdMs: 100,
      });
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      session.fire("runtime_event", { kind: "turn_end" });
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

  it("force_exit reaps the orphan via the recorded pid when the session handle is gone (batch F, Hypothesis A)", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 0;
      const persistentDriver = {
        ...fakeDriver("codex"),
        lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      } as Driver;
      const session = fakeSession();
      // A dead/never-existed pid: killProcessTree self-guards (isAlive → false),
      // so this exercises the pid-kill BRANCH without signalling a real process.
      (session as unknown as { pid: number }).pid = 2147483646;
      const mgr = new AgentProcessManager({
        driverFor: () => persistentDriver,
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: () => session,
        now: () => currentTime,
        tickIntervalMs: 5,
        idleTimeoutMs: 50,
        stoppingStuckThresholdMs: 100,
      });
      mgr.register("a1");
      mgr.deliver("a1", { seq: 1, text: "hello" });
      session.startResolver?.();
      await Promise.resolve();
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      // pid recorded at spawn.
      expect((mgr as unknown as { activeSpawnState: Map<string, { pid: number | null }> }).activeSpawnState.get("a1")?.pid).toBe(2147483646);
      session.fire("runtime_event", { kind: "turn_end" });
      mgr.start();
      currentTime = 100;
      await vi.advanceTimersByTimeAsync(10); // → stopping

      // Simulate Hypothesis A: the session handle is gone from the map (the wedge
      // cause) while force_exit is about to fire. The recorded pid must be the
      // fallback kill target — no crash, and the FSM still escapes stopping.
      (mgr as unknown as { sessions: Map<string, unknown> }).sessions.delete("a1");
      currentTime = 300;
      await vi.advanceTimersByTimeAsync(10); // → force_exit (no session, pid present)

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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      session.fire("runtime_event", { kind: "turn_end" });
      mgr.start();
      currentTime = 100;
      await vi.advanceTimersByTimeAsync(10); // → stopping
      (mgr as unknown as { sessions: Map<string, unknown> }).sessions.delete("a1"); // no handle
      currentTime = 300;
      await vi.advanceTimersByTimeAsync(10); // → force_exit: no session, no pid

      // Warned about the unkillable orphan, and still escaped stopping (no crash).
      expect(logger.calls.warn.some(([m]) => typeof m === "string" && m.includes("no session handle AND no recorded pid"))).toBe(true);
      expect(mgr.snapshot().agents["a1"]?.status).not.toBe("stopping");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentProcessManager — onAgentActivity (derived activity reporting)", () => {
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
      const factory: SessionFactory = () => session;
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // spawned -> running
      session.fire("runtime_event", { kind: "turn_end" }); // running,turnActive=false -> derived idle

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
    const factory: SessionFactory = () => session;
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
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // -> running
    session.fire("runtime_event", { kind: "turn_end" }); // -> idle (derived)

    mgr.deliver("a1", { seq: 2, text: "second turn" }); // re-wake: running,turnActive=false -> running
    session.fire("runtime_event", { kind: "turn_end" }); // -> idle again

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
      sessionFactory: () => session,
    });
    mgr.register("a1");
    // register alone: known but not running ⇒ idle.
    expect(mgr.agentActivity("a1")).toBe("idle");

    mgr.deliver("a1", { seq: 1, text: "hello" });
    session.startResolver?.();
    await Promise.resolve();
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // -> running, turnActive
    expect(mgr.agentActivity("a1")).toBe("running");
    expect(mgr.liveAgentActivities()).toEqual([{ agentId: "a1", state: "running" }]);

    session.fire("runtime_event", { kind: "turn_end" }); // running, !turnActive, empty inbox -> idle
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
      const factory: SessionFactory = ({ agentId }) => (agentId === "a1" ? sessionA : sessionB);
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
      sessionA.fire("runtime_event", { kind: "session_init", sessionId: "sa" });
      sessionA.fire("runtime_event", { kind: "turn_end" });
      sessionB.fire("runtime_event", { kind: "session_init", sessionId: "sb" });
      sessionB.fire("runtime_event", { kind: "turn_end" });
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

  it("register alone (no wake) never fires onAgentActivity", () => {
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
      sessionFactory: () => fakeSession(),
      onAgentActivity,
    });
    mgr.register("a1");
    expect(onAgentActivity).not.toHaveBeenCalled();
  });
});

// A driver in the shape of PiDriver — declares `createSession` instead of a
// usable `spawn`, mirroring the real "in-process SDK" contract.
function fakeSdkDriver(id: string): { driver: Driver & { createSession: NonNullable<Driver["createSession"]> }; createSession: ReturnType<typeof vi.fn> } {
  let session: SdkRuntimeSession;
  const handle: SdkSessionHandle = {
    prompt: (text: string) => {
      session.emitEvents([{ kind: "text", text }]);
    },
    steer: () => { },
  };
  const createSession = vi.fn(async () => {
    session = new SdkRuntimeSession(handle, "sdk-sess-1");
    return session;
  });
  const driver = {
    ...fakeDriver(id),
    spawn: async () => {
      throw new Error("in-process SDK driver — spawn unsupported");
    },
    createSession,
  } as unknown as Driver & { createSession: NonNullable<Driver["createSession"]> };
  return { driver, createSession };
}

describe("AgentProcessManager — in-process SDK driver dispatch (Driver.createSession)", () => {
  it("throws a clear error when a driver declares createSession but no sessionFactory/sdkDriverDepsFor was configured", () => {
    const { driver } = fakeSdkDriver("pi");
    const mgr = new AgentProcessManager({
      driverFor: () => driver,
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        credentialProxy: {} as LaunchContext["credentialProxy"],
      }),
    });
    mgr.register("a1");
    expect(() => mgr.deliver("a1", { seq: 1, text: "hello" })).toThrow(/sdkDriverDepsFor/);
  });

  it("dispatches through SdkManagedSession (not a child process) when sdkDriverDepsFor is configured, and streams runtime_events normally", async () => {
    const { driver, createSession } = fakeSdkDriver("pi");
    const onRuntimeSessionEstablished = vi.fn();
    const onRuntimeRawLine = vi.fn();
    const sdkDeps: SdkDriverDeps = {
      buildSpawnEnv: vi.fn().mockResolvedValue({}),
      createAgentSession: vi.fn(),
    };
    const mgr = new AgentProcessManager({
      driverFor: () => driver,
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
      }),
      sdkDriverDepsFor: () => sdkDeps,
      onRuntimeSessionEstablished,
      onRuntimeRawLine,
    });
    mgr.register("a1");
    mgr.deliver("a1", { seq: 1, text: "hello" });
    // createSession is async — let its microtasks (and the subsequent send()) drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(onRuntimeSessionEstablished).toHaveBeenCalledWith("pi");
    expect(onRuntimeRawLine).not.toHaveBeenCalled();
  });

  it("does NOT require a credentialProxy for an in-process SDK driver (that guard is child-process-only)", () => {
    const { driver } = fakeSdkDriver("pi");
    const sdkDeps: SdkDriverDeps = { buildSpawnEnv: vi.fn().mockResolvedValue({}), createAgentSession: vi.fn() };
    const mgr = new AgentProcessManager({
      driverFor: () => driver,
      baseContextFor: () => ({
        workingDirectory: "/tmp",
        agentId: "a1",
        standingPrompt: "",
        config: {} as LaunchContext["config"],
        // no credentialProxy on purpose
      }),
      sdkDriverDepsFor: () => sdkDeps,
    });
    mgr.register("a1");
    expect(() => mgr.deliver("a1", { seq: 1, text: "hello" })).not.toThrow();
  });
});

describe("truncateThinking", () => {
  it("returns text unchanged when under the byte budget", () => {
    const { text, truncated, chars } = truncateThinking("short");
    expect(text).toBe("short");
    expect(truncated).toBe(false);
    expect(chars).toBe(5);
  });

  it("truncates > 4KB text and reports the original char count", () => {
    const long = "a".repeat(5000);
    const { text, truncated, chars } = truncateThinking(long);
    expect(truncated).toBe(true);
    expect(chars).toBe(5000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("never splits a multi-byte UTF-8 sequence", () => {
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
  it("emits `thinking` with truncated+chars fields (flushed at the next event)", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "thinking", text: "think about it" });
    expect(onBotAuditEvent).not.toHaveBeenCalled();
    session.fire("runtime_event", { kind: "turn_end" });

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

  it("coalesces delta-streamed thinking into ONE row and drops empty deltas", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "thinking", text: "" });
    session.fire("runtime_event", { kind: "thinking", text: "let me " });
    session.fire("runtime_event", { kind: "thinking", text: "count" });
    session.fire("runtime_event", { kind: "thinking", text: "" });
    session.fire("runtime_event", { kind: "tool_call", name: "Read", input: { file_path: "/x" } });

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

  it("emits `tool_call` with canonical name + resolved target", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "tool_call", name: "Read", input: { file_path: "/etc/passwd" } });

    expect(onBotAuditEvent).toHaveBeenCalledWith(
      "a1",
      { kind: "tool_call", payload: { name: "read", target: "/etc/passwd" } },
      expect.objectContaining({ sessionId: null, launchId: null })
    );
  });

  it("carries sessionId (populated after session_init) into the context arg", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "session_init", sessionId: "s_abc" });
    session.fire("runtime_event", { kind: "tool_call", name: "Read", input: { file_path: "/x" } });

    expect(onBotAuditEvent).toHaveBeenCalledWith(
      "a1",
      { kind: "tool_call", payload: { name: "read", target: "/x" } },
      { sessionId: "s_abc", launchId: null }
    );
  });

  it("DROPS bash-family tool_call whose command is `alook <sub>` for BOTH capitalized and lowercase names", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", {
      kind: "tool_call",
      name: "Bash",
      input: { command: "alook inbox pull --max 5" },
    });
    session.fire("runtime_event", {
      kind: "tool_call",
      name: "bash",
      input: { command: "  alook message send @gus hi" },
    });
    session.fire("runtime_event", {
      kind: "tool_call",
      name: "Bash",
      input: { command: "alook" },
    });
    session.fire("runtime_event", {
      kind: "tool_call",
      name: "shell",
      input: { command: "alook inbox pull" },
    });

    const bashCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call"
    );
    expect(bashCalls).toHaveLength(0);
  });

  it("EMITS bash tool_call for non-alook shell work with canonical `bash` name + target", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "rm -rf /tmp/xxx" } });
    session.fire("runtime_event", { kind: "tool_call", name: "bash", input: { command: "sed -i '' '/pattern/d' todo.md" } });
    session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "echo -n > todo.md" } });

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

  it("truncates a long Bash target to <= 200 chars with an ellipsis", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    const long = "echo " + "x".repeat(400);
    session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: long } });

    const [call] = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call",
    );
    const target = (call![1] as { payload: { target?: string } }).payload.target!;
    expect(target.length).toBeLessThanOrEqual(200);
    expect(target.endsWith("…")).toBe(true);
  });

  it("emits bash tool_call without `target` when input has no command string", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: {} });

    const [call] = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "tool_call",
    );
    expect((call![1] as { payload: unknown }).payload).toEqual({ name: "bash" });
  });

  it("canonicalizes tool names on tool_calls (Edit → edit, MultiEdit → edit, Grep → grep, Glob → glob) with resolved target", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "tool_call", name: "Edit", input: { file_path: "/x" } });
    session.fire("runtime_event", { kind: "tool_call", name: "Write", input: { file_path: "/y" } });
    session.fire("runtime_event", { kind: "tool_call", name: "MultiEdit", input: { file_path: "/z" } });
    session.fire("runtime_event", { kind: "tool_call", name: "Grep", input: { pattern: "TODO" } });
    session.fire("runtime_event", { kind: "tool_call", name: "Glob", input: { pattern: "**/*.ts" } });

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

  it("does NOT emit for non-audit event kinds (session_init, text, turn_end)", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("runtime_event", { kind: "text", text: "hi human" });
    session.fire("runtime_event", { kind: "turn_end" });

    expect(onBotAuditEvent).not.toHaveBeenCalled();
  });

  it("payload never contains extra fields beyond {name, target?} (T11)", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "tool_call", name: "Edit", input: { file_path: "/x", oldText: "a", newText: "b", edits: [] } });
    session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "rm x", stdin: "secret" } });

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
  it("emits an `error` row on a pre-handshake exit (spawn scope)", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("exit");

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]![1] as { payload: { scope: string; code: string } }).payload).toEqual(
      expect.objectContaining({ scope: "spawn", code: "pre_handshake_exit" }),
    );
  });

  it("emits an `error` row for a runtime `{kind:'error'}` event (runtime scope) and does NOT count it as progress", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    // Establish first so the error is session-level (runtime), not spawn.
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("runtime_event", { kind: "error", message: "rate limited: 429 Too Many Requests" });

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    const payload = (errCalls[0]![1] as { payload: { scope: string; code: string; message: string } }).payload;
    expect(payload.scope).toBe("runtime");
    expect(payload.code).toBe("runtime_error");
    expect(payload.message).toContain("429");
  });

  it("does NOT emit a `runtime_error` row for the death rattle of a session an intentional kill superseded", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    // Establish, then enter the reset/nap kill window before the dying
    // process fires its interrupted-turn "death rattle" error. `markResetting`
    // marks THIS live session's per-session state `superseded`, so the gate
    // suppresses its rattle by session identity (not the agent-level reset
    // flag) — the reborn session, a fresh state, would still surface its own.
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    mgr.markResetting("a1");
    session.fire("runtime_event", { kind: "error", message: "turn interrupted" });

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(0);
  });

  it("DOES emit a `runtime_error` for a REBORN (non-superseded) session's error even while the agent's reset window is still open — batch C reader-C fix", () => {
    // Batch C keeps `resetting` open across the respawn until the reborn
    // process reaches `running`, so the reborn session is live while the reset
    // window is still open. Gating the audit on the agent-level reset window
    // would swallow the reborn session's OWN genuine error. The gate instead
    // keys on per-session identity: only a SUPERSEDED (outgoing/killed)
    // session's rattle is suppressed. A reborn session gets a fresh state
    // (`superseded=false`), so its real error must SURFACE.
    //
    // The fake harness reuses one session object; we assert the gate's
    // behavior directly by driving `onRuntimeEvent` with the reborn session's
    // (non-superseded) identity — mirroring what the real per-session
    // subscriber closure passes.
    const onBotAuditEvent = vi.fn();
    const { mgr } = makeManager({ onBotAuditEvent });

    // Reborn session identity → superseded=false (the subscriber passes its own
    // session state's flag). A genuine startup error must be audited.
    (mgr as unknown as {
      onRuntimeEvent: (a: string, e: unknown, r: string, superseded: boolean) => void;
    }).onRuntimeEvent("a1", { kind: "error", message: "reborn hit a rate limit" }, "codex", false);

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]![1] as { payload: { message: string } }).payload.message).toContain("rate limit");
  });

  it("does NOT emit for a SUPERSEDED session's death rattle (the outgoing session an intentional kill interrupted) — batch C reader-C fix", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr } = makeManager({ onBotAuditEvent });
    // Superseded session identity → its interrupted-turn error is teardown
    // noise, suppressed regardless of the agent's status.
    (mgr as unknown as {
      onRuntimeEvent: (a: string, e: unknown, r: string, superseded: boolean) => void;
    }).onRuntimeEvent("a1", { kind: "error", message: "turn interrupted" }, "codex", true);

    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(0);
  });

  it("adds a stuck-reset correlation trace for a reborn error while the reset window is wedged — WITHOUT suppressing the error (batch D)", () => {
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
    (mgr as unknown as {
      onRuntimeEvent: (a: string, e: unknown, r: string, superseded: boolean) => void;
    }).onRuntimeEvent("a1", { kind: "error", message: "reborn hit a rate limit" }, "codex", false);

    // 命门: the error STILL surfaces (additive trace never suppresses).
    const errCalls = onBotAuditEvent.mock.calls.filter(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    expect(errCalls).toHaveLength(1);
    // AND the correlation trace fired.
    expect(logger.calls.warn.some(([m]) => m === "runtime error during a stuck reset window")).toBe(true);
  });

  it("does NOT add the stuck-reset trace for a reborn error when the reset window is NOT stuck (batch D)", () => {
    let clock = 0;
    const onBotAuditEvent = vi.fn();
    const logger = stubLogger();
    const { mgr } = makeManager({ onBotAuditEvent, logger, now: () => clock, resetStuckThresholdMs: 100 });

    mgr.deliver("a1", { seq: 1, text: "hello" });
    clock = 10;
    mgr.markResetting("a1"); // resettingSince=10
    clock = 50; // now - resettingSince = 40 < 100 → NOT stuck

    (mgr as unknown as {
      onRuntimeEvent: (a: string, e: unknown, r: string, superseded: boolean) => void;
    }).onRuntimeEvent("a1", { kind: "error", message: "reborn hit a rate limit" }, "codex", false);

    // Error still surfaces (it's a real reborn error), but no stuck-reset trace.
    expect(onBotAuditEvent.mock.calls.filter(([, ev]) => (ev as { kind?: string })?.kind === "error")).toHaveLength(1);
    expect(logger.calls.warn.some(([m]) => m === "runtime error during a stuck reset window")).toBe(false);
  });

  it("scrubs secrets out of an error message before it becomes an audit row", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("runtime_event", { kind: "error", message: "auth failed with sk-ant-abc123DEF456 token" });

    const errCall = onBotAuditEvent.mock.calls.find(
      ([, ev]) => (ev as { kind?: string })?.kind === "error",
    );
    const message = (errCall![1] as { payload: { message: string } }).payload.message;
    expect(message).not.toContain("sk-ant-abc123DEF456");
    expect(message).toContain("[redacted-token]");
  });
});

describe("AgentProcessManager — handshake watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("terminates a session that never handshakes, emits an `error` row, and returns the FSM to idle", async () => {
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
      sessionFactory: () => session,
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
    vi.advanceTimersByTime(1000);

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
      sessionFactory: () => session,
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
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
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
  it("canonicalizes bash/shell to bash (case-insensitive)", () => {
    expect(canonicalToolName("Bash")).toBe("bash");
    expect(canonicalToolName("bash")).toBe("bash");
    expect(canonicalToolName("BASH")).toBe("bash");
    expect(canonicalToolName("shell")).toBe("bash");
  });
  it("canonicalizes file-target tools", () => {
    expect(canonicalToolName("Read")).toBe("read");
    expect(canonicalToolName("read")).toBe("read");
    expect(canonicalToolName("Edit")).toBe("edit");
    expect(canonicalToolName("MultiEdit")).toBe("edit");
    expect(canonicalToolName("file_change")).toBe("edit");
    expect(canonicalToolName("Write")).toBe("write");
    expect(canonicalToolName("LS")).toBe("ls");
    expect(canonicalToolName("NotebookEdit")).toBe("notebook_edit");
  });
  it("canonicalizes pattern tools", () => {
    expect(canonicalToolName("Grep")).toBe("grep");
    expect(canonicalToolName("Glob")).toBe("glob");
    expect(canonicalToolName("Find")).toBe("find");
  });
  it("canonicalizes web + todo tools", () => {
    expect(canonicalToolName("WebSearch")).toBe("web_search");
    expect(canonicalToolName("web_search")).toBe("web_search");
    expect(canonicalToolName("WebFetch")).toBe("web_fetch");
    expect(canonicalToolName("TodoWrite")).toBe("todo_write");
  });
  it("falls through to lowercase for unknown names", () => {
    expect(canonicalToolName("mcp_search")).toBe("mcp_search");
    expect(canonicalToolName("Frobnicate")).toBe("frobnicate");
    expect(canonicalToolName("collab_tool_call")).toBe("collab_tool_call");
  });
});

describe("extractToolAudit — shell class", () => {
  it("Anthropic Bash + non-alook command yields {name: 'bash', target, suppressed: false}", () => {
    expect(extractToolAudit("Bash", { command: "rm -rf tmp" })).toEqual({
      name: "bash",
      target: "rm -rf tmp",
      suppressed: false,
    });
  });
  it("pi lowercase bash + non-alook command yields the same shape", () => {
    expect(extractToolAudit("bash", { command: "sed -i '' '/x/d' todo.md" })).toEqual({
      name: "bash",
      target: "sed -i '' '/x/d' todo.md",
      suppressed: false,
    });
  });
  it("suppresses alook invocations for capitalized Bash", () => {
    expect(extractToolAudit("Bash", { command: "alook inbox pull" }).suppressed).toBe(true);
  });
  it("suppresses alook invocations for lowercase bash (pi)", () => {
    expect(extractToolAudit("bash", { command: "alook" }).suppressed).toBe(true);
  });
  it("suppresses even with leading whitespace (raw command trimmed for the check)", () => {
    expect(extractToolAudit("Bash", { command: "  alook  message send" }).suppressed).toBe(true);
  });
  it("codex shell (string command) — driver already unwrapped params.item", () => {
    expect(extractToolAudit("shell", { command: "pnpm test" })).toEqual({
      name: "bash",
      target: "pnpm test",
      suppressed: false,
    });
  });
  it("codex shell (array command) — joined with spaces, noisy-but-honest form", () => {
    expect(extractToolAudit("shell", { command: ["bash", "-lc", "rm -rf tmp"] })).toEqual({
      name: "bash",
      target: "bash -lc rm -rf tmp",
      suppressed: false,
    });
  });
  it("codex shell array wrapping `alook …` inside `bash -lc` does NOT suppress — outer shell is real work", () => {
    const out = extractToolAudit("shell", { command: ["bash", "-lc", "alook inbox pull"] });
    expect(out.suppressed).toBe(false);
    expect(out.name).toBe("bash");
    expect(out.target).toBe("bash -lc alook inbox pull");
  });
});

describe("extractToolAudit — file-target class", () => {
  it("Anthropic Read → file_path", () => {
    expect(extractToolAudit("Read", { file_path: "/etc/passwd" })).toEqual({
      name: "read",
      target: "/etc/passwd",
      suppressed: false,
    });
  });
  it("pi read → path", () => {
    expect(extractToolAudit("read", { path: "AGENTS.md" })).toEqual({
      name: "read",
      target: "AGENTS.md",
      suppressed: false,
    });
  });
  it("Edit picks file_path, ignoring other keys", () => {
    expect(extractToolAudit("Edit", { file_path: "src/foo.ts", oldText: "x", newText: "y" })).toEqual({
      name: "edit",
      target: "src/foo.ts",
      suppressed: false,
    });
  });
  it("pi edit → path", () => {
    expect(extractToolAudit("edit", { path: "plans/x.md", edits: [] })).toEqual({
      name: "edit",
      target: "plans/x.md",
      suppressed: false,
    });
  });
  it("Write / pi write → file_path / path", () => {
    expect(extractToolAudit("Write", { file_path: "x.md", content: "..." }).target).toBe("x.md");
    expect(extractToolAudit("write", { path: "x.md", content: "..." }).target).toBe("x.md");
  });
  it("MultiEdit → edit + file_path (semantic collapse)", () => {
    expect(extractToolAudit("MultiEdit", { file_path: "x.ts", edits: [] })).toEqual({
      name: "edit",
      target: "x.ts",
      suppressed: false,
    });
  });
  it("NotebookEdit → notebook_path", () => {
    expect(extractToolAudit("NotebookEdit", { notebook_path: "nb.ipynb" })).toEqual({
      name: "notebook_edit",
      target: "nb.ipynb",
      suppressed: false,
    });
  });
  it("LS → path", () => {
    expect(extractToolAudit("LS", { path: "src/" })).toEqual({
      name: "ls",
      target: "src/",
      suppressed: false,
    });
  });
  it("codex file_change → edit + path (already-unwrapped params.item)", () => {
    expect(extractToolAudit("file_change", { path: "src/x.ts" })).toEqual({
      name: "edit",
      target: "src/x.ts",
      suppressed: false,
    });
  });
});

describe("extractToolAudit — pattern class", () => {
  it("Grep with pattern + path picks pattern", () => {
    expect(extractToolAudit("Grep", { pattern: "TODO", path: "src/" }).target).toBe("TODO");
  });
  it("pi grep with pattern only", () => {
    expect(extractToolAudit("grep", { pattern: "TODO" }).target).toBe("TODO");
  });
  it("Glob picks pattern", () => {
    expect(extractToolAudit("Glob", { pattern: "**/*.tsx" }).target).toBe("**/*.tsx");
  });
  it("find picks pattern", () => {
    expect(extractToolAudit("find", { pattern: "*.ts", path: "src" }).target).toBe("*.ts");
  });
  it("grep falls back to path when no pattern is set", () => {
    expect(extractToolAudit("grep", { path: "src" }).target).toBe("src");
  });
});

describe("extractToolAudit — fallthrough / MCP / web", () => {
  it("WebFetch → url", () => {
    expect(extractToolAudit("WebFetch", { url: "https://example.com" })).toEqual({
      name: "web_fetch",
      target: "https://example.com",
      suppressed: false,
    });
  });
  it("mcp_search stays as mcp_search + query target", () => {
    expect(extractToolAudit("mcp_search", { query: "foo" })).toEqual({
      name: "mcp_search",
      target: "foo",
      suppressed: false,
    });
  });
  it("web_search → query", () => {
    expect(extractToolAudit("web_search", { query: "cats" })).toEqual({
      name: "web_search",
      target: "cats",
      suppressed: false,
    });
  });
  it("collab_tool_call → name (from input.name)", () => {
    expect(extractToolAudit("collab_tool_call", { name: "x" }).target).toBe("x");
  });
  it("TodoWrite → no target", () => {
    expect(extractToolAudit("TodoWrite", { todos: [] })).toEqual({
      name: "todo_write",
      suppressed: false,
    });
  });
  it("Unknown tool falls through as lowercased name + no target", () => {
    expect(extractToolAudit("Frobnicate", {})).toEqual({
      name: "frobnicate",
      suppressed: false,
    });
  });
});

describe("extractToolAudit — non-object input guard", () => {
  it("null / undefined / string / number / array — all return no target without throwing", () => {
    expect(extractToolAudit("Bash", null)).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", undefined)).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", "raw string")).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", 42)).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", ["a", "b"])).toEqual({ name: "bash", suppressed: false });
  });
  it("copilot stringified-JSON recovery: input is a JSON string that decodes to a record", () => {
    expect(extractToolAudit("Bash", '{"command":"rm -rf tmp"}')).toEqual({
      name: "bash",
      target: "rm -rf tmp",
      suppressed: false,
    });
  });
  it("invalid JSON string — no throw, returns no target", () => {
    expect(extractToolAudit("Bash", "not json{")).toEqual({ name: "bash", suppressed: false });
  });
  it("JSON string that decodes to a non-object — no throw, returns no target", () => {
    expect(extractToolAudit("Bash", "42")).toEqual({ name: "bash", suppressed: false });
    expect(extractToolAudit("Bash", '["a","b"]')).toEqual({ name: "bash", suppressed: false });
  });
});

describe("truncateTargetToCodeUnits", () => {
  it("passes short strings through unchanged", () => {
    expect(truncateTargetToCodeUnits("hello")).toBe("hello");
  });
  it("truncates a 300-unit ASCII string to <=200 units + ellipsis", () => {
    const out = truncateTargetToCodeUnits("a".repeat(300));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });
  it("emoji-heavy: never emits a lone surrogate + round-trips clean UTF-8", () => {
    const emoji = "😀";
    const s = emoji.repeat(200);
    const out = truncateTargetToCodeUnits(s);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
  });
});

describe("isAlookShellInvocation", () => {
  it("matches `alook <sub>` and bare `alook`", () => {
    expect(isAlookShellInvocation("alook")).toBe(true);
    expect(isAlookShellInvocation("alook inbox pull")).toBe(true);
    expect(isAlookShellInvocation("  alook message send")).toBe(true);
  });
  it("matches the `$ALOOK_CLI` env-var form the system prompt now teaches", () => {
    expect(isAlookShellInvocation("$ALOOK_CLI inbox pull")).toBe(true);
    expect(isAlookShellInvocation("${ALOOK_CLI} message send")).toBe(true);
    expect(isAlookShellInvocation("$ALOOK_CLI")).toBe(true);
    expect(isAlookShellInvocation("  $ALOOK_CLI nap")).toBe(true);
  });
  it("does NOT match commands that merely mention alook", () => {
    expect(isAlookShellInvocation("rm alook.log")).toBe(false);
    expect(isAlookShellInvocation("echo alook")).toBe(false);
    expect(isAlookShellInvocation("alookalike")).toBe(false);
    // A different env var that merely starts with the same prefix must not match.
    expect(isAlookShellInvocation("$ALOOK_CLIENT foo")).toBe(false);
  });
  it("returns false for missing input", () => {
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
    { driver: "codex", rawName: "file_change", rawInput: { path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "codex", rawName: "web_search", rawInput: { query: "cats" }, expected: { name: "web_search", target: "cats", suppressed: false } },
    { driver: "codex", rawName: "mcp_search", rawInput: { query: "foo" }, expected: { name: "mcp_search", target: "foo", suppressed: false } },
    { driver: "codex", rawName: "collab_tool_call", rawInput: { name: "x" }, expected: { name: "collab_tool_call", target: "x", suppressed: false } },

    { driver: "gemini", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "gemini", rawName: "read", rawInput: { path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "gemini", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "gemini", rawName: "write", rawInput: { path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "gemini", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },

    { driver: "kimi", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "kimi", rawName: "read", rawInput: { path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "kimi", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "kimi", rawName: "write", rawInput: { path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "kimi", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },

    { driver: "opencode", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "opencode", rawName: "read", rawInput: { file_path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "opencode", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "opencode", rawName: "write", rawInput: { file_path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "opencode", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },

    { driver: "copilot", rawName: "bash", rawInput: '{"command":"rm tmp"}', expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "copilot", rawName: "bash", rawInput: { command: "rm tmp" }, expected: { name: "bash", target: "rm tmp", suppressed: false } },
    { driver: "copilot", rawName: "read", rawInput: { file_path: "/x" }, expected: { name: "read", target: "/x", suppressed: false } },
    { driver: "copilot", rawName: "edit", rawInput: { file_path: "/x" }, expected: { name: "edit", target: "/x", suppressed: false } },
    { driver: "copilot", rawName: "write", rawInput: { file_path: "/x" }, expected: { name: "write", target: "/x", suppressed: false } },
    { driver: "copilot", rawName: "grep", rawInput: { pattern: "TODO" }, expected: { name: "grep", target: "TODO", suppressed: false } },
  ];
  it.each(cases)("$driver × $rawName produces canonical shape", ({ rawName, rawInput, expected }) => {
    expect(extractToolAudit(rawName, rawInput)).toEqual(expected);
  });
});

describe("onBotAuditEvent — integration through onRuntimeEvent (T9/T10)", () => {
  it("emits canonical lowercase name for every driver × tool combo", () => {
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
      { name: "file_change", input: { path: "src/x.ts" }, expect: { name: "edit", target: "src/x.ts" } },
    ];

    for (const c of combos) {
      session.fire("runtime_event", { kind: "tool_call", name: c.name, input: c.input });
    }

    const payloads = onBotAuditEvent.mock.calls
      .filter(([, ev]) => (ev as { kind?: string })?.kind === "tool_call")
      .map(([, ev]) => (ev as { payload: { name: string; target?: string } }).payload);
    expect(payloads).toEqual(combos.map((c) => c.expect));
  });

  it("alook-shell suppression fires for Bash, pi bash, AND codex shell", () => {
    const onBotAuditEvent = vi.fn();
    const { mgr, session } = makeManager({ onBotAuditEvent });
    mgr.deliver("a1", { seq: 1, text: "hello" });

    session.fire("runtime_event", { kind: "tool_call", name: "Bash", input: { command: "alook inbox pull" } });
    session.fire("runtime_event", { kind: "tool_call", name: "bash", input: { command: "alook" } });
    session.fire("runtime_event", { kind: "tool_call", name: "shell", input: { command: "alook message send" } });

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
    const mgr = new AgentProcessManager({
      driverFor: () => fakeDriver("codex"),
      baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
      sessionFactory: () => session,
      onFsmTransition: trace as never,
    });
    mgr.register("a1");
    return { mgr, session };
  }

  it("fires once per agent-scoped dispatch with the wedge-triage fields", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hello" });
    expect(recs.length).toBeGreaterThan(0);
    const wake = recs.find((r) => r.event === "wake");
    expect(wake).toBeTruthy();
    // Every field the triage needs to split the three "why no watchdog" exits.
    for (const k of ["agentId", "event", "status", "turnActive", "inbox", "lastDeliverAt", "lastProgressAt", "resetting", "resettingSince", "apmPhase", "effects", "nowMs"]) {
      expect(wake).toHaveProperty(k);
    }
    expect(wake!.agentId).toBe("a1");
    expect(Array.isArray(wake!.effects)).toBe(true);
  });

  it("does NOT change behavior — the observed effect sequence is identical with and without the hook", () => {
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
        sessionFactory: () => session,
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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      session.fire("runtime_event", { kind: "turn_end" });

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

  it("a mid-turn error then turn_end stamps endReason=errored + terminationCause=runtime_error + errorDetail (red line 6/7)", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    // Genuinely interrupt the turn: an `error` event (as the normalizer emits
    // from an is_error result) FOLLOWED by the trailing turn_end.
    session.fire("runtime_event", { kind: "error", message: "boom: model overloaded" });
    session.fire("runtime_event", { kind: "turn_end" });

    const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
    expect(turnEnd).toBeTruthy();
    expect(turnEnd!.endReason).toBe("errored");
    expect(turnEnd!.terminationCause).toBe("runtime_error");
    expect(turnEnd!.errorDetail).toBe("boom: model overloaded");
  });

  it("a CLEAN turn_end (no preceding error/kill) carries no endReason/terminationCause/errorDetail (byte-for-byte the old row)", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("runtime_event", { kind: "turn_end" });

    const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
    expect(turnEnd).toBeTruthy();
    expect(turnEnd!.endReason).toBeUndefined();
    expect(turnEnd!.terminationCause).toBeUndefined();
    expect(turnEnd!.errorDetail).toBeUndefined();
  });

  it("an intentional-kill (superseded) death-rattle error does NOT tag its turn_end errored (red line 5 — reset/nap is not a crash)", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    // Enter the reset/nap kill window, THEN the dying process rattles. The
    // marker is gated by the same `!sessionSuperseded` as the audit, so it must
    // NOT set — a nap must stay indistinguishable-from-clean, not read as crash.
    mgr.markResetting("a1");
    session.fire("runtime_event", { kind: "error", message: "turn interrupted" });
    session.fire("runtime_event", { kind: "turn_end" });

    const turnEnd = recs.find((r) => r.event === "turn_end" && r.agentId === "a1");
    expect(turnEnd).toBeTruthy();
    expect(turnEnd!.endReason).toBeUndefined();
    expect(turnEnd!.terminationCause).toBeUndefined();
  });

  it("a mid-turn error followed by a hard exit (no turn_end) clears the marker so the NEXT turn is not mis-tagged (3a marker-leak guard)", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    // Error with NO trailing turn_end, then a hard process exit (bypasses the
    // normalizer) — the marker would otherwise leak in the map.
    session.fire("runtime_event", { kind: "error", message: "crashed hard" });
    session.fire("exit");

    // A fresh wake spawns a new session; its clean turn_end must NOT inherit the
    // stale marker.
    recs.length = 0;
    mgr.deliver("a1", { seq: 2, text: "again" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s2" });
    session.fire("runtime_event", { kind: "turn_end" });

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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      // Turn is in flight (turnActive) and makes NO progress. No error injected —
      // this is a genuine hang, exactly Blair's case.
      now = 200; // past staleThreshold=100 → stalled watchdog fires terminate_stalled
      await vi.advanceTimersByTimeAsync(10);
      const killTick = recs.find((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("terminate_stalled"));
      expect(killTick).toBeTruthy(); // the stall kill actually fired

      // The SIGKILL makes the process emit its trailing turn_end (no error
      // rattle needed — that's the whole point of keying on cause, not rattle).
      recs.length = 0;
      session.fire("runtime_event", { kind: "turn_end" });
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
      session.stop = stopSpy;
      const mgr = new AgentProcessManager({
        driverFor: () => fakeDriver("codex"), // per_turn — same stall setup as the killed_stalled test above
        baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", standingPrompt: "", config: {} as LaunchContext["config"], credentialProxy: {} as LaunchContext["credentialProxy"] }),
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      // Turn is in flight (turnActive) and makes NO progress → terminate_stalled
      // sets killed_stalled marker. (Same trigger as the killed_stalled test.)
      now = 200;
      await vi.advanceTimersByTimeAsync(10);
      expect(recs.find((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("terminate_stalled"))).toBeTruthy();
      // stop() produced no exit → sit in stopping past stoppingStuck → force_exit.
      now = 500;
      await vi.advanceTimersByTimeAsync(10);
      expect(recs.find((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("force_exit"))).toBeTruthy();

      // force_exit dispatched a synthetic exit → respawn. The reborn turn runs
      // and ends CLEANLY. Its turn_end must NOT inherit the leaked marker.
      session.startResolver?.();
      await Promise.resolve();
      recs.length = 0;
      session.fire("runtime_event", { kind: "session_init", sessionId: "s2" });
      session.fire("runtime_event", { kind: "turn_end" });
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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      session.fire("runtime_event", { kind: "turn_end" }); // clean end → idle
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

  it("T1 — an established session's exit on a signal records exitSignal + abnormal=true on the trace exit row", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // hasEstablished
    // Hard death on SIGKILL, NOT a requested stop → abnormal physical fact.
    session.fire("exit", { signal: "SIGKILL", reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitSignal).toBe("SIGKILL");
    expect(exitRec!.exitCode).toBeNull();
    expect(exitRec!.abnormal).toBe(true);
  });

  it("T1 — an established session's non-zero code exit records exitCode + abnormal=true", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("exit", { code: 137, reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitCode).toBe(137);
    expect(exitRec!.exitSignal).toBeNull();
    expect(exitRec!.abnormal).toBe(true);
  });

  it("T1 — a clean code-0 exit records abnormal=false (distinguishable from a crash in the trace)", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("exit", { code: 0, reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitCode).toBe(0);
    expect(exitRec!.abnormal).toBe(false);
  });

  it("T1 — a deliberate stop (reason=requested) records the physical fact but abnormal=false", () => {
    // A requested stop that still died on a signal (SIGTERM grace → the process
    // exits): the physical fact (signal) is recorded, but it's NOT abnormal —
    // reason==="requested" gates that. So trace shows how it died without
    // mislabeling an intentional stop as a crash.
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("exit", { signal: "SIGTERM", reason: "requested" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.exitSignal).toBe("SIGTERM");
    expect(exitRec!.abnormal).toBe(false);
  });

  it("T1 — the exit physical fact is READ-ONLY: abnormal exit and clean exit produce the SAME onExit respawn/idle decision (Claudette #382)", () => {
    // With a queued inbox, onExit respawns (spawn effect); with empty inbox it
    // settles idle. That decision keys on inbox.length ONLY — the new
    // exitCode/exitSignal/abnormal fields must NOT change the branch.
    function exitEffectsFor(exitInfo: Record<string, unknown>, queueBefore: boolean): string[] {
      const recs: Record<string, unknown>[] = [];
      const { mgr, session } = makeWithTrace((r) => recs.push(r));
      mgr.deliver("a1", { seq: 1, text: "hi" });
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      if (queueBefore) mgr.deliver("a1", { seq: 2, text: "queued" }); // inbox non-empty at exit
      recs.length = 0;
      session.fire("exit", exitInfo);
      const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
      return (exitRec!.effects as string[]) ?? [];
    }
    // Empty inbox: idle (no spawn), identical for abnormal vs clean.
    expect(exitEffectsFor({ signal: "SIGKILL", reason: "runtime_exit" }, false)).toEqual(
      exitEffectsFor({ code: 0, reason: "runtime_exit" }, false),
    );
    // Queued inbox: respawn (spawn), identical for abnormal vs clean.
    expect(exitEffectsFor({ signal: "SIGKILL", reason: "runtime_exit" }, true)).toEqual(
      exitEffectsFor({ code: 0, reason: "runtime_exit" }, true),
    );
  });

  // ---- T2: launch-failure reason into trace (audit↔trace two-skins closure) ----
  // A spawn that never establishes (ENOENT / pre_handshake_exit / handshake_timeout
  // / spawn_threw) previously reached the web audit but dispatched a BARE exit —
  // in the trace it was indistinguishable from a clean exit. T2 carries the
  // failure reason (same value as the audit) onto the exit event → trace.

  it("T2 — a pre-handshake exit records spawnFailureReason on the trace exit row", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    // Exit with NO prior runtime_event (never established) → pre_handshake_exit.
    session.fire("exit");

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.spawnFailureReason).toBe("pre_handshake_exit");
  });

  it("T2 — an ENOENT spawn error carries that exact reason (same string as the web audit) into the trace", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("error", { code: "ENOENT" });
    session.fire("exit");

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.spawnFailureReason).toBe("ENOENT");
  });

  it("T2 — a normal established exit carries NO spawnFailureReason", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" }); // established
    session.fire("exit", { code: 0, reason: "runtime_exit" });

    const exitRec = recs.find((r) => r.event === "exit" && r.agentId === "a1");
    expect(exitRec).toBeTruthy();
    expect(exitRec!.spawnFailureReason).toBeUndefined();
  });

  it("T2 no-leak (Claudette #398) — a spawn failure then a SUCCESSFUL spawn + clean exit: the clean exit carries NO stale spawnFailureReason", () => {
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
      sessionFactory: () => {
        const s = fakeSession();
        sessions.push(s);
        return s;
      },
      onFsmTransition: ((r: Record<string, unknown>) => recs.push(r)) as never,
    });
    mgr.register("a1");

    // Spawn #1: fails pre-handshake.
    mgr.deliver("a1", { seq: 1, text: "hi" });
    sessions[0]!.fire("exit"); // → pre_handshake_exit, agent back to idle

    // Spawn #2: succeeds (establishes), then exits cleanly.
    recs.length = 0;
    mgr.deliver("a1", { seq: 2, text: "again" });
    sessions[1]!.fire("runtime_event", { kind: "session_init", sessionId: "s2" });
    sessions[1]!.fire("exit", { code: 0, reason: "runtime_exit" });

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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      now = 200; // past staleThreshold → terminate_stalled (sets the semantic marker)
      await vi.advanceTimersByTimeAsync(10);
      // The killed process's real exit (via the exit listener, where state lives).
      recs.length = 0;
      session.fire("exit", { signal: "SIGKILL", reason: "requested" });

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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      session.fire("runtime_event", { kind: "turn_end" }); // clean end → idle
      now = 100; // past idleTimeout → voluntary stop (sets idle_stop, NOT killed_stalled)
      await vi.advanceTimersByTimeAsync(10);
      recs.length = 0;
      session.fire("exit", { signal: "SIGTERM", reason: "requested" });

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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      session.fire("runtime_event", { kind: "turn_end" });
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

  it("T3 — a plain runtime exit (no recovery) carries NO terminationSemantics", () => {
    const recs: Record<string, unknown>[] = [];
    const { mgr, session } = makeWithTrace((r) => recs.push(r));
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
    session.fire("exit", { code: 0, reason: "runtime_exit" });

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
        sessionFactory: () => session,
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
      session.fire("runtime_event", { kind: "session_init", sessionId: "s1" });
      // Stall → terminate_stalled sets suppressExitLog before the kill.
      now = 200;
      await vi.advanceTimersByTimeAsync(10);
      // The killed process exits on a signal (a requested/deliberate stop path).
      session.fire("exit", { signal: "SIGKILL", reason: "requested" });

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

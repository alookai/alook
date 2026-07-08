import { describe, it, expect, vi } from "vitest";
import { AgentProcessManager, type ManagedSession, type SessionFactory } from "./managerRuntime.js";
import type { Driver, LaunchContext } from "../types.js";
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
    send() {},
    stop() {},
    get currentSessionId() {
      return null;
    },
    fire(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) cb(...args);
    },
  };
  return s;
}

function makeManager(opts: { logger?: Logger; tickIntervalMs?: number; idleTimeoutMs?: number; staleThresholdMs?: number; now?: () => number } = {}) {
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
});

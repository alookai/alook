import { describe, it, expect, vi } from "vitest";
import { AgentProcessManager, type ManagedSession, type SessionFactory, type TimelineRecorder } from "./managerRuntime.js";
import type { Driver, LaunchContext } from "../types.js";
import type { RuntimeConfig } from "../runtimeConfig.js";
import type { Logger } from "../logger.js";

function stubLogger(): Logger & { calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> } {
  const calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> = { debug: [], info: [], warn: [], error: [] };
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

interface FakeSession extends ManagedSession {
  fire(evt: string, ...args: unknown[]): void;
}
function fakeSession(): FakeSession {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const s: FakeSession = {
    on(event, cb) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    start() { return Promise.resolve(); },
    send() {},
    stop() {},
    get currentSessionId() { return null; },
    fire(evt, ...args) { for (const cb of listeners.get(evt) ?? []) cb(...args); },
  };
  return s;
}

const NAMED_CFG: RuntimeConfig = {
  version: 1,
  runtime: "codex",
  model: { kind: "named", name: "opus" },
  mode: { kind: "default" },
};

function makeManager(opts: { logger?: Logger } = {}) {
  const spawns: Array<{ ctx: LaunchContext; prompt: string }> = [];
  let session = fakeSession();
  const sessions: FakeSession[] = [];
  const factory: SessionFactory = ({ ctx }: { ctx: LaunchContext }) => {
    spawns.push({ ctx, prompt: ctx.prompt });
    session = fakeSession();
    sessions.push(session);
    return session;
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
    ...opts,
  });
  return { mgr, spawns, sessions, getSession: () => session };
}

const REWAKE = "You were just switched to a different model. Continue any unfinished work.";

describe("AgentProcessManager.switchModel", () => {
  it("on an idle agent: spawns immediately with the rewake prompt and the new config", () => {
    const { mgr, spawns } = makeManager();
    mgr.register("a1");
    void mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "l1", rewakePrompt: REWAKE });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.prompt).toBe(REWAKE);
    expect(spawns[0]!.ctx.config.runtimeConfig).toEqual(NAMED_CFG);
  });

  it("registers a never-registered agent first, then spawns (no throw)", () => {
    const { mgr, spawns } = makeManager();
    // No prior register.
    expect(() =>
      mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "l1", rewakePrompt: REWAKE }),
    ).not.toThrow();
    expect(spawns).toHaveLength(1);
  });

  it("on a live agent: enqueues rewake, stops, and respawns exactly once on exit — carrying the prior sessionId as resumeSessionId (no reset_session)", async () => {
    const { mgr, spawns, getSession } = makeManager();
    mgr.register("a1");
    // First spawn + establish a session id.
    mgr.deliver("a1", { seq: 1, text: "hi" });
    expect(spawns).toHaveLength(1);
    getSession().fire("runtime_event", { kind: "session_init", sessionId: "sess-123" });

    // Switch while live. stop() → onExit drain → single respawn.
    await mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "l2", rewakePrompt: REWAKE });
    getSession().fire("exit");

    // Exactly two spawns total (initial + one respawn).
    expect(spawns).toHaveLength(2);
    // The respawn resumes the prior session id (preserved — switchModel never
    // dispatches reset_session) and carries the new model.
    expect(spawns[1]!.ctx.config.sessionId).toBe("sess-123");
    expect(spawns[1]!.ctx.config.runtimeConfig).toEqual(NAMED_CFG);
    // FSM sessionId is still set (not nulled by a reset_session).
    expect(mgr.snapshot().agents["a1"]!.sessionId).toBe("sess-123");
  });

  it("a wake landing between switchModel and the respawn queues to inbox (resetting gate), not a double-spawn", async () => {
    const { mgr, spawns, getSession } = makeManager();
    mgr.register("a1");
    mgr.deliver("a1", { seq: 1, text: "hi" });
    getSession().fire("runtime_event", { kind: "session_init", sessionId: "sess-1" });
    expect(spawns).toHaveLength(1);

    await mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "l2", rewakePrompt: REWAKE });
    // A real unread wake lands mid-switch — must NOT spawn a second process.
    mgr.deliver("a1", { seq: 2, text: "new unread" });
    expect(spawns).toHaveLength(1);
    // The exit drain produces exactly one respawn for the queued rewake + unread.
    getSession().fire("exit");
    expect(spawns).toHaveLength(2);
  });

  it("idle-branch synchronous spawn throw dispatches exit and clears the resetting gate", () => {
    const logger = stubLogger();
    let firstSpawn = true;
    const factory: SessionFactory = () => {
      if (firstSpawn) {
        firstSpawn = false;
        throw new Error("spawn boom");
      }
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
      logger,
    });
    mgr.register("a1");
    expect(() =>
      mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "l1", rewakePrompt: REWAKE }),
    ).rejects.toThrow(/spawn boom/);
    // The gate must have cleared (exit dispatched) — a subsequent wake spawns.
    expect(mgr.snapshot().agents["a1"]!.status).toBe("idle");
  });

  it("doSpawn's 'spawning agent' log includes the resolved model (named → 'opus')", () => {
    const logger = stubLogger();
    const { mgr } = makeManager({ logger });
    mgr.register("a1", { runtimeConfig: NAMED_CFG });
    mgr.deliver("a1", { seq: 1, text: "hi" });
    const spawnLog = logger.calls.info.find(([m]) => m === "spawning agent");
    expect(spawnLog).toBeTruthy();
    expect((spawnLog![1][0] as { model?: string }).model).toBe("opus");
  });

  it("doSpawn logs model 'default' when the config has no model", () => {
    const logger = stubLogger();
    const { mgr } = makeManager({ logger });
    mgr.register("a1"); // no runtimeConfig
    mgr.deliver("a1", { seq: 1, text: "hi" });
    const spawnLog = logger.calls.info.find(([m]) => m === "spawning agent");
    expect((spawnLog![1][0] as { model?: string }).model).toBe("default");
  });

  it("writes NO timeline reset_session barrier — forgetSession is never called, so resume still resolves", async () => {
    const timelineCalls: string[] = [];
    const timeline: TimelineRecorder = {
      setSession: (a, s) => timelineCalls.push(`session:${a}:${s}`),
      appendResponseToLatest: () => {},
      resumeSessionId: () => "resumable-sess",
      forgetSession: (a) => timelineCalls.push(`forget:${a}`),
    };
    let session = fakeSession();
    const factory: SessionFactory = () => (session = fakeSession());
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
      timeline,
    });
    mgr.register("a1");
    mgr.deliver("a1", { seq: 1, text: "hi" });
    session.fire("runtime_event", { kind: "session_init", sessionId: "sess-live" });
    await mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "l2", rewakePrompt: REWAKE });
    session.fire("exit");
    // forgetSession — the writer of the reset_session barrier — must never run.
    expect(timelineCalls.some((c) => c.startsWith("forget:"))).toBe(false);
  });

  // Convergence contract (B1): resetSession and switchModel now both route
  // through the shared `restartAgent`; the ONLY behavioral difference is whether
  // it calls forgetSession (reset does + writes its barrier; switch does not).
  // This pins that contract in one place so a future refactor can't silently
  // make switchModel forget or resetSession preserve.
  it("resetSession forgets (with its barrier) while switchModel preserves — the sole restartAgent divergence", async () => {
    const mk = () => {
      const timelineCalls: string[] = [];
      const timeline: TimelineRecorder = {
        setSession: () => {},
        appendResponseToLatest: () => {},
        resumeSessionId: () => "resumable-sess",
        forgetSession: (a, barrierType) => timelineCalls.push(`forget:${a}:${barrierType ?? "reset_session"}`),
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
        sessionFactory: () => fakeSession(),
        onRuntimeSpawnFailed: vi.fn(),
        onRuntimeSessionEstablished: vi.fn(),
        timeline,
      });
      mgr.register("a1");
      return { mgr, timelineCalls };
    };

    // reset (idle branch) → forgetSession called with the reset_session barrier.
    const r = mk();
    await r.mgr.resetSession("a1", { runtimeConfig: NAMED_CFG, launchId: "l1", rewakePrompt: REWAKE });
    expect(r.timelineCalls).toContain("forget:a1:reset_session");

    // switch (idle branch) → forgetSession never called.
    const s = mk();
    await s.mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "l1", rewakePrompt: REWAKE });
    expect(s.timelineCalls.some((c) => c.startsWith("forget:"))).toBe(false);
  });
});

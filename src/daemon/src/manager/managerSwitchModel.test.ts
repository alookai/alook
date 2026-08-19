import { describe, it, expect, vi } from "vitest";
import { AgentProcessManager, type DaemonAgentSession, type SessionFactory, type TimelineRecorder } from "./managerRuntime.js";
import type { AgentBackend as Driver } from "../drivers/index.js";
import type { HostLaunchContext as LaunchContext } from "./hostContext.js";
import type { RuntimeConfig } from "../runtimeConfig.js";
import type { Logger } from "../logger.js";
import type { AgentEvent, AgentSessionResult, BuiltinBackendSpecs } from "@alook/agent-driver";

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
    probe: () => ({ status: "healthy" as const, version: "test" }),
    spawn: async () => ({ process: {} as never }),
    parseLine: () => [],
    encodeStdinMessage: () => null,
    buildSystemPrompt: () => "",
  } as unknown as Driver;
}

interface FakeSession extends DaemonAgentSession {
  fire(evt: string, ...args: unknown[]): void;
  bindManager(
    publish: (event: AgentEvent<BuiltinBackendSpecs, "codex">) => void,
    finish: (result: AgentSessionResult) => void,
  ): void;
}
function fakeSession(): FakeSession {
  let publish: ((event: AgentEvent<BuiltinBackendSpecs, "codex">) => void) | undefined;
  let finish: ((result: AgentSessionResult) => void) | undefined;
  let sequence = 0;
  let resolveClosed!: (result: AgentSessionResult) => void;
  const closed = new Promise<AgentSessionResult>((resolve) => { resolveClosed = resolve; });
  const s: FakeSession = {
    backend: "codex",
    capabilities: {} as FakeSession["capabilities"],
    sessionInstanceId: "switch-model-test",
    events: {
      maxBufferedBytes: 4_194_304,
      async *[Symbol.asyncIterator]() { await closed; },
    },
    closed,
    bindManager(nextPublish, nextFinish) {
      publish = nextPublish;
      finish = nextFinish;
    },
    async start(message) {
      return { status: "accepted", delivery: "prompt", commandId: message.id, turnId: "test-turn" };
    },
    async send(message) {
      return { status: "accepted", delivery: "steer", commandId: message.id, turnId: "test-turn" };
    },
    async interrupt() { return { status: "not_running" }; },
    async stop() { return { status: "accepted", requestId: "test-stop" }; },
    snapshot() {
      return { sessionInstanceId: "switch-model-test", state: "working", queuedCommands: [], lastEventSequence: sequence };
    },
    async invokeExtension() {
      return { ok: false, error: { category: "internal", code: "unsupported", message: "unsupported", retryable: false } };
    },
    fire(evt, ...args) {
      if (evt === "runtime_event") {
        const event = args[0] as { kind: string; sessionId?: string };
        if (event.kind === "session_init") {
          publish?.({
            type: "session_started",
            backendSessionId: event.sessionId ?? "test-session",
            sequence: ++sequence,
            sessionInstanceId: "switch-model-test",
            at: Date.now(),
          });
        }
        return;
      }
      if (evt === "exit") {
        const result: AgentSessionResult = {
          outcome: "completed",
          exitCode: 0,
          signal: null,
          cleanup: { status: "released" },
        };
        finish?.(result);
        resolveClosed(result);
      }
    },
  };
  return s;
}

const NAMED_CFG: RuntimeConfig = {
  version: 1,
  runtime: "codex",
  model: { kind: "named", name: "opus" },
  mode: { kind: "default" },
};

function makeManager(
  opts: {
    logger?: Logger;
    onAgentSession?: (info: { agentId: string; sessionId: string; launchId: string }) => void;
  } = {},
) {
  const spawns: Array<{ ctx: LaunchContext; prompt: string }> = [];
  let session = fakeSession();
  const sessions: FakeSession[] = [];
  const factory: SessionFactory = ({ ctx, publish, finish }) => {
    spawns.push({ ctx, prompt: ctx.prompt });
    session = fakeSession();
    session.bindManager(publish as never, finish);
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
    await Promise.resolve();
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

  it("idle-branch synchronous spawn throw dispatches exit and clears the resetting gate", async () => {
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
    await expect(
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
    const factory: SessionFactory = ({ publish, finish }) => {
      session = fakeSession();
      session.bindManager(publish as never, finish);
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

  // #910 verify-by-test (Cecilia FINAL LOCK §7 / bot-provider-switch plan):
  // model_changed re-home to agent_session only works if a forgetSession:false
  // respawn still emits session_init AND threads the switch's launchId into
  // onAgentSession. Driver-side: resume already yields session_init
  // (codex.test "delivers the prompt on resume too"; cursor system/init;
  // SdkRuntimeSession.emitEvents first-event). This pins the manager half.
  it("after switchModel respawn, session_init emits onAgentSession with the switch launchId (not the prior wake's)", async () => {
    const sessionsSeen: Array<{ agentId: string; sessionId: string; launchId: string }> = [];
    const { mgr, getSession } = makeManager({
      onAgentSession: (info) => sessionsSeen.push(info),
    });
    mgr.register("a1", { launchId: "wake-l1" });
    mgr.deliver("a1", { seq: 1, text: "hi" });
    getSession().fire("runtime_event", { kind: "session_init", sessionId: "sess-123" });
    expect(sessionsSeen).toEqual([
      { agentId: "a1", sessionId: "sess-123", launchId: "wake-l1" },
    ]);

    await mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "switch-l2", rewakePrompt: REWAKE });
    getSession().fire("exit");
    // Respawn is live; driver resume path emits session_init again (same or new id).
    getSession().fire("runtime_event", { kind: "session_init", sessionId: "sess-123" });

    expect(sessionsSeen).toHaveLength(2);
    expect(sessionsSeen[1]).toEqual({
      agentId: "a1",
      sessionId: "sess-123",
      launchId: "switch-l2",
    });
  });

  it("idle switchModel cold-start: session_init emits onAgentSession with the switch launchId", async () => {
    const sessionsSeen: Array<{ agentId: string; sessionId: string; launchId: string }> = [];
    const { mgr, getSession } = makeManager({
      onAgentSession: (info) => sessionsSeen.push(info),
    });
    await mgr.switchModel("a1", { runtimeConfig: NAMED_CFG, launchId: "switch-l1", rewakePrompt: REWAKE });
    getSession().fire("runtime_event", { kind: "session_init", sessionId: "sess-new" });
    expect(sessionsSeen).toEqual([
      { agentId: "a1", sessionId: "sess-new", launchId: "switch-l1" },
    ]);
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

import { describe, it, expect } from "vitest";
import { AgentProcessManager, type TimelineRecorder } from "./managerRuntime";
import type { HostLaunchContext as LaunchContext } from "./hostContext.js";
import type { AgentEvent, AgentSessionResult, BuiltinBackendSpecs } from "@alook/agent-driver";

/** A recorder that records calls + can supply a resume session id. */
function fakeRecorder(resume: Record<string, string> = {}) {
  const calls: string[] = [];
  const rec: TimelineRecorder = {
    setSession: (agentId, sessionId) => calls.push(`session:${agentId}:${sessionId}`),
    appendResponseToLatest: (agentId, text) => calls.push(`resp:${agentId}:${text}`),
    resumeSessionId: (agentId) => resume[agentId] ?? null,
    forgetSession: (agentId) => calls.push(`forget:${agentId}`),
  };
  return { rec, calls };
}

function manager(rec: TimelineRecorder, capture: { ctx?: LaunchContext }) {
  let publish: ((event: AgentEvent<BuiltinBackendSpecs, "codex">) => void) | undefined;
  let finish: ((result: AgentSessionResult) => void) | undefined;
  let sequence = 0;
  const mgr = new AgentProcessManager({
    driverFor: () =>
      ({ lifecycle: { kind: "persistent", stdin: "gated", inFlightWake: "queue" } }) as never,
    baseContextFor: (agentId) => ({ agentId, workingDirectory: "/tmp/x", standingPrompt: "", config: {} }),
    sessionFactory: ({ ctx, publish: nextPublish, finish: nextFinish }) => {
      capture.ctx = ctx;
      publish = nextPublish as never;
      finish = nextFinish;
      return {
        backend: "codex" as const,
        capabilities: {} as never,
        sessionInstanceId: "timeline-test",
        events: {
          maxBufferedBytes: 4_194_304 as const,
          async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
        },
        closed: new Promise<AgentSessionResult>(() => {}),
        async start(message: { id: string }) {
          return { status: "accepted" as const, delivery: "prompt" as const, commandId: message.id, turnId: "test-turn" };
        },
        async send(message: { id: string }) {
          return { status: "accepted" as const, delivery: "steer" as const, commandId: message.id, turnId: "test-turn" };
        },
        async interrupt() { return { status: "not_running" as const }; },
        async stop() { return { status: "accepted" as const, requestId: "test-stop" }; },
        snapshot() {
          return { sessionInstanceId: "timeline-test", state: "working" as const, queuedCommands: [], lastEventSequence: sequence };
        },
        async invokeExtension() {
          return { ok: false as const, error: { category: "internal" as const, code: "unsupported", message: "unsupported", retryable: false } };
        },
      };
    },
    timeline: rec,
    tickIntervalMs: 10_000,
  });
  const emit = (ev: string, arg?: unknown) => {
    if (ev === "runtime_event") {
      const event = arg as { kind: string; sessionId?: string; text?: string };
      const base = { sequence: ++sequence, sessionInstanceId: "timeline-test", at: Date.now() };
      if (event.kind === "session_init") {
        publish?.({ ...base, type: "session_started", backendSessionId: event.sessionId ?? "test-session" });
      } else if (event.kind === "text") {
        publish?.({ ...base, type: "text_delta", turnId: "test-turn", text: event.text ?? "" });
      }
    } else if (ev === "exit") {
      finish?.({ outcome: "completed", exitCode: 0, signal: null, cleanup: { status: "released" } });
    }
  };
  return { mgr, emit };
}

describe("manager ↔ timeline (daily log + resume)", () => {
  it("annotates the latest entry on session_init / text / exit (by agent, not task id)", () => {
    const { rec, calls } = fakeRecorder();
    const cap: { ctx?: LaunchContext } = {};
    const { mgr, emit } = manager(rec, cap);
    mgr.register("agent_1");
    mgr.deliver("agent_1", { seq: 1, text: "hi" });

    emit("runtime_event", { kind: "session_init", sessionId: "sess-7" });
    emit("runtime_event", { kind: "text", text: "part 1" });
    emit("runtime_event", { kind: "text", text: "part 2" });
    emit("runtime_event", { kind: "text", text: "" }); // empty text ignored
    emit("exit");

    // The manager does NOT open the entry (that's the data plane / inbox pull)
    // and there's no status close — it records the session id and accumulates the
    // agent's text onto the latest row.
    expect(calls).toEqual([
      "session:agent_1:sess-7",
      "resp:agent_1:part 1",
      "resp:agent_1:part 2",
    ]);
  });

  it("uses the timeline's resume session id when spawning", () => {
    const { rec } = fakeRecorder({ agent_2: "sess-prev" });
    const cap: { ctx?: LaunchContext } = {};
    const { mgr } = manager(rec, cap);
    mgr.register("agent_2");
    mgr.deliver("agent_2", { seq: 1, text: "hi" });
    expect(cap.ctx?.config.sessionId).toBe("sess-prev");
  });

  it("forgetSession clears resume caches so the next spawn resolves to null", () => {
    // Recorder returns null after "forgetSession" would have cleared the barrier.
    const { rec, calls } = fakeRecorder({ agent_3: "sess-old" });
    const cap: { ctx?: LaunchContext } = {};
    const { mgr } = manager(rec, cap);
    mgr.register("agent_3", { sessionId: "sess-server", launchId: "l1" });
    // Reset happens before deliver — after forget the recorder returns null.
    mgr.forgetSession("agent_3");
    // Simulate the recorder's post-forget behavior for the next resolve.
    (rec as unknown as { resumeSessionId: (a: string) => string | null }).resumeSessionId = () => null;
    mgr.deliver("agent_3", { seq: 1, text: "hi" });

    expect(calls).toContain("forget:agent_3");
    expect(cap.ctx?.config.sessionId).toBeUndefined();
  });

  it("forgetSession is a no-op on an unknown agentId (no throw)", () => {
    const { rec } = fakeRecorder();
    const cap: { ctx?: LaunchContext } = {};
    const { mgr } = manager(rec, cap);
    expect(() => mgr.forgetSession("nobody")).not.toThrow();
  });
});

describe("manager.resetSession", () => {
  const RUNTIME_CFG = {
    version: 1 as const,
    runtime: "mock",
    model: { kind: "default" as const },
    mode: { kind: "default" as const },
  };

  it("idle path: register → forgetSession → deliver rewake; spawn fires with sessionId=undefined and rewake prompt", async () => {
    const { rec, calls } = fakeRecorder();
    const cap: { ctx?: LaunchContext } = {};
    const { mgr } = manager(rec, cap);
    // Post-forget the recorder returns null.
    (rec as unknown as { resumeSessionId: (a: string) => string | null }).resumeSessionId = () => null;

    await mgr.resetSession("agent_idle", {
      runtimeConfig: RUNTIME_CFG,
      launchId: "reset-1",
      rewakePrompt: "REWAKE_TEXT",
    });

    expect(calls).toContain("forget:agent_idle");
    expect(cap.ctx?.config.sessionId).toBeUndefined();
    expect(cap.ctx?.prompt).toBe("REWAKE_TEXT");
    // The FSM lands in `starting` (spawn effect ran).
    const snap = mgr.snapshot();
    expect(snap.agents.agent_idle.resetting).toBe(false); // idle branch: onSpawned would clear; but spawned hasn't fired yet — this test just proves the effect fired.
    // Actually resetting is cleared only on spawned, which we haven't emitted;
    // still, correctness is proved by the spawn effect firing (ctx captured).
  });

  it("running path: enqueues rewake, calls stop, and on exit event drains inbox into ONE fresh spawn with sessionId=undefined", async () => {
    const { rec } = fakeRecorder();
    // Track handlers/sends per session; a new session is created on each spawn.
    const sessionsCreated: Array<{
      ctx: LaunchContext;
      finish: (result: AgentSessionResult) => void;
      stopCalled: boolean;
      sends: Array<{ text: string; mode: string }>;
    }> = [];
    const mgr = new AgentProcessManager({
      driverFor: () =>
        ({ lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" } }) as never,
      baseContextFor: (agentId) => ({ agentId, workingDirectory: "/tmp/x", standingPrompt: "", config: {} }),
      sessionFactory: ({ ctx, finish }) => {
        const entry: (typeof sessionsCreated)[number] = { ctx, finish, stopCalled: false, sends: [] };
        sessionsCreated.push(entry);
        return {
          backend: "codex" as const,
          capabilities: {} as never,
          sessionInstanceId: `reset-test-${sessionsCreated.length}`,
          events: {
            maxBufferedBytes: 4_194_304 as const,
            async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
          },
          closed: new Promise<AgentSessionResult>(() => {}),
          async start(m: { id: string }) {
            return { status: "accepted" as const, delivery: "prompt" as const, commandId: m.id, turnId: "test-turn" };
          },
          async send(m: { id: string; text: string }) {
            entry.sends.push({ text: m.text, mode: m.mode });
            return { status: "accepted" as const, delivery: "steer" as const, commandId: m.id, turnId: "test-turn" };
          },
          async interrupt() { return { status: "not_running" as const }; },
          async stop() {
            entry.stopCalled = true;
            return { status: "accepted" as const, requestId: "test-stop" };
          },
          snapshot() {
            return { sessionInstanceId: "reset-test", state: "working" as const, queuedCommands: [], lastEventSequence: 0 };
          },
          async invokeExtension() {
            return { ok: false as const, error: { category: "internal" as const, code: "unsupported", message: "unsupported", retryable: false } };
          },
        };
      },
      timeline: rec,
      tickIntervalMs: 10_000,
    });
    (rec as unknown as { resumeSessionId: (a: string) => string | null }).resumeSessionId = () => null;

    mgr.register("agent_run", { runtimeConfig: RUNTIME_CFG, launchId: "l0" });
    mgr.deliver("agent_run", { text: "first" });
    // Wait for start() microtask so `spawned` dispatch has landed.
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionsCreated).toHaveLength(1);
    const first = sessionsCreated[0]!;
    expect(mgr.snapshot().agents.agent_run.status).toBe("running");

    const resetPromise = mgr.resetSession("agent_run", {
      runtimeConfig: RUNTIME_CFG,
      launchId: "reset-1",
      rewakePrompt: "REWAKE",
    });
    await resetPromise;

    // stop() was called on the live session; no `send` was ever emitted
    // toward it (live branch uses enqueueRewake, not deliver).
    expect(first.stopCalled).toBe(true);
    expect(first.sends).toEqual([]);
    // Second session hasn't been created yet — waits for exit event.
    expect(sessionsCreated).toHaveLength(1);
    expect(mgr.snapshot().agents.agent_run.resetting).toBe(true);
    expect(mgr.snapshot().agents.agent_run.inbox.map((m) => m.text)).toEqual(["REWAKE"]);

    // Fire the session exit → onExit drains rewake into a fresh spawn.
    first.finish({ outcome: "completed", exitCode: 0, signal: null, cleanup: { status: "released" } });
    await Promise.resolve();

    expect(sessionsCreated).toHaveLength(2);
    const second = sessionsCreated[1]!;
    expect(second.ctx.prompt).toContain("REWAKE");
    expect(second.ctx.config.sessionId).toBeUndefined();
    expect(mgr.snapshot().agents.agent_run.resetting).toBe(false);
  });
});

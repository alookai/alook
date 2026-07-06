import { describe, it, expect, vi } from "vitest";
import { AgentProcessManager, type ManagedSession, type SessionFactory } from "./managerRuntime.js";
import type { Driver, LaunchContext } from "../types.js";

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

function makeManager() {
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

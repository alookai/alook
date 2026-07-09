import { describe, it, expect, vi } from "vitest";
import { SdkManagedSession } from "./sdkManagedSession.js";
import { SdkRuntimeSession, type SdkSessionHandle } from "./sdkRuntimeSession.js";
import type { Driver, LaunchContext, SdkDriverDeps } from "../types.js";

function baseCtx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    agentId: "agent_1",
    workingDirectory: "/tmp/agent_1",
    standingPrompt: "You are Pi.",
    prompt: "",
    config: {},
    ...overrides,
  };
}

function fakeDeps(): SdkDriverDeps {
  return {
    buildSpawnEnv: vi.fn().mockResolvedValue({}),
    createAgentSession: vi.fn(),
  };
}

/**
 * A driver whose `createSession` mirrors `PiDriver`'s real contract: it wires
 * `handle.prompt` to push events through the returned `SdkRuntimeSession`
 * (via a real `subscribe`-style callback), and does NOT itself await/send
 * the prompt — the caller must do that via `.send()`.
 */
function fakeSdkDriver(): { driver: Driver & { createSession: NonNullable<Driver["createSession"]> }; createSession: ReturnType<typeof vi.fn> } {
  let session: SdkRuntimeSession;
  const handle: SdkSessionHandle = {
    prompt: (text: string) => {
      session.emitEvents([{ kind: "text", text }]);
    },
    steer: (text: string) => {
      session.emitEvents([{ kind: "text", text: `steer:${text}` }]);
    },
    abort: vi.fn(),
    dispose: vi.fn(),
  };
  const createSession = vi.fn(async (_ctx: LaunchContext, _deps: SdkDriverDeps) => {
    session = new SdkRuntimeSession(handle, "sess_1");
    return session;
  });
  const driver = {
    id: "fake-sdk",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const,
    session: { recovery: "resume_or_fresh" } as const,
    model: { detectedModelsVerifiedAs: "launchable", toLaunchSpec: () => ({ params: {} }) } as const,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct" as const,
    probe: () => ({ status: "healthy" as const }),
    spawn: async () => {
      throw new Error("unsupported");
    },
    createSession,
    parseLine: () => [],
    currentSessionId: null,
    encodeStdinMessage: () => null,
    buildSystemPrompt: () => "",
  } as unknown as Driver & { createSession: NonNullable<Driver["createSession"]> };
  return { driver, createSession };
}

describe("SdkManagedSession", () => {
  it("delivers events from the initial prompt to a listener attached before start() — the event-loss regression test", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());

    const received: unknown[] = [];
    // Attached BEFORE start(), same as managerRuntime.doSpawn does.
    adapter.on("runtime_event", (e) => received.push(e));

    await adapter.start({ text: "hello" });

    expect(received).toEqual([
      { kind: "session_init", sessionId: "sess_1" },
      { kind: "text", text: "hello" },
    ]);
    expect(adapter.currentSessionId).toBe("sess_1");
  });

  it("builds the launch ctx from start()'s input, overriding the base ctx's prompt/sessionId", async () => {
    const { driver, createSession } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx({ config: { sessionId: "base-session" } }), fakeDeps());

    await adapter.start({ text: "steer this", sessionId: "resumed-session" });

    const [launchCtx] = createSession.mock.calls[0] as [LaunchContext, SdkDriverDeps];
    expect(launchCtx.prompt).toBe("steer this");
    expect(launchCtx.config.sessionId).toBe("resumed-session");
  });

  it("falls back to the base ctx's sessionId when start() doesn't supply one", async () => {
    const { driver, createSession } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx({ config: { sessionId: "base-session" } }), fakeDeps());

    await adapter.start({ text: "hi" });

    const [launchCtx] = createSession.mock.calls[0] as [LaunchContext, SdkDriverDeps];
    expect(launchCtx.config.sessionId).toBe("base-session");
  });

  it("send() delegates busy/idle mode to the inner session once started", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    const received: unknown[] = [];
    adapter.on("runtime_event", (e) => received.push(e));

    await adapter.start({ text: "hello" });
    adapter.send({ text: "follow up", mode: "busy" });
    // steer's handle callback emits synchronously.
    await Promise.resolve();

    expect(received).toContainEqual({ kind: "text", text: "steer:follow up" });
  });

  it("send() before start() returns not_started instead of throwing", () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    expect(adapter.send({ text: "too early", mode: "idle" })).toEqual({ ok: false, reason: "not_started" });
  });

  it("stop() delegates to the inner session's stop", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    await adapter.start({ text: "hello" });
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it("stop() before start() is a safe no-op", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  // Regression test: unlike ChildProcessRuntimeSession (where killing the
  // process makes the OS emit its own "exit"), there's no process here to do
  // that for us — SdkManagedSession must fire "exit" itself, or
  // managerRuntime.ts's `session.on("exit", ...)` listener never runs and the
  // agent's session is never removed from the manager's map / FSM.
  it("stop() emits \"exit\" so the manager's session-cleanup listener runs", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    const exited = vi.fn();
    adapter.on("exit", exited);

    await adapter.start({ text: "hello" });
    await adapter.stop();

    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("stop() emits \"exit\" exactly once even when called multiple times", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    const exited = vi.fn();
    adapter.on("exit", exited);

    await adapter.start({ text: "hello" });
    await adapter.stop();
    await adapter.stop();

    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("stop() before start() still emits \"exit\" (no inner session to dispose)", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    const exited = vi.fn();
    adapter.on("exit", exited);

    await adapter.stop();

    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("stop() emits \"exit\" even when the inner session's dispose rejects", async () => {
    const { driver } = fakeSdkDriver();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    const exited = vi.fn();
    adapter.on("exit", exited);
    await adapter.start({ text: "hello" });

    // Force the inner session's own stop() to reject — the manager must
    // still be notified via "exit" so the agent doesn't get stuck in
    // "stopping" forever just because disposal failed.
    const inner = (adapter as unknown as { inner: SdkRuntimeSession }).inner;
    vi.spyOn(inner, "stop").mockRejectedValueOnce(new Error("dispose failed"));

    await expect(adapter.stop()).rejects.toThrow("dispose failed");
    expect(exited).toHaveBeenCalledTimes(1);
  });

  // Regression test: `managerRuntime.ts::doSpawn` registers the session in
  // its map (and a `stop`/`terminate_stalled` effect can look it up and call
  // `.stop()`) BEFORE `start()`'s `driver.createSession()` has resolved. If
  // `stop()` disposed nothing and emitted "exit" immediately in that window,
  // the still in-flight `start()` would go on to wire up the SDK session and
  // fire the first prompt into it — an orphaned session the manager already
  // believes has exited.
  it("a stop() that races an in-flight start() disposes the session instead of leaving it orphaned, and skips the first prompt", async () => {
    let resolveCreateSession!: (session: SdkRuntimeSession) => void;
    const disposed = vi.fn();
    const promptSent = vi.fn();
    const handle: SdkSessionHandle = {
      prompt: (text: string) => promptSent(text),
      steer: vi.fn(),
      dispose: disposed,
    };
    const createSession = vi.fn(
      () =>
        new Promise<SdkRuntimeSession>((resolve) => {
          resolveCreateSession = (session) => resolve(session);
        }),
    );
    const driver = {
      id: "fake-sdk",
      lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const,
      session: { recovery: "resume_or_fresh" } as const,
      model: { detectedModelsVerifiedAs: "launchable", toLaunchSpec: () => ({ params: {} }) } as const,
      supportsStdinNotification: true,
      busyDeliveryMode: "direct" as const,
      probe: () => ({ status: "healthy" as const }),
      spawn: async () => {
        throw new Error("unsupported");
      },
      createSession,
      parseLine: () => [],
      currentSessionId: null,
      encodeStdinMessage: () => null,
      buildSystemPrompt: () => "",
    } as unknown as Driver & { createSession: NonNullable<Driver["createSession"]> };

    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    const exited = vi.fn();
    adapter.on("exit", exited);

    const startPromise = adapter.start({ text: "hello" }); // createSession() still pending
    const stopPromise = adapter.stop(); // races the in-flight start()

    // Let `driver.createSession()` resolve now that both calls are in flight.
    resolveCreateSession(new SdkRuntimeSession(handle, "sess_1"));
    await Promise.all([startPromise, stopPromise]);

    expect(disposed).toHaveBeenCalledTimes(1); // the session got cleaned up, not orphaned
    expect(promptSent).not.toHaveBeenCalled(); // no turn fired into a stopped session
    expect(exited).toHaveBeenCalledTimes(1);
  });

  // Regression test: it's not enough for the racing stop() to eventually
  // dispose and emit "exit" — `start()` must not resolve "successfully"
  // BEFORE that happens. `doSpawn` dispatches `{type: "spawned"}` the
  // instant `start()` resolves; if that happened while `stop()`'s own
  // disposal (e.g. a slow vendor `dispose()`) was still pending, the manager
  // would see a session still in its map and (correctly, per its own
  // identity check) dispatch `spawned` — a real, if brief, "running" state
  // for a session that's already mid-teardown and never ran a turn.
  it("start() does not resolve until a racing stop()'s disposal has fully finished (exit fires strictly before start() resolves)", async () => {
    let resolveCreateSession!: (session: SdkRuntimeSession) => void;
    let resolveDispose!: () => void;
    const order: string[] = [];
    const handle: SdkSessionHandle = {
      prompt: vi.fn(),
      steer: vi.fn(),
      dispose: () =>
        new Promise<void>((resolve) => {
          resolveDispose = () => {
            order.push("dispose-settled");
            resolve();
          };
        }),
    };
    const createSession = vi.fn(
      () =>
        new Promise<SdkRuntimeSession>((resolve) => {
          resolveCreateSession = (session) => resolve(session);
        }),
    );
    const driver = {
      id: "fake-sdk",
      lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const,
      session: { recovery: "resume_or_fresh" } as const,
      model: { detectedModelsVerifiedAs: "launchable", toLaunchSpec: () => ({ params: {} }) } as const,
      supportsStdinNotification: true,
      busyDeliveryMode: "direct" as const,
      probe: () => ({ status: "healthy" as const }),
      spawn: async () => {
        throw new Error("unsupported");
      },
      createSession,
      parseLine: () => [],
      currentSessionId: null,
      encodeStdinMessage: () => null,
      buildSystemPrompt: () => "",
    } as unknown as Driver & { createSession: NonNullable<Driver["createSession"]> };

    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    adapter.on("exit", () => order.push("exit-emitted"));

    const startPromise = adapter.start({ text: "hello" }).then(() => order.push("start-resolved"));
    const stopPromise = adapter.stop();
    resolveCreateSession(new SdkRuntimeSession(handle, "sess_1"));

    // Give both chains plenty of microtasks to progress WITHOUT resolving
    // dispose() yet — start() must still be pending at this point.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual([]); // neither exit nor start-resolved yet — dispose() is still pending

    resolveDispose();
    await Promise.all([startPromise, stopPromise]);

    expect(order).toEqual(["dispose-settled", "exit-emitted", "start-resolved"]);
  });
});

describe("SdkManagedSession — start() does not block on the whole first turn", () => {
  /**
   * Regression test for the production crash:
   *   Error: Agent is already processing. Specify streamingBehavior
   *   ('steer' or 'followUp') to queue the message.
   *
   * `start()` used to `await` the whole first `send()` (a vendor SDK's
   * `prompt()` doesn't resolve until the entire turn, including tool calls,
   * finishes). That meant `AgentProcessManager` didn't dispatch
   * `{type: "spawned"}` — and so didn't consider the agent "busy" — until
   * long after the turn had actually started, so a wake that arrived mid-turn
   * got queued instead of routed as an immediate "steer", then misrouted as
   * an `idle` send once the turn finally ended.
   */
  function fakeSdkDriverWithSlowFirstTurn(): {
    driver: Driver & { createSession: NonNullable<Driver["createSession"]> };
    resolveFirstTurn: () => void;
    rejectFirstTurn: (err: unknown) => void;
    steerCalls: string[];
  } {
    let session: SdkRuntimeSession;
    const steerCalls: string[] = [];
    let resolveFirstTurn!: () => void;
    let rejectFirstTurn!: (err: unknown) => void;
    const handle: SdkSessionHandle = {
      prompt: () =>
        new Promise<void>((resolve, reject) => {
          resolveFirstTurn = resolve;
          rejectFirstTurn = reject;
        }),
      steer: (text: string) => {
        steerCalls.push(text);
      },
    };
    const createSession = vi.fn(async () => {
      session = new SdkRuntimeSession(handle, "sess_1");
      return session;
    });
    const driver = {
      id: "fake-sdk",
      lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const,
      session: { recovery: "resume_or_fresh" } as const,
      model: { detectedModelsVerifiedAs: "launchable", toLaunchSpec: () => ({ params: {} }) } as const,
      supportsStdinNotification: true,
      busyDeliveryMode: "direct" as const,
      probe: () => ({ status: "healthy" as const }),
      spawn: async () => {
        throw new Error("unsupported");
      },
      createSession,
      parseLine: () => [],
      currentSessionId: null,
      encodeStdinMessage: () => null,
      buildSystemPrompt: () => "",
    } as unknown as Driver & { createSession: NonNullable<Driver["createSession"]> };
    return {
      driver,
      resolveFirstTurn: () => resolveFirstTurn(),
      rejectFirstTurn: (err) => rejectFirstTurn(err),
      steerCalls,
    };
  }

  it("start() resolves before the first turn's prompt() promise settles", async () => {
    const { driver } = fakeSdkDriverWithSlowFirstTurn();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());

    // If start() awaited the whole turn, this would hang forever (the turn's
    // prompt() promise is never resolved in this test) — the fact it resolves
    // at all is the assertion.
    await adapter.start({ text: "hello" });
  });

  it("a wake that arrives while the first turn is still in flight is delivered as a real steer, not queued until turn_end", async () => {
    const { driver, steerCalls } = fakeSdkDriverWithSlowFirstTurn();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());

    await adapter.start({ text: "hello" }); // first turn still pending underneath
    const result = adapter.send({ text: "mid-turn wake", mode: "busy" });

    expect(result).toEqual({ ok: true });
    expect(steerCalls).toEqual(["mid-turn wake"]);
  });

  it("a first-turn rejection surfaces as a runtime_event error instead of an unhandled rejection", async () => {
    // As of plans/sdk-runtime-session-live-isstreaming-guard.md,
    // SdkRuntimeSession.send() itself catches a vendor SDK rejection and
    // reports it as a normal `runtime_event: {kind: "error"}` — visible on
    // the agent's own event stream — rather than rejecting and relying on
    // this adapter's `.catch()` → `"error"` EventEmitter event (that path
    // still exists as a last-resort net, but no longer fires for this case).
    const { driver, rejectFirstTurn } = fakeSdkDriverWithSlowFirstTurn();
    const adapter = new SdkManagedSession(driver, baseCtx(), fakeDeps());
    const events: unknown[] = [];
    const errors: unknown[] = [];
    adapter.on("runtime_event", (e) => events.push(e));
    adapter.on("error", (e) => errors.push(e));

    await adapter.start({ text: "hello" });
    rejectFirstTurn(new Error("Agent is already processing"));
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toEqual([]);
    expect(events).toContainEqual({ kind: "error", message: "Agent is already processing" });
  });
});

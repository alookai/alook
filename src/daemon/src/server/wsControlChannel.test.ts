import { describe, it, expect, vi } from "vitest";
import { WS_CONTROL_COMMAND_CONSUMED, WsControlChannel } from "./wsControlChannel";
import type { WebSocketLike, HostReady, AgentSessionReport, HostCommand } from "./contract";
import type { Logger } from "../logger";

/**
 * A controllable fake socket: records sent frames, lets the test drive open/close
 * to simulate a reconnect. The factory hands out a fresh socket each connect (as
 * `ws` does), so we can assert the channel re-announces state on the NEW socket.
 */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  private handlers: Record<string, ((...a: any[]) => void)[]> = {};
  on(event: string, cb: (...a: any[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close");
  }
  ping(): void {}
  emit(event: string, ...args: unknown[]): void {
    (this.handlers[event] ?? []).forEach((h) => h(...args));
  }
  frames(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeChannel(overrides: Partial<ConstructorParameters<typeof WsControlChannel>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const ch = new WsControlChannel({
    url: "ws://test",
    webSocketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    // No real timers needed; reconnect uses setTimeout(unref) — we drive openSocket
    // indirectly by emitting close then letting the scheduled reconnect fire.
    reconnect: { baseMs: 1, maxMs: 1 },
    ...overrides,
  });
  return { ch, sockets };
}

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

describe("WsControlChannel — resync on (re)connect", () => {
  it("re-announces ready + live sessions on the new socket after a reconnect", async () => {
    const { ch, sockets } = makeChannel();
    const ready: HostReady = { runtimeReport: [{ id: "mock" }], runningAgents: ["a1"] };
    const sessions: AgentSessionReport[] = [{ agentId: "a1", sessionId: "s1", launchId: "l1" }];
    ch.onResync(() => ({ ready, sessions, activities: [] }));

    ch.connect();
    sockets[0].emit("open");
    // First connect: ready + agent_session sent. `ready` fields are spread flat
    // so the shape matches HostReadyMessageSchema in @alook/shared.
    let f = sockets[0].frames();
    expect(f[0]).toMatchObject({ type: "ready", runningAgents: ["a1"] });
    expect(f[1]).toMatchObject({ type: "agent_session", agentId: "a1", sessionId: "s1" });

    // Drop the socket → channel schedules a reconnect → new socket created.
    sockets[0].emit("close");
    await new Promise((r) => setTimeout(r, 10)); // let the 1ms backoff fire
    expect(sockets.length).toBe(2);
    sockets[1].emit("open");

    // The NEW socket must carry a fresh ready + session (state recovered).
    f = sockets[1].frames();
    expect(f.some((x) => x.type === "ready")).toBe(true);
    expect(f.some((x) => x.type === "agent_session" && x.agentId === "a1")).toBe(true);
  });

  it("2a — replays each live agent's current activity on (re)connect, recovering a frame dropped mid-disconnect", async () => {
    const { ch, sockets } = makeChannel();
    const ready: HostReady = { runtimeReport: [{ id: "mock" }], runningAgents: ["a1", "a2"] };
    ch.onResync(() => ({
      ready,
      sessions: [{ agentId: "a1", sessionId: "s1", launchId: "l1" }],
      activities: [
        { agentId: "a1", state: "running" },
        { agentId: "a2", state: "idle" },
      ],
    }));

    ch.connect();
    sockets[0].emit("open");

    // Simulate the reported failure: while the socket was down, a1's `running`
    // activity frame was dropped and never reached the server. On reconnect the
    // daemon re-asserts its OWN current truth, so the pill self-heals.
    sockets[0].emit("close");
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets.length).toBe(2);
    sockets[1].emit("open");

    const f = sockets[1].frames();
    expect(f.some((x) => x.type === "agent_activity" && x.agentId === "a1" && x.state === "running")).toBe(true);
    expect(f.some((x) => x.type === "agent_activity" && x.agentId === "a2" && x.state === "idle")).toBe(true);
    // Activity replay comes after ready + sessions.
    const readyIdx = f.findIndex((x) => x.type === "ready");
    const activityIdx = f.findIndex((x) => x.type === "agent_activity");
    expect(readyIdx).toBeLessThan(activityIdx);
  });

  it("2b — tolerates a resync provider that omits `activities` (no crash, still sends ready + sessions)", async () => {
    // Regression: `activities` is optional on ResyncProvider. A provider that
    // returns only { ready, sessions } must not throw "activities is not
    // iterable" — the resync loop treats a missing set as empty.
    const { ch, sockets } = makeChannel();
    const ready: HostReady = { runtimeReport: [{ id: "mock" }], runningAgents: ["a1"] };
    ch.onResync(() => ({ ready, sessions: [{ agentId: "a1", sessionId: "s1", launchId: "l1" }] }));

    ch.connect();
    expect(() => sockets[0].emit("open")).not.toThrow();

    const f = sockets[0].frames();
    expect(f.some((x) => x.type === "ready")).toBe(true);
    expect(f.some((x) => x.type === "agent_session" && x.agentId === "a1")).toBe(true);
    expect(f.some((x) => x.type === "agent_activity")).toBe(false);
  });

  it("does NOT replay a stale ready/session if the resync provider's state changed", async () => {
    const { ch, sockets } = makeChannel();
    let running = ["a1"];
    ch.onResync(() => ({ ready: { runtimeReport: [{ id: "mock" }], runningAgents: running }, sessions: [], activities: [] }));

    ch.connect();
    sockets[0].emit("open");
    expect(sockets[0].frames()[0]).toMatchObject({ type: "ready", runningAgents: ["a1"] });

    // Agent a1 went away before reconnect.
    running = [];
    sockets[0].emit("close");
    await new Promise((r) => setTimeout(r, 10));
    sockets[1].emit("open");
    // Fresh snapshot (empty), not the stale ["a1"].
    expect(sockets[1].frames()[0]).toMatchObject({ type: "ready", runningAgents: [] });
  });
});

describe("WsControlChannel — auth rejection", () => {
  it("stops reconnecting when server sends AUTH_REJECTED", async () => {
    const sockets: FakeSocket[] = [];
    let authRejectedCalled = false;
    const ch = new WsControlChannel({
      url: "ws://test",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      reconnect: { baseMs: 1, maxMs: 1 },
      onAuthRejected: () => { authRejectedCalled = true; },
    });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));

    ch.connect();
    sockets[0].emit("open");
    // Server sends auth rejection frame then closes
    sockets[0].emit("message", JSON.stringify({ type: "error", code: "AUTH_REJECTED" }));
    sockets[0].emit("close");

    await new Promise((r) => setTimeout(r, 20));
    // Should NOT have reconnected — only 1 socket total
    expect(sockets.length).toBe(1);
    expect(ch.status).toBe("closed");
    expect(authRejectedCalled).toBe(true);
  });

  it("does reconnect on normal close (no auth rejection)", async () => {
    const sockets: FakeSocket[] = [];
    const ch = new WsControlChannel({
      url: "ws://test",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      reconnect: { baseMs: 1, maxMs: 1 },
    });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));

    ch.connect();
    sockets[0].emit("open");
    sockets[0].emit("close");

    await new Promise((r) => setTimeout(r, 20));
    // Should have reconnected — 2 sockets
    expect(sockets.length).toBe(2);
    expect(ch.status).toBe("reconnecting");
  });
});

describe("WsControlChannel — ready frame", () => {
  it("round-trips runtimeReport on the ready frame", async () => {
    const { ch, sockets } = makeChannel();
    const ready: HostReady = {
      runtimeReport: [{ id: "claude", version: "1.0.0" }],
      runningAgents: [],
    };
    ch.onResync(() => ({ ready, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    const frames = sockets[0].frames();
    expect(frames[0]).toMatchObject({
      type: "ready",
      runtimeReport: [{ id: "claude", version: "1.0.0" }],
    });
  });
});

describe("WsControlChannel — wake/stop acks", () => {
  it("sends agent_wake_ack when open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    await ch.reportWakeAck({ agentId: "a1", launchId: "l1", status: "ok" });
    expect(sockets[0].frames().some((f) => f.type === "agent_wake_ack" && f.launchId === "l1")).toBe(true);
  });

  it("drops (does not throw, does not send) an ack issued before the socket is open", async () => {
    // Unlike the retired agent_deliver_ack, wake/stop acks are point-in-time —
    // there is no queue-side unacked-delivery store retiring them, so there
    // is nothing to buffer for. A dropped ack while offline is fine: the
    // server never addressed this wake attempt on this connection anyway.
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    await ch.reportWakeAck({ agentId: "a1", launchId: "l_early", status: "ok" });
    expect(sockets[0].frames().some((f) => f.type === "agent_wake_ack")).toBe(false);
    sockets[0].emit("open");
    expect(sockets[0].frames().some((f) => f.type === "agent_wake_ack" && f.launchId === "l_early")).toBe(false);
  });
});

describe("WsControlChannel — agent activity reports", () => {
  it("sends agent_activity when open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    await ch.reportAgentActivity({ agentId: "a1", state: "running" });
    expect(sockets[0].frames().some((f) => f.type === "agent_activity" && f.agentId === "a1" && f.state === "running")).toBe(true);
  });

  it("no-ops (does not throw) when the socket isn't open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    await expect(ch.reportAgentActivity({ agentId: "a1", state: "idle" })).resolves.toBeUndefined();
    expect(sockets[0].frames().some((f) => f.type === "agent_activity")).toBe(false);
  });
});

describe("WsControlChannel — bot audit event reports", () => {
  it("sends a well-formed bot_audit_event frame when open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    await ch.reportBotAuditEvent({
      type: "bot_audit_event",
      agentId: "bot_1",
      event: { kind: "cli_invocation", payload: { subcommand: "send" } },
    });
    const frame = sockets[0].frames().find((f) => f.type === "bot_audit_event");
    expect(frame).toBeDefined();
    expect(frame.agentId).toBe("bot_1");
    expect(frame.event).toEqual({ kind: "cli_invocation", payload: { subcommand: "send" } });
  });

  it("no-ops when the socket isn't open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    await expect(
      ch.reportBotAuditEvent({
        type: "bot_audit_event",
        agentId: "bot_1",
        event: { kind: "tool_call", payload: { name: "read", target: "AGENTS.md" } },
      })
    ).resolves.toBeUndefined();
    expect(sockets[0].frames().some((f) => f.type === "bot_audit_event")).toBe(false);
  });
});

describe("WsControlChannel — HTTP 401s are non-terminal", () => {
  it("keeps reconnecting after 3+ consecutive 401 upgrade failures — no self-kill", async () => {
    const sockets: FakeSocket[] = [];
    let authRejectedCalls = 0;
    const ch = new WsControlChannel({
      url: "ws://test",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      reconnect: { baseMs: 1, maxMs: 1 },
      onAuthRejected: () => { authRejectedCalls++; },
    });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));

    ch.connect();
    // Simulate 3 consecutive 401-then-close cycles. The channel MUST keep
    // reconnecting because AUTH_REJECTED is the only terminal signal now.
    for (let i = 0; i < 3; i++) {
      sockets[i].emit("close");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(sockets.length).toBeGreaterThanOrEqual(4);
    expect(authRejectedCalls).toBe(0);
    expect(ch.status).not.toBe("closed");
  });

  it("does fire onAuthRejected when an AUTH_REJECTED FRAME arrives", async () => {
    // Duplicated from the "auth rejection" suite as the counter-invariant to
    // the test above: the frame remains the sole permanent-revoke authority.
    const sockets: FakeSocket[] = [];
    let authRejectedCalls = 0;
    const ch = new WsControlChannel({
      url: "ws://test",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      reconnect: { baseMs: 1, maxMs: 1 },
      onAuthRejected: () => { authRejectedCalls++; },
    });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));

    ch.connect();
    sockets[0].emit("open");
    sockets[0].emit("message", JSON.stringify({ type: "error", code: "AUTH_REJECTED" }));
    sockets[0].emit("close");
    await new Promise((r) => setTimeout(r, 20));

    expect(authRejectedCalls).toBe(1);
    expect(ch.status).toBe("closed");
    expect(sockets.length).toBe(1);
  });
});

describe("WsControlChannel — reconnect timer keeps the event loop alive", () => {
  it("does NOT unref the reconnect setTimeout (regression against silent daemon exit)", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timers: Array<{ unrefCalled: boolean; hasRef: () => boolean }> = [];
    // Wrap setTimeout so we can inspect whether the reconnect scheduling
    // ever calls .unref() on its return value.
    (globalThis as any).setTimeout = ((fn: () => void, ms: number) => {
      const handle = originalSetTimeout(fn, ms) as unknown as {
        unref: () => void;
        hasRef?: () => boolean;
      };
      const record = { unrefCalled: false, hasRef: () => true };
      const origUnref = handle.unref?.bind(handle);
      handle.unref = () => {
        record.unrefCalled = true;
        origUnref?.();
      };
      timers.push(record);
      return handle;
    }) as unknown as typeof setTimeout;

    try {
      const sockets: FakeSocket[] = [];
      const ch = new WsControlChannel({
        url: "ws://test",
        webSocketFactory: () => {
          const s = new FakeSocket();
          sockets.push(s);
          return s;
        },
        reconnect: { baseMs: 50, maxMs: 50 },
      });
      ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));

      ch.connect();
      sockets[0].emit("open");
      sockets[0].emit("close");
      await new Promise((r) => originalSetTimeout(r, 10));

      // A reconnect setTimeout was scheduled. It MUST NOT have been unrefed —
      // otherwise the process would silently exit when the WS drops.
      const reconnectTimers = timers.filter((t) => t.unrefCalled);
      expect(reconnectTimers.length).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe("WsControlChannel — downlink HostCommand validation (convergence #6)", () => {
  // A REAL `agent:wake` frame as `buildUnreadWakeCommand` (wake-dispatch.ts)
  // constructs it: type/agentId/config/launchId/unreadNotice, with the optional
  // load-bearing `sessionId` present. `config`/`unreadNotice` are opaque blobs
  // (validated as `z.unknown()`), so their interiors must survive untouched.
  const realWake: HostCommand = {
    type: "agent:wake",
    agentId: "bot_1",
    config: { runtime: "claude", model: { kind: "default" }, agentName: "Melisa" } as never,
    sessionId: "sess_abc",
    launchId: "launch_1",
    unreadNotice: {
      kind: "unread_notice",
      channel: "/demo#1234/general",
      latestSeq: 42,
      channelId: "chan_xyz",
    },
  };
  // Real reset/nap/model_switch frames as ws-do (`index.ts`) serializes them.
  const realReset: HostCommand = {
    type: "agent:reset",
    agentId: "bot_1",
    config: { runtime: "claude" } as never,
    launchId: "launch_r",
  };
  const realNap: HostCommand = {
    type: "agent:nap",
    agentId: "bot_1",
    config: { runtime: "claude" } as never,
    launchId: "launch_n",
    handoff: "note to my reborn self",
  };
  const realModelSwitch: HostCommand = {
    type: "agent:model_switch",
    agentId: "bot_1",
    config: { runtime: "claude", model: { kind: "named", id: "opus" } } as never,
    launchId: "launch_m",
  };
  const realStop: HostCommand = { type: "agent:stop", agentId: "bot_1" };

  function driven() {
    const { ch, sockets } = makeChannel();
    const received: HostCommand[] = [];
    ch.onCommand((c) => {
      received.push(c);
    });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    return { sockets, received };
  }

  it("dispatches each valid arm unchanged (happy path — the transparent gate)", () => {
    for (const frame of [realWake, realReset, realNap, realModelSwitch, realStop]) {
      const { sockets, received } = driven();
      sockets[0].emit("message", JSON.stringify(frame));
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe(frame.type);
    }
  });

  it("Z5 — a real producer frame round-trips field-for-field at the top level (default-strip drops nothing real)", () => {
    // The strip risk: zod rebuilds `parsed.data`, so any top-level field the
    // schema forgot to enumerate is silently dropped. Assert every real frame's
    // top-level keys AND values survive — including optional load-bearing ones
    // (`wake.sessionId`) and the opaque blobs' interiors (`config`,
    // `unreadNotice.channelId`).
    for (const frame of [realWake, realReset, realNap, realModelSwitch, realStop]) {
      const { sockets, received } = driven();
      sockets[0].emit("message", JSON.stringify(frame));
      expect(received).toHaveLength(1);
      // Deep-equal against the exact producer shape — nothing added, nothing lost.
      expect(received[0]).toEqual(frame);
      // Explicit belt-and-suspenders on the fields strip loves to eat.
      if (frame.type === "agent:wake") {
        expect(received[0]).toHaveProperty("sessionId", "sess_abc");
        expect((received[0] as typeof realWake).unreadNotice).toEqual(realWake.unreadNotice);
      }
    }
  });

  it("drops + logs a malformed frame instead of dispatching it", () => {
    const malformed: unknown[] = [
      { type: "agent:wake", config: {}, launchId: "l", unreadNotice: {} }, // missing agentId
      { type: "agent:wake", agentId: "b", config: {}, unreadNotice: {} }, // missing launchId
      { type: "agent:nap", agentId: "b", config: {}, launchId: "l" }, // missing handoff
      { type: "agent:nap", agentId: "b", config: {}, launchId: "l", handoff: "" }, // empty handoff
      { type: "agent:reset", agentId: "", config: {}, launchId: "l" }, // empty agentId
      { type: "agent:unknown", agentId: "b" }, // unknown discriminant
    ];
    for (const frame of malformed) {
      const logger = stubLogger();
      const { ch, sockets } = makeChannel({ logger });
      const received: HostCommand[] = [];
      ch.onCommand((c) => received.push(c));
      ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
      ch.connect();
      sockets[0].emit("open");
      sockets[0].emit("message", JSON.stringify(frame));
      expect(received).toHaveLength(0);
      expect(logger.calls.warn.some(([m]) => m === "dropped malformed HostCommand frame")).toBe(true);
    }
  });

  it("keeps AUTH_REJECTED ahead of the schema gate — it is not a HostCommand", () => {
    // The `{type:"error", code:"AUTH_REJECTED"}` frame is NOT a HostCommand and
    // must short-circuit BEFORE `HostCommandSchema.safeParse`, still firing
    // onAuthRejected and never reaching a command listener.
    let authRejected = false;
    const received: HostCommand[] = [];
    const sockets: FakeSocket[] = [];
    const ch = new WsControlChannel({
      url: "ws://test",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      reconnect: { baseMs: 1, maxMs: 1 },
      onAuthRejected: () => {
        authRejected = true;
      },
    });
    ch.onCommand((c) => received.push(c));
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    sockets[0].emit("message", JSON.stringify({ type: "error", code: "AUTH_REJECTED" }));
    expect(authRejected).toBe(true);
    expect(received).toHaveLength(0);
  });

  it("config forward-compat — an unrecognized-but-well-formed config field still parses (no hard drop)", () => {
    // Scope (a): `config` is `z.unknown()` opaque passthrough, so a newer server
    // field on config must NOT hard-drop the frame on an older daemon.
    const frame: HostCommand = {
      ...realReset,
      config: { runtime: "claude", someBrandNewFieldFromANewerServer: true } as never,
    };
    const { sockets, received } = driven();
    sockets[0].emit("message", JSON.stringify(frame));
    expect(received).toHaveLength(1);
    expect((received[0] as typeof realReset).config).toEqual(frame.config);
  });

  it("stops listener broadcast synchronously only for the server-owned consume sentinel", async () => {
    const { ch, sockets } = makeChannel();
    const consumedSecond = vi.fn();
    ch.onCommand(() => WS_CONTROL_COMMAND_CONSUMED);
    ch.onCommand(consumedSecond);
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    ch.connect();
    sockets[0].emit("open");

    sockets[0].emit("message", JSON.stringify(realStop));

    expect(consumedSecond).not.toHaveBeenCalled();

    const normal = makeChannel();
    const first = vi.fn(async () => {});
    const second = vi.fn();
    normal.ch.onCommand(first);
    normal.ch.onCommand(second);
    normal.ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    normal.ch.connect();
    normal.sockets[0].emit("open");
    normal.sockets[0].emit("message", JSON.stringify(realStop));
    await Promise.resolve();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("dispatches one exact diagnostics command field-for-field", () => {
    const command = {
      type: "diagnostics:collect",
      reportId: "dbr_0123456789abcdef",
      agentId: "bot_1",
      fromMs: 1_700_000_000_000,
      deadlineAt: 1_700_087_000_000,
    } as const;
    const { sockets, received } = driven();

    sockets[0].emit("message", JSON.stringify(command));

    expect(received).toEqual([command]);
  });

  it("drops diagnostics commands with missing or unknown top-level fields", () => {
    for (const command of [
      {
        type: "diagnostics:collect",
        agentId: "bot_1",
        fromMs: 1_700_000_000_000,
        deadlineAt: 1_700_087_000_000,
      },
      {
        type: "diagnostics:collect",
        reportId: "dbr_0123456789abcdef",
        agentId: "bot_1",
        fromMs: 1_700_000_000_000,
        deadlineAt: 1_700_087_000_000,
        objectKey: "attacker-controlled",
      },
    ]) {
      const logger = stubLogger();
      const { ch, sockets } = makeChannel({ logger });
      const received: HostCommand[] = [];
      ch.onCommand((value) => received.push(value));
      ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
      ch.connect();
      sockets[0].emit("open");

      sockets[0].emit("message", JSON.stringify(command));

      expect(received).toEqual([]);
      expect(logger.calls.warn.some(([message]) => message === "dropped malformed HostCommand frame")).toBe(true);
    }
  });
});

describe("WsControlChannel — logging", () => {
  it("logs info on open, and info on resync with runtime/session counts", async () => {
    const logger = stubLogger();
    const { ch, sockets } = makeChannel({ logger });
    ch.onResync(() => ({
      ready: { runtimeReport: [{ id: "claude" }], runningAgents: ["a1"] },
      sessions: [{ agentId: "a1", sessionId: "s1", launchId: "l1" }],
      activities: [],
    }));
    ch.connect();
    sockets[0].emit("open");

    expect(logger.calls.info.some(([m, d]) => m === "control channel open" && (d[0] as any).attempt === 0)).toBe(
      true,
    );
    expect(
      logger.calls.info.some(
        ([m, d]) => m === "resync sent" && (d[0] as any).ready === 1 && (d[0] as any).sessions === 1,
      ),
    ).toBe(true);
  });

  it("logs warn on close", async () => {
    const logger = stubLogger();
    const { ch, sockets } = makeChannel({ logger });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    sockets[0].emit("close", 1006, "abnormal");

    expect(
      logger.calls.warn.some(([m, d]) => m === "control channel closed" && (d[0] as any).code === 1006),
    ).toBe(true);
  });

  it("logs info on each scheduled reconnect with the computed delayMs", async () => {
    const logger = stubLogger();
    const { ch, sockets } = makeChannel({ logger, reconnect: { baseMs: 10, maxMs: 100 } });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    sockets[0].emit("close");

    expect(
      logger.calls.info.some(([m, d]) => m === "reconnecting" && (d[0] as any).attempt === 1 && (d[0] as any).delayMs === 10),
    ).toBe(true);
  });

  it("logs error on AUTH_REJECTED", async () => {
    const logger = stubLogger();
    const { ch, sockets } = makeChannel({ logger });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    sockets[0].emit("message", JSON.stringify({ type: "error", code: "AUTH_REJECTED" }));

    expect(logger.calls.error.some(([m]) => m === "AUTH_REJECTED received — machine key rejected, not reconnecting")).toBe(
      true,
    );
  });

  it("logs warn when heartbeat pong times out", async () => {
    const logger = stubLogger();
    let now = 0;
    const { ch, sockets } = makeChannel({
      logger,
      now: () => now,
      heartbeat: { pingIntervalMs: 10, pongTimeoutMs: 20 },
    });
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [], activities: [] }));
    ch.connect();
    sockets[0].emit("open");
    // Advance the injected clock past the pong deadline, then let the
    // heartbeat interval fire against real timers.
    now = 1000;
    await new Promise((r) => setTimeout(r, 30));

    expect(logger.calls.warn.some(([m]) => m === "heartbeat pong timeout — forcing reconnect")).toBe(true);
  });
});

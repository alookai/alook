import { describe, it, expect } from "vitest";
import { WsControlChannel } from "./wsControlChannel";
import type { WebSocketLike, HostReady, AgentSessionReport } from "./contract";
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
    ch.onResync(() => ({ ready, sessions }));

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

  it("does NOT replay a stale ready/session if the resync provider's state changed", async () => {
    const { ch, sockets } = makeChannel();
    let running = ["a1"];
    ch.onResync(() => ({ ready: { runtimeReport: [{ id: "mock" }], runningAgents: running }, sessions: [] }));

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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));

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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));

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
    ch.onResync(() => ({ ready, sessions: [] }));
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    ch.connect();
    sockets[0].emit("open");
    await ch.reportAgentActivity({ agentId: "a1", state: "running" });
    expect(sockets[0].frames().some((f) => f.type === "agent_activity" && f.agentId === "a1" && f.state === "running")).toBe(true);
  });

  it("no-ops (does not throw) when the socket isn't open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    ch.connect();
    await expect(ch.reportAgentActivity({ agentId: "a1", state: "idle" })).resolves.toBeUndefined();
    expect(sockets[0].frames().some((f) => f.type === "agent_activity")).toBe(false);
  });
});

describe("WsControlChannel — bot audit event reports", () => {
  it("sends a well-formed bot_audit_event frame when open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    ch.connect();
    await expect(
      ch.reportBotAuditEvent({
        type: "bot_audit_event",
        agentId: "bot_1",
        event: { kind: "tool_call", payload: { name: "Read" } },
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));

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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));

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
      ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));

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

describe("WsControlChannel — logging", () => {
  it("logs info on open, and info on resync with runtime/session counts", async () => {
    const logger = stubLogger();
    const { ch, sockets } = makeChannel({ logger });
    ch.onResync(() => ({
      ready: { runtimeReport: [{ id: "claude" }], runningAgents: ["a1"] },
      sessions: [{ agentId: "a1", sessionId: "s1", launchId: "l1" }],
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
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
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    ch.connect();
    sockets[0].emit("open");
    // Advance the injected clock past the pong deadline, then let the
    // heartbeat interval fire against real timers.
    now = 1000;
    await new Promise((r) => setTimeout(r, 30));

    expect(logger.calls.warn.some(([m]) => m === "heartbeat pong timeout — forcing reconnect")).toBe(true);
  });
});

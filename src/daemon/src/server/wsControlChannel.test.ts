import { describe, it, expect } from "vitest";
import { WsControlChannel } from "./wsControlChannel";
import type { WebSocketLike, HostReady, AgentSessionReport } from "./contract";

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

function makeChannel() {
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
  });
  return { ch, sockets };
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

describe("WsControlChannel — deliver acks", () => {
  it("sends an ack when open", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    ch.connect();
    sockets[0].emit("open");
    await ch.reportDeliverAck({ agentId: "a1", deliveryId: "dlv_1" });
    expect(sockets[0].frames().some((f) => f.type === "agent_deliver_ack" && f.deliveryId === "dlv_1")).toBe(true);
  });

  it("buffers an ack issued before open and flushes it on connect", async () => {
    const { ch, sockets } = makeChannel();
    ch.onResync(() => ({ ready: { runtimeReport: [], runningAgents: [] }, sessions: [] }));
    ch.connect();
    // Ack before the socket opens — must be buffered, not lost.
    await ch.reportDeliverAck({ agentId: "a1", deliveryId: "dlv_early" });
    expect(sockets[0].frames().some((f) => f.type === "agent_deliver_ack")).toBe(false);
    sockets[0].emit("open");
    expect(sockets[0].frames().some((f) => f.type === "agent_deliver_ack" && f.deliveryId === "dlv_early")).toBe(true);
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

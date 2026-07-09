import { describe, it, expect, vi } from "vitest";
import { WsControlServer, type WebSocketServerLike, type WsConnectionMeta } from "./wsControlServer";
import type { WebSocketLike, HostCommand } from "./contract";

/** A fake accepted socket recording send/close. */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((...a: any[]) => void)[]> = {};
  on(event: string, cb: (...a: any[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, arg?: unknown): void {
    (this.handlers[event] ?? []).forEach((h) => h(arg));
  }
}

/** A fake ws server we can drive `connection` events into. */
function fakeWss(): { wss: WebSocketServerLike; connect: (s: FakeSocket, meta?: WsConnectionMeta) => void } {
  let cb: ((s: WebSocketLike, m?: WsConnectionMeta) => void) | null = null;
  const wss: WebSocketServerLike = {
    on: (_e, c) => {
      cb = c;
    },
    close: (done) => done?.(),
  };
  return { wss, connect: (s, meta) => cb?.(s, meta) };
}

const sampleWakeCommand: HostCommand = {
  type: "agent:wake",
  agentId: "agent1",
  config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
  launchId: "launch1",
  unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 1 },
};

describe("WsControlServer — machine-key auth on connect", () => {
  it("closes a connection whose machine key fails verification (and never becomes the active socket)", () => {
    const { wss, connect } = fakeWss();
    const cs = new WsControlServer({
      port: 0,
      webSocketServerFactory: () => wss,
      verifyMachineKey: (auth) => auth === "Bearer good",
    });
    cs.start();

    const bad = new FakeSocket();
    connect(bad, { authHeader: "Bearer forged" });
    expect(bad.closed).toBe(true);
    // It must NOT have become the active socket: pushCommand reaches nobody.
    expect(cs.isConnected).toBe(false);
    expect(cs.pushCommand(sampleWakeCommand)).toBe(false);
  });

  it("accepts a connection with a valid machine key and lets pushCommand reach it", () => {
    const { wss, connect } = fakeWss();
    const cs = new WsControlServer({
      port: 0,
      webSocketServerFactory: () => wss,
      verifyMachineKey: (auth) => auth === "Bearer good",
    });
    cs.start();

    const ok = new FakeSocket();
    connect(ok, { authHeader: "Bearer good" });
    expect(ok.closed).toBe(false);
    expect(cs.isConnected).toBe(true);

    expect(cs.pushCommand(sampleWakeCommand)).toBe(true);
    expect(ok.sent).toHaveLength(1);
    expect(JSON.parse(ok.sent[0]!)).toEqual(sampleWakeCommand);
  });

  it("with no verifyMachineKey configured, accepts (unit-test convenience)", () => {
    const { wss, connect } = fakeWss();
    const cs = new WsControlServer({ port: 0, webSocketServerFactory: () => wss });
    cs.start();
    const s = new FakeSocket();
    connect(s, { authHeader: undefined });
    expect(s.closed).toBe(false);
  });
});

describe("WsControlServer — inbound frame observers", () => {
  it("forwards ready/agent_session/agent_wake_ack/agent_stopped_ack frames to their callbacks", () => {
    const { wss, connect } = fakeWss();
    const onReady = vi.fn();
    const onAgentSession = vi.fn();
    const onWakeAck = vi.fn();
    const onStoppedAck = vi.fn();
    const cs = new WsControlServer({
      port: 0,
      webSocketServerFactory: () => wss,
      onReady,
      onAgentSession,
      onWakeAck,
      onStoppedAck,
    });
    cs.start();

    const s = new FakeSocket();
    connect(s);

    const ready = { runtimeReport: [], runningAgents: [] };
    s.emit("message", JSON.stringify({ type: "ready", ...ready }));
    expect(onReady).toHaveBeenCalledWith(ready);

    s.emit("message", JSON.stringify({ type: "agent_session", agentId: "a1", sessionId: "s1", launchId: "l1" }));
    expect(onAgentSession).toHaveBeenCalledWith({ agentId: "a1", sessionId: "s1", launchId: "l1" });

    s.emit("message", JSON.stringify({ type: "agent_wake_ack", agentId: "a1", launchId: "l1", status: "ok" }));
    expect(onWakeAck).toHaveBeenCalledWith({ agentId: "a1", launchId: "l1", status: "ok", error: undefined });

    s.emit("message", JSON.stringify({ type: "agent_stopped_ack", agentId: "a1", status: "ok" }));
    expect(onStoppedAck).toHaveBeenCalledWith({ agentId: "a1", status: "ok", error: undefined });
  });
});

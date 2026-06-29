import { describe, it, expect } from "vitest";
import { WsControlServer, type WebSocketServerLike, type WsConnectionMeta } from "./wsControlServer";
import type { WebSocketLike } from "./contract";

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

/** Minimal MockServer stand-in (only what WsControlServer touches). */
function fakeServer() {
  let sink: ((cmd: unknown) => void) | null = null;
  return {
    attachHost: (s: (cmd: unknown) => void) => {
      sink = s;
    },
    resetRunningAgents: () => {},
    redeliverUnacked: () => {},
    ackDelivery: () => {},
    get sink() {
      return sink;
    },
  };
}

describe("WsControlServer — machine-key auth on connect", () => {
  it("closes a connection whose machine key fails verification (and never attaches it)", () => {
    const server = fakeServer();
    const { wss, connect } = fakeWss();
    const cs = new WsControlServer({
      server: server as never,
      port: 0,
      webSocketServerFactory: () => wss,
      verifyMachineKey: (auth) => auth === "Bearer good",
    });
    cs.start();

    const bad = new FakeSocket();
    connect(bad, { authHeader: "Bearer forged" });
    expect(bad.closed).toBe(true);
    // It must NOT have been wired as the active host: a command dispatch reaches no socket.
    expect(server.sink).toBeNull();
  });

  it("accepts a connection with a valid machine key", () => {
    const server = fakeServer();
    const { wss, connect } = fakeWss();
    const cs = new WsControlServer({
      server: server as never,
      port: 0,
      webSocketServerFactory: () => wss,
      verifyMachineKey: (auth) => auth === "Bearer good",
    });
    cs.start();

    const ok = new FakeSocket();
    connect(ok, { authHeader: "Bearer good" });
    expect(ok.closed).toBe(false);
    expect(server.sink).not.toBeNull(); // wired as the active host
  });

  it("with no verifyMachineKey configured, accepts (unit-test convenience)", () => {
    const server = fakeServer();
    const { wss, connect } = fakeWss();
    const cs = new WsControlServer({ server: server as never, port: 0, webSocketServerFactory: () => wss });
    cs.start();
    const s = new FakeSocket();
    connect(s, { authHeader: undefined });
    expect(s.closed).toBe(false);
  });
});

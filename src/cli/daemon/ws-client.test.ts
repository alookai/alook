import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DaemonWsClient } from "./ws-client.js";

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  url: string;
  send = vi.fn();

  constructor(url: string) {
    super();
    this.url = url;
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  simulateOpen() {
    this.dispatchEvent(new Event("open"));
  }

  simulateMessage(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof DaemonWsClient>[0]> = {}) {
  return new DaemonWsClient({
    serverURL: "https://alook.ai",
    daemonId: "my-host",
    machineToken: "al_test123",
    onMessage: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    ...overrides,
  });
}

describe("DaemonWsClient", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  it("constructs production URL correctly", () => {
    const client = makeClient();
    expect(client.getUrl()).toBe("wss://alook.ai/api/ws/daemon?daemonId=my-host");
  });

  it("constructs local development URL correctly", () => {
    const client = makeClient({ serverURL: "http://localhost:3000" });
    expect(client.getUrl()).toBe("ws://localhost:8789/?daemonId=my-host");
  });

  it("reports disconnected initially", () => {
    const client = makeClient();
    expect(client.isConnected()).toBe(false);
  });

  it("sends auth message on open", () => {
    const client = makeClient();
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "auth",
      machineToken: "al_test123",
      daemonId: "my-host",
    }));
  });

  it("sets connected=true and calls onConnected after auth.ok", () => {
    const onConnected = vi.fn();
    const client = makeClient({ onConnected });
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "auth.ok" }));

    expect(client.isConnected()).toBe(true);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("validates messages with DaemonPushMessageSchema — valid message calls onMessage", () => {
    const onMessage = vi.fn();
    const client = makeClient({ onMessage });
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "auth.ok" }));
    ws.simulateMessage(JSON.stringify({ type: "daemon.rescan" }));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "daemon.rescan" });
  });

  it("invalid message (bad schema) does not call onMessage", () => {
    const onMessage = vi.fn();
    const client = makeClient({ onMessage });
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "auth.ok" }));
    ws.simulateMessage(JSON.stringify({ type: "unknown.garbage", foo: "bar" }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("schedules reconnect on close (verify reconnectTimer is set)", () => {
    const client = makeClient();
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();
    ws.simulateClose();

    expect((client as any).reconnectTimer).not.toBeNull();
  });

  it("does not reconnect after close() is called", () => {
    const client = makeClient();
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();

    client.close();

    expect((client as any).reconnectTimer).toBeNull();
    expect((client as any).closed).toBe(true);
  });

  it("liveness timeout triggers ws.close() if no messages received", () => {
    const client = makeClient();
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();

    const closeSpy = vi.spyOn(ws, "close");
    vi.advanceTimersByTime(55_000);

    expect(closeSpy).toHaveBeenCalled();
  });

  it("calls onDisconnected when connection drops after being authenticated", () => {
    const onDisconnected = vi.fn();
    const client = makeClient({ onDisconnected });
    client.connect();

    const ws = (client as any).ws as MockWebSocket;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "auth.ok" }));

    expect(client.isConnected()).toBe(true);
    ws.simulateClose();

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });
});

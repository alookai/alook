import { describe, it, expect, vi } from "vitest";
import { createDaemon } from "./createDaemon";
import type { Driver } from "../types";

class FakeSocket {
  url: string;
  headers: Record<string, string>;
  sent: string[] = [];
  private handlers: Record<string, ((...a: any[]) => void)[]> = {};
  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }
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
  emit(event: string, arg?: unknown): void {
    (this.handlers[event] ?? []).forEach((h) => h(arg));
  }
}

const fakeDriver: Driver = {
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
} as unknown as Driver;

function factory(sockets: FakeSocket[]) {
  return (url: string, headers: Record<string, string>) => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    return s;
  };
}

describe("createDaemon", () => {
  it("dials the WS control plane with Authorization: Bearer <machineKey>", async () => {
    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_abc123",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://example/control",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
    });
    expect(sockets.length).toBe(1);
    // No URL-token path anymore — the credential travels only in the header.
    expect(sockets[0].url).toBe("ws://example/control");
    expect(sockets[0].headers.Authorization).toBe("Bearer cmk_abc123");
    await daemon.stop();
  });

  it("includes hostname/os/arch/daemonVersion in the ready frame", async () => {
    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_zzz",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      hostname: "my-mac",
      platform: "darwin",
      arch: "arm64",
      daemonVersion: "1.2.3",
      osRelease: "23.0.0",
    });
    sockets[0].emit("open");
    const ready = sockets[0].sent
      .map((s) => JSON.parse(s))
      .find((f: any) => f.type === "ready");
    expect(ready).toBeDefined();
    // Fields are spread FLAT into the frame so it validates against
    // HostReadyMessageSchema in @alook/shared (see WsControlChannel).
    expect(ready).toMatchObject({
      type: "ready",
      hostname: "my-mac",
      platform: "darwin",
      arch: "arm64",
      daemonVersion: "1.2.3",
      osRelease: "23.0.0",
    });
    await daemon.stop();
  });

  it("exposes a non-empty credential proxy URL (proxy is always started)", async () => {
    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_x",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
    });
    expect(daemon.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    await daemon.stop();
  });
});

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

describe("createDaemon — community mode (no server-url)", () => {
  it("appends ?token=<machineKey> to the WS URL when serverUrl is absent", async () => {
    const sockets: FakeSocket[] = [];
    const factory = (url: string, headers: Record<string, string>) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    };
    const daemon = await createDaemon({
      machineKey: "cmt_abc123",
      serverWsUrl: "ws://example/community-daemon",
      webSocketFactory: factory as any,
      runtimes: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      hostname: "my-mac",
      os: "darwin",
      arch: "arm64",
      daemonVersion: "0.0.1",
    });
    expect(sockets.length).toBe(1);
    expect(sockets[0].url).toBe("ws://example/community-daemon?token=cmt_abc123");
    // No Authorization header in community mode (token is in URL).
    expect(sockets[0].headers).toEqual({});
    await daemon.stop();
  });

  it("includes hostname/os/arch/daemonVersion in the ready frame", async () => {
    const sockets: FakeSocket[] = [];
    const factory = (url: string, headers: Record<string, string>) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    };
    const daemon = await createDaemon({
      machineKey: "cmt_zzz",
      serverWsUrl: "ws://x",
      webSocketFactory: factory as any,
      runtimes: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      hostname: "my-mac",
      os: "darwin",
      arch: "arm64",
      daemonVersion: "1.2.3",
      osRelease: "23.0.0",
    });
    sockets[0].emit("open");
    const ready = sockets[0].sent
      .map((s) => JSON.parse(s))
      .find((f: any) => f.type === "ready");
    expect(ready).toBeDefined();
    expect(ready.ready).toMatchObject({
      hostname: "my-mac",
      os: "darwin",
      arch: "arm64",
      daemonVersion: "1.2.3",
      osRelease: "23.0.0",
    });
    await daemon.stop();
  });

  it("returns an empty proxyUrl when there's no credential proxy", async () => {
    const sockets: FakeSocket[] = [];
    const factory = (url: string, headers: Record<string, string>) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    };
    const daemon = await createDaemon({
      machineKey: "cmt_x",
      serverWsUrl: "ws://x",
      webSocketFactory: factory as any,
      runtimes: [],
      driverFor: () => fakeDriver,
      capabilities: [],
    });
    expect(daemon.proxyUrl).toBe("");
    await daemon.stop();
  });
});

describe("createDaemon — alook mode (with server-url)", () => {
  it("uses Authorization header and does NOT append ?token=", async () => {
    const sockets: FakeSocket[] = [];
    const factory = (url: string, headers: Record<string, string>) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    };
    // serverUrl present but no real fetch — the channel.connect() must not need it.
    const daemon = await createDaemon({
      machineKey: "al_key",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://example/control",
      webSocketFactory: factory as any,
      runtimes: ["mock"],
      driverFor: () => fakeDriver,
      capabilities: [],
    });
    expect(sockets[0].url).toBe("ws://example/control");
    expect(sockets[0].headers.Authorization).toBe("Bearer al_key");
    await daemon.stop();
  });
});

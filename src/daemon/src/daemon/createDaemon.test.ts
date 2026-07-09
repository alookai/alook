import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { createDaemon } from "./createDaemon";
import type { Driver } from "../types";
import type { Logger } from "../logger";

/** Stub logger — records calls per level, and hands out tagged children that report into the same store. */
function stubLogger(): Logger & { calls: Record<"debug" | "info" | "warn" | "error", Array<[string, string, unknown[]]>> } {
  const calls: Record<"debug" | "info" | "warn" | "error", Array<[string, string, unknown[]]>> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  function make(tag: string): Logger {
    const logger: Logger & { calls: typeof calls } = {
      calls,
      debug: (m: string, ...d: unknown[]) => calls.debug.push([tag, m, d]),
      info: (m: string, ...d: unknown[]) => calls.info.push([tag, m, d]),
      warn: (m: string, ...d: unknown[]) => calls.warn.push([tag, m, d]),
      error: (m: string, ...d: unknown[]) => calls.error.push([tag, m, d]),
      child: (childTag: string) => make(`${tag}:${childTag}`),
    };
    return logger;
  }
  return make("root") as ReturnType<typeof stubLogger>;
}

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
  ping(): void { }
  emit(event: string, arg?: unknown): void {
    (this.handlers[event] ?? []).forEach((h) => h(arg));
  }
}

const fakeDriver: Driver = {
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
} as unknown as Driver;

/** A driver complete enough for `AgentProcessManager.doSpawn` to actually spawn it. */
function fullFakeDriver(id: string): Driver {
  return {
    id,
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" } as never,
    session: { recovery: "resume_or_fresh" } as never,
    model: { detectedModelsVerifiedAs: "launchable", toLaunchSpec: () => ({ args: [] }) } as never,
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    probe: () => ({ status: "healthy" as const, version: "test" }),
    spawn: async () => {
      const proc = new EventEmitter() as unknown as { kill: () => void };
      proc.kill = () => { };
      return { process: proc as never };
    },
    parseLine: () => [],
    encodeStdinMessage: () => null,
    buildSystemPrompt: () => "",
  } as unknown as Driver;
}

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

describe("createDaemon — logging", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("threads the shared logger into WsControlChannel/AgentRouter/AgentProcessManager, and logs bot:removed + a successful wake through the manager", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_1" }), { status: 200 });
      }
      // Bots warmup — no bots needed, this test seeds botsById directly via bot:added.
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_log",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      capabilities: [],
      logger,
    });
    sockets[0].emit("open");
    // ws-tagged log proves the channel got `.child("ws")`.
    expect(logger.calls.info.some(([tag, m]) => tag.includes("ws") && m === "control channel open")).toBe(true);

    sockets[0].emit(
      "message",
      JSON.stringify({ type: "bot:added", botId: "bot_1", name: "Bot One", discriminator: "4821" }),
    );
    // bot:added is logged directly on the root logger (createDaemon's own tag).
    expect(logger.calls.debug.some(([, m]) => m === "bot:added")).toBe(true);

    sockets[0].emit(
      "message",
      JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "l1",
        unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // router-tagged log proves AgentRouter got `.child("router")`.
    expect(logger.calls.info.some(([tag, m]) => tag.includes("router") && m === "agent:wake received")).toBe(true);
    // manager-tagged log proves AgentProcessManager got `.child("manager")`.
    expect(logger.calls.info.some(([tag, m]) => tag.includes("manager") && m === "spawning agent")).toBe(true);

    sockets[0].emit("message", JSON.stringify({ type: "bot:removed", botId: "bot_1" }));
    expect(logger.calls.debug.some(([, m]) => m === "bot:removed")).toBe(true);

    await daemon.stop();
  });

  it("baseContextFor builds config.agentHandle from the botsById cache's name+discriminator, and bot:updated refreshes it", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const seenConfigs: Array<{ agentName?: string; agentHandle?: string }> = [];
    const driver: Driver = {
      ...fullFakeDriver("codex"),
      buildSystemPrompt: (config: { agentName?: string; agentHandle?: string }) => {
        seenConfigs.push(config);
        return "";
      },
    } as unknown as Driver;

    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_handle",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => driver,
      capabilities: [],
    });
    sockets[0].emit("open");
    // Let cold-start warmup's async fetch (bots: []) settle first — it
    // `botsById.clear()`s on resolve, which would otherwise wipe out the
    // bot:added entry below if it lands first.
    await new Promise((r) => setTimeout(r, 20));

    sockets[0].emit(
      "message",
      JSON.stringify({ type: "bot:added", botId: "bot_1", name: "Bot One", discriminator: "4821" }),
    );
    sockets[0].emit(
      "message",
      JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "l1",
        unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(seenConfigs).toContainEqual(
      expect.objectContaining({ agentName: "Bot One", agentHandle: "@Bot One#4821" }),
    );

    // A second bot, added then immediately corrected via bot:updated BEFORE
    // its first spawn — proves bot:updated's discriminator/name land in the
    // cache the next spawn reads from (not just bot:added's).
    sockets[0].emit(
      "message",
      JSON.stringify({ type: "bot:added", botId: "bot_2", name: "Wrong Name", discriminator: "0000" }),
    );
    sockets[0].emit(
      "message",
      JSON.stringify({ type: "bot:updated", botId: "bot_2", name: "Bot Two", discriminator: "1111" }),
    );
    sockets[0].emit(
      "message",
      JSON.stringify({
        type: "agent:wake",
        agentId: "bot_2",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "l2",
        unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 2 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(seenConfigs).toContainEqual(
      expect.objectContaining({ agentName: "Bot Two", agentHandle: "@Bot Two#1111" }),
    );

    await daemon.stop();
  });

  it("logs cold-start warmup success with the bot count", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ bots: [{ id: "b1", name: "n" }] }), { status: 200 })) as unknown as typeof fetch;

    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_warmup_ok",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      logger,
    });
    sockets[0].emit("open");
    await new Promise((r) => setTimeout(r, 20));

    expect(
      logger.calls.info.some(([, m, d]) => m === "cold-start bot-cache warmup succeeded" && (d[0] as any).bots === 1),
    ).toBe(true);
    await daemon.stop();
  });

  it("logs enrollAgent's failure branch (bot known, enroll HTTP call fails)", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ error: "server exploded" }), { status: 500 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_enroll_fail",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      capabilities: [],
      logger,
    });
    sockets[0].emit("open");
    sockets[0].emit("message", JSON.stringify({ type: "bot:added", botId: "bot_1", name: "Bot One" }));
    sockets[0].emit(
      "message",
      JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "l1",
        unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(
      logger.calls.warn.some(([, m, d]) => m === "agent enroll failed" && (d[0] as any).agentId === "bot_1"),
    ).toBe(true);
    await daemon.stop();
  });

  it("calls resync-wakes with the machine key bearer on open and logs the woken count", async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/resync-wakes")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer cmk_resync");
        return new Response(JSON.stringify({ woken: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_resync",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      logger,
    });
    sockets[0].emit("open");
    await new Promise((r) => setTimeout(r, 20));

    expect(
      logger.calls.info.some(([, m, d]) => m === "wake resync completed" && (d[0] as any).woken === 2),
    ).toBe(true);
    await daemon.stop();
  });

  it("logs (never throws) when resync-wakes fails", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/resync-wakes")) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_resync_fail",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      logger,
    });
    sockets[0].emit("open");
    await new Promise((r) => setTimeout(r, 20));

    expect(logger.calls.warn.some(([, m]) => m === "wake resync failed")).toBe(true);
    await daemon.stop();
  });
});

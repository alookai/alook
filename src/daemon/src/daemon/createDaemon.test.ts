import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDaemon,
  createRuntimeRawLineTap,
  deriveAuditLogSubcommand,
  emitImplicitTypingStopOnSend,
  parseRuntimeRawTraceAgentIds,
} from "./createDaemon";
import { AgentRouter } from "../manager/agentRouter";
import type { Driver } from "../types";
import type { Logger } from "../logger";

const timelineSweepHarness = vi.hoisted(() => {
  let implementation: (workingDirectoryBase: string) => Promise<unknown> =
    () => new Promise(() => {});
  const calls: string[] = [];
  return {
    calls,
    run: (workingDirectoryBase: string) => {
      calls.push(workingDirectoryBase);
      return implementation(workingDirectoryBase);
    },
    setImplementation: (next: (workingDirectoryBase: string) => Promise<unknown>) => {
      implementation = next;
    },
    reset: () => {
      calls.splice(0);
      implementation = () => new Promise(() => {});
    },
  };
});

vi.mock("../timeline/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../timeline/index.js")>();
  return {
    ...actual,
    sweepTimelineHistory: (workingDirectoryBase: string) => timelineSweepHarness.run(workingDirectoryBase),
  };
});

const startupSweepDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  timelineSweepHarness.reset();
  for (const dir of startupSweepDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spyOnRouterCommandEntry() {
  return vi.spyOn(
    AgentRouter.prototype as unknown as { onCommand(command: unknown): Promise<void> },
    "onCommand",
  );
}

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
  it("supplies only the canonical default FSM snapshot source and status path", async () => {
    const sockets: FakeSocket[] = [];
    const root = mkdtempSync(join(tmpdir(), "daemon-diagnostic-sources-"));
    startupSweepDirs.push(root);
    const onDiagnosticSources = vi.fn();
    vi.stubEnv("ALOOK_FSM_TRACE", "");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ bots: [] })));

    const daemon = await createDaemon({
      machineKey: "cmk_diagnostics_sources",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      fsmTraceDir: root,
      statusFilePath: join(root, "status.json"),
      onDiagnosticSources,
    } as Parameters<typeof createDaemon>[0]);

    try {
      expect(onDiagnosticSources).toHaveBeenCalledOnce();
      const sources = onDiagnosticSources.mock.calls[0]![0] as Record<string, unknown>;
      expect(Object.keys(sources).sort()).toEqual(["fsmTraceSource", "statusFilePath"]);
      expect(sources.statusFilePath).toBe(join(root, "status.json"));
      expect(sources.fsmTraceSource).toEqual(expect.objectContaining({
        openSnapshot: expect.any(Function),
      }));
    } finally {
      await daemon.stop();
    }
  });

  it("consumes diagnostics before Router and invokes the injected handler once", async () => {
    const sockets: FakeSocket[] = [];
    const routerEntry = spyOnRouterCommandEntry();
    const handleDiagnosticCommand = vi.fn(async () => {});
    const reportDiagnosticFailure = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/community/daemon/bots")) {
        return Response.json({
          bots: [{ id: "bot_1", name: "Bot", discriminator: "0001" }],
        });
      }
      return Response.json({ woken: 0 });
    }));
    const daemon = await createDaemon({
      machineKey: "cmk_diagnostics",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      handleDiagnosticCommand,
      reportDiagnosticFailure,
    } as Parameters<typeof createDaemon>[0]);
    sockets[0].emit("open");
    const command = {
      type: "diagnostics:collect",
      reportId: "dbr_0123456789abcdef",
      agentId: "bot_1",
      fromMs: 1_700_000_000_000,
      deadlineAt: 1_700_087_000_000,
    };

    sockets[0].emit("message", JSON.stringify(command));

    await vi.waitFor(() => expect(handleDiagnosticCommand).toHaveBeenCalledOnce());
    expect(handleDiagnosticCommand).toHaveBeenCalledWith(command);
    expect(reportDiagnosticFailure).not.toHaveBeenCalled();
    expect(routerEntry).not.toHaveBeenCalledWith(command);
    expect(fakeDriver.start).not.toHaveBeenCalled();
    expect(fakeDriver.stop).not.toHaveBeenCalled();
    await daemon.stop();
  });

  it.each([
    ["missing", undefined],
    ["sync throw", vi.fn(() => { throw new Error("private sync detail"); })],
    ["async reject", vi.fn(async () => { throw new Error("private async detail"); })],
  ])("keeps %s diagnostics handler failure out of Router/Manager/FSM", async (_label, handler) => {
    const sockets: FakeSocket[] = [];
    const routerEntry = spyOnRouterCommandEntry();
    const reportDiagnosticFailure = vi.fn(async () => {});
    const startCalls = (fakeDriver.start as ReturnType<typeof vi.fn>).mock.calls.length;
    const stopCalls = (fakeDriver.stop as ReturnType<typeof vi.fn>).mock.calls.length;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("/api/community/daemon/bots")
        ? Response.json({ bots: [{ id: "bot_1", name: "Bot", discriminator: "0001" }] })
        : Response.json({ woken: 0 });
    }));
    const daemon = await createDaemon({
      machineKey: "cmk_diagnostics_failure",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      handleDiagnosticCommand: handler,
      reportDiagnosticFailure,
    } as Parameters<typeof createDaemon>[0]);
    sockets[0].emit("open");

    sockets[0].emit("message", JSON.stringify({
      type: "diagnostics:collect",
      reportId: "dbr_0123456789abcdef",
      agentId: "bot_1",
      fromMs: 1_700_000_000_000,
      deadlineAt: 1_700_087_000_000,
    }));

    await vi.waitFor(() => expect(reportDiagnosticFailure).toHaveBeenCalledOnce());
    expect(reportDiagnosticFailure).toHaveBeenCalledWith({
      reportId: "dbr_0123456789abcdef",
      failureCode: "diagnostics_unavailable",
    });
    expect(JSON.stringify(reportDiagnosticFailure.mock.calls)).not.toMatch(/private|detail/);
    expect(routerEntry).not.toHaveBeenCalledWith(expect.objectContaining({ type: "diagnostics:collect" }));
    expect((fakeDriver.start as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(startCalls);
    expect((fakeDriver.stop as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(stopCalls);
    await daemon.stop();
  });

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

  it("starts the timeline sweep immediately without awaiting its completion", async () => {
    const sockets: FakeSocket[] = [];
    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "timeline-startup-"));
    startupSweepDirs.push(workingDirectoryBase);
    let resolveSweep!: () => void;
    timelineSweepHarness.setImplementation(() => new Promise<void>((resolve) => { resolveSweep = resolve; }));

    const daemonPromise = createDaemon({
      machineKey: "cmk_sweep",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      workingDirectoryBase,
    });

    expect(timelineSweepHarness.calls).toEqual([workingDirectoryBase]);
    const daemon = await daemonPromise;
    expect(timelineSweepHarness.calls).toEqual([workingDirectoryBase]);
    resolveSweep();
    await daemon.stop();
  });

  it("observes a rejected timeline sweep with one static safe warning and still becomes ready", async () => {
    const sockets: FakeSocket[] = [];
    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "timeline-startup-"));
    startupSweepDirs.push(workingDirectoryBase);
    const logger = stubLogger();
    timelineSweepHarness.setImplementation(() => Promise.reject(
      new Error(`private failure at ${workingDirectoryBase}/agent-secret`),
    ));

    const daemon = await createDaemon({
      machineKey: "cmk_sweep_reject",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      workingDirectoryBase,
      logger,
    });
    await vi.waitFor(() => {
      expect(logger.calls.warn.filter(([, message]) => message === "timeline startup sweep failed")).toHaveLength(1);
    });
    const warning = logger.calls.warn.find(([, message]) => message === "timeline startup sweep failed");
    expect(warning).toEqual(["root", "timeline startup sweep failed", []]);
    expect(JSON.stringify(warning)).not.toContain(workingDirectoryBase);
    expect(JSON.stringify(warning)).not.toContain("private failure");

    sockets[0].emit("open");
    expect(sockets[0].sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "ready")).toBe(true);
    await daemon.stop();
  });
});

describe("createDaemon — opt-in raw runtime trace (P0-1)", () => {
  const dirs: string[] = [];
  const expectSecureMode = (path: string) => {
    if (process.platform === "win32") return;
    expect(statSync(path).mode & 0o777).toBe(0o600);
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("parses only explicit comma-separated agent ids and rejects the all-agents wildcard", () => {
    expect([...parseRuntimeRawTraceAgentIds(" agent_a,agent_b,agent_a,*, ")]).toEqual([
      "agent_a",
      "agent_b",
    ]);
    expect(parseRuntimeRawTraceAgentIds(undefined).size).toBe(0);
  });

  it("stays disabled without both a trace directory and an explicit agent", () => {
    const logger = stubLogger();
    expect(createRuntimeRawLineTap({ traceDir: "/tmp/no-create", enabledAgentIds: new Set(), logger })).toBeUndefined();
    expect(createRuntimeRawLineTap({ enabledAgentIds: new Set(["a1"]), logger })).toBeUndefined();
  });

  it("writes only selected agents, preserves raw lines, and encodes the agent filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-raw-trace-"));
    dirs.push(dir);
    const selectedAgent = "../agent_a";
    const tap = createRuntimeRawLineTap({
      traceDir: dir,
      enabledAgentIds: new Set([selectedAgent]),
      logger: stubLogger(),
    });
    expect(tap).toBeDefined();

    tap?.("agent_b", '{"ignored":true}');
    tap?.(selectedAgent, '{"jsonrpc":"2.0","vendor":"kept"}');

    const path = join(dir, "runtime-raw-events-%2E%2E%2Fagent_a.jsonl");
    expect(readFileSync(path, "utf8")).toBe('{"jsonrpc":"2.0","vendor":"kept"}\n');
    expectSecureMode(path);
    expect(existsSync(join(dir, "runtime-raw-events-agent_b.jsonl"))).toBe(false);
  });

  it("rotates each selected agent independently and keeps both generations at 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-raw-trace-"));
    dirs.push(dir);
    const tap = createRuntimeRawLineTap({
      traceDir: dir,
      enabledAgentIds: new Set(["a1", "a2"]),
      logger: stubLogger(),
      maxBytes: 20,
    });
    tap?.("a1", "x".repeat(19));
    tap?.("a1", "latest-a1");
    tap?.("a2", "only-a2");

    const a1 = join(dir, "runtime-raw-events-a1.jsonl");
    const a2 = join(dir, "runtime-raw-events-a2.jsonl");
    expect(readFileSync(a1, "utf8")).toBe("latest-a1\n");
    expect(existsSync(`${a1}.1`)).toBe(true);
    expect(readFileSync(a2, "utf8")).toBe("only-a2\n");
    for (const path of [a1, `${a1}.1`, a2]) {
      expectSecureMode(path);
      expect(statSync(path).size).toBeLessThanOrEqual(20);
    }
  });

  it("drops an oversized multibyte line, warns once, and keeps the file hard-capped", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-raw-trace-"));
    dirs.push(dir);
    const logger = stubLogger();
    const tap = createRuntimeRawLineTap({
      traceDir: dir,
      enabledAgentIds: new Set(["a1"]),
      logger,
      maxBytes: 6,
    });

    tap?.("a1", "ééé");
    tap?.("a1", "ééé");
    tap?.("a1", "ok");

    const path = join(dir, "runtime-raw-events-a1.jsonl");
    expect(readFileSync(path, "utf8")).toBe("ok\n");
    expect(statSync(path).size).toBeLessThanOrEqual(6);
    expect(logger.calls.warn.filter(([, message]) => message === "runtime raw trace sink failed")).toHaveLength(1);
  });

  it("warns once per agent when the sink is unwritable and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-raw-trace-"));
    dirs.push(dir);
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const logger = stubLogger();
    const tap = createRuntimeRawLineTap({
      traceDir: blocker,
      enabledAgentIds: new Set(["a1"]),
      logger,
    });

    expect(() => {
      tap?.("a1", "one");
      tap?.("a1", "two");
    }).not.toThrow();
    expect(logger.calls.warn.filter(([, message]) => message === "runtime raw trace sink failed")).toHaveLength(1);
  });
});

describe("createDaemon — logging", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("asks a woken agent to read unread messages without requiring a reply", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    let spawnedPrompt = "";
    const driver: Driver = {
      ...fullFakeDriver("codex"),
      spawn: async (ctx) => {
        spawnedPrompt = ctx.prompt;
        const proc = new EventEmitter() as unknown as { kill: () => void };
        proc.kill = () => { };
        return { process: proc as never };
      },
    } as unknown as Driver;

    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_wake_prompt",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => driver,
      capabilities: [],
    });
    sockets[0].emit("open");
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
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnedPrompt).toContain("Use `alook inbox pull` to read your messages.");
    expect(spawnedPrompt).not.toContain("message send");

    await daemon.stop();
  });

  it("retries a later wake after handshake_timeout instead of globally disabling the runtime", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_retry" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const spawn = vi.fn(async () => {
      const proc = new EventEmitter() as unknown as { kill: () => void };
      proc.kill = () => {};
      return { process: proc as never };
    });
    const driver = {
      ...fullFakeDriver("cursor"),
      spawn,
    } as unknown as Driver;
    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_handshake_retry",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "cursor" }],
      driverFor: () => driver,
      capabilities: [],
      handshakeTimeoutMs: 10,
      logger,
    });

    try {
      sockets[0].emit("open");
      await new Promise((resolve) => setTimeout(resolve, 20));
      sockets[0].emit(
        "message",
        JSON.stringify({ type: "bot:added", botId: "bot_retry", name: "Retry Bot", discriminator: "0001" }),
      );
      const wake = (launchId: string, latestSeq: number) =>
        sockets[0].emit(
          "message",
          JSON.stringify({
            type: "agent:wake",
            agentId: "bot_retry",
            config: { version: 1, runtime: "cursor", model: { kind: "default" }, mode: { kind: "default" } },
            launchId,
            unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq },
          }),
        );

      wake("launch_1", 1);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(
          logger.calls.warn.some(
            ([, message, detail]) =>
              message === "spawn failed" && (detail[0] as { reason?: string })?.reason === "handshake_timeout",
          ),
        ).toBe(true),
      );

      wake("launch_2", 2);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      expect(logger.calls.warn.some(([, message]) => message === "runtime marked unhealthy")).toBe(false);
      expect(
        logger.calls.info.some(
          ([, message, detail]) =>
            message === "agent:wake ack" &&
            (detail[0] as { status?: string; "error.code"?: string })?.["error.code"] === "bot_runtime_missing",
        ),
      ).toBe(false);
    } finally {
      await daemon.stop();
    }
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
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
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
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
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
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 2 },
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
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(
      logger.calls.warn.some(([, m, d]) => m === "agent enroll failed" && (d[0] as any).agentId === "bot_1"),
    ).toBe(true);
    await daemon.stop();
  });

  it("preserves status and bounded text when enroll-agent returns a non-JSON error", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/enroll-agent")) {
        return new Response("upstream overloaded", { status: 503 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_enroll_text_error",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      capabilities: [],
      logger,
    });
    sockets[0].emit("open");
    sockets[0].emit("message", JSON.stringify({ type: "bot:added", botId: "bot_text", name: "Bot Text" }));
    sockets[0].emit(
      "message",
      JSON.stringify({
        type: "agent:wake",
        agentId: "bot_text",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "l_text",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(
      logger.calls.warn.some(([, m, d]) => {
        const err = String((d[0] as any).err);
        return m === "agent enroll failed" && err.includes("503") && err.includes("upstream overloaded");
      }),
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

describe("createDaemon — level-triggered activity heartbeat (2b: live-connection self-heal)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("re-asserts a running agent's current activity every heartbeat with NO intervening transition — recovery path for a dropped frame on a live socket", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) return new Response(JSON.stringify({ runnerKey: "rk_1" }), { status: 200 });
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    // A persistent, stdin-capable driver stays `running` after session_init
    // without emitting turn_end — so the agent sits in a STEADY working state,
    // which is exactly the window 2b exercises.
    const emitters: Array<EventEmitter> = [];
    const persistentDriver = {
      id: "codex",
      lifecycle: { kind: "persistent", start: "immediate", exit: "natural", inFlightWake: "queue" } as never,
      session: { recovery: "resume_or_fresh" } as never,
      model: { detectedModelsVerifiedAs: "launchable", toLaunchSpec: () => ({ args: [] }) } as never,
      supportsStdinNotification: true,
      busyDeliveryMode: "direct",
      probe: () => ({ status: "healthy" as const, version: "test" }),
      spawn: async () => {
        const proc = new EventEmitter() as unknown as { kill: () => void; stdin: unknown };
        (proc as unknown as { kill: () => void }).kill = () => {};
        emitters.push(proc as unknown as EventEmitter);
        return { process: proc as never };
      },
      parseLine: () => [],
      encodeStdinMessage: () => null,
      buildSystemPrompt: () => "",
    } as unknown as Driver;

    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_hb",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => persistentDriver,
      capabilities: [],
      tickIntervalMs: 1_000_000, // park the stall/hibernation loop out of the way
    });
    sockets[0].emit("open");
    sockets[0].emit("message", JSON.stringify({ type: "bot:added", botId: "bot_1", name: "Bot One", discriminator: "4821" }));
    sockets[0].emit(
      "message",
      JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "l1",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }),
    );
    // Let enroll + spawn resolve, then land the runtime handshake so the FSM
    // reaches `running` (turnActive) — a steady working state.
    await vi.advanceTimersByTimeAsync(50);
    expect(emitters.length).toBeGreaterThan(0);
    emitters[0].emit("runtime_event", { kind: "session_init", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(1);

    const activityFrames = () =>
      sockets[0].sent.map((s) => JSON.parse(s)).filter((f: any) => f.type === "agent_activity");
    const beforeCount = activityFrames().length;
    expect(beforeCount).toBeGreaterThan(0); // the edge transition to running fired

    // Advance ONE heartbeat with no further runtime events → the level-triggered
    // re-assert must emit another running frame despite zero transitions.
    await vi.advanceTimersByTimeAsync(5_000);
    const after = activityFrames();
    expect(after.length).toBeGreaterThan(beforeCount);
    expect(after.at(-1)).toMatchObject({ type: "agent_activity", agentId: "bot_1", state: "running" });

    await daemon.stop();
  });
});

describe("deriveAuditLogSubcommand", () => {
  it("does not normalize deleted flat or legacy-agent inputs", () => {
    expect(deriveAuditLogSubcommand("/api/send")).toBe(null);
    expect(deriveAuditLogSubcommand("/api/attachmentUpload?target=/x/y")).toBe(null);
    expect(deriveAuditLogSubcommand("/api/community/send")).toBe(null);
    expect(deriveAuditLogSubcommand("/api/community/agent/send")).toBe(null);
    expect(deriveAuditLogSubcommand("/api/ack")).toBe(null);
    expect(deriveAuditLogSubcommand("/api/community/agent/ack")).toBe(null);
  });

  it("returns null for non-/api pathnames", () => {
    expect(deriveAuditLogSubcommand("/health")).toBe(null);
    expect(deriveAuditLogSubcommand("/")).toBe(null);
  });

  it("maps the canonical id-in-path door shapes back to the logical verb (route/disc retarget)", () => {
    // Without this, slicing the first segment would log the DOOR (`channels` /
    // `messages`), losing which action the bot invoked in the cli_invocation row.
    // Messages door is dual-verb — method disambiguates read vs send.
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/messages", "POST")).toBe("send");
    expect(deriveAuditLogSubcommand("/api/community/channels/abc123/messages", "POST")).toBe("send");
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/messages", "GET")).toBe("read");
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/messages?ref=%2Fs%2Fg", "GET")).toBe("read");
    // message-keyed write doors.
    expect(deriveAuditLogSubcommand("/api/community/messages/resolve/reactions/%F0%9F%91%8D", "PUT")).toBe("reactAdd");
    expect(deriveAuditLogSubcommand("/api/community/messages/resolve/marks", "PUT")).toBe("markSet");
    expect(deriveAuditLogSubcommand("/api/community/messages/resolve/marks", "DELETE")).toBe("markRemove");
    expect(deriveAuditLogSubcommand("/api/community/users/me/marks", "GET")).toBe("markList");
    expect(deriveAuditLogSubcommand("/api/community/messages/m1/marks", "GET")).toBe(null);
    // seq→id lookup (folded resolve).
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/messages/seq/42", "GET")).toBe("resolve");
    // single-message hydrate door GET messages/{id} = the folded `resolve` verb.
    expect(deriveAuditLogSubcommand("/api/community/messages/resolve?ref=%2Fs%2Fg&seq=42", "GET")).toBe("resolve");
    expect(deriveAuditLogSubcommand("/api/community/messages/m1", "GET")).toBe("resolve");
    // hydrate door must not shadow the write sub-paths.
    expect(deriveAuditLogSubcommand("/api/community/messages/m1/reactions/x", "PUT")).toBe("reactAdd");
    // members door (folded channelMember).
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/members?ref=%2Fs%2Fg", "GET")).toBe("channelMember");
    expect(deriveAuditLogSubcommand("/api/community/channels/c1/members", "GET")).toBe("channelMember");
    // server-scoped list doors (轴3 fold): servers/{id}/members = listMembers;
    // servers/{id}/channels + servers/channels (all-servers collection) = listChannels.
    expect(deriveAuditLogSubcommand("/api/community/servers/resolve/members?server=studio", "GET")).toBe("listMembers");
    expect(deriveAuditLogSubcommand("/api/community/servers/srv_1/members", "GET")).toBe("listMembers");
    expect(deriveAuditLogSubcommand("/api/community/servers/resolve/channels?server=studio", "GET")).toBe("listChannels");
    expect(deriveAuditLogSubcommand("/api/community/servers/srv_1/channels", "GET")).toBe("listChannels");
    expect(deriveAuditLogSubcommand("/api/community/servers/channels", "GET")).toBe("listChannels");
    // friends bucket doors (轴3 fold): accepted + pending map back to listFriends
    // (the bot's `alook friend list` fans out to both). blocked is bot-403 → not mapped.
    expect(deriveAuditLogSubcommand("/api/community/friends/accepted", "GET")).toBe("listFriends");
    expect(deriveAuditLogSubcommand("/api/community/friends/pending", "GET")).toBe("listFriends");
    // friend-request door (friendRequest fold): POST friends/request maps back to
    // `friendRequest`, not the `friends` segment (audit is daemon/proxy = bot path).
    expect(deriveAuditLogSubcommand("/api/community/friends/request", "POST")).toBe("friendRequest");
    // inbox bucket doors (轴3 fold): users/me/inbox/{pull,snapshot} map back to
    // the logical verb, not the `users` segment.
    expect(deriveAuditLogSubcommand("/api/community/users/me/inbox/pull", "POST")).toBe("inboxPull");
    expect(deriveAuditLogSubcommand("/api/community/users/me/inbox/snapshot", "GET")).toBe("inboxSnapshot");
    // ack is the advance op of the trinity but writes NO audit row here (re-homed
    // to the daemon reborn-ready signal) — null, same as flat /ack, NOT `users`.
    expect(deriveAuditLogSubcommand("/api/community/users/me/inbox/ack", "POST")).toBe(null);
    // bot-self lifecycle door (bots/me/*): nap maps back to `nap`, not `bots`.
    expect(deriveAuditLogSubcommand("/api/community/bots/me/nap", "POST")).toBe("nap");
    // attachments door (attachments fold): channels/{id}/attachments = upload,
    // channels/{id}/attachments/{attachmentId} = download. Map back to the
    // logical verb, not the `channels` door segment. Download shape (has the
    // sub-segment) must win over the bare-upload shape.
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/attachments", "POST")).toBe("attachmentUpload");
    expect(deriveAuditLogSubcommand("/api/community/channels/c1/attachments", "POST")).toBe("attachmentUpload");
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/attachments?target=%2Fs%2Fg", "POST")).toBe("attachmentUpload");
    expect(deriveAuditLogSubcommand("/api/community/channels/resolve/attachments/att_1", "GET")).toBe("attachmentDownload");
    expect(deriveAuditLogSubcommand("/api/community/channels/c1/attachments/att_1", "GET")).toBe("attachmentDownload");
  });
});

describe("emitImplicitTypingStopOnSend", () => {
  const tracker = (scopes: Record<string, string[]>) => ({
    snapshot: (agentId: string) => scopes[agentId] ?? [],
  });

  it("emits an agent_typing_stop for every active DM scope when the sub is `send`", () => {
    const emitted: Array<{ agentId: string; channelId: string }> = [];
    emitImplicitTypingStopOnSend({
      subcommand: "send",
      agentId: "bot_1",
      typingTracker: tracker({ bot_1: ["dm-a", "dm-b"] }),
      reportAgentTypingStop: (info) => emitted.push(info),
    });
    expect(emitted).toEqual([
      { agentId: "bot_1", channelId: "dm-a" },
      { agentId: "bot_1", channelId: "dm-b" },
    ]);
  });

  it("no-ops when the sub is not `send`", () => {
    const emitted: unknown[] = [];
    for (const sub of ["inboxPull", "read", "listServers", "attachmentUpload"]) {
      emitImplicitTypingStopOnSend({
        subcommand: sub,
        agentId: "bot_1",
        typingTracker: tracker({ bot_1: ["dm-a"] }),
        reportAgentTypingStop: (info) => emitted.push(info),
      });
    }
    expect(emitted).toEqual([]);
  });

  it("no-ops when the tracker has no scope for this agent (never woken via DM)", () => {
    const emitted: unknown[] = [];
    emitImplicitTypingStopOnSend({
      subcommand: "send",
      agentId: "bot_1",
      typingTracker: tracker({}),
      reportAgentTypingStop: (info) => emitted.push(info),
    });
    expect(emitted).toEqual([]);
  });

  it("no-ops when the channel isn't wired for typing (defensive)", () => {
    expect(() =>
      emitImplicitTypingStopOnSend({
        subcommand: "send",
        agentId: "bot_1",
        typingTracker: tracker({ bot_1: ["dm-a"] }),
        reportAgentTypingStop: undefined,
      }),
    ).not.toThrow();
  });
});

describe("AgentProcessManager.auditContext", () => {
  // Producer B (credential-proxy sighting) reads this so `cli_invocation`
  // rows carry the same context Producer A's tool_call / thinking rows do.
  it("returns nulls before any register() / session_init", async () => {
    const { AgentProcessManager } = await import("../manager/managerRuntime");
    const mgr = new AgentProcessManager({
      driverFor: () => ({} as never),
      baseContextFor: () => ({} as never),
    });
    expect(mgr.auditContext("unknown_agent")).toEqual({ sessionId: null, launchId: null });
  });

  it("reports launchId once register() has stashed one, and sessionId once a runtime session_init has landed", async () => {
    const { AgentProcessManager } = await import("../manager/managerRuntime");
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const session = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(cb);
        listeners.set(event, arr);
      },
      start: () => new Promise<void>(() => { }),
      send: () => { },
      stop: () => { },
      get currentSessionId() { return null; },
    };
    const mgr = new AgentProcessManager({
      driverFor: () => ({
        id: "codex",
        lifecycle: { kind: "per_turn" },
        supportsStdinNotification: false,
        busyDeliveryMode: "none",
      } as never),
      baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", config: {} }) as never,
      sessionFactory: () => session as never,
    });
    mgr.register("a1", { launchId: "l_XYZ" });
    expect(mgr.auditContext("a1")).toEqual({ sessionId: null, launchId: "l_XYZ" });

    mgr.deliver("a1", { seq: 1, text: "hi" } as never);
    for (const cb of listeners.get("runtime_event") ?? []) cb({ kind: "session_init", sessionId: "s_ABC" });
    expect(mgr.auditContext("a1")).toEqual({ sessionId: "s_ABC", launchId: "l_XYZ" });
  });
});

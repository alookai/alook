import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDaemon,
  createBuiltinDaemonSessionFactory,
  createRuntimeRawLineTap,
  deriveAuditLogSubcommand,
  emitImplicitTypingStopOnSend,
  parseRuntimeRawTraceAgentIds,
} from "./createDaemon";
import {
  AgentProcessManager,
  type SessionFactory,
} from "../manager/managerRuntime";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  BuiltinBackendSpecs,
} from "@alook/agent-driver";
import { AgentRouter } from "../manager/agentRouter";
import { WsControlChannel } from "../server/wsControlChannel";
import { CredentialBroker } from "../credentials/credentialProxy";
import type { AgentBackend as Driver } from "../drivers/index.js";
import type { Logger } from "../logger";
import {
  DAEMON_SELF_SLEEP_TIMEOUT_MS,
  type DaemonSelfSleepClock,
} from "./daemonSelfSleep";
import { createTimelineRecorder } from "../timeline/index.js";

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

const credentialProxyHarness = vi.hoisted(() => ({
  onInboxPullStart: undefined as ((agentId: string) => unknown) | undefined,
  onInboxPullResponse: undefined as (
    ((agentId: string, messages: unknown[], observationToken?: unknown) => void) | undefined
  ),
  onInboxPullObservationError: undefined as ((failure: Record<string, unknown>) => void) | undefined,
}));

const timelineRecorderHarness = vi.hoisted(() => ({
  pulls: [] as Array<{ agentId: string; owner: unknown; messages: unknown[] }>,
}));

vi.mock("../timeline/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../timeline/index.js")>();
  return {
    ...actual,
    sweepTimelineHistory: (workingDirectoryBase: string) => timelineSweepHarness.run(workingDirectoryBase),
    createTimelineRecorder: (...args: Parameters<typeof actual.createTimelineRecorder>) => {
      const recorder = actual.createTimelineRecorder(...args);
      return {
        ...recorder,
        recordInboxPull(agentId: string, owner: Parameters<typeof recorder.recordInboxPull>[1], messages: Parameters<typeof recorder.recordInboxPull>[2]) {
          timelineRecorderHarness.pulls.push({ agentId, owner, messages });
          recorder.recordInboxPull(agentId, owner, messages);
        },
      };
    },
  };
});

vi.mock("../credentials/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials/index.js")>();
  return {
    ...actual,
    startCredentialProxy: (
      ...args: Parameters<typeof actual.startCredentialProxy>
    ): ReturnType<typeof actual.startCredentialProxy> => {
      credentialProxyHarness.onInboxPullStart = args[1]?.onInboxPullStart;
      credentialProxyHarness.onInboxPullResponse = args[1]?.onInboxPullResponse as
        | ((agentId: string, messages: unknown[], observationToken?: unknown) => void)
        | undefined;
      credentialProxyHarness.onInboxPullObservationError = args[1]?.onInboxPullObservationError as
        | ((failure: Record<string, unknown>) => void)
        | undefined;
      return actual.startCredentialProxy(...args);
    },
  };
});

const startupSweepDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  timelineSweepHarness.reset();
  credentialProxyHarness.onInboxPullStart = undefined;
  credentialProxyHarness.onInboxPullResponse = undefined;
  credentialProxyHarness.onInboxPullObservationError = undefined;
  timelineRecorderHarness.pulls.splice(0);
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

type DaemonTestSession = AgentSession<BuiltinBackendSpecs, "codex">;

interface DaemonFakeSession extends DaemonTestSession {
  fire(event: string, ...args: unknown[]): Promise<void>;
}

function daemonFakeSession(options: {
  onStart?: (input: { id: string; text: string }) => void;
  onSend?: (input: { id: string; text: string; sequence?: number }) => void;
  onStop?: () => void;
  establish?: boolean;
  enforceCommandIdempotency?: boolean;
} = {}): DaemonFakeSession {
  type Event = AgentEvent<BuiltinBackendSpecs, "codex">;
  let sequence = 0;
  const queued: Event[] = [];
  const waiters: Array<(value: IteratorResult<Event>) => void> = [];
  let ended = false;
  const commands = new Map<string, { method: "start" | "send"; canonical: string }>();
  let resolveClosed!: (result: AgentSessionResult) => void;
  const closed = new Promise<AgentSessionResult>((resolve) => { resolveClosed = resolve; });
  const emit = (payload: Omit<Event, "sequence" | "sessionInstanceId" | "at">) => {
    const event = { ...payload, sequence: ++sequence, sessionInstanceId: "daemon-test", at: Date.now() } as Event;
    const waiter = waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else queued.push(event);
  };
  const session: DaemonFakeSession = {
    backend: "codex",
    capabilities: {} as DaemonTestSession["capabilities"],
    sessionInstanceId: "daemon-test",
    events: {
      maxBufferedBytes: 4_194_304,
      [Symbol.asyncIterator]() {
        return {
          next: () => queued.length > 0
            ? Promise.resolve({ done: false as const, value: queued.shift()! })
            : new Promise<IteratorResult<Event>>((resolve) => waiters.push(resolve)),
        };
      },
    },
    closed,
    async start(input) {
      options.onStart?.(input);
      commands.set(input.id, { method: "start", canonical: JSON.stringify(input) });
      if (options.establish !== false) {
        await session.fire("runtime_event", { kind: "session_init", sessionId: "test-session" });
      }
      emit({ type: "command_accepted", commandId: input.id, turnId: "daemon-test-turn", delivery: "prompt" } as never);
      emit({ type: "turn_started", turnId: "daemon-test-turn", commandIds: [input.id] } as never);
      return { status: "accepted", delivery: "prompt", commandId: input.id, turnId: "daemon-test-turn" };
    },
    async send(input) {
      options.onSend?.(input);
      const canonical = JSON.stringify(input);
      const existing = commands.get(input.id);
      if (options.enforceCommandIdempotency && existing) {
        if (existing.method !== "send" || existing.canonical !== canonical) {
          return { status: "rejected", reason: "duplicate_conflict" };
        }
        return { status: "accepted", delivery: "steer", commandId: input.id, turnId: "daemon-test-turn" };
      }
      commands.set(input.id, { method: "send", canonical });
      emit({ type: "command_accepted", commandId: input.id, turnId: "daemon-test-turn", delivery: "steer" } as never);
      return { status: "accepted", delivery: "steer", commandId: input.id, turnId: "daemon-test-turn" };
    },
    async interrupt() { return { status: "not_running" }; },
    async stop() {
      options.onStop?.();
      if (!ended) {
        ended = true;
        const result: AgentSessionResult = { outcome: "stopped", requested: true, exitCode: null, signal: null, cleanup: { status: "released" } };
        resolveClosed(result);
      }
      return { status: "accepted", requestId: "daemon-test-stop" };
    },
    snapshot() {
      return { sessionInstanceId: "daemon-test", state: "working", queuedCommands: [], lastEventSequence: sequence };
    },
    async invokeExtension() {
      return { ok: false, error: { category: "internal", code: "unsupported", message: "unsupported", retryable: false } };
    },
    async fire(event, ...args) {
      if (event === "runtime_event") {
        const runtime = args[0] as { kind: string; sessionId?: string; text?: string };
        if (runtime.kind === "session_init") {
          emit({ type: "session_started", backendSessionId: runtime.sessionId ?? "test-session" } as never);
        } else if (runtime.kind === "turn_end") {
          emit({ type: "turn_completed", turnId: "daemon-test-turn", commandIds: [], result: { outcome: "success", backendSessionId: runtime.sessionId } } as never);
        } else if (runtime.kind === "text") {
          emit({ type: "assistant_message_completed", turnId: "daemon-test-turn", text: runtime.text ?? "", truncated: false } as never);
        }
      } else if (event === "agent_event") {
        emit(args[0] as never);
      } else if (event === "exit") {
        const result: AgentSessionResult = { outcome: "stopped", requested: true, exitCode: null, signal: null, cleanup: { status: "released" } };
        ended = true;
        resolveClosed(result);
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  } as DaemonFakeSession;
  return session;
}

function daemonSessionFactory(
  options: Parameters<typeof daemonFakeSession>[0] = {},
): SessionFactory {
  return () => {
    const session = daemonFakeSession(options);
    return session;
  };
}

function factory(sockets: FakeSocket[]) {
  return (url: string, headers: Record<string, string>) => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    return s;
  };
}

describe("createDaemon", () => {
  it("commits terminal usage before idle and attaches the current backend quota", async () => {
    const sockets: FakeSocket[] = [];
    const sessions: DaemonFakeSession[] = [];
    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "daemon-provider-telemetry-"));
    startupSweepDirs.push(workingDirectoryBase);
    mkdirSync(join(workingDirectoryBase, "bot_1"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/enroll-agent")) return Response.json({ runnerKey: "runner_test" });
      if (url.includes("/daemon/bots")) {
        return Response.json({ bots: [{ id: "bot_1", name: "Bot", discriminator: "0001" }] });
      }
      return Response.json({ attempted: 0 });
    }));
    const daemon = await createDaemon({
      machineKey: "cmk_telemetry",
      serverUrl: "http://server.invalid",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      sessionFactory: () => {
        const session = daemonFakeSession();
        sessions.push(session);
        return session;
      },
      capabilities: [],
      workingDirectoryBase,
    });

    try {
      sockets[0]!.emit("open");
      sockets[0]!.emit("message", JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch_1",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }));
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      await sessions[0]!.fire("agent_event", {
        type: "token_usage",
        turnId: "daemon-test-turn",
        source: "codex_thread_token_usage_updated",
        usage: {
          input: 20,
          output: 5,
          cache: null,
        },
      });
      await sessions[0]!.fire("agent_event", {
        type: "rate_limits",
        source: "codex_account_rate_limits_updated",
        quota: {
          status: "available",
          sourceEpoch: "A".repeat(22),
          freshForSeconds: 300,
          limits: [{
            bucket: {
              limitId: "codex",
              product: { kind: "reported", id: "codex", displayName: "Codex" },
              model: { kind: "not_applicable" },
              window: { kind: "rolling", durationSeconds: 18_000, displayName: "5 hour usage limit" },
            },
            usedPercent: 30,
          }],
        },
      });
      await sessions[0]!.fire("runtime_event", { kind: "turn_end", sessionId: "test-session" });

      const frames = () => sockets[0]!.sent.map((frame) => JSON.parse(frame) as any);
      expect(frames().find((frame) => frame.type === "ready")?.timeZone)
        .toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      await vi.waitFor(() => expect(frames().some((frame) =>
        frame.type === "agent_activity"
        && frame.agentId === "bot_1"
        && frame.state === "idle"
        && typeof frame.usageTimeZone === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(frame.usageDay ?? "")
        && frame.dailyUsage?.[0]?.metrics.input === 20
        && frame.quota?.observation?.limits?.[0]?.usedPercent === 30
      )).toBe(true));
      expect(existsSync(join(workingDirectoryBase, ".telemetry", "daily-token-usage.json"))).toBe(true);

      const readyBefore = frames().filter((frame) => frame.type === "ready").length;
      await sessions[0]!.fire("agent_event", {
        type: "rate_limits",
        source: "codex_account_rate_limits_updated",
        quota: {
          status: "error",
          sourceEpoch: "B".repeat(22),
          code: "unauthorized",
          retryable: false,
        },
      });
      await vi.waitFor(() => expect(frames().filter((frame) => frame.type === "ready")).toHaveLength(readyBefore + 1));
      expect(frames().filter((frame) => frame.type === "ready").at(-1)?.providerQuotas).toEqual([{
        agentBackendId: "codex",
        observation: {
          status: "error",
          sourceEpoch: "B".repeat(22),
          code: "unauthorized",
          retryable: false,
        },
      }]);
    } finally {
      await daemon.stop();
    }
  });

  it("uploads persisted Pi token usage when the bot becomes idle", async () => {
    const sockets: FakeSocket[] = [];
    const sessions: DaemonFakeSession[] = [];
    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "daemon-pi-telemetry-"));
    startupSweepDirs.push(workingDirectoryBase);
    mkdirSync(join(workingDirectoryBase, "bot_1"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/enroll-agent")) return Response.json({ runnerKey: "runner_test" });
      if (url.includes("/daemon/bots")) {
        return Response.json({ bots: [{ id: "bot_1", name: "Pi Bot", discriminator: "0001" }] });
      }
      return Response.json({ attempted: 0 });
    }));
    const daemon = await createDaemon({
      machineKey: "cmk_pi_telemetry",
      serverUrl: "http://server.invalid",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [{ id: "pi" }],
      driverFor: () => fullFakeDriver("pi"),
      sessionFactory: () => {
        const session = daemonFakeSession();
        sessions.push(session);
        return session;
      },
      capabilities: [],
      workingDirectoryBase,
    });

    try {
      sockets[0]!.emit("open");
      sockets[0]!.emit("message", JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "pi", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch_pi",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }));
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      await sessions[0]!.fire("agent_event", {
        type: "token_usage",
        turnId: "daemon-test-turn",
        source: "pi_message_end",
        usage: {
          input: 13,
          output: 5,
          cache: 7,
        },
      });
      await sessions[0]!.fire("runtime_event", { kind: "turn_end", sessionId: "test-session" });

      const frames = () => sockets[0]!.sent.map((frame) => JSON.parse(frame) as any);
      await vi.waitFor(() => expect(frames().some((frame) =>
        frame.type === "agent_activity"
        && frame.agentId === "bot_1"
        && frame.state === "idle"
        && typeof frame.usageTimeZone === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(frame.usageDay ?? "")
        && frame.dailyUsage?.[0]?.metrics.input === 13
        && frame.dailyUsage?.[0]?.metrics.output === 5
        && frame.dailyUsage?.[0]?.metrics.cache === 7
      )).toBe(true));
      expect(JSON.parse(readFileSync(
        join(workingDirectoryBase, ".telemetry", "daily-token-usage.json"),
        "utf8",
      ))).toMatchObject({
        version: 1,
        bots: {
          bot_1: [{ metrics: { input: 13, output: 5, cache: 7 } }],
        },
      });
    } finally {
      await daemon.stop();
    }
  });

  it("opens the builtin session factory and reports host preparation failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-builtin-session-"));
    try {
      const broker = new CredentialBroker({ upstreamBaseUrl: "https://upstream.test", voucherDir: dir });
      const ctx = {
        workingDirectory: dir,
        agentId: "a1",
        standingPrompt: "",
        prompt: "",
        agentCliPath: process.execPath,
        launchId: "launch-1",
        credentialProxy: {
          broker,
          proxyUrl: "http://127.0.0.1:9/proxy",
          runnerKey: "runner-test",
          capabilities: ["send"],
        },
        config: {},
      };
      const runtimeConfig = {
        version: 1 as const,
        runtime: "codex" as const,
        model: { kind: "default" as const },
        mode: { kind: "default" as const },
      };
      const session = await createBuiltinDaemonSessionFactory(vi.fn())({ agentId: "a1", ctx, runtimeConfig });
      expect(session.backend).toBe("codex");
      await session.stop({ reason: "shutdown", forceAfterMs: 10 });
      await expect(createBuiltinDaemonSessionFactory()({
        agentId: "a1",
        ctx: { ...ctx, credentialProxy: undefined },
        runtimeConfig,
      })).rejects.toMatchObject({ code: "credential_proxy_required" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts the builtin Codex lane from a fresh nested daemon workspace", async () => {
    const base = mkdtempSync(join(tmpdir(), "daemon-fresh-workspace-"));
    startupSweepDirs.push(base);
    const rawLines: string[] = [];
    const workingDirectory = join(base, "daemon", "agent-fresh");
    const fakeRuntime = join(base, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
    const fakeModule = join(base, "fake-codex.mjs");
    writeFileSync(fakeModule, `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "fresh-thread" } } });
  } else if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "fresh-thread", turn: { id: "fresh-turn" } } });
  }
}
`);
    if (process.platform === "win32") {
      writeFileSync(fakeRuntime, `@node "%~dp0\\fake-codex.mjs" %*\r\n`);
    } else {
      writeFileSync(fakeRuntime, `#!/usr/bin/env node\nawait import(${JSON.stringify(fakeModule)});\n`);
      chmodSync(fakeRuntime, 0o755);
    }

    const broker = new CredentialBroker({ upstreamBaseUrl: "https://upstream.test", voucherDir: base });
    const ctx = {
      workingDirectory,
      agentId: "agent-fresh",
      standingPrompt: "Fresh daemon instructions.",
      prompt: "",
      agentCliPath: process.execPath,
      launchId: "fresh-launch",
      credentialProxy: {
        broker,
        proxyUrl: "http://127.0.0.1:9/proxy",
        runnerKey: "runner-fresh",
        capabilities: ["send"],
      },
      config: {},
    };
    const runtimeConfig = {
      version: 1 as const,
      runtime: "codex" as const,
      model: { kind: "default" as const },
      mode: { kind: "default" as const },
      command: fakeRuntime,
    };

    const session = await createBuiltinDaemonSessionFactory((_, line) => rawLines.push(line))({
      agentId: "agent-fresh",
      ctx,
      runtimeConfig,
    });
    const events: AgentEvent<BuiltinBackendSpecs, "codex">[] = [];
    const collectEvents = (async () => {
      for await (const event of session.events) events.push(event);
    })();
    try {
      const started = session.start({ id: "first", kind: "user", text: "hello" });
      const admission = await new Promise<Awaited<typeof started>>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `fresh Codex admission timed out; raw stdout: ${JSON.stringify(rawLines)}; events: ${JSON.stringify(events)}`,
          ));
        }, 15_000);
        void started.then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      expect(admission).toMatchObject({ status: "accepted" });
      expect(readFileSync(join(workingDirectory, "AGENTS.md"), "utf8")).toBe("Fresh daemon instructions.");
      expect(readFileSync(join(workingDirectory, "CLAUDE.md"), "utf8")).toBe("Fresh daemon instructions.");
    } finally {
      await session.stop({ reason: "shutdown", forceAfterMs: 10 });
      await session.closed;
      await collectEvents;
      // `session.closed` is a teardown ownership boundary: the spawned shell and
      // every runtime descendant must have released the workspace by this point.
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("routes local reminder expiry through the manager and cancels on exact-scope wake/stop/removal/daemon stop", async () => {
    const realFetch = globalThis.fetch;
    const sockets: FakeSocket[] = [];
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    let now = 1_000;
    const deliver = vi.spyOn(AgentProcessManager.prototype, "deliver");
    vi.spyOn(CredentialBroker.prototype, "check").mockReturnValue({
      ok: true,
      reg: {
        agentId: "bot_1",
        launchId: "launch_1",
        capabilities: new Set(["send"]),
        voucherFile: "/unused",
        runnerKey: "runner_test",
      },
    } as never);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      if (url.includes("/enroll-agent")) return Response.json({ runnerKey: "runner_test" });
      if (url.includes("/daemon/bots")) {
        return Response.json({ bots: [{ id: "bot_1", name: "Bot", discriminator: "0001" }] });
      }
      return Response.json({ attempted: 0 });
    }));

    const daemon = await createDaemon({
      machineKey: "cmk_reminder",
      serverUrl: "http://server.invalid",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [{ id: "mock" }],
      driverFor: () => fullFakeDriver("mock"),
      sessionFactory: daemonSessionFactory(),
      capabilities: ["send"],
      messageReminderClock: {
        now: () => now,
        setTimer: (callback) => {
          const timer = { callback, cancelled: false, unref() {} };
          timers.push(timer);
          return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (handle) => {
          const index = timers.findIndex((timer) => timer === (handle as unknown));
          if (index >= 0) timers[index]!.cancelled = true;
        },
      },
    });

    const runTimer = (index: number) => {
      const timer = timers[index]!;
      if (!timer.cancelled) timer.callback();
    };
    const arm = (sentSeq: number, remindAfterMs = 60_000) =>
      realFetch(`${daemon.proxyUrl}/__alook/local/message-reminder`, {
        method: "PUT",
        headers: { authorization: "Bearer vch_test", "content-type": "application/json" },
        body: JSON.stringify({ channel: "/demo#1234/general", sentSeq, remindAfterMs }),
      });
    const sentFrames = () => sockets[0]!.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const wakeAcked = (launchId: string) => sentFrames().some((frame) =>
      frame.type === "agent_wake_ack" && frame.launchId === launchId && frame.status === "ok");
    const stopAcked = () => sentFrames().some((frame) =>
      frame.type === "agent_stopped_ack" && frame.agentId === "bot_1" && frame.status === "ok");
    const reminderDeliveries = () => deliver.mock.calls.filter(([, message]) =>
      typeof message.id === "string" && message.id.includes(":reminder:"));

    try {
      sockets[0]!.emit("open");
      sockets[0]!.emit("message", JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch_1",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }));
      await vi.waitFor(() => expect(wakeAcked("launch_1")).toBe(true));

      now = 2_000;
      expect(await (await arm(7)).json()).toEqual({ armed: true, dueAt: 62_000 });
      runTimer(0);
      expect(reminderDeliveries()).toHaveLength(1);
      expect(reminderDeliveries().at(-1)).toEqual(["bot_1", expect.objectContaining({
        text: expect.stringContaining("/demo#1234/general#7"),
      })]);

      await arm(8);
      expect(await (await arm(9, 0)).json()).toEqual({ armed: false, reason: "disabled" });
      runTimer(1);
      expect(reminderDeliveries()).toHaveLength(1);

      await arm(10);
      sockets[0]!.emit("message", JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch_2",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 11 },
      }));
      await vi.waitFor(() => expect(wakeAcked("launch_2")).toBe(true));
      await vi.waitFor(() => expect(timers[2]?.cancelled).toBe(true));
      runTimer(2);
      expect(reminderDeliveries()).toHaveLength(1);

      await arm(12);
      sockets[0]!.emit("message", JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch_duplicate",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 11 },
      }));
      await vi.waitFor(() => expect(wakeAcked("launch_duplicate")).toBe(true));
      expect(timers[3]?.cancelled).toBe(false);
      runTimer(3);
      expect(reminderDeliveries()).toHaveLength(2);
      expect(reminderDeliveries().at(-1)).toEqual(["bot_1", expect.objectContaining({
        text: expect.stringContaining("/demo#1234/general#12"),
      })]);

      await arm(13);
      sockets[0]!.emit("message", JSON.stringify({ type: "agent:stop", agentId: "bot_1" }));
      await vi.waitFor(() => expect(stopAcked()).toBe(true));
      await vi.waitFor(() => expect(timers[4]?.cancelled).toBe(true));
      runTimer(4);
      expect(reminderDeliveries()).toHaveLength(2);

      await arm(14);
      sockets[0]!.emit("message", JSON.stringify({ type: "bot:removed", botId: "bot_1" }));
      await vi.waitFor(() => expect(timers[5]?.cancelled).toBe(true));
      runTimer(5);
      expect(reminderDeliveries()).toHaveLength(2);

      await arm(15);
      await daemon.stop();
      expect(timers[6]?.cancelled).toBe(true);
      runTimer(6);
      expect(reminderDeliveries()).toHaveLength(2);
    } finally {
      // stop is idempotent enough for the failure path and keeps the loopback
      // server from leaking if an assertion above throws early.
      await daemon.stop();
    }
  });

  it("resets self-sleep only for newer wakes and suspends it while an agent works", async () => {
    const sockets: FakeSocket[] = [];
    const sessions: DaemonFakeSession[] = [];
    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "daemon-self-sleep-"));
    startupSweepDirs.push(workingDirectoryBase);
    // The real driver SDK prepares the agent directory before session_started.
    // This test uses a fake session, so reproduce that precondition explicitly.
    mkdirSync(join(workingDirectoryBase, "bot_1"));
    const timers: Array<{
      callback: () => void;
      delayMs: number;
      cancelled: boolean;
      handle: ReturnType<typeof setTimeout>;
    }> = [];
    const clock: DaemonSelfSleepClock = {
      setTimer: (callback, delayMs) => {
        const handle = { unref() {} } as ReturnType<typeof setTimeout>;
        timers.push({ callback, delayMs, cancelled: false, handle });
        return handle;
      },
      clearTimer: (handle) => {
        const timer = timers.find((candidate) => candidate.handle === handle);
        if (timer) timer.cancelled = true;
      },
    };
    const onSelfSleep = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/enroll-agent")) return Response.json({ runnerKey: "runner_test" });
      if (url.includes("/daemon/bots")) {
        return Response.json({ bots: [{ id: "bot_1", name: "Bot", discriminator: "0001" }] });
      }
      return Response.json({ attempted: 0 });
    }));

    const daemon = await createDaemon({
      machineKey: "cmk_self_sleep",
      serverUrl: "http://server.invalid",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      sessionFactory: () => {
        const session = daemonFakeSession();
        sessions.push(session);
        return session;
      },
      capabilities: [],
      workingDirectoryBase,
      onSelfSleep,
      selfSleepClock: clock,
    });
    const wake = (seq: number) => sockets[0]!.emit("message", JSON.stringify({
      type: "agent:wake",
      agentId: "bot_1",
      config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: `launch_${seq}`,
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: seq },
    }));
    const sentFrames = () => sockets[0]!.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const wakeAckCount = (seq: number) => sentFrames()
      .filter((frame) => frame.type === "agent_wake_ack" && frame.launchId === `launch_${seq}` && frame.status === "ok")
      .length;
    const activityCount = (state: "running" | "idle") => sentFrames()
      .filter((frame) => frame.type === "agent_activity" && frame.agentId === "bot_1" && frame.state === state)
      .length;

    try {
      expect(timers).toHaveLength(1);
      expect(timers[0]?.delayMs).toBe(DAEMON_SELF_SLEEP_TIMEOUT_MS);
      sockets[0]!.emit("open");
      wake(1);
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      await vi.waitFor(() => expect(wakeAckCount(1)).toBe(1));
      await vi.waitFor(() => expect(activityCount("running")).toBe(1), { timeout: 5_000 });
      await vi.waitFor(() => expect(timers).toHaveLength(2));
      expect(timers.slice(0, 2).every((timer) => timer.cancelled)).toBe(true);

      await sessions[0]!.fire("runtime_event", { kind: "turn_end", sessionId: "test-session" });
      await vi.waitFor(() => expect(activityCount("idle")).toBe(1), { timeout: 5_000 });
      await vi.waitFor(() => expect(timers).toHaveLength(3));
      expect(timers[2]?.cancelled).toBe(false);

      wake(1);
      await vi.waitFor(() => expect(wakeAckCount(1)).toBe(2));
      expect(timers).toHaveLength(3);

      wake(2);
      await vi.waitFor(() => expect(wakeAckCount(2)).toBe(1));
      await vi.waitFor(() => expect(timers.length).toBeGreaterThanOrEqual(4));
      expect(timers[2]?.cancelled).toBe(true);
      expect(timers[3]?.cancelled).toBe(false);
      timers[2]?.callback();
      expect(onSelfSleep).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

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

  it("uses one clock sample for status writtenAt and agent progress ages", async () => {
    const sockets: FakeSocket[] = [];
    const root = mkdtempSync(join(tmpdir(), "daemon-status-clock-"));
    startupSweepDirs.push(root);
    const statusFilePath = join(root, "status.json");
    const projectionTimes: number[] = [];
    let nowMs = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => ++nowMs);
    vi.spyOn(AgentProcessManager.prototype, "statusProjection").mockImplementation((sampledNowMs) => {
      projectionTimes.push(sampledNowMs);
      return [];
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ bots: [] })));

    const daemon = await createDaemon({
      machineKey: "cmk_status_clock",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      statusFilePath,
    });

    try {
      const snapshot = JSON.parse(readFileSync(statusFilePath, "utf8")) as { writtenAt: number };
      expect(projectionTimes).toHaveLength(1);
      expect(snapshot.writtenAt).toBe(projectionTimes[0]);
    } finally {
      await daemon.stop();
    }
  });

  it("writes machine-bound bot totals after warmup and keeps bot pushes in sync", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const root = mkdtempSync(join(tmpdir(), "daemon-status-summary-"));
    startupSweepDirs.push(root);
    const statusFilePath = join(root, "status.json");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/community/daemon/bots")) {
        return Response.json({
          bots: [
            { id: "bot_1", name: "One", discriminator: "0001" },
            { id: "bot_2", name: "Two", discriminator: "0002" },
          ],
        });
      }
      return Response.json({});
    }));

    const daemon = await createDaemon({
      machineKey: "cmk_status_summary",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      statusFilePath,
      workingDirectoryBase: root,
      tickIntervalMs: 1_000_000,
    });

    try {
      expect(JSON.parse(readFileSync(statusFilePath, "utf8")).agentSummary).toEqual({
        total: null,
        running: 0,
      });

      sockets[0].emit("open");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(JSON.parse(readFileSync(statusFilePath, "utf8")).agentSummary).toEqual({
        total: 2,
        running: 0,
      });

      sockets[0].emit("message", JSON.stringify({
        type: "bot:added",
        botId: "bot_3",
        name: "Three",
        discriminator: "0003",
      }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(JSON.parse(readFileSync(statusFilePath, "utf8")).agentSummary.total).toBe(3);

      sockets[0].emit("message", JSON.stringify({ type: "bot:removed", botId: "bot_2" }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(JSON.parse(readFileSync(statusFilePath, "utf8")).agentSummary.total).toBe(2);
    } finally {
      await daemon.stop();
      vi.useRealTimers();
    }
  });

  it("counts manager-owned sessions across bot removal and physical exit", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const sessions: DaemonFakeSession[] = [];
    const root = mkdtempSync(join(tmpdir(), "daemon-status-running-"));
    startupSweepDirs.push(root);
    mkdirSync(join(root, "bot_1"));
    mkdirSync(join(root, "bot_2"));
    const statusFilePath = join(root, "status.json");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/community/daemon/bots")) {
        return Response.json({
          bots: [
            { id: "bot_1", name: "One", discriminator: "0001" },
            { id: "bot_2", name: "Two", discriminator: "0002" },
          ],
        });
      }
      if (url.includes("/api/community/daemon/enroll-agent")) {
        return Response.json({ runnerKey: "runner_test" });
      }
      return Response.json({ attempted: 0 });
    }));

    const daemon = await createDaemon({
      machineKey: "cmk_status_running",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      sessionFactory: () => {
        const session = daemonFakeSession();
        sessions.push(session);
        return session;
      },
      capabilities: [],
      statusFilePath,
      workingDirectoryBase: root,
      tickIntervalMs: 1_000_000,
    });
    const summary = () => JSON.parse(readFileSync(statusFilePath, "utf8")).agentSummary;
    const wake = (agentId: string, latestSeq: number) => sockets[0].emit("message", JSON.stringify({
      type: "agent:wake",
      agentId,
      config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: `launch_${latestSeq}`,
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq },
    }));

    try {
      sockets[0].emit("open");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(summary()).toEqual({ total: 2, running: 0 });

      wake("bot_1", 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sessions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(summary()).toEqual({ total: 2, running: 1 });

      sockets[0].emit("message", JSON.stringify({ type: "bot:removed", botId: "bot_1" }));
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(summary()).toEqual({ total: 1, running: 0 });

      wake("bot_2", 2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sessions).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(summary()).toEqual({ total: 1, running: 1 });

      await sessions[1]!.fire("exit");
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(summary()).toEqual({ total: 1, running: 0 });
    } finally {
      await daemon.stop();
      vi.useRealTimers();
    }
  });

  it("marks a deferred roster fetch authoritative after warmup exhaustion", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const sessions: DaemonFakeSession[] = [];
    const root = mkdtempSync(join(tmpdir(), "daemon-status-deferred-roster-"));
    startupSweepDirs.push(root);
    mkdirSync(join(root, "bot_1"));
    const statusFilePath = join(root, "status.json");
    let allowRoster = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/community/daemon/bots")) {
        return allowRoster
          ? Response.json({ bots: [{ id: "bot_1", name: "One", discriminator: "0001" }] })
          : Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (url.includes("/api/community/daemon/enroll-agent")) {
        return Response.json({ runnerKey: "runner_test" });
      }
      return Response.json({ attempted: 0 });
    }));

    const daemon = await createDaemon({
      machineKey: "cmk_status_deferred_roster",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as never,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      sessionFactory: () => {
        const session = daemonFakeSession();
        sessions.push(session);
        return session;
      },
      capabilities: [],
      statusFilePath,
      workingDirectoryBase: root,
      tickIntervalMs: 1_000_000,
    });
    const summary = () => JSON.parse(readFileSync(statusFilePath, "utf8")).agentSummary;

    try {
      sockets[0].emit("open");
      await vi.advanceTimersByTimeAsync(35_000);
      expect(summary()).toEqual({ total: null, running: 0 });

      allowRoster = true;
      sockets[0].emit("message", JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch_deferred",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }));
      await vi.advanceTimersByTimeAsync(1);
      expect(sessions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(summary()).toEqual({ total: 1, running: 1 });
    } finally {
      await daemon.stop();
      vi.useRealTimers();
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
      return Response.json({ attempted: 0 });
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

  it("consumes machine:update before bot observers and AgentRouter", async () => {
    const sockets: FakeSocket[] = [];
    const routerEntry = spyOnRouterCommandEntry();
    const handleSelfUpdate = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ bots: [] })));
    const daemon = await createDaemon({
      machineKey: "cmk_self_update",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      handleSelfUpdate,
    } as Parameters<typeof createDaemon>[0]);
    sockets[0].emit("open");

    sockets[0].emit("message", JSON.stringify({ type: "machine:update" }));

    await vi.waitFor(() => expect(handleSelfUpdate).toHaveBeenCalledOnce());
    expect(routerEntry).not.toHaveBeenCalledWith(expect.objectContaining({ type: "machine:update" }));
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
        : Response.json({ attempted: 0 });
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

  it("wires inbox observation failures to one bounded redacted daemon warning", async () => {
    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_observation_warning",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      logger,
    });

    expect(credentialProxyHarness.onInboxPullObservationError).toBeTypeOf("function");
    credentialProxyHarness.onInboxPullObservationError?.({
      agentId: "agent-1",
      reason: "invalid_json",
      contentEncoding: "gzip",
      body: "private message body",
      authorization: "Bearer private-runner-key",
    });

    const warnings = logger.calls.warn.filter(([, message]) => message === "inbox pull timeline observation failed");
    expect(warnings).toEqual([[
      "root",
      "inbox pull timeline observation failed",
      [{ agentId: "agent-1", reason: "invalid_json", contentEncoding: "gzip" }],
    ]]);
    expect(JSON.stringify(warnings)).not.toContain("private");
    expect(JSON.stringify(warnings)).not.toContain("Bearer");
    await daemon.stop();
  });

  it("treats non-object or absent pull observation tokens as ownerless without model-seen updates", async () => {
    const sockets: FakeSocket[] = [];
    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "timeline-invalid-token-"));
    startupSweepDirs.push(workingDirectoryBase);
    const recordModelSeen = vi.spyOn(WsControlChannel.prototype, "recordModelSeen");
    const daemon = await createDaemon({
      machineKey: "cmk_invalid_observation_token",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [],
      driverFor: () => fakeDriver,
      capabilities: [],
      workingDirectoryBase,
    });
    const messages = [{
      seq: "#1",
      channel: "/demo#1234/general",
      sender: "@gus#1813",
      content: { text: "ownerless" },
      time: "2026-08-24T12:00:00Z",
    }];

    credentialProxyHarness.onInboxPullResponse?.("bot_1", messages, "invalid-token");
    credentialProxyHarness.onInboxPullResponse?.("bot_1", messages);

    expect(timelineRecorderHarness.pulls.map((pull) => pull.owner)).toEqual([null, null]);
    expect(recordModelSeen).not.toHaveBeenCalled();
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

  it("asks a woken agent to pull unread messages without exposing the selected channel", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    let spawnedPrompt = "";
    const driver = fullFakeDriver("codex");

    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_wake_prompt",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => driver,
      sessionFactory: daemonSessionFactory({
        onStart: ({ text }) => { spawnedPrompt = text; },
      }),
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

    expect(spawnedPrompt).toContain("You have unread messages.");
    expect(spawnedPrompt).toContain("Use `alook inbox pull` to read your messages.");
    expect(spawnedPrompt).not.toContain("/demo#1234/general");
    expect(spawnedPrompt).not.toContain("message send");

    await daemon.stop();
  });

  it("keeps every working unread covered while coalescing wake bursts into one real session delivery", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_working_coverage" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const channel = "/demo#1234/general";
    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "working-unread-coverage-"));
    startupSweepDirs.push(workingDirectoryBase);
    // The real driver SDK prepares this directory before session_started. This
    // test uses a fake session, so reproduce that precondition explicitly.
    mkdirSync(join(workingDirectoryBase, "bot_working"));
    const starts: Array<{ id: string; text: string }> = [];
    const sends: Array<{ id: string; text: string; sequence?: number }> = [];
    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_working_coverage",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      workingDirectoryBase,
      driverFor: () => fullFakeDriver("codex"),
      sessionFactory: daemonSessionFactory({
        onStart: (input) => starts.push(input),
        onSend: (input) => sends.push(input),
      }),
      capabilities: [],
    });
    const wake = (seq: number) => sockets[0].emit("message", JSON.stringify({
      type: "agent:wake",
      agentId: "bot_working",
      config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: `launch_${seq}`,
      unreadNotice: { kind: "unread_notice", channel, latestSeq: seq },
    }));
    const wakeAcked = (seq: number) => sockets[0].sent.map((frame) => JSON.parse(frame)).some(
      (frame) => frame.type === "agent_wake_ack" && frame.launchId === `launch_${seq}` && frame.status === "ok",
    );
    const observePull = (seq: number) => {
      const observationToken = credentialProxyHarness.onInboxPullStart?.("bot_working");
      credentialProxyHarness.onInboxPullResponse?.(
        "bot_working",
        [{ channel, seq: `#${seq}` }],
        observationToken,
      );
    };

    try {
      sockets[0].emit("open");
      await new Promise((resolve) => setTimeout(resolve, 20));
      sockets[0].emit(
        "message",
        JSON.stringify({
          type: "bot:added",
          botId: "bot_working",
          name: "Working Bot",
          discriminator: "0001",
        }),
      );

      wake(1);
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      await vi.waitFor(() => expect(wakeAcked(1)).toBe(true));
      observePull(1);

      for (let seq = 2; seq <= 6; seq++) wake(seq);
      await vi.waitFor(() => expect(wakeAcked(6)).toBe(true));
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ sequence: 2 });

      observePull(6);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sends).toHaveLength(1);

      wake(7);
      wake(8);
      await vi.waitFor(() => expect(wakeAcked(8)).toBe(true));
      expect(sends).toHaveLength(2);
      expect(sends[1]).toMatchObject({ sequence: 7 });

      observePull(7);
      await vi.waitFor(() => expect(sends).toHaveLength(3));
      expect(sends[2]).toMatchObject({ sequence: 8 });
    } finally {
      await daemon.stop();
    }
  });

  it("re-injects partial multi-channel coverage with a fresh driver command id while the session stays active", async () => {
    let releaseEnroll!: () => void;
    const enrollGate = new Promise<void>((resolve) => { releaseEnroll = resolve; });
    let enrollStarted = false;
    global.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/enroll-agent")) {
        enrollStarted = true;
        await enrollGate;
        return new Response(JSON.stringify({ runnerKey: "rk_unobserved_replay" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "unobserved-wake-replay-"));
    startupSweepDirs.push(workingDirectoryBase);
    mkdirSync(join(workingDirectoryBase, "bot_replay"));
    const starts: Array<{ id: string; text: string }> = [];
    const sends: Array<{ id: string; text: string; sequence?: number }> = [];
    let stopCount = 0;
    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_unobserved_replay",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      workingDirectoryBase,
      driverFor: () => fullFakeDriver("codex"),
      sessionFactory: () => daemonFakeSession({
        onStart: (input) => starts.push(input),
        onSend: (input) => sends.push(input),
        onStop: () => { stopCount += 1; },
        enforceCommandIdempotency: true,
      }),
      capabilities: [],
    });
    const wake = (channel: string, latestSeq: number, launchId: string) => sockets[0].emit("message", JSON.stringify({
      type: "agent:wake",
      agentId: "bot_replay",
      config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
      launchId,
      unreadNotice: { kind: "unread_notice", channel, latestSeq },
    }));
    const wakeAcked = (launchId: string) => sockets[0].sent.map((frame) => JSON.parse(frame)).some(
      (frame) => frame.type === "agent_wake_ack"
        && frame.launchId === launchId
        && frame.status === "ok",
    );
    const observePull = (channel: string, seq: number) => {
      const observationToken = credentialProxyHarness.onInboxPullStart?.("bot_replay");
      credentialProxyHarness.onInboxPullResponse?.(
        "bot_replay",
        [{ channel, seq: `#${seq}` }],
        observationToken,
      );
    };

    try {
      sockets[0].emit("open");
      await new Promise((resolve) => setTimeout(resolve, 20));
      sockets[0].emit("message", JSON.stringify({
        type: "bot:added",
        botId: "bot_replay",
        name: "Replay Bot",
        discriminator: "0001",
      }));

      wake("/demo#1234/root", 1, "root");
      await vi.waitFor(() => expect(enrollStarted).toBe(true));

      // These two desired watermarks are folded into the admission that
      // follows the blocked root wake. The selected c2 command therefore owns
      // coverage for both c1 and c2.
      wake("/demo#1234/c1", 2, "c1");
      wake("/demo#1234/c2", 7, "c2");
      await vi.waitFor(() => expect(wakeAcked("c1")).toBe(true));
      await vi.waitFor(() => expect(wakeAcked("c2")).toBe(true));
      observePull("/demo#1234/root", 1);
      releaseEnroll();

      await vi.waitFor(() => expect(starts).toHaveLength(1));
      await vi.waitFor(() => expect(wakeAcked("root")).toBe(true));
      await vi.waitFor(() => expect(sends).toHaveLength(1));

      // The pull proves only c1 reached the model. c2 must be re-admitted into
      // the still-running session, using a fresh driver command identity.
      await new Promise((resolve) => setTimeout(resolve, 2));
      observePull("/demo#1234/c1", 2);
      await vi.waitFor(() => expect(sends).toHaveLength(2));

      expect(starts[0]!.id).toContain(":admission:1");
      expect(sends[0]!.id).toContain(":admission:2");
      expect(sends[1]!.id).toContain(":admission:3");
      expect(sends[0]).toMatchObject({ sequence: 7 });
      expect(sends[1]).toMatchObject({ sequence: 7 });
      expect(sends[1]!.id).not.toBe(sends[0]!.id);
      expect(sends[1]!.text).not.toBe(sends[0]!.text);
      expect(stopCount).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it("uses only the immutable pull-start owner when the active turn changes before response", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_pull_owner" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const workingDirectoryBase = mkdtempSync(join(tmpdir(), "timeline-pull-owner-"));
    startupSweepDirs.push(workingDirectoryBase);
    mkdirSync(join(workingDirectoryBase, "bot_1"));
    const sockets: FakeSocket[] = [];
    let session: DaemonFakeSession | undefined;
    const daemon = await createDaemon({
      machineKey: "cmk_pull_owner",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => fullFakeDriver("codex"),
      sessionFactory: () => {
        session = daemonFakeSession();
        return session;
      },
      capabilities: [],
      workingDirectoryBase,
    });

    try {
      const ownerlessToken = credentialProxyHarness.onInboxPullStart?.("bot_1");
      sockets[0].emit("open");
      sockets[0].emit("message", JSON.stringify({
        type: "bot:added",
        botId: "bot_1",
        name: "Bot One",
        discriminator: "0001",
      }));
      sockets[0].emit("message", JSON.stringify({
        type: "agent:wake",
        agentId: "bot_1",
        config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch_1",
        unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
      }));
      await vi.waitFor(() => expect(session).toBeDefined());
      await vi.waitFor(() => {
        const token = credentialProxyHarness.onInboxPullStart?.("bot_1") as { owner?: unknown } | undefined;
        expect(token?.owner).toMatchObject({ sessionInstanceId: "daemon-test", rootTurnId: "daemon-test-turn" });
      });
      const ownedToken = credentialProxyHarness.onInboxPullStart?.("bot_1");
      await session!.fire("runtime_event", { kind: "turn_end", sessionId: "test-session" });

      const observed = (seq: string, text: string) => [{
        seq,
        channel: "/demo#1234/general",
        sender: "@gus#1813",
        content: { text },
        time: "2026-08-24T12:00:00Z",
      }];
      credentialProxyHarness.onInboxPullResponse?.("bot_1", observed("#1", "late owned"), ownedToken);
      credentialProxyHarness.onInboxPullResponse?.("bot_1", observed("#2", "late ownerless"), ownerlessToken);

      expect(timelineRecorderHarness.pulls).toHaveLength(2);
      expect(timelineRecorderHarness.pulls[0]!.owner).toMatchObject({
        sessionInstanceId: "daemon-test",
        rootTurnId: "daemon-test-turn",
        barrierGeneration: 0,
      });
      expect(timelineRecorderHarness.pulls[1]!.owner).toBeNull();
    } finally {
      await daemon.stop();
    }
  });

  it("retries a later wake after handshake_timeout instead of globally disabling the runtime", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) {
        return new Response(JSON.stringify({ runnerKey: "rk_retry" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const spawn = vi.fn();
    const driver = fullFakeDriver("cursor");
    const sessionFactory: SessionFactory = () => {
      spawn();
      return daemonFakeSession({ establish: false });
    };
    const sockets: FakeSocket[] = [];
    const logger = stubLogger();
    const daemon = await createDaemon({
      machineKey: "cmk_handshake_retry",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "cursor" }],
      driverFor: () => driver,
      sessionFactory,
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
      sessionFactory: () => daemonFakeSession(),
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
    const driver = fullFakeDriver("codex");

    const sockets: FakeSocket[] = [];
    const daemon = await createDaemon({
      machineKey: "cmk_handle",
      serverUrl: "http://localhost:9999",
      serverWsUrl: "ws://x",
      webSocketFactory: factory(sockets) as any,
      runtimeReport: [{ id: "codex" }],
      driverFor: () => driver,
      sessionFactory: (hooks) => {
        const { ctx } = hooks;
        seenConfigs.push(ctx.config);
        return daemonFakeSession();
      },
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

  it("replays the same durable idle-reset completion after daemon reconstruction", async () => {
    const base = mkdtempSync(join(tmpdir(), "daemon-audit-outbox-"));
    startupSweepDirs.push(base);
    const completion = {
      eventId: "bae_process_rebuild",
      occurredAt: "2026-08-25T12:00:00.000Z",
    };
    const timelineDirFor = (agentId: string) => join(base, agentId, ".context_timeline");
    mkdirSync(join(base, "bot_1"));
    const recorder = createTimelineRecorder({ timelineDirFor });
    expect(recorder.forgetSession("bot_1", "reset_session", "sess-old", completion)).toBe(true);
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      bots: [{ id: "bot_1", name: "Bot", discriminator: "0001" }],
    }), { status: 200 })) as unknown as typeof fetch;

    const start = async (sockets: FakeSocket[]) => {
      const daemon = await createDaemon({
        machineKey: "cmk_outbox",
        serverUrl: "http://localhost:9999",
        serverWsUrl: "ws://x",
        webSocketFactory: factory(sockets) as any,
        runtimeReport: [],
        driverFor: () => fakeDriver,
        workingDirectoryBase: base,
        capabilities: [],
      });
      sockets[0].emit("open");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return daemon;
    };

    const firstSockets: FakeSocket[] = [];
    const firstDaemon = await start(firstSockets);
    const firstFrame = firstSockets[0].sent.map((raw) => JSON.parse(raw)).find(
      (frame) => frame.type === "bot_audit_event",
    );
    expect(firstFrame).toMatchObject({ ...completion, agentId: "bot_1" });
    await firstDaemon.stop();

    const rebuiltSockets: FakeSocket[] = [];
    const rebuiltDaemon = await start(rebuiltSockets);
    const replay = rebuiltSockets[0].sent.map((raw) => JSON.parse(raw)).find(
      (frame) => frame.type === "bot_audit_event",
    );
    expect(replay).toEqual(firstFrame);
    rebuiltSockets[0].emit("message", JSON.stringify({
      type: "bot_audit_event_ack",
      eventId: completion.eventId,
    }));
    expect(createTimelineRecorder({ timelineDirFor }).pendingIdleResetEvents("bot_1")).toEqual([]);
    await rebuiltDaemon.stop();
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

  it("calls resync-wakes with the machine key bearer on open and logs the attempted count", async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/resync-wakes")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer cmk_resync");
        return new Response(JSON.stringify({ attempted: 2 }), { status: 200 });
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
      logger.calls.info.some(([, m, d]) => m === "wake resync completed" && (d[0] as any).attempted === 2),
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
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    global.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/enroll-agent")) return new Response(JSON.stringify({ runnerKey: "rk_1" }), { status: 200 });
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    // A persistent, stdin-capable driver stays `running` after session_init
    // without emitting turn_end — so the agent sits in a STEADY working state,
    // which is exactly the window 2b exercises.
    const emitters: DaemonFakeSession[] = [];
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
      sessionFactory: () => {
        const session = daemonFakeSession({ establish: false });
        emitters.push(session);
        return session;
      },
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
    await emitters[0].fire("runtime_event", { kind: "session_init", sessionId: "s1" });

    const activityFrames = () =>
      sockets[0].sent.map((s) => JSON.parse(s)).filter((f: any) => f.type === "agent_activity");
    await vi.waitFor(() => expect(activityFrames().at(-1)).toMatchObject({
      type: "agent_activity",
      agentId: "bot_1",
      state: "running",
    }));
    const beforeCount = activityFrames().length;

    // Invoke ONE installed heartbeat with no further runtime events. Calling
    // the registered callback directly keeps this test independent of the
    // platform-specific fake-timer handling for unref'ed intervals.
    const heartbeatCalls = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 5_000);
    expect(heartbeatCalls).toHaveLength(1);
    const heartbeat = heartbeatCalls[0]![0];
    expect(heartbeat).toBeTypeOf("function");
    if (typeof heartbeat !== "function") throw new Error("heartbeat callback was not installed");
    heartbeat();
    // Activity reports are serialized through an async per-agent tail, so wait
    // until that tail sends the callback's level-triggered re-assertion.
    await vi.waitFor(() => expect(activityFrames().length).toBeGreaterThan(beforeCount));
    const after = activityFrames();
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
    // One combined profile command issues two independently auditable writes.
    expect(deriveAuditLogSubcommand("/api/community/users/me/avatar", "POST")).toBe("profileAvatarUpdate");
    expect(deriveAuditLogSubcommand("/api/community/users/me/profile", "PATCH")).toBe("profileBioUpdate");
    expect(deriveAuditLogSubcommand("/api/community/users/me/profile", "GET")).toBe(null);
    expect(deriveAuditLogSubcommand("/api/community/users/me/avatar", "PATCH")).toBe(null);
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
    const session = daemonFakeSession({ establish: false });
    const mgr = new AgentProcessManager({
      driverFor: () => ({
        id: "codex",
        lifecycle: { kind: "per_turn" },
        supportsStdinNotification: false,
        busyDeliveryMode: "none",
      } as never),
      baseContextFor: () => ({ workingDirectory: "/tmp", agentId: "a1", config: {} }) as never,
      sessionFactory: () => session,
    });
    mgr.register("a1", { launchId: "l_XYZ" });
    expect(mgr.auditContext("a1")).toEqual({ sessionId: null, launchId: "l_XYZ" });

    mgr.deliver("a1", { seq: 1, text: "hi" } as never);
    await session.fire("runtime_event", { kind: "session_init", sessionId: "s_ABC" });
    expect(mgr.auditContext("a1")).toEqual({ sessionId: "s_ABC", launchId: "l_XYZ" });
  });
});

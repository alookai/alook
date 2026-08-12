import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PreparedDaemon } from "./daemonRunner";
import {
  createDaemonProcessLogger,
  DAEMON_LOG_MAX_BYTES,
  logDaemonStartup,
  logDaemonUp,
  runPreparedDaemon,
} from "./daemonRunner";

const runnerDaemonHarness = vi.hoisted(() => {
  const create = vi.fn();
  return { create };
});

const runnerDiagnosticHarness = vi.hoisted(() => {
  const upload = vi.fn(async () => ({ kind: "retryable" as const }));
  const fail = vi.fn(async () => ({ kind: "terminal" as const, status: "failed" as const }));
  const transport = { upload, fail };
  const collect = vi.fn(async () => ({ status: "pending" as const }));
  const recover = vi.fn(async () => {});
  const shutdown = vi.fn(async () => {});
  const coordinator = { collect, recover, shutdown };
  const createTransport = vi.fn(() => transport);
  const createCoordinator = vi.fn(() => coordinator);
  return {
    upload,
    fail,
    transport,
    collect,
    recover,
    shutdown,
    coordinator,
    createTransport,
    createCoordinator,
  };
});

vi.mock("../daemon/createDaemon.js", () => ({
  createDaemon: (...args: unknown[]) => runnerDaemonHarness.create(...args),
}));

vi.mock("../diagnostics/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diagnostics/index.js")>();
  return {
    ...actual,
    createDiagnosticHttpTransport: (...args: unknown[]) => runnerDiagnosticHarness.createTransport(...args),
    createDiagnosticReportCoordinator: (...args: unknown[]) => runnerDiagnosticHarness.createCoordinator(...args),
  };
});

const RUNNER_PROCESS_EVENTS = ["uncaughtException", "unhandledRejection", "SIGINT", "SIGTERM"] as const;

function preparedDaemon(dir: string): PreparedDaemon {
  return {
    machineId: "machine-1",
    machineKey: "cmk_PRIVATE_RUNNER_KEY",
    serverUrl: "https://community.example",
    wsUrl: "wss://community.example/ws",
    baseDir: path.join(dir, "agents"),
    daemonDir: dir,
    statusFilePath: path.join(dir, "status.json"),
    agentCliPath: undefined,
    runtimeReport: [],
    healthyRuntimeIds: [],
    hostname: "host",
    platform: "test",
    arch: "test",
    osRelease: "test",
    daemonVersion: "1.2.3",
    ownerToken: "owner-private",
    startedAt: "2026-08-12T00:00:00.000Z",
  };
}

function resetDiagnosticHarness(): void {
  runnerDaemonHarness.create.mockReset();
  runnerDiagnosticHarness.upload.mockReset().mockResolvedValue({ kind: "retryable" });
  runnerDiagnosticHarness.fail.mockReset().mockResolvedValue({ kind: "terminal", status: "failed" });
  runnerDiagnosticHarness.collect.mockReset().mockResolvedValue({ status: "pending" });
  runnerDiagnosticHarness.recover.mockReset().mockResolvedValue(undefined);
  runnerDiagnosticHarness.shutdown.mockReset().mockResolvedValue(undefined);
  runnerDiagnosticHarness.createTransport.mockReset().mockReturnValue(runnerDiagnosticHarness.transport);
  runnerDiagnosticHarness.createCoordinator.mockReset().mockReturnValue(runnerDiagnosticHarness.coordinator);
}

function processListenerSnapshot(): Map<string, Set<(...args: never[]) => unknown>> {
  return new Map(RUNNER_PROCESS_EVENTS.map((event) => [
    event,
    new Set(process.listeners(event) as Array<(...args: never[]) => unknown>),
  ]));
}

function removeNewProcessListeners(before: Map<string, Set<(...args: never[]) => unknown>>): void {
  for (const event of RUNNER_PROCESS_EVENTS) {
    const existing = before.get(event)!;
    for (const listener of process.listeners(event) as Array<(...args: never[]) => unknown>) {
      if (!existing.has(listener)) process.removeListener(event, listener as never);
    }
  }
}

function installDaemonHarness(dir: string, events: string[] = []) {
  const state: { options?: Record<string, unknown> } = {};
  const stop = vi.fn(async () => { events.push("daemon-stop"); });
  const fsmTraceSource = { openSnapshot: vi.fn() };
  runnerDaemonHarness.create.mockImplementation(async (options: Record<string, unknown>) => {
    state.options = options;
    const supplySources = options.onDiagnosticSources as ((sources: unknown) => void) | undefined;
    supplySources?.({ fsmTraceSource, statusFilePath: path.join(dir, "status.json") });
    return {
      proxyUrl: "http://127.0.0.1:1234",
      onOpen: vi.fn(),
      stop,
    };
  });
  return { state, stop, fsmTraceSource };
}

describe("daemon runner logger", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-runner-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes one structured JSON record per physical line with secure modes", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    logger.info("hostile\nmessage", { header: "spoof", agentId: "a1" });
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      header: "@alook/daemon",
      level: "info",
      message: "hostile\nmessage",
      fields: { header: "spoof", agentId: "a1" },
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps active and rotated generations within the hard cap", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    const payload = "x".repeat(256 * 1024);
    for (let i = 0; i < 80; i++) logger.info("chunk", { payload, i });
    for (const file of [logPath, `${logPath}.1`]) {
      if (!fs.existsSync(file)) continue;
      expect(fs.statSync(file).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("removes legacy oversized active and rotated generations before startup", () => {
    const logPath = path.join(dir, "daemon.log");
    fs.writeFileSync(logPath, "");
    fs.writeFileSync(`${logPath}.1`, "");
    fs.truncateSync(logPath, DAEMON_LOG_MAX_BYTES + 1);
    fs.truncateSync(`${logPath}.1`, DAEMON_LOG_MAX_BYTES + 1);

    createDaemonProcessLogger(dir, false);

    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(fs.readFileSync(logPath, "utf8")).toContain("oversize daemon log generation removed");
  });

  it("drops an oversize event whole and records only one bounded warning", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    const payload = "x".repeat(DAEMON_LOG_MAX_BYTES);
    logger.info("oversize", { payload });
    logger.info("oversize", { payload });
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([expect.objectContaining({ message: "daemon log record dropped: oversize" })]);
  });

  it("records a safe startup and runtime probe summary", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    logDaemonStartup(logger, {
      machineId: "machine-1",
      machineKey: "cmk_must_not_log",
      daemonVersion: "1.2.3",
      runtimeReport: [
        { id: "claude", status: "healthy", version: "4", lastError: "secret healthy detail" },
        { id: "codex", status: "unhealthy", lastError: "secret failure detail" },
      ],
    } as PreparedDaemon);

    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(record).toMatchObject({
      level: "info",
      message: "daemon startup",
      fields: {
        machineId: "machine-1",
        version: "1.2.3",
        healthyRuntimeIds: ["claude"],
        unhealthyRuntimeIds: ["codex"],
      },
    });
    expect(JSON.stringify(record)).not.toContain("cmk_must_not_log");
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("records only URL protocols when the daemon is up", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    logDaemonUp(
      logger,
      "http://user:password@127.0.0.1:1234/proxy?token=proxy-secret",
      "wss://control.example/ws?access_token=control-secret",
    );

    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(record).toMatchObject({
      message: "daemon up",
      fields: { proxyProtocol: "http", controlProtocol: "wss" },
    });
    expect(JSON.stringify(record)).not.toContain("password");
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(JSON.stringify(record)).not.toContain("control.example");
  });

  it("wires one diagnostic lifecycle and starts unresolved recovery without blocking ready", async () => {
    resetDiagnosticHarness();
    vi.useFakeTimers();
    const listenersBefore = processListenerSnapshot();
    const events: string[] = [];
    const daemonHarness = installDaemonHarness(dir);
    runnerDiagnosticHarness.recover.mockImplementation(() => {
      events.push("recover");
      return new Promise<void>(() => {});
    });
    const readyError = new Error("stop after ready receipt");
    const prepared = preparedDaemon(dir);

    try {
      await expect(runPreparedDaemon(prepared, {
        foreground: false,
        releaseOwnership: vi.fn(),
        onReady: () => {
          events.push("ready");
          throw readyError;
        },
      })).rejects.toBe(readyError);

      expect(runnerDiagnosticHarness.createTransport).toHaveBeenCalledOnce();
      expect(runnerDiagnosticHarness.createTransport).toHaveBeenCalledWith({
        serverUrl: prepared.serverUrl,
        machineKey: prepared.machineKey,
      });
      expect(runnerDiagnosticHarness.createCoordinator).toHaveBeenCalledOnce();
      expect(runnerDiagnosticHarness.createCoordinator).toHaveBeenCalledWith(expect.objectContaining({
        machineDir: prepared.daemonDir,
        transport: runnerDiagnosticHarness.transport,
        buildBundle: expect.any(Function),
        logger: expect.any(Object),
      }));
      expect(daemonHarness.state.options?.onDiagnosticSources).toEqual(expect.any(Function));
      expect(daemonHarness.state.options?.handleDiagnosticCommand).toEqual(expect.any(Function));
      expect(daemonHarness.state.options?.reportDiagnosticFailure).toEqual(expect.any(Function));
      expect(events).toEqual(["recover", "ready"]);

      const command = {
        type: "diagnostics:collect",
        reportId: "dbr_0123456789abcdef",
        agentId: "bot_1",
        fromMs: 1_700_000_000_000,
        deadlineAt: 1_700_087_000_000,
      };
      await (daemonHarness.state.options?.handleDiagnosticCommand as (value: typeof command) => Promise<void>)(command);
      expect(runnerDiagnosticHarness.collect).toHaveBeenCalledWith(command);
      await (daemonHarness.state.options?.reportDiagnosticFailure as (value: { reportId: string; failureCode: string }) => Promise<void>)({
        reportId: command.reportId,
        failureCode: "diagnostics_unavailable",
      });
      expect(runnerDiagnosticHarness.fail).toHaveBeenCalledWith(
        command.reportId,
        "diagnostics_unavailable",
      );
    } finally {
      removeNewProcessListeners(listenersBefore);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("observes a rejected fire-and-observe recovery through the safe logger", async () => {
    resetDiagnosticHarness();
    vi.useFakeTimers();
    const listenersBefore = processListenerSnapshot();
    installDaemonHarness(dir);
    runnerDiagnosticHarness.recover.mockRejectedValue(
      new Error("recovery failed cmk_PRIVATE_RECOVERY_KEY"),
    );
    const readyError = new Error("stop after ready receipt");

    try {
      await expect(runPreparedDaemon(preparedDaemon(dir), {
        foreground: false,
        releaseOwnership: vi.fn(),
        onReady: () => { throw readyError; },
      })).rejects.toBe(readyError);
      await Promise.resolve();
      await Promise.resolve();

      const records = fs.readFileSync(path.join(dir, "daemon.log"), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({
        level: "warn",
        message: "diagnostic recovery failed",
        fields: expect.objectContaining({ errorClass: "Error" }),
      }));
      expect(JSON.stringify(records)).not.toContain("cmk_PRIVATE_RECOVERY_KEY");
    } finally {
      removeNewProcessListeners(listenersBefore);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shuts down the coordinator before the daemon process exits", async () => {
    resetDiagnosticHarness();
    vi.useFakeTimers();
    const listenersBefore = processListenerSnapshot();
    const events: string[] = [];
    installDaemonHarness(dir, events);
    runnerDiagnosticHarness.shutdown.mockImplementation(async () => { events.push("coordinator-shutdown"); });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });

    try {
      void runPreparedDaemon(preparedDaemon(dir), {
        foreground: false,
        releaseOwnership: vi.fn(),
        onReady: ready,
      });
      await readyPromise;
      const original = listenersBefore.get("SIGTERM")!;
      const signalHandler = (process.listeners("SIGTERM") as Array<(...args: never[]) => unknown>)
        .find((listener) => !original.has(listener));
      expect(signalHandler).toEqual(expect.any(Function));
      signalHandler!();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

      expect(runnerDiagnosticHarness.shutdown).toHaveBeenCalledOnce();
      expect(events).toEqual(["coordinator-shutdown", "daemon-stop"]);
    } finally {
      removeNewProcessListeners(listenersBefore);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("maps collection errors to fixed PATCH codes without leaking a rejection to createDaemon", async () => {
    resetDiagnosticHarness();
    vi.useFakeTimers();
    const listenersBefore = processListenerSnapshot();
    const daemonHarness = installDaemonHarness(dir);
    const readyError = new Error("stop after ready receipt");
    const command = {
      type: "diagnostics:collect",
      reportId: "dbr_0123456789abcdef",
      agentId: "bot_1",
      fromMs: 1_700_000_000_000,
      deadlineAt: 1_700_087_000_000,
    };

    try {
      await expect(runPreparedDaemon(preparedDaemon(dir), {
        foreground: false,
        releaseOwnership: vi.fn(),
        onReady: () => { throw readyError; },
      })).rejects.toBe(readyError);
      const handle = daemonHarness.state.options?.handleDiagnosticCommand as
        (value: typeof command) => Promise<void>;

      runnerDiagnosticHarness.collect.mockRejectedValueOnce(
        Object.assign(new Error("bundle is too large"), { code: "bundle_too_large" }),
      );
      await expect(handle(command)).resolves.toBeUndefined();
      expect(runnerDiagnosticHarness.fail).toHaveBeenLastCalledWith(
        command.reportId,
        "bundle_too_large",
      );

      runnerDiagnosticHarness.collect.mockRejectedValueOnce(new Error("ordinary collection failure"));
      await expect(handle(command)).resolves.toBeUndefined();
      expect(runnerDiagnosticHarness.fail).toHaveBeenLastCalledWith(
        command.reportId,
        "collection_failed",
      );
      expect(runnerDiagnosticHarness.fail).not.toHaveBeenCalledWith(
        command.reportId,
        "diagnostics_unavailable",
      );
    } finally {
      removeNewProcessListeners(listenersBefore);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

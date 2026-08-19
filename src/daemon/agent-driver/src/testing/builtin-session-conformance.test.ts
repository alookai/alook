import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  ConfigOf,
} from "../contract.js";
import type { AdapterLaunchContext, SpawnedProcessHandle, VendorSessionHandle } from "../internal/adapter.js";
import { ClaudeDriver } from "../adapters/claude/index.js";
import { CodexDriver } from "../adapters/codex/index.js";
import { CursorDriver } from "../adapters/cursor/index.js";
import { OpenCodeDriver } from "../adapters/opencode/index.js";
import { PiDriver } from "../adapters/pi/index.js";
import { ProcessLane } from "../controller/process-host.js";
import { SdkLane } from "../controller/sdk-host.js";
import { createFakeAgentDriverHost } from "./fake-host.js";
import { createBuiltinAgentDriverRegistry } from "../registry.js";
import { createAgentDriverSdkWithRegistry } from "../sdk.js";

const configs: { [Id in BuiltinBackendId]: ConfigOf<BuiltinBackendSpecs, Id> } = {
  claude: { model: { kind: "default" }, provider: { kind: "default" }, mode: "default" },
  codex: { model: { kind: "default" }, mode: "default" },
  cursor: { model: { kind: "default" } },
  opencode: { model: { kind: "default" } },
  pi: { model: { kind: "default" }, provider: { kind: "default" } },
};

type HarnessProcess = SpawnedProcessHandle & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  finish(code?: number | null, signal?: NodeJS.Signals | null): void;
};

interface VendorHarness {
  readonly contexts: AdapterLaunchContext[];
  readonly processes: HarnessProcess[];
  readonly lanes: SdkLane[];
  readonly handles: Array<VendorSessionHandle & { isStreaming: boolean }>;
  sessionReady(turn: number): void;
  completeTurn(turn: number): void;
}

const workingDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of workingDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeProcess(): HarnessProcess {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
    finish(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      proc.exitCode = code;
      proc.signalCode = signal;
      proc.emit("exit", code, signal);
    },
  });
  return proc as unknown as HarnessProcess;
}

function installVendorHarness(backend: BuiltinBackendId): VendorHarness {
  const contexts: AdapterLaunchContext[] = [];
  const processes: HarnessProcess[] = [];
  const lanes: SdkLane[] = [];
  const handles: Array<VendorSessionHandle & { isStreaming: boolean }> = [];
  if (backend === "pi") {
    vi.spyOn(PiDriver.prototype, "openSdkSession").mockImplementation(async (ctx) => {
      contexts.push(ctx);
      const handle = {
        isStreaming: true,
        prompt: vi.fn(async () => {}),
        steer: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      };
      handles.push(handle);
      const lane = new SdkLane(handle, "pi-resumed");
      lanes.push(lane);
      return lane;
    });
  } else {
    const classes = { claude: ClaudeDriver, codex: CodexDriver, cursor: CursorDriver, opencode: OpenCodeDriver };
    vi.spyOn(classes[backend].prototype, "spawn").mockImplementation(async (ctx) => {
      contexts.push(ctx as AdapterLaunchContext);
      const process = fakeProcess();
      processes.push(process);
      return { process };
    });
  }

  const write = (value: unknown, index = processes.length - 1) => {
    processes[index]!.stdout.write(`${JSON.stringify(value)}\n`);
  };
  return {
    contexts,
    processes,
    lanes,
    handles,
    sessionReady(turn) {
      switch (backend) {
        case "claude":
          write({ type: "system", subtype: "init", session_id: "claude-resumed" });
          break;
        case "codex":
          if (turn === 1) write({ jsonrpc: "2.0", id: 2, result: { thread: { id: "codex-resumed" } } });
          write({ jsonrpc: "2.0", method: "turn/started", params: {
            threadId: "codex-resumed", turn: { id: `codex-turn-${turn}`, status: "inProgress" },
          } });
          break;
        case "cursor":
          write({ type: "system", subtype: "init", session_id: "cursor-resumed" });
          break;
        case "opencode":
          write({ type: "step_start", sessionID: "opencode-resumed" });
          break;
        case "pi":
          lanes[0]!.emitEvents([{ kind: "thinking", text: `turn-${turn}` }]);
          break;
      }
    },
    completeTurn(turn) {
      switch (backend) {
        case "claude":
          write({ type: "result", subtype: "success", session_id: "claude-resumed" });
          break;
        case "codex":
          write({ jsonrpc: "2.0", method: "turn/completed", params: {
            threadId: "codex-resumed", turn: { id: `codex-turn-${turn}`, status: "completed" },
          } });
          break;
        case "cursor":
          write({ type: "result", subtype: "success", session_id: "cursor-resumed" });
          break;
        case "opencode":
          write({ type: "step_finish", sessionID: "opencode-resumed", part: { reason: "stop" } });
          break;
        case "pi":
          handles[0]!.isStreaming = false;
          lanes[0]!.emitEvents([{ kind: "turn_end", sessionId: "pi-resumed" }]);
          break;
      }
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function runPublicSessionLifecycle(backend: BuiltinBackendId): Promise<void> {
  const harness = installVendorHarness(backend);
  const host = createFakeAgentDriverHost({
    environmentLayers: {
      base: { CONFORMANCE_BASE: backend },
      hostStatic: {}, identityProtected: {}, platformProtected: {}, runtimeProtected: {},
      networkProtected: {}, credentialSensitive: { CONFORMANCE_SECRET: "injected" },
    },
  });
  const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry(), hostReleaseTimeoutMs: 50 });
  const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-${backend}-`));
  workingDirectories.push(workingDirectory);
  const opened = await sdk.open({
    backend,
    config: configs[backend] as never,
    launch: {
      workingDirectory,
      instructions: { format: "markdown", content: "Conformance instructions" },
      resumeSessionId: `${backend}-resume-input`,
      launchId: `${backend}-public-conformance`,
    },
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const session = opened.session;
  const events: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
  const collecting = (async () => { for await (const event of session.events) events.push(event as never); })();

  expect(await session.send({ id: "early", kind: "user", text: "early" })).toMatchObject({ status: "rejected", reason: "not_started" });
  expect(await session.start({ id: "first", kind: "user", text: "first" })).toMatchObject({ status: "accepted" });
  harness.sessionReady(1);
  await settle();
  expect(harness.contexts[0]!.config.sessionId).toBe(`${backend}-resume-input`);
  expect(harness.contexts[0]!.prepared.environmentLayers).toMatchObject({
    base: { CONFORMANCE_BASE: backend },
    credentialSensitive: { CONFORMANCE_SECRET: "injected" },
  });

  const busy = await session.send({ id: "busy", kind: "user", text: "busy" });
  expect(busy.status).toBe(backend === "pi" ? "accepted" : "queued");
  const interrupted = await session.interrupt({ requestId: "interrupt-1", reason: "conformance" });
  expect(interrupted.status).toBe("accepted");
  harness.completeTurn(1);
  if (backend === "cursor" || backend === "opencode") harness.processes[0]!.finish();
  await settle();

  if (backend === "pi") {
    expect(await session.send({ id: "reuse", kind: "user", text: "reuse" })).toMatchObject({ status: "accepted" });
    harness.handles[0]!.isStreaming = true;
  }
  harness.sessionReady(2);
  await settle();
  harness.completeTurn(2);
  if (backend === "cursor" || backend === "opencode") harness.processes[1]!.finish();
  await settle();

  expect(await session.stop({ reason: "shutdown", forceAfterMs: 25 })).toMatchObject({ status: "accepted" });
  const closed = await session.closed;
  await collecting;
  expect(closed.outcome).toBe("stopped");
  expect(host.releases).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("session_closed");
  expect(events.filter((event) => event.type === "turn_completed").map((event) => event.type === "turn_completed" && event.result.outcome)).toContain("interrupted");
  expect(events.filter((event) => event.type === "command_accepted" && event.commandId === "busy")).toHaveLength(1);
}

describe.each(["claude", "codex", "cursor", "opencode", "pi"] as const)(
  "%s registered public-session lifecycle conformance",
  (backend) => {
    it("runs resume, busy admission, interrupt reuse, environment, release, and requested stop through sdk.open", async () => {
      await runPublicSessionLifecycle(backend);
    });

    it("settles a stop racing an in-flight registered-adapter open without late acceptance", async () => {
      const harness = installVendorHarness(backend);
      let releaseOpen!: () => void;
      const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
      const method = backend === "pi" ? "openSdkSession" : "spawn";
      const prototype = backend === "pi"
        ? PiDriver.prototype
        : ({ claude: ClaudeDriver, codex: CodexDriver, cursor: CursorDriver, opencode: OpenCodeDriver } as const)[backend].prototype;
      const existing = (prototype as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]!;
      existing.mockImplementationOnce(async (...args: unknown[]) => {
        await openGate;
        if (backend === "pi") return harness.lanes[0] ?? new SdkLane({
          isStreaming: false,
          prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
        }, "late-pi");
        const process = fakeProcess();
        harness.processes.push(process);
        return { process };
      });
      const host = createFakeAgentDriverHost();
      const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry(), hostReleaseTimeoutMs: 20 });
      const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-race-${backend}-`));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend,
        config: configs[backend] as never,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `race-${backend}` },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const events: string[] = [];
      const collecting = (async () => { for await (const event of opened.session.events) events.push(event.type); })();
      const starting = opened.session.start({ id: "racing", kind: "user", text: "racing" });
      const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
      releaseOpen();
      expect(await starting).toMatchObject({ status: "rejected" });
      expect(await stopping).toMatchObject({ status: "accepted" });
      await opened.session.closed;
      await collecting;
      expect(events.filter((type) => type === "command_failed")).toHaveLength(1);
      expect(events).not.toContain("command_accepted");
      expect(events.at(-1)).toBe("session_closed");
      expect(host.releases).toHaveLength(1);
    });

    it("scrubs and releases a registered-adapter failed start", async () => {
      installVendorHarness(backend);
      const method = backend === "pi" ? "openSdkSession" : "spawn";
      const prototype = backend === "pi"
        ? PiDriver.prototype
        : ({ claude: ClaudeDriver, codex: CodexDriver, cursor: CursorDriver, opencode: OpenCodeDriver } as const)[backend].prototype;
      (prototype as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]!.mockRejectedValueOnce(
        new Error("apiKey=supersecret failed at /Users/Alice Smith/private key.json"),
      );
      const host = createFakeAgentDriverHost();
      const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
      const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-failed-${backend}-`));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend,
        config: configs[backend] as never,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `failed-${backend}` },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const events: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
      const collecting = (async () => { for await (const event of opened.session.events) events.push(event as never); })();
      expect(await opened.session.start({ id: "failed", kind: "user", text: "failed" })).toMatchObject({ status: "rejected" });
      const closed = await opened.session.closed;
      await collecting;
      expect(closed.outcome).toBe("failed_to_start");
      expect(JSON.stringify({ closed, events })).not.toMatch(/supersecret|Alice Smith|private key/);
      expect(host.releases).toHaveLength(1);
      expect(host.releases[0]?.reason).toBe("failed_start");
    });

    it("settles stop before start through the public session and releases exactly once", async () => {
      installVendorHarness(backend);
      const host = createFakeAgentDriverHost();
      const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
      const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-prestart-${backend}-`));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend,
        config: configs[backend] as never,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `prestart-${backend}` },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(await opened.session.stop({ reason: "shutdown", forceAfterMs: 10 })).toMatchObject({ status: "accepted" });
      expect((await opened.session.closed).outcome).toBe("stopped");
      expect(host.releases).toHaveLength(1);
      expect(await opened.session.start({ id: "late", kind: "user", text: "late" })).toMatchObject({ status: "rejected", reason: "closed" });
    });

    it("settles a physical stop rejection as forced and still releases exactly once", async () => {
      installVendorHarness(backend);
      const laneStop = backend === "pi"
        ? vi.spyOn(SdkLane.prototype, "stop")
        : vi.spyOn(ProcessLane.prototype, "stop");
      laneStop.mockRejectedValueOnce(new Error("dispose rejected at /Users/Alice/private"));
      const host = createFakeAgentDriverHost();
      const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
      const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-reject-stop-${backend}-`));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend,
        config: configs[backend] as never,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `reject-stop-${backend}` },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      await opened.session.start({ id: "reject-stop", kind: "user", text: "start" });
      const receipt = await opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
      expect(receipt.status).toBe("failed");
      expect(JSON.stringify(receipt)).not.toContain("/Users/Alice");
      expect((await opened.session.closed).outcome).toBe("forced");
      expect(host.releases).toHaveLength(1);
    });

    it("forces a bounded stop and releases the registered adapter when its physical lane hangs", async () => {
      installVendorHarness(backend);
      const laneStop = backend === "pi"
        ? vi.spyOn(SdkLane.prototype, "stop")
        : vi.spyOn(ProcessLane.prototype, "stop");
      laneStop.mockImplementationOnce(() => new Promise<void>(() => {}));
      const host = createFakeAgentDriverHost();
      const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
      const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-force-${backend}-`));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend,
        config: configs[backend] as never,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `force-${backend}` },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      await opened.session.start({ id: "force", kind: "user", text: "force" });
      expect(await opened.session.stop({ reason: "stalled", forceAfterMs: 1 })).toMatchObject({ status: "accepted" });
      const closed = await opened.session.closed;
      expect(closed.outcome).toBe("forced");
      expect(host.releases).toHaveLength(1);
      expect(host.releases[0]?.reason).toBe("requested_stop");
    });
  },
);

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
import { capabilitiesFor, createAgentDriverRegistry, createBuiltinAgentDriverRegistry } from "../registry.js";
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
  readonly claudeInputUuids: readonly string[];
  readonly stdinMessages: readonly Record<string, unknown>[];
  sessionReady(turn: number): void;
  completeTurn(turn: number): void;
  duplicateTurn(turn: number, overrides?: Record<string, unknown>): void;
  completeTurnWithTail(turn: number, tail: readonly unknown[], sameChunk: boolean): void;
  emitProvider(event: unknown): void;
  replayClaudeInput(index: number): void;
  resultForClaudeInput(index: number, overrides?: Record<string, unknown>): void;
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
  const piPromptResolutions: Array<() => void> = [];
  const claudeTurnUuids: string[] = [];
  const claudeInputUuids: string[] = [];
  const stdinMessages: Record<string, unknown>[] = [];
  let claudeAckCursor = 0;
  if (backend === "pi") {
    vi.spyOn(PiDriver.prototype, "openSdkSession").mockImplementation(async (ctx) => {
      contexts.push(ctx);
      const handle = {
        isStreaming: false,
        prompt: vi.fn(() => new Promise<void>((resolve) => { piPromptResolutions.push(resolve); })),
        steer: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      };
      handles.push(handle);
      const lane = new SdkLane(handle, "pi-resumed", { terminalOnPromptSettled: true });
      lanes.push(lane);
      return lane;
    });
  } else {
    const classes = { claude: ClaudeDriver, codex: CodexDriver, cursor: CursorDriver, opencode: OpenCodeDriver };
    if (backend === "claude") {
      const beginTurn = ClaudeDriver.prototype.beginTurn;
      vi.spyOn(ClaudeDriver.prototype, "beginTurn").mockImplementation(function (this: ClaudeDriver) {
        const receipt = beginTurn.call(this);
        const uuid = receipt.slice("claude:".length);
        claudeTurnUuids.push(uuid);
        claudeInputUuids.push(uuid);
        return receipt;
      });
      const encodeMessage = ClaudeDriver.prototype.encodeMessage;
      vi.spyOn(ClaudeDriver.prototype, "encodeMessage").mockImplementation(function (
        this: ClaudeDriver,
        text,
        sessionId,
        opts,
      ) {
        const encoded = encodeMessage.call(this, text, sessionId, opts);
        if (opts?.mode === "busy") claudeInputUuids.push(JSON.parse(encoded).uuid);
        return encoded;
      });
    }
    vi.spyOn(classes[backend].prototype, "spawn").mockImplementation(async (ctx) => {
      contexts.push(ctx as AdapterLaunchContext);
      const process = fakeProcess();
      let stdinBuffer = "";
      process.stdin.on("data", (chunk) => {
        stdinBuffer += chunk.toString();
        const lines = stdinBuffer.split("\n");
        stdinBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) stdinMessages.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
      processes.push(process);
      return { process };
    });
  }

  const write = (value: unknown, index = processes.length - 1) => {
    processes[index]!.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const acknowledgeClaudeInputs = () => {
    for (const uuid of claudeInputUuids.slice(claudeAckCursor)) {
      write({
        type: "user",
        isReplay: true,
        uuid,
        session_id: "claude-resumed",
        message: { role: "user", content: [{ type: "text", text: "ack" }] },
      });
    }
    claudeAckCursor = claudeInputUuids.length;
  };
  const claudeTerminal = (turn: number, overrides: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    session_id: "claude-resumed",
    user_message_uuid: claudeTurnUuids[turn - 1],
    duration_ms: turn,
    ...overrides,
  });
  return {
    contexts,
    processes,
    lanes,
    handles,
    claudeInputUuids,
    stdinMessages,
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
          handles[0]!.isStreaming = true;
          lanes[0]!.emitEvents([{ kind: "thinking", text: `turn-${turn}` }]);
          break;
      }
    },
    completeTurn(turn) {
      switch (backend) {
        case "claude":
          acknowledgeClaudeInputs();
          write(claudeTerminal(turn));
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
          piPromptResolutions[turn - 1]!();
          break;
      }
    },
    duplicateTurn(turn, overrides = {}) {
      switch (backend) {
        case "claude":
          write(claudeTerminal(turn, overrides));
          break;
        case "codex":
          write({ jsonrpc: "2.0", method: "turn/completed", params: {
            threadId: "codex-resumed", turn: { id: `codex-turn-${turn}`, status: "completed" },
          } });
          break;
        case "cursor":
        case "opencode":
          throw new Error(`${backend} has a process-per-turn lane instead of a persistent terminal fence`);
        case "pi":
          throw new Error("pi terminals are owned by prompt promise settlement, not vendor event payloads");
      }
    },
    completeTurnWithTail(turn, tail, sameChunk) {
      if (backend !== "claude") throw new Error("terminal tail fixture is Claude-specific");
      acknowledgeClaudeInputs();
      const events = [claudeTerminal(turn), ...tail];
      if (sameChunk) {
        processes[0]!.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      } else {
        for (const event of events) write(event, 0);
      }
    },
    emitProvider(event) {
      write(event);
    },
    replayClaudeInput(index) {
      if (backend !== "claude") throw new Error("replay acknowledgements are Claude-specific");
      const uuid = claudeInputUuids[index];
      if (!uuid) throw new Error(`missing Claude input UUID at index ${index}`);
      write({
        type: "user",
        isReplay: true,
        uuid,
        session_id: "claude-resumed",
        message: { role: "user", content: [{ type: "text", text: "ack" }] },
      });
    },
    resultForClaudeInput(index, overrides = {}) {
      if (backend !== "claude") throw new Error("input-owned results are Claude-specific");
      const uuid = claudeInputUuids[index];
      if (!uuid) throw new Error(`missing Claude input UUID at index ${index}`);
      write({
        type: "result",
        subtype: "success",
        session_id: "claude-resumed",
        user_message_uuid: uuid,
        ...overrides,
      });
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

  if (backend === "pi" || backend === "claude" || backend === "codex") {
    expect(await session.send({ id: "reuse", kind: "user", text: "reuse" })).toMatchObject({ status: "accepted" });
    if (backend === "pi") harness.handles[0]!.isStreaming = true;
  }
  harness.sessionReady(2);
  await settle();
  harness.completeTurn(2);
  if (backend === "cursor" || backend === "opencode") harness.processes[1]!.finish();
  await settle();

  const stopping = session.stop({ reason: "shutdown", forceAfterMs: 25 });
  if (backend === "claude") harness.processes[0]!.finish();
  expect(await stopping).toMatchObject({ status: "accepted" });
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
      const settlementOrder: string[] = [];
      void opened.session.closed.then(() => { settlementOrder.push("session_closed"); });
      const starting = opened.session.start({ id: "racing", kind: "user", text: "racing" });
      void starting.then(() => { settlementOrder.push("start_resolved"); });
      const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
      releaseOpen();
      expect(await starting).toMatchObject({ status: "rejected" });
      expect(await stopping).toMatchObject({ status: "accepted" });
      await opened.session.closed;
      await starting;
      await collecting;
      expect(settlementOrder.indexOf("session_closed")).toBeLessThan(settlementOrder.indexOf("start_resolved"));
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

    it("closes as crashed on an unexpected registered-backend physical exit and releases exactly once", async () => {
      const harness = installVendorHarness(backend);
      const host = createFakeAgentDriverHost();
      const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
      const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-crash-${backend}-`));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend,
        config: configs[backend] as never,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `crash-${backend}` },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const events: string[] = [];
      const collecting = (async () => { for await (const event of opened.session.events) events.push(event.type); })();
      expect(await opened.session.start({ id: "crash", kind: "user", text: "crash" })).toMatchObject({ status: "accepted" });
      if (backend === "pi") harness.lanes[0]!.reportUnexpectedExit();
      else harness.processes[0]!.finish(17, null);
      expect((await opened.session.closed).outcome).toBe("crashed");
      await collecting;
      expect(events).toContain("session_failed");
      expect(events.at(-1)).toBe("session_closed");
      expect(host.releases).toHaveLength(1);
      expect(host.releases[0]?.reason).toBe("crash");
    });
  },
);

describe("pi registered public-session lifecycle conformance", () => {
  it("completes a clean SDK dispose before the force timer without waiting for its deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = installVendorHarness("pi");
      const host = createFakeAgentDriverHost();
      const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
      const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-clean-dispose-pi-"));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend: "pi",
        config: configs.pi,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "clean-dispose-pi" },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      await opened.session.start({ id: "clean-dispose", kind: "user", text: "clean" });
      harness.handles[0]!.isStreaming = false;
      await vi.advanceTimersByTimeAsync(25);
      const stopped = opened.session.stop({ reason: "shutdown", forceAfterMs: 60_000 });
      expect(await stopped).toMatchObject({ status: "accepted" });
      expect((await opened.session.closed).outcome).toBe("stopped");
      expect(harness.handles[0]!.dispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("codex persistent terminal ownership", () => {
  it("keeps turn B active when turn A's terminal is duplicated after B starts", async () => {
    const backend = "codex" as const;
    const harness = installVendorHarness(backend);
    const host = createFakeAgentDriverHost();
    const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
    const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-terminal-owner-${backend}-`));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend,
      config: configs[backend] as never,
      launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `terminal-owner-${backend}` },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event as never); })();

    const first = await opened.session.start({ id: "first", kind: "user", text: "first" });
    expect(first.status).toBe("accepted");
    harness.sessionReady(1);
    harness.completeTurn(1);
    await settle();
    const second = await opened.session.send({ id: "second", kind: "user", text: "second" });
    expect(second.status).toBe("accepted");
    harness.sessionReady(2);
    await settle();
    harness.duplicateTurn(1);
    await settle();
    expect(opened.session.snapshot().activeTurn?.turnId).toBe(second.status === "accepted" ? second.turnId : "unreachable");
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    harness.completeTurn(2);
    await settle();
    expect(opened.session.snapshot().activeTurn).toBeUndefined();
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
    await opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
    await collecting;
  });
});

describe("claude persistent transport ownership", () => {
  it("accepts identical legitimate terminals while a late prior-turn duplicate stays fenced on one process", async () => {
    const backend = "claude" as const;
    const harness = installVendorHarness(backend);
    const host = createFakeAgentDriverHost();
    const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-terminal-owner-claude-"));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend,
      config: configs.claude,
      launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "terminal-owner-claude" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, "claude">> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();

    const first = await opened.session.start({ id: "first", kind: "user", text: "same" });
    expect(first.status).toBe("accepted");
    harness.sessionReady(1);
    harness.completeTurn(1);
    await settle();
    const second = await opened.session.send({ id: "second", kind: "user", text: "same" });
    expect(second.status).toBe("accepted");
    expect(harness.processes).toHaveLength(1);
    harness.sessionReady(2);

    for (let index = 0; index < 128; index += 1) {
      harness.duplicateTurn(1);
    }
    await settle();
    expect(opened.session.snapshot().activeTurn?.turnId).toBe(second.status === "accepted" ? second.turnId : "unreachable");
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);

    harness.completeTurn(2);
    await settle();
    expect(opened.session.snapshot().activeTurn).toBeUndefined();
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
    expect(harness.contexts).toHaveLength(1);
    const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
    harness.processes[0]!.finish();
    await stopping;
    await collecting;
  });

  it("drops stale errored-result side effects before they can poison the active turn", async () => {
    const harness = installVendorHarness("claude");
    const sdk = createAgentDriverSdkWithRegistry({
      host: createFakeAgentDriverHost(),
      registry: createBuiltinAgentDriverRegistry(),
    });
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-stale-error-claude-"));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend: "claude",
      config: configs.claude,
      launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "stale-error-claude" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, "claude">> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();

    await opened.session.start({ id: "first", kind: "user", text: "first" });
    harness.sessionReady(1);
    harness.completeTurn(1);
    await settle();
    const second = await opened.session.send({ id: "second", kind: "user", text: "second" });
    expect(second.status).toBe("accepted");
    harness.sessionReady(2);
    harness.duplicateTurn(1, {
      is_error: true,
      result: "stale failure",
      usage: { input_tokens: 99, output_tokens: 99 },
    });
    await settle();
    expect(opened.session.snapshot().activeTurn?.turnId).toBe(second.status === "accepted" ? second.turnId : "unreachable");
    expect(events.filter((event) => event.type === "diagnostic")).toHaveLength(0);
    expect(events.filter((event) => event.type === "token_usage")).toHaveLength(0);

    harness.completeTurn(2);
    await settle();
    const completions = events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions.at(-1)).toMatchObject({ result: { outcome: "success" } });
    const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
    harness.processes[0]!.finish();
    await stopping;
    await collecting;
  });

  it("fences a prior-turn stdout tail until the next root replay acknowledgement", async () => {
    const harness = installVendorHarness("claude");
    const sdk = createAgentDriverSdkWithRegistry({
      host: createFakeAgentDriverHost(),
      registry: createBuiltinAgentDriverRegistry(),
    });
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-cross-turn-tail-claude-"));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend: "claude",
      config: configs.claude,
      launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "cross-turn-tail-claude" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, "claude">> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();

    await opened.session.start({ id: "first", kind: "user", text: "first" });
    harness.sessionReady(1);
    harness.completeTurn(1);
    await settle();
    expect(await opened.session.send({ id: "second", kind: "user", text: "second" }))
      .toMatchObject({ status: "accepted" });

    harness.emitProvider({ type: "assistant", message: { content: [{ type: "text", text: "LATE_A" }] } });
    harness.emitProvider({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "late-tool", name: "LateTool", input: {} }] },
    });
    harness.emitProvider({ type: "system", subtype: "status", status: "late-progress" });
    await settle();
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(0);
    expect(events.filter((event) => event.type === "tool_started")).toHaveLength(0);
    expect(events.filter((event) => event.type === "internal_progress")).toHaveLength(0);

    harness.sessionReady(2);
    harness.replayClaudeInput(1);
    harness.emitProvider({ type: "assistant", message: { content: [{ type: "text", text: "B_TEXT" }] } });
    harness.emitProvider({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b-tool", name: "CurrentTool", input: {} }] },
    });
    harness.emitProvider({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "b-tool", content: "done" }] },
    });
    harness.resultForClaudeInput(1);
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
    });
    expect(events.filter((event) => event.type === "text_delta")).toMatchObject([{ text: "B_TEXT" }]);
    expect(events.filter((event) => event.type === "tool_started")).toMatchObject([{ name: "CurrentTool" }]);
    expect(harness.processes).toHaveLength(1);

    const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
    harness.processes[0]!.finish();
    await stopping;
    await collecting;
  });

  it.each([true, false] as const)(
    "drops provider work after a final result (%s chunk) and starts B on the same process",
    async (sameChunk) => {
      const harness = installVendorHarness("claude");
      const sdk = createAgentDriverSdkWithRegistry({
        host: createFakeAgentDriverHost(),
        registry: createBuiltinAgentDriverRegistry(),
      });
      const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-terminal-tail-claude-"));
      workingDirectories.push(workingDirectory);
      const opened = await sdk.open({
        backend: "claude",
        config: configs.claude,
        launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "terminal-tail-claude" },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const events: Array<AgentEvent<BuiltinBackendSpecs, "claude">> = [];
      const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();

      await opened.session.start({ id: "first", kind: "user", text: "first" });
      harness.sessionReady(1);
      harness.completeTurnWithTail(1, [
        { type: "assistant", message: { content: [{ type: "text", text: "late text" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "LateTool", input: {} }] } },
        { type: "system", subtype: "status", status: "late-progress" },
      ], sameChunk);
      await settle();
      expect(opened.session.snapshot().activeTurn).toBeUndefined();
      expect(events.filter((event) => event.type === "text_delta")).toHaveLength(0);
      expect(events.filter((event) => event.type === "tool_started")).toHaveLength(0);
      expect(events.filter((event) => event.type === "internal_progress")).toHaveLength(0);

      const second = await opened.session.send({ id: "second", kind: "user", text: "second" });
      expect(second.status).toBe("accepted");
      expect(harness.processes).toHaveLength(1);
      harness.sessionReady(2);
      harness.completeTurn(2);
      await settle();
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
      const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
      harness.processes[0]!.finish();
      await stopping;
      await collecting;
    },
  );

  it("delivers high-frequency FIFO steering inside one turn and one process across a follow-on provider segment", async () => {
    const harness = installVendorHarness("claude");
    const sdk = createAgentDriverSdkWithRegistry({
      host: createFakeAgentDriverHost(),
      registry: createBuiltinAgentDriverRegistry(),
    });
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-steering-claude-"));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend: "claude",
      config: configs.claude,
      launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "steering-claude" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, "claude">> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();

    await opened.session.start({ id: "root", kind: "user", text: "root" });
    harness.sessionReady(1);
    harness.replayClaudeInput(0);
    harness.emitProvider({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
    });
    await settle();

    const steering = Array.from({ length: 9 }, (_, index) => ({
      id: `steer-${index + 1}`,
      text: `steer-${index + 1}`,
    }));
    for (const message of steering) {
      expect(await opened.session.send({ id: message.id, kind: "user", text: message.text }))
        .toEqual({ status: "queued", reason: "unsafe_boundary", commandId: message.id });
    }
    expect(harness.stdinMessages).toHaveLength(0);

    harness.emitProvider({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] },
    });
    await vi.waitFor(() => expect(harness.stdinMessages).toHaveLength(9));
    expect(harness.processes).toHaveLength(1);
    expect(harness.stdinMessages.map((frame) => frame.priority)).toEqual(Array(9).fill("now"));
    for (const [index, frame] of harness.stdinMessages.entries()) {
      expect(frame).toMatchObject({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: steering[index]!.text }] },
      });
    }
    const wireUuids = harness.stdinMessages.map((frame) => frame.uuid);
    expect(new Set(wireUuids).size).toBe(9);
    expect(wireUuids).toEqual(harness.claudeInputUuids.slice(1));
    await vi.waitFor(() => {
      expect(opened.session.snapshot()).toMatchObject({
        activeTurn: { commandIds: ["root", ...steering.map((message) => message.id)] },
        queuedCommands: [],
      });
    });
    await vi.waitFor(() => {
      for (const message of steering) {
        expect(events.filter((event) => event.type === "command_accepted" && event.commandId === message.id))
          .toHaveLength(1);
      }
    });

    harness.resultForClaudeInput(0);
    await settle();
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    expect(opened.session.snapshot().activeTurn).toBeDefined();

    for (let index = 1; index <= steering.length; index += 1) harness.replayClaudeInput(index);
    harness.resultForClaudeInput(1);
    await settle();
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    harness.resultForClaudeInput(steering.length);
    await settle();
    const completions = events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      commandIds: ["root", ...steering.map((message) => message.id)],
      result: { outcome: "success" },
    });
    expect(harness.processes).toHaveLength(1);

    const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
    harness.processes[0]!.finish();
    await stopping;
    await collecting;
  });

  it("keeps ten sequential turns on one stdin/stdout process", async () => {
    const harness = installVendorHarness("claude");
    const host = createFakeAgentDriverHost();
    const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-terminal-tail-claude-"));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend: "claude",
      config: configs.claude,
      launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "terminal-tail-claude" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, "claude">> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();
    for (let turn = 1; turn <= 10; turn += 1) {
      const receipt = turn === 1
        ? await opened.session.start({ id: `message-${turn}`, kind: "user", text: `turn-${turn}` })
        : await opened.session.send({ id: `message-${turn}`, kind: "user", text: `turn-${turn}` });
      expect(receipt.status).toBe("accepted");
      harness.sessionReady(turn);
      harness.completeTurn(turn);
      await settle();
    }
    expect(harness.processes).toHaveLength(1);
    expect(harness.contexts).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(10);
    const stopping = opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
    harness.processes[0]!.finish();
    await stopping;
    await collecting;
  });
});

it("Pi real adapter public chain owns identical turns by prompt invocation and ignores old completion duplicates", async () => {
  let notify!: (event: unknown) => void;
  const prompts: Array<{ resolve: () => void; promise: Promise<void> }> = [];
  const vendor = {
    prompt: vi.fn(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      prompts.push({ resolve, promise });
      return promise;
    }),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    isStreaming: false,
    subscribe(listener: (event: unknown) => void) { notify = listener; return () => {}; },
  };
  const adapter = new PiDriver(() => ({
    buildSpawnEnv: async () => ({}),
    createAgentSession: async () => ({ session: vendor, sessionId: "pi-terminal-owner" }),
  } as never));
  const registry = createAgentDriverRegistry<BuiltinBackendSpecs>([{
    id: "pi",
    capabilities: capabilitiesFor("pi"),
    createAdapter: () => adapter,
  }] as never);
  const host = createFakeAgentDriverHost();
  const sdk = createAgentDriverSdkWithRegistry<BuiltinBackendSpecs>({ host, registry });
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-terminal-owner-pi-"));
  workingDirectories.push(workingDirectory);
  const opened = await sdk.open({
    backend: "pi",
    config: configs.pi,
    launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: "terminal-owner-pi" },
  });
  if (!opened.ok) throw new Error(opened.error.message);
  const events: Array<AgentEvent<BuiltinBackendSpecs, "pi">> = [];
  const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();
  await opened.session.start({ id: "first", kind: "user", text: "first" });
  const firstTerminal = { type: "agent_end", messages: [] };
  notify(firstTerminal);
  prompts[0]!.resolve();
  await prompts[0]!.promise;
  await settle();
  const second = await opened.session.send({ id: "second", kind: "user", text: "second" });
  expect(second.status).toBe("accepted");
  for (let index = 0; index < 128; index += 1) {
    notify(firstTerminal);
    prompts[0]!.resolve();
  }
  await settle();
  expect(opened.session.snapshot().activeTurn?.turnId).toBe(second.status === "accepted" ? second.turnId : "unreachable");
  expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  notify({ type: "agent_end", messages: [] });
  prompts[1]!.resolve();
  await prompts[1]!.promise;
  await settle();
  expect(opened.session.snapshot().activeTurn).toBeUndefined();
  expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
  await opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
  await collecting;
});

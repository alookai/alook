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
import type {
  AdapterEvent,
  AdapterLaunchContext,
  LaneAdmission,
  LaneInterruptInput,
  LaneSendInput,
  LaneStartInput,
  LaneStopInput,
  RuntimeLane,
  RuntimeLaneEventMap,
  SpawnedProcessHandle,
  VendorSessionHandle,
} from "../internal/adapter.js";
import { ClaudeDriver } from "../adapters/claude/index.js";
import { CodexDriver } from "../adapters/codex/index.js";
import { CursorDriver } from "../adapters/cursor/index.js";
import { CursorAcpLane } from "../adapters/cursor/acp-lane.js";
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
  readonly openCodeLanes: HarnessRuntimeLane[];
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

class HarnessRuntimeLane implements RuntimeLane {
  private readonly events = new EventEmitter();
  currentSessionId: string | null = "opencode-resumed";
  rootReceipt: string | undefined;

  on<K extends keyof RuntimeLaneEventMap>(event: K, listener: (value: RuntimeLaneEventMap[K]) => void): void {
    this.events.on(event, listener);
  }

  start(input: LaneStartInput): Promise<LaneAdmission> {
    this.rootReceipt = input.terminalOwner ?? "msg_opencode_root";
    return Promise.resolve({ ok: true, acceptedAs: "prompt", receipt: this.rootReceipt });
  }

  send(input: LaneSendInput): Promise<LaneAdmission> {
    if (input.mode === "idle") this.rootReceipt = input.terminalOwner ?? "msg_opencode_idle";
    return Promise.resolve({
      ok: true,
      acceptedAs: input.mode === "busy" ? "steer" : "prompt",
      receipt: input.mode === "busy" ? "msg_opencode_steer" : this.rootReceipt!,
    });
  }

  interrupt(_input: LaneInterruptInput): Promise<boolean> {
    return Promise.resolve(true);
  }

  stop(_input: LaneStopInput): Promise<void> {
    return Promise.resolve();
  }

  emit(event: AdapterEvent): void {
    this.events.emit("runtime_event", event);
  }

  reportUnexpectedExit(code = 17, signal: string | null = null): void {
    this.events.emit("exit", { code, signal, reason: "runtime_exit" } satisfies RuntimeLaneEventMap["exit"]);
  }
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
  const openCodeLanes: HarnessRuntimeLane[] = [];
  const handles: Array<VendorSessionHandle & { isStreaming: boolean }> = [];
  const piPromptResolutions: Array<() => void> = [];
  const claudeTurnUuids: string[] = [];
  const claudeInputUuids: string[] = [];
  const stdinMessages: Record<string, unknown>[] = [];
  let claudeAckCursor = 0;
  if (backend === "pi") {
    vi.spyOn(PiDriver.prototype, "openLane").mockImplementation(async (ctx) => {
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
  } else if (backend === "opencode") {
    vi.spyOn(OpenCodeDriver.prototype, "openLane").mockImplementation(async (ctx) => {
      contexts.push(ctx);
      const lane = new HarnessRuntimeLane();
      openCodeLanes.push(lane);
      return lane;
    });
  } else {
    const classes = { claude: ClaudeDriver, codex: CodexDriver, cursor: CursorDriver };
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
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          stdinMessages.push(message);
          if (backend !== "cursor") continue;
          const respond = (result: unknown) => process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result,
          })}\n`);
          if (message.method === "initialize") {
            respond({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
            });
          } else if (message.method === "authenticate") {
            respond({});
          } else if (message.method === "session/load") {
            const params = message.params as { sessionId?: string } | undefined;
            respond({ sessionId: params?.sessionId ?? "cursor-resumed", configOptions: [] });
          } else if (message.method === "session/new") {
            respond({ sessionId: "cursor-resumed", configOptions: [] });
          }
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
    openCodeLanes,
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
          break;
        case "opencode":
          openCodeLanes[0]!.emit({ kind: "assistant_reasoning_completed", text: `turn-${turn}` });
          break;
        case "pi":
          handles[0]!.isStreaming = true;
          lanes[0]!.emitEvents([{ kind: "assistant_reasoning_delta", text: `turn-${turn}` }]);
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
          {
            const prompts = stdinMessages.filter((message) => message.method === "session/prompt");
            const prompt = prompts[turn - 1]!;
            write({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
          }
          break;
        case "opencode":
          openCodeLanes[0]!.emit({
            kind: "turn_end",
            sessionId: "opencode-resumed",
            turnOwner: openCodeLanes[0]!.rootReceipt,
          });
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
        case "cursor": {
          const prompts = stdinMessages.filter((message) => message.method === "session/prompt");
          const prompt = prompts[turn - 1]!;
          write({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn", ...overrides } });
          break;
        }
        case "opencode":
          openCodeLanes[0]!.emit({
            kind: "turn_end",
            sessionId: "opencode-resumed",
            turnOwner: openCodeLanes[0]!.rootReceipt,
          });
          break;
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

async function settlePromptAdmission<T>(
  backend: BuiltinBackendId,
  harness: VendorHarness,
  turn: number,
  pending: Promise<T>,
): Promise<T> {
  if (backend === "codex") {
    await vi.waitFor(() => expect(harness.processes).toHaveLength(1));
    harness.sessionReady(turn);
  }
  return pending;
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
  const first = session.start({ id: "first", kind: "user", text: "first" });
  expect(await settlePromptAdmission(backend, harness, 1, first)).toMatchObject({ status: "accepted" });
  if (backend !== "codex") harness.sessionReady(1);
  await settle();
  expect(harness.contexts[0]!.config.sessionId).toBe(`${backend}-resume-input`);
  expect(harness.contexts[0]!.prepared.environmentLayers).toMatchObject({
    base: { CONFORMANCE_BASE: backend },
    credentialSensitive: { CONFORMANCE_SECRET: "injected" },
  });

  const busy = await session.send({ id: "busy", kind: "user", text: "busy" });
  expect(busy.status).toBe(backend === "pi" || backend === "opencode" || backend === "cursor" ? "accepted" : "queued");
  const interrupted = await session.interrupt({ requestId: "interrupt-1", reason: "conformance" });
  expect(interrupted.status).toBe("accepted");
  if (backend === "claude") {
    expect(harness.stdinMessages).toContainEqual({
      type: "control_request",
      request_id: "interrupt-1",
      request: { subtype: "interrupt" },
    });
    expect(harness.processes[0]!.kill).not.toHaveBeenCalled();
  } else if (backend === "codex") {
    expect(harness.stdinMessages).toContainEqual(expect.objectContaining({
      method: "turn/interrupt",
      params: { threadId: "codex-resumed", turnId: "codex-turn-1" },
    }));
    expect(harness.processes[0]!.kill).not.toHaveBeenCalled();
  }
  harness.completeTurn(1);
  await settle();

  if (backend === "cursor") {
    await vi.waitFor(() => {
      expect(harness.stdinMessages.filter((message) => message.method === "session/prompt")).toHaveLength(2);
    });
    harness.completeTurn(2);
    await settle();
    const reuse = session.send({ id: "reuse", kind: "user", text: "reuse" });
    expect(await settlePromptAdmission(backend, harness, 3, reuse)).toMatchObject({ status: "accepted" });
    harness.sessionReady(3);
    await settle();
    harness.completeTurn(3);
  } else if (backend === "pi" || backend === "claude" || backend === "codex" || backend === "opencode") {
    const reuse = session.send({ id: "reuse", kind: "user", text: "reuse" });
    expect(await settlePromptAdmission(backend, harness, 2, reuse)).toMatchObject({ status: "accepted" });
    if (backend === "pi") harness.handles[0]!.isStreaming = true;
  }
  if (backend !== "cursor") {
    if (backend !== "codex") harness.sessionReady(2);
    await settle();
    harness.completeTurn(2);
    await settle();
  }

  if (backend === "claude" || backend === "codex") {
    expect(harness.processes).toHaveLength(1);
    expect(harness.processes[0]!.kill).not.toHaveBeenCalled();
  }

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

async function openRegisteredHarness(backend: BuiltinBackendId, label: string) {
  const harness = installVendorHarness(backend);
  const host = createFakeAgentDriverHost();
  const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry(), hostReleaseTimeoutMs: 50 });
  const workingDirectory = mkdtempSync(join(tmpdir(), `agent-driver-${label}-${backend}-`));
  workingDirectories.push(workingDirectory);
  const opened = await sdk.open({
    backend,
    config: configs[backend] as never,
    launch: { workingDirectory, instructions: { format: "markdown", content: "" }, launchId: `${label}-${backend}` },
  });
  if (!opened.ok) throw new Error(opened.error.message);
  const events: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
  const collecting = (async () => { for await (const event of opened.session.events) events.push(event as never); })();
  return { session: opened.session, harness, host, events, collecting };
}

async function stopRegisteredHarness(
  backend: BuiltinBackendId,
  fixture: Awaited<ReturnType<typeof openRegisteredHarness>>,
): Promise<void> {
  const stopping = fixture.session.stop({ reason: "shutdown", forceAfterMs: 25 });
  if (backend === "claude") fixture.harness.processes[0]?.finish();
  await stopping;
  await fixture.session.closed;
  await fixture.collecting;
}

function emitStaleTerminal(backend: BuiltinBackendId, harness: VendorHarness): void {
  if (backend === "opencode") {
    harness.openCodeLanes[0]!.emit({
      kind: "turn_end",
      sessionId: "opencode-resumed",
      turnOwner: "msg_opencode_root",
    });
    return;
  }
  if (backend === "pi") {
    harness.lanes[0]!.emitEvents([{ kind: "turn_end", sessionId: "pi-resumed", turnOwner: "pi-stale" }]);
    return;
  }
  harness.duplicateTurn(1);
}

describe.each(["claude", "codex", "cursor", "opencode", "pi"] as const)(
  "%s shared persistent stress conformance",
  (backend) => {
    it("runs ten sequential public turns through one physical open", async () => {
      const fixture = await openRegisteredHarness(backend, "shared-ten-turn");
      for (let turn = 1; turn <= 10; turn += 1) {
        const pending = turn === 1
          ? fixture.session.start({ id: `turn-${turn}`, kind: "user", text: `turn ${turn}` })
          : fixture.session.send({ id: `turn-${turn}`, kind: "user", text: `turn ${turn}` });
        expect(await settlePromptAdmission(backend, fixture.harness, turn, pending)).toMatchObject({ status: "accepted" });
        if (backend !== "codex") fixture.harness.sessionReady(turn);
        fixture.harness.completeTurn(turn);
        await vi.waitFor(() => expect(fixture.session.snapshot().activeTurn).toBeUndefined());
      }
      expect(fixture.session.snapshot().diagnostics.metrics).toMatchObject({
        physicalOpenCount: 1,
        turnCount: 10,
        commandAdmissionCount: 10,
      });
      await vi.waitFor(() => expect(fixture.events.filter((event) => event.type === "turn_completed")).toHaveLength(10));
      await stopRegisteredHarness(backend, fixture);
    });

    it("settles a ten-command busy/terminal/idle burst exactly once in FIFO order", async () => {
      const fixture = await openRegisteredHarness(backend, "shared-high-frequency");
      const ids = Array.from({ length: 10 }, (_, index) => `command-${index}`);
      const first = fixture.session.start({ id: ids[0]!, kind: "user", text: ids[0]! });
      await settlePromptAdmission(backend, fixture.harness, 1, first);
      if (backend !== "codex") fixture.harness.sessionReady(1);

      const busy = ids.slice(1, 6).map((id) => fixture.session.send({ id, kind: "user", text: id }));
      await Promise.all(busy);
      fixture.harness.completeTurn(backend === "cursor" ? 6 : 1);
      await settle();

      const idleBurst = ids.slice(6).map((id) => fixture.session.send({ id, kind: "user", text: id }));
      if (backend === "codex") {
        await vi.waitFor(() => expect(fixture.session.snapshot().diagnostics.deliveryPhase).toBe("admission_wait"));
        fixture.harness.sessionReady(2);
      }
      await Promise.all(idleBurst);
      if (backend !== "codex" && backend !== "cursor") fixture.harness.sessionReady(2);
      let turn = backend === "cursor" ? 10 : 2;
      let staleTerminalEmitted = false;
      let completedTurnId: string | undefined;
      while (
        fixture.session.snapshot().diagnostics.metrics.commandAdmissionCount < ids.length
        || fixture.session.snapshot().activeTurn
      ) {
        await vi.waitFor(() => {
          const activeTurnId = fixture.session.snapshot().activeTurn?.turnId;
          expect(activeTurnId).toBeDefined();
          expect(activeTurnId).not.toBe(completedTurnId);
        });
        if (backend === "codex" && fixture.session.snapshot().diagnostics.deliveryPhase === "admission_wait") {
          fixture.harness.sessionReady(turn);
          await vi.waitFor(() => expect(fixture.session.snapshot().diagnostics.deliveryPhase).not.toBe("admission_wait"));
        }
        if (!staleTerminalEmitted) {
          emitStaleTerminal(backend, fixture.harness);
          staleTerminalEmitted = true;
          await settle();
          expect(fixture.session.snapshot().activeTurn).toBeDefined();
        }
        completedTurnId = fixture.session.snapshot().activeTurn!.turnId;
        fixture.harness.completeTurn(turn);
        turn += 1;
        if (turn > 11) throw new Error(`${backend} did not drain the ten-command FIFO`);
        await settle();
      }
      await vi.waitFor(() => {
        expect(fixture.events.filter((event) => event.type === "command_accepted" || event.type === "command_failed"))
          .toHaveLength(ids.length);
      });

      const finalEvents = fixture.events.filter((event) => event.type === "command_accepted" || event.type === "command_failed");
      expect(finalEvents.map((event) => event.commandId)).toEqual(ids);
      for (const id of ids) expect(finalEvents.filter((event) => event.commandId === id)).toHaveLength(1);
      expect(fixture.session.snapshot().diagnostics.metrics).toMatchObject({
        physicalOpenCount: 1,
        commandAdmissionCount: 10,
      });
      await stopRegisteredHarness(backend, fixture);
    });
  },
);

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
      const laneOwned = backend === "pi" || backend === "opencode";
      const method = laneOwned ? "openLane" : "spawn";
      const prototype = backend === "pi"
        ? PiDriver.prototype
        : backend === "opencode"
          ? OpenCodeDriver.prototype
        : ({ claude: ClaudeDriver, codex: CodexDriver, cursor: CursorDriver, opencode: OpenCodeDriver } as const)[backend].prototype;
      const existing = (prototype as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]!;
      existing.mockImplementationOnce(async (...args: unknown[]) => {
        await openGate;
        if (backend === "pi") return harness.lanes[0] ?? new SdkLane({
          isStreaming: false,
          prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
        }, "late-pi");
        if (backend === "opencode") return harness.openCodeLanes[0] ?? new HarnessRuntimeLane();
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
      const laneOwned = backend === "pi" || backend === "opencode";
      const method = laneOwned ? "openLane" : "spawn";
      const prototype = backend === "pi"
        ? PiDriver.prototype
        : backend === "opencode"
          ? OpenCodeDriver.prototype
          : ({ claude: ClaudeDriver, codex: CodexDriver, cursor: CursorDriver } as const)[backend].prototype;
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
      const harness = installVendorHarness(backend);
      const laneStop = backend === "pi"
        ? vi.spyOn(SdkLane.prototype, "stop")
        : backend === "cursor"
          ? vi.spyOn(CursorAcpLane.prototype, "stop")
          : backend === "opencode"
            ? vi.spyOn(HarnessRuntimeLane.prototype, "stop")
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
      await settlePromptAdmission(
        backend,
        harness,
        1,
        opened.session.start({ id: "reject-stop", kind: "user", text: "start" }),
      );
      const receipt = await opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
      expect(receipt.status).toBe("failed");
      expect(JSON.stringify(receipt)).not.toContain("/Users/Alice");
      expect((await opened.session.closed).outcome).toBe("forced");
      expect(host.releases).toHaveLength(1);
    });

    it("forces a bounded stop and releases the registered adapter when its physical lane hangs", async () => {
      const harness = installVendorHarness(backend);
      const laneStop = backend === "pi"
        ? vi.spyOn(SdkLane.prototype, "stop")
        : backend === "cursor"
          ? vi.spyOn(CursorAcpLane.prototype, "stop")
          : backend === "opencode"
            ? vi.spyOn(HarnessRuntimeLane.prototype, "stop")
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
      await settlePromptAdmission(
        backend,
        harness,
        1,
        opened.session.start({ id: "force", kind: "user", text: "force" }),
      );
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
      expect(await settlePromptAdmission(
        backend,
        harness,
        1,
        opened.session.start({ id: "crash", kind: "user", text: "crash" }),
      )).toMatchObject({ status: "accepted" });
      if (backend === "pi") harness.lanes[0]!.reportUnexpectedExit();
      else if (backend === "opencode") harness.openCodeLanes[0]!.reportUnexpectedExit();
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

    const firstPending = opened.session.start({ id: "first", kind: "user", text: "first" });
    const first = await settlePromptAdmission(backend, harness, 1, firstPending);
    expect(first.status).toBe("accepted");
    harness.completeTurn(1);
    await settle();
    const secondPending = opened.session.send({ id: "second", kind: "user", text: "second" });
    const second = await settlePromptAdmission(backend, harness, 2, secondPending);
    expect(second.status).toBe("accepted");
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

describe("cursor persistent ACP ownership", () => {
  it("steers a busy message on the wire and lets only the current JSON-RPC id settle the root", async () => {
    const harness = installVendorHarness("cursor");
    const host = createFakeAgentDriverHost();
    const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-terminal-owner-cursor-"));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend: "cursor",
      config: configs.cursor,
      launch: {
        workingDirectory,
        instructions: { format: "markdown", content: "" },
        launchId: "terminal-owner-cursor",
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, "cursor">> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();

    expect(await opened.session.start({ id: "first", kind: "user", text: "same" }))
      .toMatchObject({ status: "accepted" });
    expect(harness.stdinMessages.filter((message) => message.method === "session/prompt")).toHaveLength(1);
    expect(await opened.session.send({ id: "second", kind: "user", text: "same" }))
      .toMatchObject({ status: "accepted", delivery: "steer", commandId: "second" });
    expect(harness.stdinMessages.filter((message) => message.method === "session/prompt")).toHaveLength(2);
    expect(opened.session.snapshot().activeTurn?.commandIds).toEqual(["first", "second"]);

    harness.completeTurn(1);
    await settle();
    harness.duplicateTurn(1);
    await settle();
    expect(opened.session.snapshot().activeTurn?.commandIds).toEqual(["first", "second"]);
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);

    harness.completeTurn(2);
    await vi.waitFor(() => expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1));
    expect(events.filter((event) => event.type === "turn_completed")).toMatchObject([{
      commandIds: ["first", "second"],
      result: { outcome: "success" },
    }]);
    expect(harness.processes).toHaveLength(1);
    await opened.session.stop({ reason: "shutdown", forceAfterMs: 10 });
    await collecting;
  });

  it("keeps ten sequential public root turns on one process and one ACP session", async () => {
    const harness = installVendorHarness("cursor");
    const host = createFakeAgentDriverHost();
    const sdk = createAgentDriverSdkWithRegistry({ host, registry: createBuiltinAgentDriverRegistry() });
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-ten-turn-cursor-"));
    workingDirectories.push(workingDirectory);
    const opened = await sdk.open({
      backend: "cursor",
      config: configs.cursor,
      launch: {
        workingDirectory,
        instructions: { format: "markdown", content: "" },
        launchId: "ten-turn-cursor",
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const events: Array<AgentEvent<BuiltinBackendSpecs, "cursor">> = [];
    const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();

    for (let turn = 1; turn <= 10; turn += 1) {
      const receipt = turn === 1
        ? await opened.session.start({ id: `cursor-${turn}`, kind: "user", text: "same" })
        : await opened.session.send({ id: `cursor-${turn}`, kind: "user", text: "same" });
      expect(receipt.status).toBe("accepted");
      harness.completeTurn(turn);
      await vi.waitFor(() => {
        expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(turn);
      });
    }
    expect(harness.processes).toHaveLength(1);
    expect(harness.contexts).toHaveLength(1);
    expect(harness.stdinMessages.filter((message) => message.method === "session/new")).toHaveLength(1);
    expect(harness.stdinMessages.filter((message) => message.method === "session/prompt")).toHaveLength(10);
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
    expect(events.filter((event) => event.type === "assistant_message_completed")).toHaveLength(0);
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
    expect(events.filter((event) => event.type === "assistant_message_completed")).toMatchObject([{ text: "B_TEXT" }]);
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
      expect(events.filter((event) => event.type === "assistant_message_completed")).toHaveLength(0);
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
    contractVersion: 1,
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

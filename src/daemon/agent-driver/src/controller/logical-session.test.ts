import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type {
  AgentEvent,
  BuiltinBackendId,
  BuiltinBackendSpecs,
  ConfigOf,
  PreparedExecutionResource,
} from "../contract.js";
import type {
  BackendAdapter, BackendExecution, AdapterLaunchContext, AdapterEvent, LaneAdmission, LaneSendInput,
  LaneStartInput, RuntimeLane, RuntimeLaneEventMap, RuntimeLaneOpenOptions,
} from "../internal/adapter.js";
import { createFakeAgentDriverHost } from "../testing/fake-host.js";
import { runAgentDriverConformance } from "../testing/conformance.js";
import { LogicalAgentSession } from "./logical-session.js";
import { createProcessLane, ProcessLane } from "./process-host.js";
import { SdkLane } from "./sdk-host.js";
import { capabilitiesFor } from "../registry.js";

const configs: Record<BuiltinBackendId, unknown> = {
  claude: { model: { kind: "default" }, provider: { kind: "default" }, mode: "default" },
  codex: { model: { kind: "default" }, mode: "default" },
  cursor: { model: { kind: "default" } },
  opencode: { model: { kind: "default" } },
  pi: { model: { kind: "default" }, provider: { kind: "default" } },
};

class FakeDriver implements BackendAdapter {
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly currentSessionId = null;
  readonly processes: Array<ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough }> = [];
  readonly spawnContexts: AdapterLaunchContext[] = [];
  readonly writes: string[] = [];
  lane?: SdkLane;
  sdkHandle?: {
    isStreaming: boolean;
    prompt: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  failSpawn?: Error;
  failPrompt?: Error;
  failAbort?: Error;
  failDispose?: Error;
  rejectWrites = false;
  hangDispose = false;
  spawnGate?: Promise<void>;
  sdkOpenGate?: Promise<void>;
  laneOverride?: RuntimeLane;
  promptAdmissionTimeoutMs?: number;
  beginTurn: (() => string) | undefined = () => {
    this.currentTerminalOwner = `${this.id}:test:${++this.terminalSequence}`;
    return this.currentTerminalOwner;
  };
  private terminalSequence = 0;
  currentTerminalOwner?: string;

  constructor(readonly id: BuiltinBackendId, readonly execution: BackendExecution) {}
  probe() { return { status: "healthy" as const }; }
  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    if (this.laneOverride) return this.laneOverride;
    if (this.execution.transport.kind === "in_process_sdk") return this.createSdkLane(ctx);
    return createProcessLane(this, ctx, {
      onRawStdoutLine: options?.onRawStdoutLine,
      stopAfterTurn: this.id === "opencode",
      promptAdmissionTimeoutMs: this.promptAdmissionTimeoutMs,
    });
  }
  async spawn(ctx: AdapterLaunchContext) {
    await this.spawnGate;
    if (this.failSpawn) throw this.failSpawn;
    this.spawnContexts.push(ctx);
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough };
    this.processes.push(proc);
    return { process: proc };
  }
  async createSdkLane(_ctx: AdapterLaunchContext): Promise<SdkLane> {
    await this.sdkOpenGate;
    const handle = {
      isStreaming: false,
      prompt: vi.fn(async () => {
        if (this.failPrompt) throw this.failPrompt;
      }),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {
        if (this.failAbort) throw this.failAbort;
      }),
      dispose: vi.fn(() => {
        if (this.failDispose) return Promise.reject(this.failDispose);
        return this.hangDispose ? new Promise<void>(() => {}) : Promise.resolve();
      }),
    };
    this.sdkHandle = handle;
    this.lane = new SdkLane(handle, "sdk-session");
    return this.lane;
  }
  normalizeLine(line: string): AdapterEvent[] { return [JSON.parse(line) as AdapterEvent]; }
  encodeMessage(text: string): string {
    this.writes.push(text);
    return this.rejectWrites ? "" : text;
  }
}

class ControlledRuntimeLane implements RuntimeLane {
  readonly currentSessionId = null;
  readonly events = new EventEmitter();
  startAdmission: LaneAdmission = { ok: true, acceptedAs: "prompt", receipt: "claude:test:1" };
  sendAdmission: LaneAdmission = { ok: true, acceptedAs: "prompt", receipt: "claude:test:2" };
  onStart?: (input: LaneStartInput) => void;
  onSend?: (input: LaneSendInput) => void;
  readonly stop = vi.fn(async () => {});
  readonly interrupt = vi.fn(async () => false);

  on<K extends keyof RuntimeLaneEventMap>(
    event: K,
    listener: (value: RuntimeLaneEventMap[K]) => void,
  ): void {
    this.events.on(event, listener);
  }
  start(input: LaneStartInput): Promise<LaneAdmission> {
    this.onStart?.(input);
    return Promise.resolve(this.startAdmission);
  }
  send(input: LaneSendInput): Promise<LaneAdmission> {
    this.onSend?.(input);
    return Promise.resolve(this.sendAdmission);
  }
  emit(event: AdapterEvent): void {
    this.events.emit("runtime_event", event);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function executionFor(backend: BuiltinBackendId): BackendExecution {
  if (backend === "opencode") {
    return {
      lifetime: "session",
      transport: { kind: "http_sse", protocol: "opencode.test.v2" },
      wakeStart: "immediate",
      terminalOwnership: "transport_request",
    };
  }
  if (backend === "cursor") {
    return {
      lifetime: "session",
      transport: { kind: "stdio_rpc", protocol: "cursor.test.v1" },
      wakeStart: "immediate",
      terminalOwnership: "transport_request",
    };
  }
  return backend === "pi"
    ? {
        lifetime: "session",
        transport: { kind: "in_process_sdk", protocol: "pi.test.v1" },
        wakeStart: "immediate",
        terminalOwnership: "prompt_invocation",
      }
    : {
        lifetime: "session",
        transport: { kind: "stdio_stream", protocol: `${backend}.test.v1` },
        wakeStart: "immediate",
        terminalOwnership: "vendor_message",
      };
}

function makeSession<Id extends BuiltinBackendId>(
  backend: Id,
  options: {
    prepared?: PreparedExecutionResource;
    timeout?: number;
    resumeSessionId?: string;
    workingDirectory?: string;
    instructions?: string;
    execution?: BackendExecution;
    lane?: RuntimeLane;
    authoritativeOwner?: boolean;
    promptAdmissionTimeoutMs?: number;
  } = {},
) {
  const driver = new FakeDriver(backend, options.execution ?? executionFor(backend));
  driver.laneOverride = options.lane;
  driver.promptAdmissionTimeoutMs = options.promptAdmissionTimeoutMs;
  if (options.authoritativeOwner) driver.beginTurn = undefined;
  const host = createFakeAgentDriverHost(options.prepared);
  const prepared: PreparedExecutionResource = {
    environmentLayers: {
      base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {},
      runtimeProtected: {}, networkProtected: {}, credentialSensitive: {},
    },
    async release(input) { host.releases.push(input); },
    ...options.prepared,
  };
  const session = new LogicalAgentSession<BuiltinBackendSpecs, Id>(
    backend,
    configs[backend] as never,
    {
      workingDirectory: options.workingDirectory ?? process.cwd(),
      instructions: options.instructions ?? "",
      launchId: `launch-${backend}`,
      resumeSessionId: options.resumeSessionId,
    },
    driver as unknown as BackendAdapter<Id, ConfigOf<BuiltinBackendSpecs, Id>>,
    capabilitiesFor(backend),
    host,
    prepared,
    options.timeout ?? 100,
  );
  return { session, driver, host };
}

async function emit(driver: FakeDriver, event: AdapterEvent): Promise<void> {
  emitNow(driver, event);
  await Promise.resolve();
}

function emitNow(driver: FakeDriver, event: AdapterEvent): void {
  const ownedEvent = event.kind === "turn_end" && !event.turnOwner && driver.currentTerminalOwner
    ? { ...event, turnOwner: driver.currentTerminalOwner }
    : event;
  if (driver.id === "pi") driver.lane!.emitEvents([ownedEvent]);
  else driver.processes.at(-1)!.stdout.write(`${JSON.stringify(ownedEvent)}\n`);
}

async function take(
  iterator: AsyncIterator<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>>,
  count: number,
) {
  const events: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
  while (events.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  return events;
}

describe.each(["claude", "codex", "cursor", "opencode", "pi"] as const)("%s logical-session conformance", (backend) => {
  it("passes the exported black-box conformance suite", async () => {
    const { session, driver } = makeSession(backend);
    await runAgentDriverConformance(async () => ({
      session,
      async completeFirstTurn() {
        await emit(driver, { kind: "turn_end", sessionId: `${backend}-session` });
        if (driver.execution.lifetime === "turn") {
          driver.processes[0].emit("exit", 0, null);
          await Promise.resolve();
        }
      },
    }));
  });

  it("rejects send-before-start, preserves idempotency, and rejects a second start", async () => {
    const { session } = makeSession(backend);
    expect(await session.send({ id: "early", kind: "user", text: "early" })).toEqual({ status: "rejected", reason: "not_started" });
    const first = session.start({ id: "one", kind: "user", text: "hello" });
    const duplicate = session.start({ id: "one", kind: "user", text: "hello" });
    expect(await duplicate).toEqual(await first);
    expect(await session.start({ id: "two", kind: "user", text: "again" })).toEqual({ status: "rejected", reason: "already_started" });
    expect(await session.send({ id: "one", kind: "user", text: "different" })).toEqual({ status: "rejected", reason: "duplicate_conflict" });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("attaches the iterator before start and loses no normalized event", async () => {
    const { session, driver } = makeSession(backend);
    const iterator = session.events[Symbol.asyncIterator]() as AsyncIterator<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>>;
    const pending = take(iterator, 5);
    await session.start({ id: "one", kind: "user", text: "hello" });
    await emit(driver, { kind: "session_init", sessionId: backend === "pi" ? "sdk-session" : `${backend}-session` });
    await emit(driver, { kind: "thinking", text: "think" });
    await emit(driver, { kind: "text", text: "answer" });
    const events = await pending;
    expect(events.map((event) => event.type)).toEqual([
      "command_accepted", "turn_started", "session_started", "thinking_delta", "text_delta",
    ]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });
});

describe("runtime-lane admission state machine", () => {
  it("rejects a lane start without ever publishing command acceptance", async () => {
    const lane = new ControlledRuntimeLane();
    lane.startAdmission = { ok: false, reason: "vendor_rejected" };
    const { session, host } = makeSession("claude", { lane });
    const iterator = session.events[Symbol.asyncIterator]();

    await expect(session.start({ id: "one", kind: "user", text: "start" })).resolves.toMatchObject({
      status: "rejected",
      reason: "runtime_unavailable",
    });
    await expect(session.closed).resolves.toMatchObject({ outcome: "failed_to_start" });
    const events = await take(iterator as never, 99);
    expect(events.some((event) => event.type === "command_accepted" || event.type === "turn_started")).toBe(false);
    expect(events.find((event) => event.type === "command_failed")).toMatchObject({
      commandId: "one",
      error: { code: "failed_to_start" },
    });
    expect(lane.stop).toHaveBeenCalledOnce();
    expect(host.releases).toHaveLength(1);
  });

  it.each(["reset_required", "incompatible_configuration"] as const)(
    "preserves structured %s admission failures for reset and configuration UX",
    async (reason) => {
      const lane = new ControlledRuntimeLane();
      lane.startAdmission = { ok: false, reason, error: `Cursor ACP ${reason}` };
      const { session } = makeSession("cursor", { lane });
      const iterator = session.events[Symbol.asyncIterator]();

      await expect(session.start({ id: "one", kind: "user", text: "start" })).resolves.toMatchObject({
        status: "rejected",
        reason: "runtime_unavailable",
        error: { category: "configuration", code: reason, retryable: false },
      });
      await expect(session.closed).resolves.toMatchObject({
        outcome: "failed_to_start",
        error: { category: "configuration", code: reason, retryable: false },
      });
      const events = await take(iterator as never, 99);
      expect(events.find((event) => event.type === "command_failed")).toMatchObject({
        error: { category: "configuration", code: reason, retryable: false },
      });
    },
  );

  it("fails a silent authoritative admission without publishing acceptance and stops its process", async () => {
    vi.useFakeTimers();
    try {
      const { session, driver, host } = makeSession("codex", {
        authoritativeOwner: true,
        promptAdmissionTimeoutMs: 25,
      });
      const iterator = session.events[Symbol.asyncIterator]();
      const starting = session.start({ id: "one", kind: "user", text: "start" });
      await vi.advanceTimersByTimeAsync(0);
      expect(driver.processes).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);
      await expect(starting).resolves.toMatchObject({
        status: "rejected",
        reason: "runtime_unavailable",
      });
      await expect(session.closed).resolves.toMatchObject({ outcome: "failed_to_start" });
      const events = await take(iterator as never, 99);
      expect(events.some((event) => event.type === "command_accepted" || event.type === "turn_started")).toBe(false);
      expect(events.find((event) => event.type === "command_failed")).toMatchObject({
        commandId: "one",
        error: { code: "failed_to_start" },
      });
      expect(events.find((event) => event.type === "session_failed")).toMatchObject({
        error: { code: "failed_to_start" },
      });
      expect(driver.processes[0]!.kill).toHaveBeenCalledOnce();
      expect(driver.processes[0]!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(host.releases).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders a synchronous matching terminal after acceptance and settles the turn", async () => {
    const lane = new ControlledRuntimeLane();
    lane.onStart = (input) => {
      lane.emit({ kind: "session_init", sessionId: "vendor-session" });
      lane.emit({ kind: "turn_end", sessionId: "vendor-session", turnOwner: input.terminalOwner });
    };
    const { session } = makeSession("claude", { lane });
    const iterator = session.events[Symbol.asyncIterator]();

    await expect(session.start({ id: "one", kind: "user", text: "start" })).resolves.toMatchObject({
      status: "accepted",
      commandId: "one",
    });
    expect(session.snapshot()).toMatchObject({ state: "idle", activeTurn: undefined });
    const events = await take(iterator as never, 4);
    expect(events.map((event) => event.type)).toEqual([
      "command_accepted",
      "turn_started",
      "session_started",
      "turn_completed",
    ]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("ignores a forged terminal owner and completes only for the admission receipt", async () => {
    const lane = new ControlledRuntimeLane();
    const { session } = makeSession("claude", { lane });
    const iterator = session.events[Symbol.asyncIterator]();
    const started = await session.start({ id: "one", kind: "user", text: "start" });
    expect(started).toMatchObject({ status: "accepted" });

    lane.emit({ kind: "turn_end", sessionId: "vendor-session", turnOwner: "owner-wrong" });
    await Promise.resolve();
    expect(session.snapshot().activeTurn).toBeDefined();
    lane.emit({ kind: "turn_end", sessionId: "vendor-session", turnOwner: "claude:test:1" });
    await Promise.resolve();
    expect(session.snapshot()).toMatchObject({ state: "idle", activeTurn: undefined });
    const events = await take(iterator as never, 4);
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("rejects an idle send on an existing lane without publishing acceptance", async () => {
    const lane = new ControlledRuntimeLane();
    const { session } = makeSession("claude", { lane });
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    lane.emit({ kind: "turn_end", turnOwner: "claude:test:1" });
    await Promise.resolve();
    lane.sendAdmission = { ok: false, reason: "vendor_rejected" };

    await expect(session.send({ id: "two", kind: "user", text: "next" })).resolves.toMatchObject({
      status: "rejected",
      reason: "runtime_unavailable",
    });
    await expect(session.closed).resolves.toMatchObject({ outcome: "failed_to_start" });
    const events = await take(iterator as never, 99);
    expect(events.filter((event) => event.type === "command_accepted" && event.commandId === "two")).toHaveLength(0);
    expect(events.find((event) => event.type === "command_failed" && event.commandId === "two")).toMatchObject({
      error: { code: "failed_to_start" },
    });
    expect(lane.stop).toHaveBeenCalledOnce();
  });
});

describe("closed physical-lane tombstone", () => {
  it("drops every closed per-turn lane tail before it can poison the next turn boundary", async () => {
    const { session, driver } = makeSession("claude", {
      execution: {
        lifetime: "turn",
        transport: { kind: "one_shot_cli", protocol: "test.one-shot.v1" },
        wakeStart: "immediate",
        terminalOwnership: "lane_generation",
      },
    });
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "a", kind: "user", text: "first" });
    await emit(driver, { kind: "turn_end", sessionId: "root" });
    await emit(driver, { kind: "tool_call", name: "late", input: {} });
    await emit(driver, { kind: "compaction_started" });
    await emit(driver, { kind: "review_started" });
    await emit(driver, { kind: "error", message: "late error" });
    await emit(driver, { kind: "internal_progress", source: "late", itemType: "tail" });
    driver.processes[0]!.emit("exit", 0, null);
    await Promise.resolve();

    const second = await session.send({ id: "b", kind: "user", text: "second" });
    expect(second.status).toBe("accepted");
    await emit(driver, { kind: "tool_call", name: "current", input: {} });
    expect(await session.send({ id: "c", kind: "user", text: "third" })).toEqual({
      status: "queued",
      reason: "unsafe_boundary",
      commandId: "c",
    });
    await emit(driver, { kind: "tool_output", name: "current" });
    await vi.waitFor(() => {
      expect(session.snapshot()).toMatchObject({
        activeTurn: { commandIds: ["b", "c"] },
        queuedCommands: [],
      });
    });

    const observed: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
    while (observed.length < 10) {
      const next = await iterator.next();
      if (next.done) break;
      observed.push(next.value);
    }
    expect(observed.filter((event) => event.type === "internal_progress")).toHaveLength(0);
    expect(observed.filter((event) => event.type === "diagnostic")).toHaveLength(0);
    expect(observed.filter((event) => event.type === "command_accepted" && event.commandId === "c"))
      .toHaveLength(1);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("reopens only for proven same-lane root work, re-closes once, and suppresses bare duplicate terminals", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    const receipt = await session.start({ id: "one", kind: "user", text: "start" });
    expect(receipt).toMatchObject({ status: "accepted" });
    const turnId = receipt.status === "accepted" ? receipt.turnId : "unreachable";

    await emit(driver, { kind: "turn_end", sessionId: "root-session" });
    await emit(driver, { kind: "turn_end", sessionId: "root-session" });
    await emit(driver, {
      kind: "telemetry",
      name: "rate_limits",
      source: "tail-telemetry",
      attrs: { remaining: 1 },
    });
    expect(session.snapshot().activeTurn).toBeUndefined();

    await emit(driver, {
      kind: "internal_progress",
      source: "root-owner",
      itemType: "post-terminal-work",
    });
    expect(session.snapshot().activeTurn).toEqual({ turnId, commandIds: ["one"] });

    await emit(driver, { kind: "turn_end", sessionId: "root-session" });
    await emit(driver, { kind: "turn_end", sessionId: "root-session" });
    expect(session.snapshot().activeTurn).toBeUndefined();

    const observed = await take(iterator as never, 7);
    expect(observed.map((event) => event.type)).toEqual([
      "command_accepted",
      "turn_started",
      "session_started",
      "turn_completed",
      "rate_limits",
      "internal_progress",
      "turn_completed",
    ]);
    expect(observed.filter((event) => event.type === "turn_completed")).toHaveLength(2);
    expect(observed.find((event) => event.type === "internal_progress")).toMatchObject({ turnId });
    expect(observed.find((event) => event.type === "rate_limits")).toMatchObject({ turnId: undefined });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("rejects a prior receipt after the next turn starts and accepts only the new terminal owner", async () => {
    const { session, driver } = makeSession("claude");
    const first = await session.start({ id: "one", kind: "user", text: "first" });
    const firstOwner = driver.currentTerminalOwner!;
    await emit(driver, { kind: "turn_end", sessionId: "root", turnOwner: firstOwner });
    const second = await session.send({ id: "two", kind: "user", text: "second" });
    const secondOwner = driver.currentTerminalOwner!;
    await emit(driver, { kind: "turn_end", sessionId: "root", turnOwner: firstOwner });
    expect(session.snapshot().activeTurn?.turnId).toBe(second.status === "accepted" ? second.turnId : "unreachable");
    await emit(driver, { kind: "turn_end", sessionId: "root", turnOwner: secondOwner });
    expect(session.snapshot().activeTurn).toBeUndefined();
    expect(first.status).toBe("accepted");
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("does not reopen a tombstone for a different physical owner or generation", async () => {
    const { session, driver } = makeSession("claude");
    await session.start({ id: "one", kind: "user", text: "first" });
    await emit(driver, { kind: "turn_end", sessionId: "root" });
    const reopened = (session as any).reopenClosedLaneForWork(
      { kind: "text", text: "stale" },
      new SdkLane({ prompt: async () => {}, steer: async () => {} }, "other"),
      99,
    );
    expect(reopened).toBeUndefined();
    expect(session.snapshot().activeTurn).toBeUndefined();
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });
});

it("returns not_running when an SDK lane declines interrupt without disturbing the active turn", async () => {
  const { session } = makeSession("pi");
  const started = await session.start({ id: "one", kind: "user", text: "first" });
  expect(await session.interrupt({ requestId: "no-op", reason: "test" })).toEqual({ status: "not_running" });
  expect(session.snapshot().activeTurn?.turnId).toBe(started.status === "accepted" ? started.turnId : "unreachable");
  await session.stop({ reason: "shutdown", forceAfterMs: 10 });
});

describe("backend-owned delivery behavior", () => {
  it("writes AGENTS.md and the CLAUDE.md alias for non-empty instructions", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-instructions-"));
    try {
      const { session } = makeSession("claude", { workingDirectory, instructions: "Be useful." });
      await session.start({ id: "one", kind: "user", text: "start" });
      expect(readFileSync(join(workingDirectory, "AGENTS.md"), "utf8")).toBe("Be useful.");
      expect(lstatSync(join(workingDirectory, "CLAUDE.md")).isSymbolicLink()).toBe(true);
      await session.stop({ reason: "shutdown", forceAfterMs: 10 });
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it.each(["claude", "codex"] as const)("%s queues mid-turn and flushes at a safe boundary", async (backend) => {
    const { session, driver } = makeSession(backend);
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    expect(await session.send({ id: "two", kind: "user", text: "follow" })).toEqual({ status: "queued", reason: "unsafe_boundary", commandId: "two" });
    expect(session.snapshot().queuedCommands).toEqual([{ commandId: "two", kind: "user" }]);
    expect(driver.writes).toEqual([]);
    await emit(driver, { kind: "compaction_finished" });
    expect(driver.writes).toEqual(["follow"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it.each(["claude", "codex"] as const)("%s preserves FIFO and distinct ids for identical queued text", async (backend) => {
    const { session, driver } = makeSession(backend);
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    expect(await session.send({ id: "same-a", kind: "user", text: "same" })).toMatchObject({ status: "queued" });
    expect(await session.send({ id: "same-b", kind: "user", text: "same" })).toMatchObject({ status: "queued" });
    await emit(driver, { kind: "compaction_finished" });
    expect(driver.writes).toEqual(["same", "same"]);
    const accepted: string[] = [];
    while (accepted.length < 2) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "command_accepted" && next.value.commandId.startsWith("same-")) {
        accepted.push(next.value.commandId);
      }
    }
    expect(accepted).toEqual(["same-a", "same-b"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it.each(["claude", "codex"] as const)("%s flushes a message that arrives at an already-safe boundary", async (backend) => {
    const { session, driver } = makeSession(backend);
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });

    expect(await session.send({ id: "two", kind: "user", text: "follow" })).toEqual({
      status: "queued",
      reason: "unsafe_boundary",
      commandId: "two",
    });
    await vi.waitFor(() => expect(driver.writes).toEqual(["follow"]));
    expect(session.snapshot()).toMatchObject({
      activeTurn: { commandIds: ["one", "two"] },
      queuedCommands: [],
    });
    const events = await take(iterator as never, 4);
    expect(events.filter((event) => event.type === "command_accepted" && event.commandId === "two"))
      .toHaveLength(1);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("flushes a safe-boundary message queued while the persistent lane is still starting", async () => {
    const { session, driver } = makeSession("claude");
    const gate = deferred();
    driver.spawnGate = gate.promise;
    const starting = session.start({ id: "one", kind: "user", text: "start" });
    await Promise.resolve();
    expect(await session.send({ id: "two", kind: "user", text: "follow" })).toEqual({
      status: "queued",
      reason: "unsafe_boundary",
      commandId: "two",
    });
    gate.resolve();
    await expect(starting).resolves.toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(driver.writes).toEqual(["follow"]));
    expect(session.snapshot()).toMatchObject({
      activeTurn: { commandIds: ["one", "two"] },
      queuedCommands: [],
    });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("starts OpenCode immediately and admits later system/user input as FIFO steers", async () => {
    const { session, driver } = makeSession("opencode");
    const iterator = session.events[Symbol.asyncIterator]();
    expect(await session.start({ id: "system-a", kind: "system", text: "a" })).toMatchObject({ status: "accepted", delivery: "prompt" });
    expect(await session.send({ id: "system-b", kind: "system", text: "b" })).toMatchObject({ status: "accepted", delivery: "steer" });
    expect(await session.send({ id: "user", kind: "user", text: "go" })).toMatchObject({ status: "accepted", delivery: "steer" });
    const events = await take(iterator as never, 4);
    expect(events.filter((event) => event.type === "command_accepted").map((event) => event.commandId))
      .toEqual(["system-a", "system-b", "user"]);
    expect(session.snapshot().activeTurn).toMatchObject({ commandIds: ["system-a", "system-b", "user"] });
    expect(driver.writes).toEqual(["b", "go"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("derives deferred first-message behavior from the adapter execution declaration", async () => {
    const { session, driver } = makeSession("cursor", {
      execution: {
        lifetime: "turn",
        transport: { kind: "one_shot_cli", protocol: "test.deferred.v1" },
        wakeStart: "deferred",
        terminalOwnership: "lane_generation",
      },
    });
    expect(await session.start({ id: "system", kind: "system", text: "standing" })).toEqual({
      status: "queued",
      reason: "waiting_for_message",
      commandId: "system",
    });
    expect(driver.processes).toHaveLength(0);
    expect(await session.send({ id: "user", kind: "user", text: "go" })).toMatchObject({ status: "accepted" });
    expect(driver.processes).toHaveLength(1);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("reuses an open SDK lane for the next physical turn", async () => {
    const { session, driver } = makeSession("pi");
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "turn_end", sessionId: "sdk-session" });
    expect(await session.send({ id: "two", kind: "user", text: "next" })).toMatchObject({
      status: "accepted",
      commandId: "two",
    });
    expect(driver.sdkHandle!.prompt).toHaveBeenCalledTimes(2);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("reports an adapter interrupt rejection without changing the active turn", async () => {
    const { session, driver } = makeSession("pi");
    await session.start({ id: "one", kind: "user", text: "start" });
    driver.failAbort = new Error("abort rejected");
    driver.sdkHandle!.isStreaming = true;
    expect(await session.interrupt({ requestId: "interrupt", reason: "user" })).toMatchObject({
      status: "failed",
      error: { code: "interrupt_failed" },
    });
    expect(session.snapshot().activeTurn?.commandIds).toEqual(["one"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("normalizes progress, diagnostics, telemetry, and circular telemetry details", async () => {
    const { session, driver } = makeSession("pi");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await emit(driver, { kind: "internal_progress", source: "pi", itemType: "working", payloadBytes: 12 });
    await emit(driver, { kind: "runtime_diagnostic", severity: "notice", source: "pi", message: "heads up" });
    await emit(driver, { kind: "telemetry", name: "token_usage", source: "pi", attrs: circular } as never);
    await emit(driver, { kind: "telemetry", name: "rate_limits", source: "pi", attrs: { remaining: 1 } });
    const events = await take(iterator as never, 7);
    expect(events.map((event) => event.type)).toEqual([
      "command_accepted",
      "turn_started",
      "session_started",
      "internal_progress",
      "diagnostic",
      "token_usage",
      "rate_limits",
    ]);
    expect(events[4]).toMatchObject({ severity: "info", message: "heads up" });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("forwards process stderr as raw output and a warning diagnostic", async () => {
    const { session, driver, host } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    driver.processes[0]!.stderr.write("warning text\n");
    await Promise.resolve();
    const events = await take(iterator as never, 3);
    expect(events.at(-1)).toMatchObject({ type: "diagnostic", severity: "warning", message: "warning text" });
    expect(host.rawOutput.at(-1)).toMatchObject({ stream: "stderr", text: "warning text" });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("fails every still-queued command when the session stops", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await session.send({ id: "two", kind: "user", text: "follow" });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
    const events = await take(iterator as never, 6);
    expect(events.filter((event) => event.type === "command_failed")).toMatchObject([
      { commandId: "two", error: { code: "session_stopping" } },
    ]);
  });

  it("emits command_failed for every safe-boundary delivery rejection", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await session.send({ id: "two", kind: "user", text: "follow two" });
    await session.send({ id: "three", kind: "user", text: "follow three" });
    driver.rejectWrites = true;
    await emit(driver, { kind: "compaction_finished" });
    const events = await take(iterator as never, 8);
    expect(events.filter((event) => event.type === "command_failed").map((event) => event.commandId))
      .toEqual(["two", "three"]);
    expect(session.snapshot().queuedCommands).toEqual([]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("single-flights same-tick safe boundaries and delivers queued commands exactly once in FIFO order", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await session.send({ id: "two", kind: "user", text: "follow two" });
    await session.send({ id: "three", kind: "user", text: "follow three" });
    emitNow(driver, { kind: "compaction_finished" });
    emitNow(driver, { kind: "review_finished" });
    const events = await take(iterator as never, 9);
    expect(driver.writes).toEqual(["follow two", "follow three"]);
    expect(events.filter((event) => event.type === "command_accepted").map((event) => event.commandId))
      .toEqual(["one", "two", "three"]);
    expect(session.snapshot()).toMatchObject({
      activeTurn: { commandIds: ["one", "two", "three"] },
      queuedCommands: [],
    });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("single-flights same-tick rejected safe boundaries and fails each queued command exactly once", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await session.send({ id: "two", kind: "user", text: "follow two" });
    await session.send({ id: "three", kind: "user", text: "follow three" });
    driver.rejectWrites = true;
    emitNow(driver, { kind: "compaction_finished" });
    emitNow(driver, { kind: "review_finished" });
    const events = await take(iterator as never, 9);
    expect(driver.writes).toEqual(["follow two", "follow three"]);
    expect(events.filter((event) => event.type === "command_failed").map((event) => event.commandId))
      .toEqual(["two", "three"]);
    expect(session.snapshot()).toMatchObject({
      activeTurn: { commandIds: ["one"] },
      queuedCommands: [],
    });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("cancels an in-flight safe-boundary admission once before a same-tick terminal stop", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await session.send({ id: "two", kind: "user", text: "follow two" });
    emitNow(driver, { kind: "compaction_finished" });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
    const events = await take(iterator as never, 99);
    const admission = events.filter((event) =>
      (event.type === "command_accepted" || event.type === "command_failed")
      && event.commandId === "two"
    );
    expect(driver.writes).toEqual(["follow two"]);
    expect(admission).toMatchObject([{
      type: "command_failed",
      commandId: "two",
      error: { code: "session_stopping" },
    }]);
    expect(events.findIndex((event) => event === admission[0]))
      .toBeLessThan(events.findIndex((event) => event.type === "turn_completed"));
    expect(events.find((event) => event.type === "turn_completed"))
      .toMatchObject({ commandIds: ["one"] });
    expect(events.findIndex((event) => event.type === "turn_completed"))
      .toBeLessThan(events.findIndex((event) => event.type === "session_closed"));
  });

  it("keeps stop bounded when a safe-boundary continuation never settles", async () => {
    const { session } = makeSession("claude");
    await session.start({ id: "one", kind: "user", text: "start" });
    Object.assign(session, { safeBoundaryFlush: new Promise<void>(() => {}) });
    const stopped = await Promise.race([
      session.stop({ reason: "shutdown", forceAfterMs: 10 }),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50)),
    ]);
    expect(stopped).toMatchObject({ status: "accepted" });
    await expect(session.closed).resolves.toMatchObject({ outcome: "stopped" });
  });

  it("fails an in-flight boundary command before a same-tick turn completion", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await session.send({ id: "two", kind: "user", text: "follow two" });
    emitNow(driver, { kind: "compaction_finished" });
    emitNow(driver, { kind: "turn_end" });
    const events = await take(iterator as never, 7);
    const admission = events.filter((event) =>
      (event.type === "command_accepted" || event.type === "command_failed")
      && event.commandId === "two"
    );
    expect(driver.writes).toEqual(["follow two"]);
    expect(admission).toMatchObject([{
      type: "command_failed",
      commandId: "two",
      error: { code: "turn_completed_before_command_acceptance" },
    }]);
    expect(events.findIndex((event) => event === admission[0]))
      .toBeLessThan(events.findIndex((event) => event.type === "turn_completed"));
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("settles a rejected in-flight boundary command once before same-tick turn completion", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await session.send({ id: "two", kind: "user", text: "follow two" });
    driver.rejectWrites = true;
    emitNow(driver, { kind: "compaction_finished" });
    emitNow(driver, { kind: "turn_end" });
    const events = await take(iterator as never, 7);
    const admission = events.filter((event) =>
      (event.type === "command_accepted" || event.type === "command_failed")
      && event.commandId === "two"
    );
    expect(driver.writes).toEqual(["follow two"]);
    expect(admission).toMatchObject([{
      type: "command_failed",
      commandId: "two",
      error: { code: "turn_completed_before_command_acceptance" },
    }]);
    expect(events.findIndex((event) => event === admission[0]))
      .toBeLessThan(events.findIndex((event) => event.type === "turn_completed"));
    expect(events.find((event) => event.type === "turn_completed"))
      .toMatchObject({ commandIds: ["one"] });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("does not start the next turn while a cancelled boundary send is still physically in flight", async () => {
    const { session, driver } = makeSession("claude");
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    const internals = session as unknown as {
      sendLane(text: string, mode: "busy" | "idle"): Promise<unknown>;
    };
    const sendLane = internals.sendLane.bind(session);
    let settleBoundary = () => {};
    const boundary = new Promise<void>((resolve) => { settleBoundary = resolve; });
    const startedBoundaryWrites: string[] = [];
    vi.spyOn(internals, "sendLane").mockImplementation((text, mode) => {
      if (mode === "busy") {
        startedBoundaryWrites.push(text);
        return boundary;
      }
      return sendLane(text, mode);
    });
    await session.send({ id: "two", kind: "user", text: "follow two" });
    emitNow(driver, { kind: "compaction_finished" });
    await session.send({ id: "three", kind: "user", text: "follow three" });
    emitNow(driver, { kind: "turn_end" });
    await Promise.resolve();
    expect(startedBoundaryWrites).toEqual(["follow two"]);
    expect(driver.writes).toEqual([]);
    expect(session.snapshot()).toMatchObject({ state: "idle", queuedCommands: [{ commandId: "three" }] });
    settleBoundary();
    await boundary;
    await vi.waitFor(() => expect(driver.writes).toEqual(["follow three"]));
    expect(session.snapshot()).toMatchObject({ activeTurn: { commandIds: ["three"] }, queuedCommands: [] });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("waits for the final nested tool output before flushing a gated command", async () => {
    const { session, driver } = makeSession("claude");
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "tool_call", name: "one", input: {} });
    await emit(driver, { kind: "tool_call", name: "two", input: {} });
    await session.send({ id: "two", kind: "user", text: "follow" });
    await emit(driver, { kind: "tool_output", name: "one" });
    expect(driver.writes).toEqual([]);
    await emit(driver, { kind: "tool_output", name: "two" });
    expect(driver.writes).toEqual(["follow"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("flushes after review finishes but not while review is active", async () => {
    const { session, driver } = makeSession("codex");
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "review_started" });
    await session.send({ id: "two", kind: "user", text: "follow" });
    expect(driver.writes).toEqual([]);
    await emit(driver, { kind: "review_finished" });
    expect(driver.writes).toEqual(["follow"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("projects ordinary compaction and runtime diagnostics for the active turn", async () => {
    const { session, driver } = makeSession("codex");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "compaction_started" });
    await emit(driver, { kind: "compaction_finished" });
    await emit(driver, {
      kind: "runtime_diagnostic",
      severity: "warning",
      source: "codex",
      message: "careful",
    });
    const events = await take(iterator as never, 5);
    expect(events.map((event) => event.type)).toEqual([
      "command_accepted",
      "turn_started",
      "compaction_started",
      "compaction_finished",
      "diagnostic",
    ]);
    expect(events.at(-1)).toMatchObject({ severity: "warning", message: "careful" });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("does not tool-boundary flush after an error in the same turn", async () => {
    const { session, driver } = makeSession("claude");
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "tool_call", name: "one", input: {} });
    await session.send({ id: "two", kind: "user", text: "follow" });
    await emit(driver, { kind: "error", message: "failed" });
    await emit(driver, { kind: "tool_output", name: "one" });
    expect(driver.writes).toEqual([]);
    await emit(driver, { kind: "turn_end", sessionId: "s1" });
    expect(driver.writes).toEqual(["follow"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("opencode keeps one persistent lane and admits busy input as steer", async () => {
    const { session, driver } = makeSession("opencode");
    await session.start({ id: "one", kind: "user", text: "start" });
    expect(await session.send({ id: "two", kind: "user", text: "steer" })).toMatchObject({
      status: "accepted",
      delivery: "steer",
      commandId: "two",
    });
    expect(driver.processes).toHaveLength(1);
    await emit(driver, { kind: "turn_end", sessionId: "s1" });
    await expect(session.send({ id: "three", kind: "user", text: "next" })).resolves.toMatchObject({
      status: "accepted",
      delivery: "prompt",
    });
    expect(driver.processes).toHaveLength(1);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("Pi accepts a busy send as an in-turn steer", async () => {
    const { session } = makeSession("pi");
    await session.start({ id: "one", kind: "user", text: "start" });
    expect(await session.send({ id: "two", kind: "user", text: "steer" })).toMatchObject({ status: "accepted", delivery: "steer", commandId: "two" });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });
});

describe("logical-session terminal facts", () => {
  it("reports unsupported extensions without backend-specific core logic", async () => {
    const { session } = makeSession("claude");
    await expect((session as any).invokeExtension("unknown", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported_extension" },
    });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("starts an idle persistent-process turn on the existing lane", async () => {
    const { session, driver } = makeSession("claude");
    await session.start({ id: "one", kind: "user", text: "start" });
    await emit(driver, { kind: "turn_end", sessionId: "session-1" });
    await expect(session.send({ id: "two", kind: "user", text: "next" })).resolves.toMatchObject({
      status: "accepted",
      delivery: "prompt",
    });
    expect(driver.writes).toEqual(["next"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("normalizes lane errors into runtime diagnostics", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    driver.processes[0].emit("error", new Error("lane exploded"));
    const events = await take(iterator as never, 3);
    expect(events.at(-1)).toMatchObject({
      type: "diagnostic",
      severity: "error",
      message: "lane exploded",
    });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("fails and releases a session when its unread event buffer overflows", async () => {
    const { session, driver, host } = makeSession("pi");
    await session.start({ id: "one", kind: "user", text: "start" });
    driver.lane!.emitEvents([{ kind: "text", text: "x".repeat(session.events.maxBufferedBytes) }]);
    await expect(session.closed).resolves.toMatchObject({
      outcome: "crashed",
      error: { code: "event_buffer_overflow" },
      cleanup: { status: "released" },
    });
    expect(host.releases).toHaveLength(1);
  });

  it("bounds overflow teardown when an SDK dispose never settles", async () => {
    vi.useFakeTimers();
    try {
      const { session, driver, host } = makeSession("pi", { timeout: 10 });
      const iterator = session.events[Symbol.asyncIterator]();
      driver.hangDispose = true;
      await session.start({ id: "one", kind: "user", text: "start" });
      driver.lane!.emitEvents([{ kind: "text", text: "x".repeat(session.events.maxBufferedBytes) }]);
      await expect(session.stop({ reason: "shutdown", forceAfterMs: 10 })).resolves.toMatchObject({
        status: "already_stopping",
        requestId: expect.any(String),
      });
      await vi.advanceTimersByTimeAsync(11);
      await expect(session.closed).resolves.toMatchObject({
        outcome: "crashed",
        error: { code: "event_buffer_overflow" },
        cleanup: { status: "released" },
      });
      const observed: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) observed.push(event);
      expect(observed.at(-1)).toMatchObject({
        type: "session_closed",
        result: { error: { code: "event_buffer_overflow" } },
      });
      expect(host.releases).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the interrupted turn id when an SDK abort emits turn_end before resolving", async () => {
    const { session, driver } = makeSession("pi");
    const iterator = session.events[Symbol.asyncIterator]();
    const started = await session.start({ id: "one", kind: "user", text: "start" });
    expect(started).toMatchObject({ status: "accepted" });
    driver.sdkHandle!.isStreaming = true;
    driver.sdkHandle!.abort.mockImplementation(async () => {
      driver.lane!.emitEvents([{
        kind: "turn_end",
        sessionId: "sdk-session",
        turnOwner: driver.currentTerminalOwner,
      }]);
    });

    await expect(session.interrupt({ requestId: "interrupt-one", reason: "test" })).resolves.toEqual({
      status: "accepted",
      requestId: "interrupt-one",
      turnId: started.status === "accepted" ? started.turnId : "unreachable",
    });
    const events = await take(iterator as never, 4);
    expect(events.find((event) => event.type === "turn_completed")).toMatchObject({
      type: "turn_completed",
      result: { outcome: "interrupted" },
    });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("normalizes an accepted process interrupt followed by SIGINT exit as an interrupted turn", async () => {
    const { session, driver } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    const started = await session.start({ id: "one", kind: "user", text: "start" });
    expect(await session.interrupt({ requestId: "interrupt-process", reason: "test" })).toMatchObject({
      status: "accepted",
      turnId: started.status === "accepted" ? started.turnId : "unreachable",
    });

    driver.processes[0]!.emit("exit", null, "SIGINT");
    await expect(session.closed).resolves.toMatchObject({ outcome: "crashed", signal: "SIGINT" });
    const observed: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) observed.push(event);
    expect(observed.find((event) => event.type === "turn_completed")).toMatchObject({
      type: "turn_completed",
      result: { outcome: "interrupted" },
    });
  });

  it("keeps admission closed while a stop-triggered SDK turn_end races a pending abort", async () => {
    const { session, driver } = makeSession("pi");
    await session.start({ id: "one", kind: "user", text: "start" });
    const abortGate = deferred();
    driver.sdkHandle!.isStreaming = true;
    driver.sdkHandle!.abort.mockImplementation(() => {
      driver.lane!.emitEvents([{
        kind: "turn_end",
        sessionId: "sdk-session",
        turnOwner: driver.currentTerminalOwner,
      }]);
      return abortGate.promise;
    });

    const stopping = session.stop({ reason: "owner_request", forceAfterMs: 1_000 });
    expect(session.snapshot().state).toBe("stopping");
    await expect(session.send({ id: "two", kind: "user", text: "must not start" })).resolves.toEqual({
      status: "rejected",
      reason: "closed",
    });
    expect(driver.sdkHandle!.prompt).toHaveBeenCalledOnce();
    abortGate.resolve();
    await expect(stopping).resolves.toMatchObject({ status: "accepted" });
    await expect(session.closed).resolves.toMatchObject({ outcome: "stopped" });
  });

  it.each(["claude", "pi"] as const)("cleans up a late %s open after stop has already closed the session", async (backend) => {
    const gate = deferred();
    const { session, driver } = makeSession(backend, { timeout: 25 });
    if (backend === "pi") driver.sdkOpenGate = gate.promise;
    else driver.spawnGate = gate.promise;

    const starting = session.start({ id: "one", kind: "user", text: "start" });
    await Promise.resolve();
    await expect(session.stop({ reason: "owner_request", forceAfterMs: 10 })).resolves.toMatchObject({ status: "accepted" });
    await expect(session.closed).resolves.toMatchObject({ outcome: "stopped" });
    gate.resolve();
    await expect(starting).resolves.toEqual({ status: "rejected", reason: "closed" });
    if (backend === "pi") expect(driver.sdkHandle!.dispose).toHaveBeenCalledOnce();
    else expect(driver.processes[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("absorbs a rejected process-lane stop while cleaning up a late open", async () => {
    const gate = deferred();
    const stop = vi.spyOn(ProcessLane.prototype, "stop")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stop rejected"));
    try {
      const { session, driver } = makeSession("claude", { timeout: 25 });
      driver.spawnGate = gate.promise;
      const starting = session.start({ id: "one", kind: "user", text: "start" });
      await Promise.resolve();
      await expect(session.stop({ reason: "owner_request", forceAfterMs: 10 })).resolves.toMatchObject({ status: "accepted" });
      gate.resolve();
      await expect(starting).resolves.toEqual({ status: "rejected", reason: "closed" });
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      stop.mockRestore();
    }
  });

  it("keeps a late spawn rejection closed after a racing stop", async () => {
    const gate = deferred();
    const { session, driver } = makeSession("claude");
    driver.spawnGate = gate.promise;
    driver.failSpawn = new Error("late spawn failure");
    const starting = session.start({ id: "one", kind: "user", text: "start" });
    await Promise.resolve();
    await session.stop({ reason: "owner_request", forceAfterMs: 10 });
    gate.resolve();
    await expect(starting).resolves.toEqual({ status: "rejected", reason: "closed" });
  });

  it("does not revive an SDK session after the first prompt fails synchronously", async () => {
    const { session, driver } = makeSession("pi");
    driver.failPrompt = new Error("prompt failed");
    const iterator = session.events[Symbol.asyncIterator]();
    expect(await session.start({ id: "one", kind: "user", text: "start" })).toMatchObject({ status: "accepted" });
    const observed = await take(iterator as never, 5);
    expect(observed.find((event) => event.type === "turn_completed")).toMatchObject({
      result: { outcome: "failed" },
    });
    expect(session.snapshot().state).toBe("idle");
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("bounds a hung SDK dispose and still settles closed", async () => {
    vi.useFakeTimers();
    try {
      const { session, driver } = makeSession("pi");
      driver.hangDispose = true;
      await session.start({ id: "one", kind: "user", text: "start" });
      const stopped = session.stop({ reason: "owner_request", forceAfterMs: 25 });
      await vi.advanceTimersByTimeAsync(30);
      expect(await stopped).toMatchObject({ status: "accepted" });
      expect(await session.closed).toMatchObject({ outcome: "forced" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles closed and releases resources when lane stop rejects", async () => {
    const { session, driver, host } = makeSession("pi");
    await session.start({ id: "one", kind: "user", text: "start" });
    driver.failDispose = new Error("dispose failed");
    await expect(session.stop({ reason: "owner_request", forceAfterMs: 25 })).resolves.toMatchObject({
      status: "failed",
      error: { code: "stop_failed" },
    });
    await expect(session.closed).resolves.toMatchObject({
      outcome: "forced",
      error: { code: "stop_failed" },
      cleanup: { status: "released" },
    });
    expect(session.snapshot().state).toBe("closed");
    expect(host.releases).toHaveLength(1);
    await expect(session.stop({ reason: "shutdown", forceAfterMs: 25 })).resolves.toMatchObject({ status: "closed" });
  });

  it("releases host resources as consumer_closed when the event consumer cancels", async () => {
    const { session, host } = makeSession("claude");
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await iterator.return?.();
    await session.closed;
    expect(host.releases).toHaveLength(1);
    expect(host.releases[0].reason).toBe("consumer_closed");
  });

  it("passes an exact resume id to the physical adapter", async () => {
    const { session, driver } = makeSession("codex", { resumeSessionId: "resume-exact" });
    await session.start({ id: "one", kind: "user", text: "start" });
    expect(driver.spawnContexts[0].config.sessionId).toBe("resume-exact");
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it("classifies failed start and releases the host resource once", async () => {
    const { session, driver, host } = makeSession("claude");
    driver.failSpawn = new Error("spawn failed");
    expect(await session.start({ id: "one", kind: "user", text: "start" })).toMatchObject({ status: "rejected", reason: "runtime_unavailable" });
    expect(await session.closed).toMatchObject({ outcome: "failed_to_start", cleanup: { status: "released" } });
    expect(host.releases).toHaveLength(1);
  });

  it("classifies an unexpected physical exit as a crash", async () => {
    const { session, driver } = makeSession("claude");
    await session.start({ id: "one", kind: "user", text: "start" });
    driver.processes[0].emit("exit", 7, null);
    expect(await session.closed).toMatchObject({ outcome: "crashed", exitCode: 7, signal: null });
  });

  it("closes admission immediately while crash cleanup is pending", async () => {
    const releaseGate = deferred();
    const prepared: PreparedExecutionResource = {
      environmentLayers: { base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {}, runtimeProtected: {}, networkProtected: {}, credentialSensitive: {} },
      release: vi.fn(() => releaseGate.promise),
    };
    const { session, driver } = makeSession("claude", { prepared, timeout: 1_000 });
    await session.start({ id: "one", kind: "user", text: "start" });
    driver.processes[0].emit("exit", 7, null);
    await expect(session.send({ id: "two", kind: "user", text: "must not queue" })).resolves.toEqual({
      status: "rejected",
      reason: "closed",
    });
    expect(session.snapshot()).toMatchObject({ state: "stopping", queuedCommands: [] });
    releaseGate.resolve();
    await expect(session.closed).resolves.toMatchObject({ outcome: "crashed" });
  });

  it("bounds a hung host release and still closes the iterator", async () => {
    vi.useFakeTimers();
    try {
      const prepared: PreparedExecutionResource = {
        environmentLayers: { base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {}, runtimeProtected: {}, networkProtected: {}, credentialSensitive: {} },
        release: () => new Promise(() => {}),
      };
      const { session } = makeSession("claude", { prepared, timeout: 25 });
      await session.start({ id: "one", kind: "user", text: "start" });
      const stopped = session.stop({ reason: "owner_request", forceAfterMs: 10 });
      await vi.advanceTimersByTimeAsync(30);
      await stopped;
      expect(await session.closed).toMatchObject({ outcome: "stopped", cleanup: { status: "timed_out" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["throw", "reject"] as const)("settles one failed cleanup diagnostic when host release %ss", async (mode) => {
    const prepared: PreparedExecutionResource = {
      environmentLayers: { base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {}, runtimeProtected: {}, networkProtected: {}, credentialSensitive: {} },
      release: vi.fn(() => {
        if (mode === "throw") throw new Error("private release detail");
        return Promise.reject(new Error("private release detail"));
      }),
    };
    const { session } = makeSession("claude", { prepared });
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
    await expect(session.stop({ reason: "owner_request", forceAfterMs: 10 })).resolves.toMatchObject({ status: "accepted" });
    await expect(session.closed).resolves.toMatchObject({
      outcome: "stopped",
      cleanup: { status: "failed", error: { code: "host_release_failed" } },
    });
    const observed: Array<AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>> = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) observed.push(event);
    expect(observed.filter((event) => event.type === "diagnostic" && event.source === "host")).toHaveLength(1);
    expect(observed.at(-1)?.type).toBe("session_closed");
    expect(prepared.release).toHaveBeenCalledOnce();
  });

  it("shares one terminal cleanup across concurrent stop calls", async () => {
    let release!: () => void;
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const prepared: PreparedExecutionResource = {
      environmentLayers: { base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {}, runtimeProtected: {}, networkProtected: {}, credentialSensitive: {} },
      release: vi.fn(() => releaseGate),
    };
    const { session } = makeSession("claude", { prepared, timeout: 1_000 });
    await session.start({ id: "one", kind: "user", text: "start" });
    const first = session.stop({ reason: "owner_request", forceAfterMs: 10 });
    expect(await session.stop({ reason: "shutdown", forceAfterMs: 10 })).toMatchObject({ status: "already_stopping" });
    release();
    expect(await first).toMatchObject({ status: "accepted" });
    await session.closed;
    expect(prepared.release).toHaveBeenCalledOnce();
  });
});

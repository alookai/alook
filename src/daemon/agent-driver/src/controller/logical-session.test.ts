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
  PreparedExecutionResource,
} from "../contract.js";
import type { BackendAdapter, BackendExecution, AdapterLaunchContext, AdapterEvent } from "../internal/adapter.js";
import { createFakeAgentDriverHost } from "../testing/fake-host.js";
import { runAgentDriverConformance } from "../testing/conformance.js";
import { LogicalAgentSession } from "./logical-session.js";
import { SdkLane } from "./sdk-host.js";

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
  hangDispose = false;

  constructor(readonly id: BuiltinBackendId, readonly execution: BackendExecution) {}
  probe() { return { status: "healthy" as const }; }
  async spawn(ctx: AdapterLaunchContext) {
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
  async openSdkSession(_ctx: AdapterLaunchContext): Promise<SdkLane> {
    const handle = {
      isStreaming: false,
      prompt: vi.fn(async () => {
        if (this.failPrompt) throw this.failPrompt;
      }),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(() => this.hangDispose ? new Promise<void>(() => {}) : Promise.resolve()),
    };
    this.sdkHandle = handle;
    this.lane = new SdkLane(handle, "sdk-session");
    return this.lane;
  }
  normalizeLine(line: string): AdapterEvent[] { return [JSON.parse(line) as AdapterEvent]; }
  encodeMessage(text: string): string {
    this.writes.push(text);
    return text;
  }
}

function executionFor(backend: BuiltinBackendId): BackendExecution {
  if (backend === "cursor" || backend === "opencode") {
    return {
      kind: "per_turn_process",
      start: backend === "opencode" ? "deferred" : "immediate",
      afterTurn: backend === "opencode" ? "terminate" : "natural_exit",
    };
  }
  return backend === "pi"
    ? { kind: "in_process_sdk", input: "direct" }
    : { kind: "persistent_process", input: "safe_boundary" };
}

function makeSession<Id extends BuiltinBackendId>(
  backend: Id,
  options: { prepared?: PreparedExecutionResource; timeout?: number; resumeSessionId?: string; workingDirectory?: string } = {},
) {
  const driver = new FakeDriver(backend, executionFor(backend));
  const host = createFakeAgentDriverHost(options.prepared);
  const prepared: PreparedExecutionResource = {
    environmentLayers: {
      base: {}, hostStatic: {}, identityProtected: {}, platformProtected: {},
      runtimeProtected: {}, networkProtected: {}, credentialSensitive: {},
    },
    async release(input) { host.releases.push(input); },
    ...options.prepared,
  };
  const session = new LogicalAgentSession(
    backend,
    configs[backend] as never,
    {
      workingDirectory: options.workingDirectory ?? process.cwd(),
      instructions: "Be useful.",
      launchId: `launch-${backend}`,
      resumeSessionId: options.resumeSessionId,
    },
    driver,
    host,
    prepared,
    options.timeout ?? 100,
  );
  return { session, driver, host };
}

async function emit(driver: FakeDriver, event: AdapterEvent): Promise<void> {
  if (driver.id === "pi") driver.lane!.emitEvents([event]);
  else driver.processes.at(-1)!.stdout.write(`${JSON.stringify(event)}\n`);
  await Promise.resolve();
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
        if (driver.execution.kind === "per_turn_process") {
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

describe("backend-owned delivery behavior", () => {
  it("writes AGENTS.md and the CLAUDE.md alias for non-empty instructions", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "agent-driver-instructions-"));
    try {
      const { session } = makeSession("claude", { workingDirectory });
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
    expect(await session.send({ id: "two", kind: "user", text: "follow" })).toEqual({ status: "queued", reason: "unsafe_boundary", commandId: "two" });
    expect(driver.writes).toEqual([]);
    await emit(driver, { kind: "compaction_finished" });
    expect(driver.writes).toEqual(["follow"]);
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
  });

  it.each(["claude", "codex"] as const)("%s preserves FIFO and distinct ids for identical queued text", async (backend) => {
    const { session, driver } = makeSession(backend);
    const iterator = session.events[Symbol.asyncIterator]();
    await session.start({ id: "one", kind: "user", text: "start" });
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

  it("admits a deferred OpenCode system prefix in exact FIFO order", async () => {
    const { session } = makeSession("opencode");
    const iterator = session.events[Symbol.asyncIterator]();
    expect(await session.start({ id: "system-a", kind: "system", text: "a" })).toMatchObject({ status: "queued" });
    expect(await session.send({ id: "system-b", kind: "system", text: "b" })).toMatchObject({ status: "queued" });
    expect(await session.send({ id: "user", kind: "user", text: "go" })).toMatchObject({ status: "accepted" });
    const events = await take(iterator as never, 6);
    expect(events.filter((event) => event.type === "command_accepted").map((event) => event.commandId))
      .toEqual(["system-a", "system-b", "user"]);
    expect(events.find((event) => event.type === "turn_started")).toMatchObject({
      commandIds: ["system-a", "system-b", "user"],
    });
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

  it.each(["cursor", "opencode"] as const)("%s queues for a new physical turn and never creates two lanes concurrently", async (backend) => {
    const { session, driver } = makeSession(backend);
    if (backend === "opencode") {
      expect(await session.start({ id: "system", kind: "system", text: "standing" })).toEqual({ status: "queued", reason: "waiting_for_message", commandId: "system" });
      await session.send({ id: "one", kind: "user", text: "start" });
    } else {
      await session.start({ id: "one", kind: "user", text: "start" });
    }
    expect(await session.send({ id: "two", kind: "user", text: "next" })).toEqual({ status: "queued", reason: "runtime_busy", commandId: "two" });
    expect(driver.processes).toHaveLength(1);
    await emit(driver, { kind: "turn_end", sessionId: "s1" });
    driver.processes[0].emit("exit", 0, null);
    await Promise.resolve();
    expect(driver.processes).toHaveLength(2);
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
  it("returns the interrupted turn id when an SDK abort emits turn_end before resolving", async () => {
    const { session, driver } = makeSession("pi");
    const started = await session.start({ id: "one", kind: "user", text: "start" });
    expect(started).toMatchObject({ status: "accepted" });
    driver.sdkHandle!.isStreaming = true;
    driver.sdkHandle!.abort.mockImplementation(async () => {
      driver.lane!.emitEvents([{ kind: "turn_end", sessionId: "sdk-session" }]);
    });

    await expect(session.interrupt({ requestId: "interrupt-one", reason: "test" })).resolves.toEqual({
      status: "accepted",
      requestId: "interrupt-one",
      turnId: started.status === "accepted" ? started.turnId : "unreachable",
    });
    await session.stop({ reason: "shutdown", forceAfterMs: 10 });
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

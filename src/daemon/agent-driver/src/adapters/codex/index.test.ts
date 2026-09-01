import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodexDriver } from "./index.js";
import type { AdapterLaunchContext } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";

const runtimeMocks = vi.hoisted(() => ({
  spawnAgentProcess: vi.fn(),
  killProcessTree: vi.fn(async () => {}),
  probeCliRuntime: vi.fn(async (): Promise<
    | { status: "healthy"; version: string }
    | { status: "unhealthy"; lastError: string }
  > => ({ status: "healthy", version: "0.test" })),
}));

vi.mock("../../internal/killTree.js", async () => {
  const actual = await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js");
  return {
    ...actual,
    spawnAgentProcess: runtimeMocks.spawnAgentProcess,
    killProcessTree: runtimeMocks.killProcessTree,
  };
});

vi.mock("../../internal/probe.js", async () => {
  const actual = await vi.importActual<typeof import("../../internal/probe.js")>("../../internal/probe.js");
  return { ...actual, probeCliRuntime: runtimeMocks.probeCliRuntime };
});

function simpleProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = { write: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

beforeEach(() => {
  runtimeMocks.spawnAgentProcess.mockReset();
  runtimeMocks.spawnAgentProcess.mockImplementation(simpleProcess);
  runtimeMocks.killProcessTree.mockClear();
  runtimeMocks.probeCliRuntime.mockClear();
  runtimeMocks.probeCliRuntime.mockResolvedValue({ status: "healthy", version: "0.test" });
});

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
}

function baseCtx(): AdapterLaunchContext {
  const tmp = mkTmp();
  return fakeLaunchContext("codex", tmp, {
    standingPrompt: "You are Codex.",
    prompt: "hi",
  });
}

function probingProcess(
  respond: (request: Record<string, any>) => Record<string, unknown>,
) {
  const proc = simpleProcess() as ReturnType<typeof simpleProcess> & {
    stdout: EventEmitter;
    pid?: number;
  };
  proc.stdout = new EventEmitter();
  proc.stdin.write = vi.fn((line: string) => {
    const request = JSON.parse(line.trim()) as Record<string, any>;
    queueMicrotask(() => {
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify(respond(request))}\n`));
    });
    return true;
  });
  return proc;
}

describe("CodexDriver reasoning catalog probe", () => {
  it("keeps an unhealthy CLI result unchanged without starting app-server", async () => {
    runtimeMocks.probeCliRuntime.mockResolvedValueOnce({
      status: "unhealthy",
      lastError: "missing",
    });

    await expect(new CodexDriver().probe()).resolves.toEqual({
      status: "unhealthy",
      lastError: "missing",
    });
    expect(runtimeMocks.spawnAgentProcess).not.toHaveBeenCalled();
  });

  it("keeps Codex healthy when the catalog process cannot spawn", async () => {
    runtimeMocks.spawnAgentProcess.mockImplementationOnce(() => {
      throw new Error("catalog spawn failed");
    });

    await expect(new CodexDriver().probe()).resolves.toEqual({
      status: "healthy",
      version: "0.test",
      reasoning: undefined,
    });
  });

  it("initializes, pages model/list, preserves reported options, and tears down", async () => {
    const proc = probingProcess((request) => {
      if (request.method === "initialize") return { jsonrpc: "2.0", id: request.id, result: {} };
      if (request.params.cursor === "next") {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            data: [{
              id: "gpt-5.1",
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "xhigh", description: "Deeper reasoning" },
                { reasoningEffort: "future_level" },
              ],
              defaultReasoningEffort: "xhigh",
            }],
            nextCursor: null,
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          data: [{
            id: "gpt-5",
            supportedReasoningEfforts: [
              null,
              { reasoningEffort: "minimal", description: "Fast" },
              { reasoningEffort: "minimal", description: "duplicate" },
              { reasoningEffort: "bad effort" },
            ],
            defaultReasoningEffort: "minimal",
          }, null, { id: "", supportedReasoningEfforts: [] }],
          nextCursor: "next",
        },
      };
    });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toEqual({
      status: "healthy",
      version: "0.test",
      reasoning: {
        updateMode: "live_next_turn",
        defaultModelId: "gpt-5.1",
        models: [
          {
            id: "gpt-5",
            supportedReasoningEfforts: [{ value: "minimal", description: "Fast" }],
            defaultReasoningEffort: "minimal",
          },
          {
            id: "gpt-5.1",
            supportedReasoningEfforts: [
              { value: "xhigh", description: "Deeper reasoning" },
              { value: "future_level" },
            ],
            defaultReasoningEffort: "xhigh",
          },
        ],
      },
    });

    const requests = proc.stdin.write.mock.calls.map(([line]) => JSON.parse(line.trim()));
    expect(requests.map((request) => request.method)).toEqual(["initialize", "model/list", "model/list"]);
    expect(requests[2].params.cursor).toBe("next");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps Codex healthy when model/list is unavailable", async () => {
    const proc = probingProcess((request) => request.method === "initialize"
      ? { jsonrpc: "2.0", id: request.id, result: {} }
      : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toEqual({
      status: "healthy",
      version: "0.test",
      reasoning: undefined,
    });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("normalizes missing option arrays and non-string catalog fields", async () => {
    const proc = probingProcess((request) => request.method === "initialize"
      ? { jsonrpc: "2.0", id: request.id, result: {} }
      : {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            data: [
              { id: 42, supportedReasoningEfforts: [] },
              {
                id: "gpt-minimal",
                supportedReasoningEfforts: "not-an-array",
                defaultReasoningEffort: 42,
              },
              {
                id: "gpt-options",
                supportedReasoningEfforts: [
                  { reasoningEffort: 42 },
                  { reasoningEffort: "high", description: "" },
                ],
              },
            ],
            nextCursor: null,
          },
        });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toMatchObject({
      reasoning: {
        models: [
          { id: "gpt-minimal", supportedReasoningEfforts: [] },
          { id: "gpt-options", supportedReasoningEfforts: [{ value: "high" }] },
        ],
      },
    });
  });

  it("treats a non-array model/list data field as an unavailable catalog", async () => {
    const proc = probingProcess((request) => request.method === "initialize"
      ? { jsonrpc: "2.0", id: request.id, result: {} }
      : { jsonrpc: "2.0", id: request.id, result: { data: "invalid", nextCursor: null } });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toMatchObject({ reasoning: undefined });
  });

  it("ignores malformed and unrelated lines before consuming the catalog response", async () => {
    const proc = probingProcess(() => ({ jsonrpc: "2.0", id: -1, result: {} }));
    proc.stdin.write = vi.fn((line: string) => {
      const request = JSON.parse(line.trim()) as Record<string, any>;
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("not-json\n"));
        proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: -1, result: {} })}\n`));
        proc.stdout.emit("data", Buffer.from(`${JSON.stringify(
          request.method === "initialize"
            ? { jsonrpc: "2.0", id: request.id, result: {} }
            : { jsonrpc: "2.0", id: request.id, result: { data: [], nextCursor: null } },
        )}\n`));
      });
      return true;
    });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toMatchObject({
      status: "healthy",
      reasoning: undefined,
    });
  });

  it("returns no catalog rather than a truncated list when pagination exceeds 512 models", async () => {
    const models = Array.from({ length: 512 }, (_, index) => ({
      id: `gpt-model-${index}`,
      supportedReasoningEfforts: [],
    }));
    const proc = probingProcess((request) => request.method === "initialize"
      ? { jsonrpc: "2.0", id: request.id, result: {} }
      : { jsonrpc: "2.0", id: request.id, result: { data: models, nextCursor: "more" } });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toMatchObject({
      status: "healthy",
      reasoning: undefined,
    });
  });

  it("returns no catalog when a producer ignores the page limit and sends 513 unique models", async () => {
    const models = Array.from({ length: 513 }, (_, index) => ({
      id: `gpt-model-${index}`,
      supportedReasoningEfforts: [],
    }));
    const proc = probingProcess((request) => request.method === "initialize"
      ? { jsonrpc: "2.0", id: request.id, result: {} }
      : { jsonrpc: "2.0", id: request.id, result: { data: models, nextCursor: null } });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toMatchObject({ reasoning: undefined });
  });

  it("returns no catalog when app-server output exceeds the byte bound", async () => {
    const proc = probingProcess(() => ({ jsonrpc: "2.0", id: -1, result: {} }));
    proc.stdin.write = vi.fn((line: string) => {
      const request = JSON.parse(line.trim()) as Record<string, any>;
      queueMicrotask(() => {
        if (request.method === "initialize") {
          proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result: {} })}\n`));
        } else {
          proc.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, "x"));
        }
      });
      return true;
    });
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toMatchObject({ reasoning: undefined });
  });

  it("treats initialize rejection as an unavailable catalog", async () => {
    const proc = probingProcess((request) => ({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "initialize rejected" },
    }));
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    await expect(new CodexDriver().probe()).resolves.toMatchObject({
      status: "healthy",
      reasoning: undefined,
    });
  });

  it("times out a silent catalog process", async () => {
    vi.useFakeTimers();
    try {
      const proc = simpleProcess() as ReturnType<typeof simpleProcess> & { stdout: EventEmitter };
      proc.stdout = new EventEmitter();
      runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

      const pending = new CodexDriver().probe();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toMatchObject({ status: "healthy", reasoning: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles only once when catalog process error and exit race", async () => {
    const proc = simpleProcess() as ReturnType<typeof simpleProcess> & { stdout: EventEmitter; pid: number };
    proc.stdout = new EventEmitter();
    proc.pid = 42_424;
    runtimeMocks.killProcessTree.mockRejectedValueOnce(new Error("already exited"));
    runtimeMocks.spawnAgentProcess.mockReturnValueOnce(proc as never);

    const pending = new CodexDriver().probe();
    await vi.waitFor(() => expect(runtimeMocks.spawnAgentProcess).toHaveBeenCalledOnce());
    proc.emit("error", new Error("catalog failed"));
    proc.emit("exit", 1, null);

    await expect(pending).resolves.toMatchObject({ status: "healthy", reasoning: undefined });
    expect(runtimeMocks.killProcessTree).toHaveBeenCalledWith(42_424, { graceMs: 250 });
  });
});

describe("CodexDriver initialize payload", () => {
  it("sends alook-daemon identity via clientInfo (matches Codex's schema)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    const { process: proc } = await driver.spawn(ctx);
    // Codex writes on queueMicrotask — flush.
    await Promise.resolve();

    const stdin = (proc as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin;
    const firstCall = stdin.write.mock.calls[0][0] as string;
    const initPayload = JSON.parse(firstCall.trim());

    expect(initPayload.jsonrpc).toBe("2.0");
    expect(initPayload.method).toBe("initialize");
    expect(initPayload.params.clientInfo).toEqual({ name: "alook-agent-driver", version: "0.1.14" });
  });

  it("passes an explicit effort on fresh launch and omits Default", async () => {
    const explicit = new CodexDriver();
    const explicitCtx = baseCtx();
    explicitCtx.config.runtimeConfig = {
      model: { kind: "default" },
      mode: "default",
      reasoningEffort: "ultra",
    };
    const { process: explicitProc } = await explicit.spawn(explicitCtx);
    await Promise.resolve();
    const explicitStart = stdinWrites(explicitProc)
      .map((write) => JSON.parse(write.trim()))
      .find((message) => message.method === "thread/start");
    expect(explicitStart.params.config).toEqual({ model_reasoning_effort: "ultra" });

    const defaults = new CodexDriver();
    const defaultCtx = baseCtx();
    defaultCtx.config.runtimeConfig = {
      model: { kind: "default" },
      mode: "default",
    };
    const { process: defaultProc } = await defaults.spawn(defaultCtx);
    await Promise.resolve();
    const defaultStart = stdinWrites(defaultProc)
      .map((write) => JSON.parse(write.trim()))
      .find((message) => message.method === "thread/start");
    expect(defaultStart.params.config).toBeUndefined();
  });

  it("reads the account before requesting its quota snapshot", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();

    const beforeAccount = stdinWrites(proc).map((line) => JSON.parse(line.trim()));
    const accountRead = beforeAccount.find((message) => message.method === "account/read");
    expect(accountRead).toBeDefined();
    expect(beforeAccount.some((message) => message.method === "account/rateLimits/read")).toBe(false);

    driver.normalizeLine(JSON.stringify({
      jsonrpc: "2.0",
      id: accountRead.id,
      result: { account: { type: "chatgpt", email: "user@example.com", planType: "pro" } },
    }));

    const afterAccount = stdinWrites(proc).map((line) => JSON.parse(line.trim()));
    expect(afterAccount.filter((message) => message.method === "account/rateLimits/read")).toHaveLength(1);
  });
});

// The `thread/start` (or resume) RESULT line carries the new thread id and is
// what the normalizer adopts as the session — feeding it to normalizeLine is what
// triggers the deferred initial-prompt delivery.
function threadStartResult(threadId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: threadId } } });
}
// The `thread/started` NOTIFICATION — Codex emits this too, so normalizeLine sees a
// SECOND session_init for the same thread.
function threadStartedNotif(threadId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } });
}

function stdinWrites(proc: unknown): string[] {
  const stdin = (proc as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin;
  return stdin.write.mock.calls.map((c) => c[0] as string);
}
function turnStarts(writes: string[]): any[] {
  return writes
    .map((w) => JSON.parse(w.trim()))
    .filter((m) => m.method === "turn/start");
}

describe("CodexDriver initial-prompt delivery", () => {
  it("submits the initial prompt as a turn/start once the thread id is adopted", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx(); // prompt: "hi"
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve(); // flush handshake microtask

    // Before the thread is adopted, no turn/start yet — only the handshake.
    expect(turnStarts(stdinWrites(proc))).toHaveLength(0);

    // Feed the thread/start result → thread adopted → prompt delivered.
    driver.normalizeLine(threadStartResult("th_abc"));

    const turns = turnStarts(stdinWrites(proc));
    expect(turns).toHaveLength(1);
    expect(turns[0].params.threadId).toBe("th_abc");
    expect(turns[0].params.input).toEqual([{ type: "text", text: "hi" }]);
  });

  it("delivers the prompt exactly once despite the double session_init (result + thread/started)", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();

    driver.normalizeLine(threadStartResult("th_abc")); // session_init #1
    driver.normalizeLine(threadStartedNotif("th_abc")); // session_init #2 (same thread)

    expect(turnStarts(stdinWrites(proc))).toHaveLength(1);
  });

  it("delivers the prompt on resume too (thread/resume result yields session_init)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" }; // resuming
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    // resume result carries the (same) thread id.
    driver.normalizeLine(threadStartResult("th_prior"));

    const turns = turnStarts(stdinWrites(proc));
    expect(turns).toHaveLength(1);
    expect(turns[0].params.threadId).toBe("th_prior");
    expect(turns[0].params.input).toEqual([{ type: "text", text: "hi" }]);
  });

  it("does not start a turn when the prompt is empty (a bare wake)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.prompt = "   "; // whitespace-only → treated as no prompt
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    driver.normalizeLine(threadStartResult("th_abc"));

    expect(turnStarts(stdinWrites(proc))).toHaveLength(0);
  });
});

// A JSON-RPC error response to thread/resume — the prior thread's rollout is gone.
function missingRolloutError(message = "no rollout found for thread id th_prior"): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message } });
}
function threadStarts(writes: string[]): any[] {
  return writes.map((w) => JSON.parse(w.trim())).filter((m) => m.method === "thread/start");
}

describe("CodexDriver missing-rollout resume recovery", () => {
  it("on a 'no rollout found' resume error, re-issues a FRESH thread/start (no threadId) and swallows the error", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" }; // resuming a now-dead thread
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve(); // flush handshake (writes thread/resume)

    const returned = driver.normalizeLine(missingRolloutError());

    // The resume error is swallowed — not surfaced to the manager as a fault.
    expect(returned.some((e: any) => e.kind === "error")).toBe(false);
    // A fresh thread/start was issued, with NO threadId (fresh, not resume).
    const starts = threadStarts(stdinWrites(proc));
    expect(starts).toHaveLength(1);
    expect(starts[0].params.threadId).toBeUndefined();
  });

  it("after the fallback fresh-thread's session_init, the held prompt is still delivered", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" };
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    driver.normalizeLine(missingRolloutError());        // → fresh thread/start, prompt still pending
    driver.normalizeLine(threadStartResult("th_fresh")); // fresh thread adopted

    const turns = turnStarts(stdinWrites(proc));
    expect(turns).toHaveLength(1);
    expect(turns[0].params.threadId).toBe("th_fresh");
    expect(turns[0].params.input).toEqual([{ type: "text", text: "hi" }]);
  });

  it("recognizes a missing rollout when the error leads with not-found", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" };
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    expect(driver.normalizeLine(missingRolloutError("not found for requested rollout"))).toEqual([]);
    expect(threadStarts(stdinWrites(proc))).toHaveLength(1);
  });

  it("a successful resume does NOT trigger the fallback (no spurious fresh thread/start)", async () => {
    const driver = new CodexDriver();
    const ctx = baseCtx();
    ctx.config = { sessionId: "th_prior" };
    const { process: proc } = await driver.spawn(ctx);
    await Promise.resolve();

    // Resume succeeds → session_init for the resumed thread.
    driver.normalizeLine(threadStartResult("th_prior"));

    // No fallback thread/start — only the handshake's thread/resume happened.
    expect(threadStarts(stdinWrites(proc))).toHaveLength(0);
    // And the prompt was delivered on the resumed thread.
    expect(turnStarts(stdinWrites(proc))).toHaveLength(1);
  });
});

describe("CodexDriver encodeMessage — turn/steer expectedTurnId", () => {
  it("busy steer includes expectedTurnId = the active turn id (codex requires it)", () => {
    const driver = new CodexDriver();
    // Adopt a thread + observe a turn/started so the normalizer has both ids.
    driver.normalizeLine(threadStartResult("th_1"));
    driver.normalizeLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_9" } } }));

    const encoded = driver.encodeMessage("hang on", "th_1", { mode: "busy" });
    const msg = JSON.parse(encoded!);
    expect(msg.method).toBe("turn/steer");
    expect(msg.params.threadId).toBe("th_1");
    expect(msg.params.expectedTurnId).toBe("turn_9");
    expect(msg.params.input).toEqual([{ type: "text", text: "hang on" }]);
  });

  it("falls back to a fresh turn/start when there is no live turn to steer", () => {
    const driver = new CodexDriver();
    driver.normalizeLine(threadStartResult("th_1")); // thread but no active turn
    const encoded = driver.encodeMessage("hi", "th_1", { mode: "busy" });
    const msg = JSON.parse(encoded!);
    // No turn id → don't send an invalid steer; start a fresh turn instead.
    expect(msg.method).toBe("turn/start");
    expect(msg.params.expectedTurnId).toBeUndefined();
  });

  it("idle message is always a fresh turn/start (no expectedTurnId)", () => {
    const driver = new CodexDriver();
    driver.normalizeLine(threadStartResult("th_1"));
    driver.normalizeLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_9" } } }));
    const encoded = driver.encodeMessage("new topic", "th_1", { mode: "idle" });
    const msg = JSON.parse(encoded!);
    expect(msg.method).toBe("turn/start");
    expect(msg.params.expectedTurnId).toBeUndefined();
  });
});

describe("CodexDriver native turn interrupt", () => {
  it("interrupts the active turn over JSON-RPC without signaling the app-server", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_interrupt"));
    driver.normalizeLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "th_interrupt", turn: { id: "turn_active" } },
    }));

    await expect(driver.interrupt(
      { requestId: "owner-1", reason: "owner_request" },
      proc,
    )).resolves.toBe(true);
    const request = stdinWrites(proc)
      .map((write) => JSON.parse(write.trim()))
      .find((message) => message.method === "turn/interrupt");
    expect(request.params).toEqual({ threadId: "th_interrupt", turnId: "turn_active" });
    expect((proc as unknown as ReturnType<typeof simpleProcess>).kill).not.toHaveBeenCalled();
  });

  it("does not send an interrupt without an active turn or after its terminal event", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_interrupt"));
    await expect(driver.interrupt(
      { requestId: "before", reason: "owner_request" },
      proc,
    )).resolves.toBe(false);

    driver.normalizeLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "th_interrupt", turn: { id: "turn_done" } },
    }));
    driver.normalizeLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "th_interrupt", turn: { id: "turn_done", status: "completed" } },
    }));
    await expect(driver.interrupt(
      { requestId: "after", reason: "owner_request" },
      proc,
    )).resolves.toBe(false);

    const interrupts = stdinWrites(proc)
      .map((write) => JSON.parse(write.trim()))
      .filter((message) => message.method === "turn/interrupt");
    expect(interrupts).toHaveLength(0);
  });
});

describe("CodexDriver live reasoning settings", () => {
  it("rejects an update when no live thread is available", async () => {
    await expect(new CodexDriver().updateSettings({ reasoningEffort: "high" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "settings_thread_unavailable", retryable: true },
    });
  });

  it("correlates an explicit effort update by JSON-RPC id", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_settings"));

    const pending = driver.updateSettings({ reasoningEffort: "xhigh" });
    const request = stdinWrites(proc)
      .map((write) => JSON.parse(write.trim()))
      .find((message) => message.method === "thread/settings/update");
    expect(request.params).toEqual({ threadId: "th_settings", effort: "xhigh" });
    expect(driver.normalizeLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }))).toEqual([]);
    await expect(pending).resolves.toEqual({ status: "applied" });
  });

  it("sends null to restore Default and classifies method-not-found as unsupported", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_settings"));

    const pending = driver.updateSettings({ reasoningEffort: null });
    const request = stdinWrites(proc)
      .map((write) => JSON.parse(write.trim()))
      .find((message) => message.method === "thread/settings/update");
    expect(request.params).toEqual({ threadId: "th_settings", effort: null });
    driver.normalizeLine(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" },
    }));
    await expect(pending).resolves.toMatchObject({
      status: "unsupported",
      error: { code: "settings_update_unsupported" },
    });
  });

  it("maps a non-method RPC rejection to a sanitized retryable failure", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_settings"));

    const pending = driver.updateSettings({ reasoningEffort: "high" });
    const request = stdinWrites(proc)
      .map((write) => JSON.parse(write.trim()))
      .find((message) => message.method === "thread/settings/update");
    driver.normalizeLine(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "settings rejected" },
    }));

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      error: {
        category: "protocol",
        code: "settings_update_rejected",
        message: "settings rejected",
        retryable: true,
      },
    });
  });

  it("uses the fallback rejection message when the RPC error has no string message", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_settings"));

    const pending = driver.updateSettings({ reasoningEffort: "high" });
    const request = stdinWrites(proc)
      .map((write) => JSON.parse(write.trim()))
      .find((message) => message.method === "thread/settings/update");
    driver.normalizeLine(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: 42 },
    }));

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      error: { message: "Codex rejected the settings update" },
    });
  });

  it("maps a synchronous settings write failure to a retryable result", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_settings"));
    const stdin = (proc as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin;
    stdin.write.mockImplementationOnce(() => {
      throw new Error("write exploded");
    });

    await expect(driver.updateSettings({ reasoningEffort: "high" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "settings_update_write_failed", retryable: true },
    });
  });

  it("passes malformed non-settings lines through without claiming them", () => {
    const driver = new CodexDriver();
    expect(driver.normalizeLine("not-json")).toEqual([]);
    expect(driver.normalizeLine("null")).toEqual([]);
  });

  it("fails an in-flight update immediately when the Codex process exits", async () => {
    const driver = new CodexDriver();
    const { process: proc } = await driver.spawn(baseCtx());
    await Promise.resolve();
    driver.normalizeLine(threadStartResult("th_settings"));

    const pending = driver.updateSettings({ reasoningEffort: "minimal" });
    (proc as unknown as EventEmitter).emit("exit", 1, null);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      error: { category: "process", code: "settings_process_exited", retryable: true },
    });
  });

  it("times out an unacknowledged update", async () => {
    vi.useFakeTimers();
    try {
      const driver = new CodexDriver();
      const { process: proc } = await driver.spawn(baseCtx());
      await Promise.resolve();
      driver.normalizeLine(threadStartResult("th_settings"));

      const pending = driver.updateSettings({ reasoningEffort: "minimal" });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toMatchObject({
        status: "failed",
        error: { category: "timeout", code: "settings_update_timeout", retryable: true },
      });
      expect(proc).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a timeout after its pending correlation was already removed", async () => {
    vi.useFakeTimers();
    try {
      const driver = new CodexDriver();
      const { process: proc } = await driver.spawn(baseCtx());
      await Promise.resolve();
      driver.normalizeLine(threadStartResult("th_settings"));

      void driver.updateSettings({ reasoningEffort: "minimal" });
      const request = stdinWrites(proc)
        .map((write) => JSON.parse(write.trim()))
        .find((message) => message.method === "thread/settings/update");
      (driver as unknown as { pendingSettingsUpdates: Map<number, unknown> })
        .pendingSettingsUpdates.delete(request.id);

      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

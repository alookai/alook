import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import type { AgentMessage } from "../../types.js";

let currentMockProc: ReturnType<typeof createMockProc> | null = null;

function createMockProc() {
  const stdinWrites: string[] = [];
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: {
      write: (data: string) => {
        stdinWrites.push(data);
        return true;
      },
    },
    kill: vi.fn(),
    pid: 12345,
  });
  return { proc, stdout, stderr, stdinWrites };
}

vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    currentMockProc = createMockProc();
    return currentMockProc.proc;
  }),
}));

async function collectMessages(
  messages: AsyncIterable<AgentMessage>,
  maxMessages = 100,
  timeoutMs = 500,
): Promise<AgentMessage[]> {
  const collected: AgentMessage[] = [];
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  const iter = messages[Symbol.asyncIterator]();
  for (let i = 0; i < maxMessages; i++) {
    const next = iter.next();
    const result = await Promise.race([next, timeout.then(() => null)]);
    if (!result || result.done) break;
    collected.push(result.value);
  }
  return collected;
}

const { CodexBackend, extractThreadID } = await import("../codex.js");

function getMock() {
  return currentMockProc!;
}

function sendResponse(id: number, result: unknown) {
  getMock().stdout.push(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id: number, error: { code: number; message: string }) {
  getMock().stdout.push(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\n");
}

function sendNotification(method: string, params?: Record<string, unknown>) {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params) msg.params = params;
  getMock().stdout.push(JSON.stringify(msg) + "\n");
}

function sendServerRequest(id: number, method: string, params?: Record<string, unknown>) {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params) msg.params = params;
  getMock().stdout.push(JSON.stringify(msg) + "\n");
}

async function completeHandshake(threadId = "thread_abc") {
  await tick();
  sendResponse(1, { capabilities: {} }); // initialize response
  await tick();
  sendResponse(2, { thread: { id: threadId } }); // thread/start response
  await tick();
  sendResponse(3, {}); // turn/start response
  await tick();
}

function tick(ms = 15) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("extractThreadID", () => {
  it("extracts from nested response", () => {
    expect(extractThreadID({ result: { thread: { id: "t_1" } } })).toBe("t_1");
  });

  it("extracts from flat thread object", () => {
    expect(extractThreadID({ thread: { id: "t_2" } })).toBe("t_2");
  });

  it("returns empty string when missing", () => {
    expect(extractThreadID(null)).toBe("");
    expect(extractThreadID({})).toBe("");
    expect(extractThreadID({ thread: {} })).toBe("");
  });
});

describe("CodexBackend", () => {
  let backend: InstanceType<typeof CodexBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMockProc = null;
    backend = new CodexBackend("/usr/bin/codex");
  });

  it("sends structured initialize params", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await tick();

    const initWrite = mock.stdinWrites.find((w) => w.includes('"initialize"'));
    expect(initWrite).toBeDefined();
    const parsed = JSON.parse(initWrite!);
    expect(parsed.params.clientInfo.name).toBe("alook-daemon");
    expect(parsed.params.clientInfo.title).toBe("Alook Agent SDK");
    expect(parsed.params.capabilities.experimentalApi).toBe(true);
    expect(parsed.id).toBe(1);

    mock.proc.emit("close", 1);
    await session.result;
  });

  it("sends initialized notification after initialize response", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await tick();
    sendResponse(1, { capabilities: {} });
    await tick();

    const initializedWrite = mock.stdinWrites.find((w) => w.includes('"initialized"'));
    expect(initializedWrite).toBeDefined();
    const parsed = JSON.parse(initializedWrite!);
    expect(parsed.method).toBe("initialized");
    expect(parsed.id).toBeUndefined();

    mock.proc.emit("close", 1);
    await session.result;
  });

  it("thread/start includes correct params without developerInstructions", async () => {
    const session = backend.execute("hello", {
      cwd: "/tmp",
      model: "gpt-4",
    });
    const mock = getMock();

    await tick();
    sendResponse(1, {});
    await tick(30);

    const threadWrite = mock.stdinWrites.find((w) => w.includes('"thread/start"'));
    expect(threadWrite).toBeDefined();
    const parsed = JSON.parse(threadWrite!);
    expect(parsed.params.cwd).toBe("/tmp");
    expect(parsed.params.sandbox).toBe("workspace-write");
    expect(parsed.params.persistExtendedHistory).toBe(true);
    expect(parsed.params.experimentalRawEvents).toBe(false);
    expect(parsed.params.developerInstructions).toBeUndefined();
    expect(parsed.params.model).toBe("gpt-4");

    mock.proc.emit("close", 1);
    await session.result;
  });

  it("turn/start RPC sent with threadId and prompt", async () => {
    const session = backend.execute("do stuff", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake("thread_xyz");

    const turnWrite = mock.stdinWrites.find((w) => w.includes('"turn/start"'));
    expect(turnWrite).toBeDefined();
    const parsed = JSON.parse(turnWrite!);
    expect(parsed.params.threadId).toBe("thread_xyz");
    expect(parsed.params.input).toEqual([{ type: "text", text: "do stuff" }]);

    mock.proc.emit("close", 0);
    await session.result;
  });

  it("extracts session ID from thread/start response", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake("my_thread_id");
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.sessionId).toBe("my_thread_id");
  });

  it("JSON-RPC error response rejects pending request", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await tick();
    sendError(1, { code: -1, message: "init failed" });
    await tick(30);

    mock.proc.emit("close", 1);

    const result = await session.result;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("init failed");
  });

  it("JSON-RPC error response (id + error, no method) routed to response resolution", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await tick();
    // Send error response — should NOT go to notification handler
    sendError(1, { code: -32600, message: "bad request" });
    await tick(30);

    mock.proc.emit("close", 1);
    const result = await session.result;
    expect(result.error).toContain("bad request");
  });

  it("routes server requests (id + method) to handleServerRequest", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendServerRequest(99, "item/commandExecution/requestApproval", {});
    await tick();

    const resp = mock.stdinWrites.find((w) => w.includes('"id":99') && w.includes('"decision"'));
    expect(resp).toBeDefined();
    expect(JSON.parse(resp!).result.decision).toBe("accept");

    mock.proc.emit("close", 0);
    await session.result;
  });

  it("sends {decision: accept} for item/fileChange/requestApproval", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendServerRequest(100, "item/fileChange/requestApproval", {});
    await tick();

    const resp = mock.stdinWrites.find((w) => w.includes('"id":100'));
    expect(JSON.parse(resp!).result.decision).toBe("accept");

    mock.proc.emit("close", 0);
    await session.result;
  });

  it("sends {decision: accept} for execCommandApproval", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendServerRequest(101, "execCommandApproval", {});
    await tick();

    const resp = mock.stdinWrites.find((w) => w.includes('"id":101'));
    expect(JSON.parse(resp!).result.decision).toBe("accept");

    mock.proc.emit("close", 0);
    await session.result;
  });

  it("sends {decision: accept} for applyPatchApproval", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendServerRequest(102, "applyPatchApproval", {});
    await tick();

    const resp = mock.stdinWrites.find((w) => w.includes('"id":102'));
    expect(JSON.parse(resp!).result.decision).toBe("accept");

    mock.proc.emit("close", 0);
    await session.result;
  });

  it("sends empty {} for unknown server requests", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendServerRequest(200, "unknown/method", {});
    await tick();

    const resp = mock.stdinWrites.find((w) => w.includes('"id":200'));
    expect(resp).toBeDefined();
    expect(JSON.parse(resp!).result).toEqual({});

    mock.proc.emit("close", 0);
    await session.result;
  });

  // Legacy protocol tests
  it("legacy codex/event — task_started emits status running", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("codex/event", { type: "task_started" });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "status", status: "running" });
  });

  it("legacy codex/event — agent_message emits MessageText", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("codex/event", { type: "agent_message", text: "I found the issue" });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "text", content: "I found the issue" });
  });

  it("legacy codex/event — exec_command_begin/end emits tool-use + tool-result", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("codex/event", { type: "exec_command_begin", id: "cmd_1", command: "ls" });
    sendNotification("codex/event", { type: "exec_command_end", id: "cmd_1", output: "total 0" });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-use", tool: "exec_command", callId: "cmd_1" }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-result", callId: "cmd_1", output: "total 0" }),
    );
  });

  it("legacy codex/event — patch_apply_begin/end emits tool-use + tool-result", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("codex/event", { type: "patch_apply_begin", id: "patch_1" });
    sendNotification("codex/event", { type: "patch_apply_end", id: "patch_1", output: "applied" });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-use", tool: "patch_apply", callId: "patch_1" }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-result", callId: "patch_1", output: "applied" }),
    );
  });

  it("legacy codex/event — task_complete triggers turn done (not aborted)", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("codex/event", { type: "task_complete", output: "all done" });
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("all done");
  });

  it("legacy codex/event — turn_aborted triggers aborted", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("codex/event", { type: "turn_aborted" });
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("aborted");
  });

  // Raw protocol tests
  it("raw protocol — turn/started sets status and captures turnId", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("turn/started", { turnId: "turn_1" });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "status", status: "turn_start" });
  });

  it("raw protocol — turn/completed with completed triggers turn done", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("turn/completed", { turnId: "turn_1", status: "completed" });
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
  });

  it("raw protocol — turn/completed with cancelled triggers aborted", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("turn/completed", { turnId: "turn_1", status: "cancelled" });
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("aborted");
  });

  it("raw protocol — duplicate turn/completed for same turnId is deduplicated", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("turn/completed", { turnId: "turn_1", status: "completed" });
    sendNotification("turn/completed", { turnId: "turn_1", status: "failed", output: "should not override" });
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
  });

  it("raw protocol — item/started (commandExecution) emits tool-use", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("item/started", {
      item: { type: "commandExecution", id: "cmd_1", command: "ls" },
    });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-use", tool: "exec_command", callId: "cmd_1" }),
    );
  });

  it("raw protocol — item/completed (commandExecution) emits tool-result with aggregatedOutput", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("item/completed", {
      item: { type: "commandExecution", id: "cmd_1", aggregatedOutput: "total 0\n" },
    });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-result", callId: "cmd_1", output: "total 0\n" }),
    );
  });

  it("raw protocol — item/started (fileChange) emits tool-use patch_apply", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("item/started", { item: { type: "fileChange", id: "fc_1" } });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-use", tool: "patch_apply", callId: "fc_1" }),
    );
  });

  it("raw protocol — item/completed (fileChange) emits tool-result", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("item/completed", { item: { type: "fileChange", id: "fc_1" } });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-result", callId: "fc_1", output: "" }),
    );
  });

  it("raw protocol — item/completed (agentMessage, phase=final_answer) emits text + turn done", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("item/completed", {
      item: {
        type: "agentMessage",
        phase: "final_answer",
        content: [{ type: "text", text: "Here is the answer" }],
      },
    });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "text", content: "Here is the answer" });
  });

  it("raw protocol — thread/status/changed (idle) triggers turn done", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("turn/started", { turnId: "turn_1" });
    sendNotification("thread/status/changed", { status: "idle" });
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
  });

  // Protocol detection / locking
  it("first legacy event locks protocol to legacy", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("codex/event", { type: "task_started" });
    sendNotification("turn/started", { turnId: "turn_1" });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "status", status: "running" });
    expect(messages).not.toContainEqual({ type: "status", status: "turn_start" });
  });

  it("first raw event locks protocol to raw", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await completeHandshake();
    sendNotification("turn/started", { turnId: "turn_1" });
    sendNotification("codex/event", { type: "agent_message", text: "ignored" });
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "status", status: "turn_start" });
    expect(messages).not.toContainEqual({ type: "text", content: "ignored" });
  });

  it("handles invalid JSON gracefully", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push("not valid json\n");
    await tick();
    mock.proc.emit("close", 1);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "log", content: "not valid json", level: "debug" });
  });

  it("closeAllPending sends error to all pending RPC callbacks on process close", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    // Don't respond to initialize — let process close while it's pending
    await tick(30);
    mock.proc.emit("close", 1);

    const result = await session.result;
    // Process exiting with code 1 without responding sets failed status
    expect(result.status).toBe("failed");
  });

  it("timeout kills process and sets status to timeout", async () => {
    vi.useFakeTimers();
    const session = backend.execute("hello", { cwd: "/tmp", timeout: 5000 });
    const mock = getMock();

    vi.advanceTimersByTime(5000);
    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");

    mock.proc.emit("close", null);

    const result = await session.result;
    expect(result.status).toBe("timeout");
    vi.useRealTimers();
  });
});

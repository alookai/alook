import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { spawn } from "child_process";
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

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: vi.fn().mockResolvedValue(undefined),
  killGraceMs: () => 2000,
  isAlive: () => false,
}));

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function collectMessages(
  messages: AsyncIterable<AgentMessage>,
  maxMessages = 50,
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

const { ClaudeBackend } = await import("../claude.js");

describe("ClaudeBackend", () => {
  let backend: InstanceType<typeof ClaudeBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMockProc = null;
    backend = new ClaudeBackend("/usr/bin/claude");
  });

  function getMock() {
    return currentMockProc!;
  }

  it("emits MessageText for assistant text blocks", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
      }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "text", content: "Hello world" });
  });

  it("emits MessageThinking for thinking blocks", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", text: "Let me think..." }] },
      }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "thinking", content: "Let me think..." });
  });

  it("emits MessageToolUse for tool_use blocks", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "read_file", id: "call_123", input: { path: "/tmp/test.txt" } },
          ],
        },
      }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({
      type: "tool-use",
      tool: "read_file",
      callId: "call_123",
      input: { path: "/tmp/test.txt" },
    });
  });

  it("emits MessageToolResult for tool_result events", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({ type: "tool_result", content: "file contents here", tool_use_id: "call_123" }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({
      type: "tool-result",
      callId: "call_123",
      output: "file contents here",
    });
  });

  it("writes correct control_request approval format", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({
        type: "control_request",
        request_id: "req_abc",
        payload: { input: '{"command":"ls"}' },
      }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    await session.result;

    const approvalWrite = mock.stdinWrites.find((w) => w.includes("control_response"));
    expect(approvalWrite).toBeDefined();
    const parsed = JSON.parse(approvalWrite!.trim());
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.subtype).toBe("success");
    expect(parsed.response.request_id).toBe("req_abc");
    expect(parsed.response.response.behavior).toBe("allow");
    expect(parsed.response.response.updatedInput).toEqual({ command: "ls" });
  });

  it("does not write approval when request_id is missing", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "control_request" }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    await session.result;

    const approvalWrite = mock.stdinWrites.find((w) => w.includes("control_response"));
    expect(approvalWrite).toBeUndefined();
  });

  it("captures session ID from system event (subtype init)", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess_123" }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.sessionId).toBe("sess_123");
  });

  it("captures session ID from result event", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({ type: "result", result: "done", session_id: "sess_456" }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.sessionId).toBe("sess_456");
  });

  it("sets status to failed when result event has is_error", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({ type: "result", result: "something went wrong", is_error: true }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("something went wrong");
  });

  it("handles invalid JSON gracefully", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push("not json at all\n");
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "log", content: "not json at all", level: "debug" });
  });

  it("sets status to timeout when process is killed by timeout", async () => {
    vi.useFakeTimers();
    const killTree = await vi.importMock<typeof import("../../kill-tree.js")>("../../kill-tree.js");
    const session = backend.execute("hello", { cwd: "/tmp", timeout: 1000 });
    const mock = getMock();

    vi.advanceTimersByTime(1000);
    expect(killTree.killProcessTree).toHaveBeenCalledWith(12345);

    mock.proc.emit("close", null);

    const result = await session.result;
    expect(result.status).toBe("timeout");
    vi.useRealTimers();
  });

  it("TC8: spawns the CLI detached on POSIX so its group can be reaped", () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    expect(session.pid).toBe(12345);
    const opts = vi.mocked(spawn).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(opts.detached).toBe(process.platform !== "win32");
  });
});

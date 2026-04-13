import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import type { AgentMessage } from "../../types.js";

let currentMockProc: ReturnType<typeof createMockProc> | null = null;
let lastSpawnArgs: { cmd: string; args: string[]; opts: Record<string, unknown> } | null = null;

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
  spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
    lastSpawnArgs = { cmd, args, opts };
    currentMockProc = createMockProc();
    return currentMockProc.proc;
  }),
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

const { OpenCodeBackend } = await import("../opencode.js");

function getMock() {
  return currentMockProc!;
}

describe("OpenCodeBackend", () => {
  let backend: InstanceType<typeof OpenCodeBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMockProc = null;
    lastSpawnArgs = null;
    backend = new OpenCodeBackend("/usr/bin/opencode");
  });

  it("emits MessageText for assistant message events", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "message", role: "assistant", content: "Hi there" }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "text", content: "Hi there" });
  });

  it("does not emit for empty message content", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "message", role: "assistant", content: "" }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    const textMessages = messages.filter((m) => m.type === "text");
    expect(textMessages).toHaveLength(0);
  });

  it("emits tool-use for tool_call events", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({ type: "tool_call", name: "read_file", call_id: "call_1", input: { path: "/test" } }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({
      type: "tool-use",
      tool: "read_file",
      callId: "call_1",
      input: { path: "/test" },
    });
  });

  it("emits tool-result for tool_result events", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({ type: "tool_result", call_id: "call_1", output: "file contents" }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({
      type: "tool-result",
      callId: "call_1",
      output: "file contents",
    });
  });

  it("emits error event and sets error", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "error", message: "something broke" }) + "\n");
    await tick();
    mock.proc.emit("close", 1);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "error", content: "something broke" });
  });

  it("error event with content fallback works", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "error", content: "fallback error" }) + "\n");
    await tick();
    mock.proc.emit("close", 1);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "error", content: "fallback error" });
  });

  it("captures session ID from session event", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "session", session_id: "sess_abc" }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.sessionId).toBe("sess_abc");
  });

  it("session ID uses last non-empty value", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "session", session_id: "first" }) + "\n");
    mock.stdout.push(JSON.stringify({ type: "session", session_id: "" }) + "\n");
    mock.stdout.push(JSON.stringify({ type: "session", session_id: "last" }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.sessionId).toBe("last");
  });

  it("handles empty lines and invalid JSON gracefully", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push("\n");
    mock.stdout.push("   \n");
    mock.stdout.push("not json\n");
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "log", content: "not json", level: "debug" });
  });

  it("OPENCODE_PERMISSION env var is set on subprocess", () => {
    backend.execute("hello", { cwd: "/tmp" });
    expect(lastSpawnArgs).toBeTruthy();
    const env = lastSpawnArgs!.opts.env as Record<string, string>;
    expect(env.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
  });

  it("merges execenv vars into spawn env and OPENCODE_PERMISSION wins", () => {
    backend.execute("hello", {
      cwd: "/tmp",
      env: { ALOOK_WORKSPACE_ID: "ws1", OPENCODE_PERMISSION: "should-be-overridden" },
    });
    expect(lastSpawnArgs).toBeTruthy();
    const env = lastSpawnArgs!.opts.env as Record<string, string>;
    expect(env.ALOOK_WORKSPACE_ID).toBe("ws1");
    expect(env.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
  });

  it("does not pass --prompt flag, user prompt is positional", () => {
    backend.execute("do things", { cwd: "/tmp" });
    expect(lastSpawnArgs).toBeTruthy();
    const args = lastSpawnArgs!.args;
    expect(args).not.toContain("--prompt");
    expect(args[args.length - 1]).toBe("do things");
  });

  it("sets status to timeout when process is killed by timeout", async () => {
    vi.useFakeTimers();
    const session = backend.execute("hello", { cwd: "/tmp", timeout: 3000 });
    const mock = getMock();

    vi.advanceTimersByTime(3000);
    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");

    mock.proc.emit("close", null);

    const result = await session.result;
    expect(result.status).toBe("timeout");
    vi.useRealTimers();
  });

  it("error event with nil error emits empty content", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "error" }) + "\n");
    await tick();
    mock.proc.emit("close", 1);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "error", content: "" });
  });

  it("tool_call with missing fields does not crash", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "tool_call" }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "tool-use", tool: "" }),
    );
  });

  it("done/complete event updates output and session ID", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(
      JSON.stringify({ type: "done", output: "final output", session_id: "sess_done", status: "completed" }) + "\n",
    );
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.output).toBe("final output");
    expect(result.sessionId).toBe("sess_done");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import type { AgentMessage } from "../../types.js";

let currentMockProc: ReturnType<typeof createMockProc> | null = null;
let lastSpawnArgs: { cmd: string; args: string[]; opts: Record<string, unknown> } | null = null;

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null,
    kill: vi.fn(),
    pid: 12345,
  });
  return { proc, stdout, stderr };
}

vi.mock("child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
    lastSpawnArgs = { cmd, args, opts };
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

  it("spawns with stdin ignored to prevent opencode from blocking on pipe", () => {
    backend.execute("hello", { cwd: "/tmp" });
    expect(lastSpawnArgs).toBeTruthy();
    const stdio = lastSpawnArgs!.opts.stdio as string[];
    expect(stdio[0]).toBe("ignore");
    expect(stdio[1]).toBe("pipe");
    expect(stdio[2]).toBe("pipe");
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

  it("TC8: spawns the CLI detached on POSIX so its group can be reaped", () => {
    backend.execute("hello", { cwd: "/tmp" });
    expect(lastSpawnArgs).toBeTruthy();
    expect(lastSpawnArgs!.opts.detached).toBe(process.platform !== "win32");
  });

  it("sets status to timeout when process is killed by timeout", async () => {
    vi.useFakeTimers();
    const killTree = await vi.importMock<typeof import("../../kill-tree.js")>("../../kill-tree.js");
    const session = backend.execute("hello", { cwd: "/tmp", timeout: 3000 });
    const mock = getMock();

    vi.advanceTimersByTime(3000);
    expect(killTree.killProcessTree).toHaveBeenCalledWith(12345);

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

  // --- Turn completion: process lifecycle ---

  it("done event kills the process", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "done", output: "all done" }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");

    mock.proc.emit("close", 0);
    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("all done");
  });

  it("complete event kills the process", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "complete", output: "finished" }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");

    mock.proc.emit("close", 0);
    const result = await session.result;
    expect(result.status).toBe("completed");
  });

  it("error event kills the process", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "error", message: "fatal error" }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");

    mock.proc.emit("close", 1);
    const result = await session.result;
    expect(result.error).toBe("fatal error");
  });

  it("turnDone is idempotent — done after error does not double-kill", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "error", message: "boom" }) + "\n");
    await tick();
    mock.stdout.push(JSON.stringify({ type: "done", output: "done anyway" }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledTimes(1);

    mock.proc.emit("close", 1);
    await session.result;
  });

  it("full flow: message → tool_call → tool_result → done → result resolves", async () => {
    const session = backend.execute("fix the bug", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "session", session_id: "sess_123" }) + "\n");
    mock.stdout.push(JSON.stringify({ type: "message", role: "assistant", content: "Let me check" }) + "\n");
    mock.stdout.push(JSON.stringify({ type: "tool_call", name: "read_file", call_id: "c1", input: { path: "/bug.ts" } }) + "\n");
    mock.stdout.push(JSON.stringify({ type: "tool_result", call_id: "c1", output: "buggy code" }) + "\n");
    mock.stdout.push(JSON.stringify({ type: "message", role: "assistant", content: "Found the bug" }) + "\n");
    mock.stdout.push(JSON.stringify({ type: "done", output: "Found the bug", session_id: "sess_123" }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Found the bug");
    expect(result.sessionId).toBe("sess_123");

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "text", content: "Let me check" });
    expect(messages).toContainEqual({ type: "text", content: "Found the bug" });
    expect(messages).toContainEqual(expect.objectContaining({ type: "tool-use", tool: "read_file", callId: "c1" }));
    expect(messages).toContainEqual(expect.objectContaining({ type: "tool-result", callId: "c1", output: "buggy code" }));
  });

  // --- v1.14+ format tests ---

  it("v1.14+: emits text from part.text field", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({
      type: "text",
      timestamp: 1777626241755,
      sessionID: "ses_abc123",
      part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_abc123", type: "text", text: "Hello from v1.14!" },
    }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "text", content: "Hello from v1.14!" });

    const result = await session.result;
    expect(result.output).toBe("Hello from v1.14!");
    expect(result.sessionId).toBe("ses_abc123");
  });

  it("v1.14+: step_finish with reason=stop calls turnDone", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({
      type: "step_start",
      sessionID: "ses_abc",
      part: { type: "step-start" },
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "text",
      sessionID: "ses_abc",
      part: { type: "text", text: "Done!" },
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "step_finish",
      sessionID: "ses_abc",
      part: { type: "step-finish", reason: "stop", tokens: { total: 100 } },
    }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Done!");
  });

  it("v1.14+: extracts sessionID from event-level field", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({
      type: "step_start",
      sessionID: "ses_from_event",
      part: { type: "step-start" },
    }) + "\n");
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.sessionId).toBe("ses_from_event");
  });

  it("v1.14+: full flow with new format", async () => {
    const session = backend.execute("你是谁", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({
      type: "step_start",
      sessionID: "ses_new",
      part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_new", type: "step-start" },
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "text",
      sessionID: "ses_new",
      part: { id: "prt_2", messageID: "msg_1", sessionID: "ses_new", type: "text", text: "我是トニー大木" },
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "step_finish",
      sessionID: "ses_new",
      part: { id: "prt_3", reason: "stop", messageID: "msg_1", sessionID: "ses_new", type: "step-finish", tokens: { total: 20145, input: 6, output: 34 }, cost: 0.12 },
    }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("我是トニー大木");
    expect(result.sessionId).toBe("ses_new");

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({ type: "text", content: "我是トニー大木" });
  });

  it("v1.14+: non-zero exit after turnDone still reports completed", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({
      type: "text",
      sessionID: "ses_x",
      part: { type: "text", text: "Done!" },
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "step_finish",
      sessionID: "ses_x",
      part: { type: "step-finish", reason: "stop" },
    }) + "\n");
    await tick();

    expect(mock.proc.kill).toHaveBeenCalledWith("SIGTERM");
    // Process exits with non-zero due to SIGTERM (143)
    mock.proc.emit("close", 143);

    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Done!");
  });

  it("non-zero exit with output but no turnDone still reports completed", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push(JSON.stringify({ type: "message", role: "assistant", content: "Got it" }) + "\n");
    await tick();
    // Process crashes after producing output
    mock.proc.emit("close", 1);

    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Got it");
  });

  it("non-zero exit with no output and no turnDone reports failed", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    await tick();
    mock.proc.emit("close", 1);

    const result = await session.result;
    expect(result.status).toBe("failed");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import type { AgentMessage } from "../../types.js";

let currentMockProc: ReturnType<typeof createMockProc> | null = null;
let lastSpawnArgs: {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
} | null = null;

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
  spawn: vi.fn(
    (cmd: string, args: string[], opts: Record<string, unknown>) => {
      lastSpawnArgs = { cmd, args, opts };
      currentMockProc = createMockProc();
      return currentMockProc.proc;
    },
  ),
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

const { HermesBackend } = await import("../hermes.js");

function getMock() {
  return currentMockProc!;
}

describe("HermesBackend", () => {
  let backend: InstanceType<typeof HermesBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMockProc = null;
    lastSpawnArgs = null;
    backend = new HermesBackend("/usr/bin/hermes");
  });

  it("spawns hermes with chat -Q -q flags", () => {
    backend.execute("do something", { cwd: "/tmp" });
    expect(lastSpawnArgs!.cmd).toBe("/usr/bin/hermes");
    expect(lastSpawnArgs!.args).toEqual([
      "chat",
      "-Q",
      "-q",
      "do something",
    ]);
  });

  it("includes model flag when model is specified", () => {
    backend.execute("hello", { cwd: "/tmp", model: "anthropic/claude-sonnet-4" });
    expect(lastSpawnArgs!.args).toEqual([
      "-m",
      "anthropic/claude-sonnet-4",
      "chat",
      "-Q",
      "-q",
      "hello",
    ]);
  });

  it("emits text messages from stdout lines", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push("session_id: 20260705_test123\n");
    await tick();
    mock.stdout.push("Hello from Hermes\n");
    await tick();
    mock.proc.emit("close", 0);

    const messages = await collectMessages(session.messages);
    expect(messages).toContainEqual({
      type: "log",
      content: "session_id: 20260705_test123",
      level: "info",
    });
    expect(messages).toContainEqual({
      type: "text",
      content: "Hello from Hermes",
    });
  });

  it("resolves sessionId from session_id line", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push("session_id: 20260705_abc123\n");
    await tick();
    mock.proc.emit("close", 0);

    const sessionId = await session.sessionId;
    expect(sessionId).toBe("20260705_abc123");
  });

  it("completes successfully on exit code 0", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stdout.push("session_id: 20260705_ok\n");
    mock.stdout.push("Done\n");
    await tick();
    mock.proc.emit("close", 0);

    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Done");
  });

  it("fails on non-zero exit code with no output", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.proc.emit("close", 1);

    const result = await session.result;
    expect(result.status).toBe("failed");
  });

  it("captures stderr as error", async () => {
    const session = backend.execute("hello", { cwd: "/tmp" });
    const mock = getMock();

    mock.stderr.push("Error: something went wrong\n");
    await tick();
    mock.proc.emit("close", 1);

    const result = await session.result;
    expect(result.error).toContain("something went wrong");
  });

  it("handles spawn errors gracefully", async () => {
    const { spawn } = await import("child_process");
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    // Re-create backend to get fresh mock
    const backend2 = new HermesBackend("/usr/bin/hermes");
    expect(() => backend2.execute("hello", { cwd: "/tmp" })).toThrow();
  });

  it("passes env vars to child process", () => {
    backend.execute("hello", {
      cwd: "/tmp",
      env: { HERMES_PROFILE: "codehub" },
    });
    const env = lastSpawnArgs!.opts.env as Record<string, string>;
    expect(env.HERMES_PROFILE).toBe("codehub");
  });
});

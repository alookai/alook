import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";

let currentMockProc: ReturnType<typeof createMockProc> | null = null;

function createMockProc() {
  const stdinWrites: string[] = [];
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinEnd = vi.fn();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: {
      write: (data: string) => {
        stdinWrites.push(data);
        return true;
      },
      end: stdinEnd,
    },
    kill: vi.fn(),
    pid: 12345,
  });
  return { proc, stdout, stderr, stdinWrites, stdinEnd };
}

vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    currentMockProc = createMockProc();
    return currentMockProc.proc;
  }),
}));

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const { CodexBackend } = await import("../codex.js");

function getMock() {
  return currentMockProc!;
}

function sendResponse(id: number, result: unknown) {
  getMock().stdout.push(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendServerRequest(id: number, method: string, params?: Record<string, unknown>) {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params) msg.params = params;
  getMock().stdout.push(JSON.stringify(msg) + "\n");
}

async function completeHandshake(threadId = "thread_abc") {
  await tick();
  sendResponse(1, { capabilities: {} });
  await tick();
  sendResponse(2, { thread: { id: threadId } });
  await tick();
  sendResponse(3, {});
  await tick();
}

describe("CodexBackend triage_readonly profile", () => {
  let backend: InstanceType<typeof CodexBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMockProc = null;
    backend = new CodexBackend("/usr/bin/codex");
  });

  it("spawns codex with read-only sandbox config override", async () => {
    const { spawn } = await import("child_process");
    const session = backend.execute("hello", { cwd: "/tmp", executionProfile: "triage_readonly" });
    const mock = getMock();

    const spawnCall = (spawn as any).mock.calls[0];
    expect(spawnCall[1]).toEqual(["app-server", "--listen", "stdio://", "--config", "sandbox_mode=read-only"]);

    mock.proc.emit("close", 0);
    await session.result;
  });

  it("thread/start uses read-only sandbox and approval requests", async () => {
    const session = backend.execute("hello", {
      cwd: "/tmp",
      executionProfile: "triage_readonly",
    });
    const mock = getMock();

    await tick();
    sendResponse(1, {});
    await tick(30);

    const threadWrite = mock.stdinWrites.find((w) => w.includes('"thread/start"'));
    expect(threadWrite).toBeDefined();
    const parsed = JSON.parse(threadWrite!);
    expect(parsed.params.sandboxPolicy).toEqual({ type: "readOnly" });
    expect(parsed.params.approvalPolicy).toBe("on-request");

    mock.proc.emit("close", 1);
    await session.result;
  });

  it("rejects command approval requests", async () => {
    const session = backend.execute("hello", { cwd: "/tmp", executionProfile: "triage_readonly" });
    const mock = getMock();

    await completeHandshake();
    sendServerRequest(99, "item/commandExecution/requestApproval", {});
    await tick();

    const resp = mock.stdinWrites.find((w) => w.includes('"id":99') && w.includes('"decision"'));
    expect(resp).toBeDefined();
    expect(JSON.parse(resp!).result.decision).toBe("reject");

    mock.proc.emit("close", 0);
    await session.result;
  });
});

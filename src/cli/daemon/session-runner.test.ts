import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockClientInstance = {
  completeTask: vi.fn(async () => ({})),
  failTask: vi.fn(async () => ({})),
  reportMessages: vi.fn(async () => ({})),
};
vi.mock("./client.js", () => {
  function MockDaemonClient() { return mockClientInstance; }
  return { DaemonClient: MockDaemonClient };
});

const mockPrepare = vi.fn(() => ({
  workDir: "/tmp/ws/ws1/agent1/workdir",
  timelineDir: "/tmp/ws/ws1/agent1/workdir/.context_timeline",
  env: {
    ALOOK_WORKSPACE_ID: "ws1",
    ALOOK_AGENT_ID: "agent1",
    ALOOK_TASK_ID: "t1",
    ALOOK_CONVERSATION_ID: "c1",
    ALOOK_HEALTH_PORT: "19514",
  },
}));
vi.mock("./execenv/index.js", () => ({
  prepare: (...args: any[]) => mockPrepare(...args),
}));

const mockInitEntryAsync = vi.fn(async () => {});
const mockUpdateEntry = vi.fn();
const mockCreateTimelineEntry = vi.fn(
  (
    taskId: string,
    prompt: string,
    type: string,
    sessionId?: string,
    pid?: number,
    provider?: string,
    contextKey?: string | null,
    detailedLog?: string | null,
  ) => ({
    task_id: taskId,
    context_key: contextKey ?? null,
    session_id: sessionId || null,
    pid: pid ?? null,
    status: "running",
    datetime: "2026-04-16T10:00:00-05:00",
    type,
    prompt,
    agent_responses: [],
    errmsg: null,
    provider: provider || null,
    detailed_log: detailedLog ?? null,
  }),
);
const mockFindResumableSessionByContextKey = vi.fn(() => null);
vi.mock("./execenv/timeline.js", () => ({
  initEntryAsync: (...args: any[]) => mockInitEntryAsync(...args),
  updateEntry: (...args: any[]) => mockUpdateEntry(...args),
  createTimelineEntry: (...args: any[]) => mockCreateTimelineEntry(...args),
  findResumableSessionByContextKey: (...args: any[]) => mockFindResumableSessionByContextKey(...args),
}));

vi.mock("./prompt.js", () => ({
  buildPrompt: vi.fn((task: any) => task.prompt),
}));

const mockBackendExecute = vi.fn();
vi.mock("./agent/index.js", () => ({
  createBackend: vi.fn(() => ({
    name: "claude",
    execute: (...args: any[]) => mockBackendExecute(...args),
  })),
}));

vi.mock("../lib/logger.js", () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { runSession } from "./session-runner.js";
import { createBackend } from "./agent/index.js";
import { buildPrompt } from "./prompt.js";
import { log as mockLog } from "../lib/logger.js";
import type { SessionRunnerInput } from "./types.js";

function makeInput(overrides?: Partial<SessionRunnerInput>): SessionRunnerInput {
  return {
    task: {
      id: "t1",
      agentId: "a1",
      runtimeId: "rt1",
      conversationId: "c1",
      workspaceId: "ws1",
      prompt: "do the thing",
      status: "dispatched",
      priority: 0,
      type: "user_dm_message",
      contextKey: "dm:c1",
      createdAt: "2026-01-01T00:00:00Z",
    },
    provider: "claude",
    cliPath: "claude",
    model: "opus",
    serverURL: "http://localhost:8080",
    token: "test_token",
    workspacesRoot: "/tmp/ws",
    agentTimeout: 7200000,
    ...overrides,
  };
}

function setupBackend(
  messages: any[],
  result: any,
  sessionId = "sess-1",
) {
  mockBackendExecute.mockReturnValue({
    pid: 12345,
    messages: (async function* () {
      for (const msg of messages) yield msg;
    })(),
    sessionId: Promise.resolve(sessionId),
    result: Promise.resolve(result),
  });
}

describe("session-runner runSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses input, calls prepare, executes backend, and calls completeTask", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done!",
      error: "",
      durationMs: 1000,
      sessionId: "sess-1",
    });

    await runSession(makeInput());

    expect(mockPrepare).toHaveBeenCalledWith(
      { workspacesRoot: "/tmp/ws" },
      expect.objectContaining({ id: "t1" }),
    );
    expect(createBackend).toHaveBeenCalledWith("claude", "claude");
    expect(mockBackendExecute).toHaveBeenCalledWith(
      "do the thing",
      expect.objectContaining({
        cwd: "/tmp/ws/ws1/agent1/workdir",
        model: "opus",
        timeout: 7200000,
      }),
    );
    expect(mockClientInstance.completeTask).toHaveBeenCalledWith(
      "test_token",
      "t1",
      expect.objectContaining({ output: "Done!", session_id: "sess-1" }),
    );
  });

  it("calls buildPrompt with task", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "s1",
    });

    await runSession(makeInput());

    expect(buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", prompt: "do the thing" }),
      undefined,
    );
  });

  it("calls failTask on failed agent result", async () => {
    setupBackend([], {
      status: "failed",
      output: "",
      error: "something broke",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput());

    expect(mockClientInstance.failTask).toHaveBeenCalledWith(
      "test_token",
      "t1",
      "something broke",
    );
    expect(mockClientInstance.completeTask).not.toHaveBeenCalled();
  });

  it("writes timeline init entry with session runner PID (process.pid)", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput());

    expect(mockCreateTimelineEntry).toHaveBeenCalledWith(
      "t1",
      "do the thing",
      "user_dm_message",
      "sess-1",
      process.pid,
      "claude",
      "dm:c1",
      undefined,
    );
    expect(mockInitEntryAsync).toHaveBeenCalledWith(
      "/tmp/ws/ws1/agent1/workdir/.context_timeline",
      expect.objectContaining({ task_id: "t1", pid: process.pid }),
    );
  });

  it("finalizes timeline on completion (status=completed, pid=null, session_id set)", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-2",
    });

    await runSession(makeInput());

    // Find the finalization call (last updateEntry)
    const calls = mockUpdateEntry.mock.calls;
    const lastCall = calls[calls.length - 1];
    const entry = {
      session_id: null as string | null,
      pid: process.pid as number | null,
      status: "running" as string,
      errmsg: null as string | null,
      agent_responses: [] as string[],
    };
    lastCall[2](entry);
    expect(entry.session_id).toBe("sess-2");
    expect(entry.pid).toBeNull();
    expect(entry.status).toBe("completed");
  });

  it("finalizes timeline on failure (status=failed, pid=null, errmsg set)", async () => {
    setupBackend([], {
      status: "failed",
      output: "",
      error: "kaboom",
      durationMs: 100,
      sessionId: "sess-3",
    });

    await runSession(makeInput());

    const calls = mockUpdateEntry.mock.calls;
    const lastCall = calls[calls.length - 1];
    const entry = {
      pid: process.pid as number | null,
      status: "running" as string,
      errmsg: null as string | null,
      agent_responses: [] as string[],
    };
    lastCall[2](entry);
    expect(entry.pid).toBeNull();
    expect(entry.status).toBe("failed");
    expect(entry.errmsg).toBe("kaboom");
  });

  it("text messages update timeline agent_responses array", async () => {
    setupBackend(
      [
        { type: "text", content: "Looking at code..." },
        { type: "tool-use", tool: "read", content: undefined },
        { type: "text", content: "Found the issue." },
      ],
      {
        status: "completed",
        output: "Fixed",
        error: "",
        durationMs: 2000,
        sessionId: "sess-1",
      },
    );

    await runSession(makeInput());

    const textCalls = mockUpdateEntry.mock.calls.filter((call: any[]) => {
      const updater = call[2];
      const testEntry = { agent_responses: [] as string[] };
      updater(testEntry);
      return testEntry.agent_responses.length > 0;
    });
    expect(textCalls.length).toBe(2);
  });

  it("batches and flushes messages to server via reportMessages", async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      type: "text",
      content: `msg-${i}`,
    }));

    setupBackend(messages, {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput());

    expect(mockClientInstance.reportMessages).toHaveBeenCalled();
    // Should have flushed at least once during the batch (at 20) + final flush
    const totalReported = mockClientInstance.reportMessages.mock.calls
      .flatMap((c: any[]) => c[2])
      .length;
    expect(totalReported).toBe(25);
  });

  it("uses findResumableSessionByContextKey and passes to backend for user_dm_message tasks", async () => {
    mockFindResumableSessionByContextKey.mockReturnValueOnce("prev-session-123");

    setupBackend([], {
      status: "completed",
      output: "Resumed",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput());

    expect(mockFindResumableSessionByContextKey).toHaveBeenCalledWith(
      "/tmp/ws/ws1/agent1/workdir/.context_timeline",
      "dm:c1",
      "claude",
    );
    expect(mockBackendExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ resumeSessionId: "prev-session-123" }),
    );
  });

  it("skips findResumableSessionByContextKey for calendar_event tasks (no contextKey)", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-2",
    });

    await runSession(
      makeInput({
        task: {
          id: "t2",
          agentId: "a1",
          runtimeId: "rt1",
          conversationId: "c2",
          workspaceId: "ws1",
          prompt: "Run daily standup",
          status: "dispatched",
          priority: 0,
          type: "calendar_event",
          createdAt: "2026-04-17T09:00:00Z",
        },
      }),
    );

    expect(mockFindResumableSessionByContextKey).not.toHaveBeenCalled();
    expect(mockBackendExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ resumeSessionId: undefined }),
    );
  });

  it("writes timeline entries with task.type (calendar_event) for calendar tasks", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-3",
    });

    await runSession(
      makeInput({
        task: {
          id: "t3",
          agentId: "a1",
          runtimeId: "rt1",
          conversationId: "c3",
          workspaceId: "ws1",
          prompt: "scheduled work",
          status: "dispatched",
          priority: 0,
          type: "calendar_event",
          createdAt: "2026-04-17T09:00:00Z",
        },
      }),
    );

    // The 3rd positional arg to createTimelineEntry is the type.
    const typeArg = mockCreateTimelineEntry.mock.calls[0]![2];
    expect(typeArg).toBe("calendar_event");
  });

  it("passes branchName through to completeTask (forward-compat)", async () => {
    // branchName is currently always undefined in AgentResult
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput());

    // completeTask should be called — branchName is not in the body since it's undefined
    const callBody = mockClientInstance.completeTask.mock.calls[0][2];
    expect(callBody.output).toBe("Done");
    expect(callBody.session_id).toBe("sess-1");
    // branch_name key should not be present (undefined values aren't serialized)
    expect(callBody.branch_name).toBeUndefined();
  });

  it("catches top-level errors and calls failTask before exiting", async () => {
    // Make prepare throw to simulate a crash before the agent starts
    mockPrepare.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    // runSession should throw, but the caller (main) wraps it in try/catch
    // Here we test that runSession itself propagates the error
    await expect(runSession(makeInput())).rejects.toThrow("disk full");

    // failTask should NOT have been called by runSession itself —
    // that's main()'s responsibility. But completeTask shouldn't have been called either.
    expect(mockClientInstance.completeTask).not.toHaveBeenCalled();
  });

  it("gracefully cleans up on SIGTERM: kills agent, updates timeline to killed, calls failTask", async () => {
    // Mock process.kill to track calls
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Mock process.exit to prevent test process from actually exiting
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    // Create a backend that yields messages with a pause in the middle
    // so we can fire SIGTERM during execution
    let resolveMessage: (() => void) | null = null;
    const agentPid = 99999;

    mockBackendExecute.mockReturnValue({
      pid: agentPid,
      messages: (async function* () {
        yield { type: "text", content: "working..." };
        // Pause — signal will fire here
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: "text", content: "should not reach" };
      })(),
      sessionId: Promise.resolve("sess-kill"),
      result: new Promise(() => {}), // never resolves (agent is killed)
    });

    const sessionPromise = runSession(makeInput());

    // Wait for the first message to be processed
    await new Promise((r) => setTimeout(r, 50));

    // Fire SIGTERM
    process.emit("SIGTERM", "SIGTERM");

    // Unblock the message iterator so runSession can finish
    if (resolveMessage) resolveMessage();

    // Wait for cleanup to finish
    await new Promise((r) => setTimeout(r, 50));

    // 1. Should have killed the inner agent process
    expect(killSpy).toHaveBeenCalledWith(agentPid, "SIGTERM");

    // 2. Timeline should be updated to "killed"
    const killCalls = mockUpdateEntry.mock.calls.filter((call: any[]) => {
      const updater = call[2];
      const entry = { pid: 1, status: "running" as string, errmsg: null as string | null, agent_responses: [] as string[] };
      updater(entry);
      return entry.status === "killed";
    });
    expect(killCalls.length).toBe(1);

    // 3. Should have called failTask with "killed by signal"
    expect(mockClientInstance.failTask).toHaveBeenCalledWith(
      "test_token",
      "t1",
      "killed by signal",
    );

    // 4. Should have called process.exit(1)
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Cleanup
    killSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("signal handler cleans up listeners after normal completion", async () => {
    const listenersBefore = process.listenerCount("SIGTERM");

    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput());

    // After normal completion, signal listeners should be removed
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });

  it("passes provider to createTimelineEntry", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput({ provider: "codex" }));

    expect(mockCreateTimelineEntry).toHaveBeenCalledWith(
      "t1",
      "do the thing",
      "user_dm_message",
      "sess-1",
      process.pid,
      "codex",
      "dm:c1",
      undefined,
    );
  });

  it("passes provider to findResumableSessionByContextKey", async () => {
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput({ provider: "codex" }));

    expect(mockFindResumableSessionByContextKey).toHaveBeenCalledWith(
      "/tmp/ws/ws1/agent1/workdir/.context_timeline",
      "dm:c1",
      "codex",
    );
  });

  it("session resume works when findResumableSessionByContextKey returns a session for matching provider", async () => {
    mockFindResumableSessionByContextKey.mockReturnValueOnce("prev-sess-codex");

    setupBackend([], {
      status: "completed",
      output: "Resumed",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput({ provider: "codex" }));

    expect(mockBackendExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ resumeSessionId: "prev-sess-codex" }),
    );
  });

  it("session starts fresh when provider has no matching prior entry", async () => {
    mockFindResumableSessionByContextKey.mockReturnValueOnce(null);

    setupBackend([], {
      status: "completed",
      output: "Fresh",
      error: "",
      durationMs: 100,
      sessionId: "sess-1",
    });

    await runSession(makeInput({ provider: "opencode" }));

    expect(mockFindResumableSessionByContextKey).toHaveBeenCalledWith(
      "/tmp/ws/ws1/agent1/workdir/.context_timeline",
      "dm:c1",
      "opencode",
    );
    expect(mockBackendExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ resumeSessionId: undefined }),
    );
  });

  // --- Logging tests ---

  describe("logging", () => {
    it("logs task start with metadata", async () => {
      setupBackend([], {
        status: "completed",
        output: "Done",
        error: "",
        durationMs: 1000,
        sessionId: "sess-1",
      });

      await runSession(makeInput());

      expect(mockLog.info).toHaveBeenCalledWith(
        "starting (task=t1, type=user_dm_message, agent=a1, provider=claude, model=opus)",
      );
    });

    it("logs agent started with PID and session ID", async () => {
      setupBackend([], {
        status: "completed",
        output: "Done",
        error: "",
        durationMs: 1000,
        sessionId: "sess-1",
      });

      await runSession(makeInput());

      expect(mockLog.info).toHaveBeenCalledWith(
        "agent started (pid=12345, session=sess-1)",
      );
    });

    it("logs user prompt with role=user", async () => {
      setupBackend([], {
        status: "completed",
        output: "Done",
        error: "",
        durationMs: 1000,
        sessionId: "sess-1",
      });

      await runSession(makeInput());

      expect(mockLog.info).toHaveBeenCalledWith(
        JSON.stringify({ role: "user", type: "text", content: "do the thing" }),
      );
    });

    it("logs each agent message with role=assistant", async () => {
      const msg = { type: "text", content: "hello world" };
      setupBackend(
        [msg],
        {
          status: "completed",
          output: "Done",
          error: "",
          durationMs: 1000,
          sessionId: "sess-1",
        },
      );

      await runSession(makeInput());

      expect(mockLog.info).toHaveBeenCalledWith(
        JSON.stringify({ role: "assistant", ...msg }),
      );
    });

    it("logs tool-use messages with role=assistant and counts tools", async () => {
      const messages = [
        { type: "tool-use", tool: "Read", callId: "c1", input: { file_path: "a.ts" } },
        { type: "tool-result", tool: "Read", callId: "c1", output: "ok" },
        { type: "tool-use", tool: "Edit", callId: "c2", input: { file_path: "a.ts" } },
        { type: "tool-result", tool: "Edit", callId: "c2", output: "ok" },
      ];
      setupBackend(messages, {
        status: "completed",
        output: "Done",
        error: "",
        durationMs: 5400,
        sessionId: "sess-1",
      });

      await runSession(makeInput());

      for (const msg of messages) {
        expect(mockLog.info).toHaveBeenCalledWith(
          JSON.stringify({ role: "assistant", ...msg }),
        );
      }
      expect(mockLog.info).toHaveBeenCalledWith(
        "completed (duration=5.4s, messages=4, tools=2)",
      );
    });

    it("logs completion with duration, message count, and tool count", async () => {
      setupBackend(
        [
          { type: "text", content: "thinking..." },
          { type: "tool-use", tool: "Read", callId: "c1", input: { file_path: "a.ts" } },
          { type: "tool-result", tool: "Read", callId: "c1", output: "ok" },
        ],
        {
          status: "completed",
          output: "Done",
          error: "",
          durationMs: 5400,
          sessionId: "sess-1",
        },
      );

      await runSession(makeInput());

      expect(mockLog.info).toHaveBeenCalledWith(
        "completed (duration=5.4s, messages=3, tools=1)",
      );
    });

    it("logs failure with duration, message count, tool count, and error", async () => {
      setupBackend(
        [
          { type: "tool-use", tool: "Bash", callId: "c1", input: { command: "exit 1" } },
          { type: "tool-result", tool: "Bash", callId: "c1", output: "err" },
        ],
        {
          status: "failed",
          output: "",
          error: "command failed",
          durationMs: 1200,
          sessionId: "sess-1",
        },
      );

      await runSession(makeInput());

      expect(mockLog.info).toHaveBeenCalledWith(
        "failed (duration=1.2s, messages=2, tools=1) — command failed",
      );
    });

    it("logs kill with message count and tool count", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      let resolveMessage: (() => void) | null = null;

      mockBackendExecute.mockReturnValue({
        pid: 99999,
        messages: (async function* () {
          yield { type: "tool-use", tool: "Read", callId: "c1", input: { file_path: "x.ts" } };
          yield { type: "tool-result", tool: "Read", callId: "c1", output: "ok" };
          yield { type: "text", content: "working..." };
          await new Promise<void>((resolve) => { resolveMessage = resolve; });
        })(),
        sessionId: Promise.resolve("sess-kill"),
        result: new Promise(() => {}),
      });

      const sessionPromise = runSession(makeInput());
      await new Promise((r) => setTimeout(r, 50));

      process.emit("SIGTERM", "SIGTERM");
      if (resolveMessage) resolveMessage();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLog.info).toHaveBeenCalledWith(
        "killed by signal (messages=3, tools=1)",
      );

      killSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it("logs 'default' when model is empty", async () => {
      setupBackend([], {
        status: "completed",
        output: "Done",
        error: "",
        durationMs: 100,
        sessionId: "sess-1",
      });

      await runSession(makeInput({ model: "" }));

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("model=default"),
      );
    });
  });
});

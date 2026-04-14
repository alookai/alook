import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all external dependencies before importing
const mockClientInstance = {
  register: vi.fn(async () => ({
    runtimes: [{ id: "rt1" }],
  })),
  heartbeat: vi.fn(async () => {}),
  deregister: vi.fn(async () => {}),
  claimTask: vi.fn(async () => ({ task: null })),
};
vi.mock("./client.js", () => {
  function MockDaemonClient() { return mockClientInstance; }
  return { DaemonClient: MockDaemonClient };
});

vi.mock("./config.js", () => ({
  loadDaemonConfig: vi.fn(() => ({
    serverURL: "http://localhost:8080",
    claudePath: "claude",
    codexPath: "codex",
    opencodePath: "opencode",
    claudeModel: "",
    codexModel: "",
    opencodeModel: "",
    pollInterval: 3000,
    heartbeatInterval: 15000,
    agentTimeout: 7200000,
    maxConcurrentTasks: 20,
    daemonId: "d1",
    deviceName: "test-host",
    runtimeName: "Local Agent",
    workspacesRoot: "/tmp/ws",
    keepEnvAfterTask: false,
    cliVersion: "0.1.0",
  })),
}));

vi.mock("./health.js", () => ({
  createHealthServer: vi.fn(() => ({
    setRuntimeCount: vi.fn(),
    server: { close: vi.fn() },
  })),
}));

vi.mock("./agent/index.js", () => ({
  createBackend: vi.fn(),
  detectVersion: vi.fn(async () => "1.0.0"),
}));

vi.mock("../lib/config.js", () => ({
  loadCLIConfigForProfile: vi.fn(() => ({
    token: "al_test_token",
    server_url: null,
    watched_workspaces: [{ id: "ws1", name: "Test WS" }],
  })),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
}));

vi.mock("./execenv/index.js", () => ({
  prepare: vi.fn(() => ({
    workDir: "/tmp/ws/ws1/agent1/workdir",
    logFile: "/tmp/ws/ws1/agent1/agent.log",
    timelineDir: "/tmp/ws/ws1/agent1/workdir/.context_timeline",
    env: {
      ALOOK_WORKSPACE_ID: "ws1",
      ALOOK_AGENT_ID: "agent1",
      ALOOK_TASK_ID: "t1",
      ALOOK_CONVERSATION_ID: "c1",
      ALOOK_HEALTH_PORT: "19514",
    },
  })),
}));

const mockInitEntryAsync = vi.fn(async () => {});
const mockUpdateEntry = vi.fn();
const mockCreateTimelineEntry = vi.fn((taskId: string, prompt: string, sessionId?: string, pid?: number) => ({
  task_id: taskId,
  session_id: sessionId || null,
  pid: pid ?? null,
  status: "running",
  datetime: "2026-04-13T10:30:00-05:00",
  type: "user_dm_message",
  prompt,
  steps: [],
  response: null,
  errmsg: null,
}));
vi.mock("./execenv/timeline.js", () => ({
  initEntryAsync: (...args: any[]) => mockInitEntryAsync(...args),
  updateEntry: (...args: any[]) => mockUpdateEntry(...args),
  createTimelineEntry: (...args: any[]) => mockCreateTimelineEntry(...args),
  findResumableSessionId: vi.fn(() => null),
}));

// Capture signal handlers and prevent actual process.exit
const signalHandlers = new Map<string, (...args: any[]) => any>();
const originalOn = process.on.bind(process);
const mockProcessExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

vi.spyOn(process, "on").mockImplementation(((event: string, handler: any) => {
  if (event === "SIGTERM" || event === "SIGINT") {
    signalHandlers.set(event, handler);
    return process;
  }
  return originalOn(event, handler);
}) as any);

// Track setInterval/clearInterval calls
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const intervalTimers: NodeJS.Timeout[] = [];

vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: any) => {
  const timer = realSetInterval(() => {}, 999999) as NodeJS.Timeout; // dummy timer
  intervalTimers.push(timer);
  return timer;
}) as any);

const clearedTimers: NodeJS.Timeout[] = [];
vi.spyOn(globalThis, "clearInterval").mockImplementation(((timer: any) => {
  clearedTimers.push(timer);
  realClearInterval(timer);
}) as any);

import { createBackend } from "./agent/index.js";
import { startDaemon } from "./daemon.js";

describe("daemon timeline integration", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  function setupTaskClaim() {
    const fakeTask = {
      id: "t1",
      agent_id: "a1",
      runtime_id: "rt1",
      conversation_id: "c1",
      workspace_id: "ws1",
      prompt: "do stuff",
      status: "dispatched",
      priority: 0,
      dispatched_at: null,
      started_at: null,
      completed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      type: "user_dm_message",
      result: null,
      error: null,
      agent: { name: "Agent 1", instructions: "be helpful" },
    };

    let claimed = false;
    mockClientInstance.claimTask.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { task: fakeTask };
      }
      return { task: null };
    });

    // Mock startTask and completeTask
    (mockClientInstance as any).startTask = vi.fn(async () => ({}));
    (mockClientInstance as any).completeTask = vi.fn(async () => ({}));
    (mockClientInstance as any).failTask = vi.fn(async () => ({}));
    (mockClientInstance as any).reportMessages = vi.fn(async () => ({}));

    return fakeTask;
  }

  function setupBackend(messages: any[], result: any) {
    async function* messageIterator() {
      for (const msg of messages) yield msg;
    }

    const mockBackend = {
      name: "claude",
      execute: vi.fn(() => ({
        pid: 12345,
        messages: messageIterator(),
        sessionId: Promise.resolve(result.sessionId || ""),
        result: Promise.resolve(result),
      })),
    };

    vi.mocked(createBackend).mockReturnValue(mockBackend);
    return mockBackend;
  }

  it("task start writes init entry to timeline", async () => {
    setupTaskClaim();
    setupBackend([], {
      status: "completed",
      output: "Done",
      error: "",
      durationMs: 1000,
      sessionId: "s1",
    });

    await startDaemon();

    // Wait for async task handling
    await new Promise((r) => setTimeout(r, 50));

    expect(mockCreateTimelineEntry).toHaveBeenCalledWith("t1", "do stuff", "s1", 12345);
    expect(mockInitEntryAsync).toHaveBeenCalledWith(
      "/tmp/ws/ws1/agent1/workdir/.context_timeline",
      expect.objectContaining({ task_id: "t1", session_id: "s1", pid: 12345 }),
    );
  });

  it("assistant text messages update steps array", async () => {
    setupTaskClaim();
    setupBackend(
      [
        { type: "text", content: "Looking at code..." },
        { type: "tool-use", tool: "read", content: undefined },
        { type: "text", content: "Found the issue." },
      ],
      {
        status: "completed",
        output: "Fixed it",
        error: "",
        durationMs: 2000,
        sessionId: "s2",
      },
    );

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // Should have been called for each text message
    const textCalls = mockUpdateEntry.mock.calls.filter(
      (call: any[]) => {
        // The updater is the third argument, but we check it was called for steps
        const updater = call[2];
        const testEntry = { steps: [] as string[], response: null };
        updater(testEntry);
        return testEntry.steps.length > 0;
      }
    );
    expect(textCalls.length).toBe(2);
  });

  it("task completion updates response field", async () => {
    setupTaskClaim();
    setupBackend([], {
      status: "completed",
      output: "All done!",
      error: "",
      durationMs: 500,
      sessionId: "s3",
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // Last updateEntry call should set completion fields
    const calls = mockUpdateEntry.mock.calls;
    const lastCall = calls[calls.length - 1];
    const testEntry = {
      steps: [] as string[],
      response: null as string | null,
      session_id: null as string | null,
      pid: process.pid as number | null,
      status: "running" as string,
      errmsg: null as string | null,
    };
    lastCall[2](testEntry);
    expect(testEntry.response).toBe("All done!");
    expect(testEntry.session_id).toBe("s3");
    expect(testEntry.pid).toBeNull();
    expect(testEntry.status).toBe("completed");
  });

  it("failed tasks get init entry and failure fields set", async () => {
    setupTaskClaim();
    setupBackend([], {
      status: "failed",
      output: "",
      error: "something went wrong",
      durationMs: 100,
      sessionId: "s4",
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // initEntry should have been called
    expect(mockInitEntryAsync).toHaveBeenCalled();

    // Last updateEntry call should set failure fields
    const calls = mockUpdateEntry.mock.calls;
    const lastCall = calls[calls.length - 1];
    const testEntry = {
      steps: [] as string[],
      response: null as string | null,
      pid: process.pid as number | null,
      status: "running" as string,
      errmsg: null as string | null,
    };
    lastCall[2](testEntry);
    expect(testEntry.pid).toBeNull();
    expect(testEntry.status).toBe("failed");
    expect(testEntry.errmsg).toBe("something went wrong");
    expect(testEntry.response).toBeNull();
  });
});

describe("daemon shutdown", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    vi.clearAllMocks();
    // Re-apply exit mock after clearAllMocks
    mockProcessExit.mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    // Clear any real timers
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("clears heartbeat and poll intervals before calling deregister", async () => {
    await startDaemon();

    // startDaemon should have created 2 intervals (heartbeat + poll)
    expect(intervalTimers.length).toBe(2);
    const heartbeatTimer = intervalTimers[0];
    const pollTimer = intervalTimers[1];

    const deregisterMock = mockClientInstance.deregister;

    let deregisterCalledAt = -1;
    let clearCalledCount = 0;
    deregisterMock.mockImplementation(async () => {
      deregisterCalledAt = clearCalledCount;
    });

    // Replace clearInterval to track ordering
    const originalClearMock = vi.mocked(globalThis.clearInterval);
    originalClearMock.mockImplementation(((timer: any) => {
      clearCalledCount++;
      clearedTimers.push(timer);
      realClearInterval(timer);
    }) as any);

    // Trigger SIGTERM
    const shutdownHandler = signalHandlers.get("SIGTERM");
    expect(shutdownHandler).toBeDefined();
    await shutdownHandler!();

    // Both intervals should have been cleared
    expect(clearedTimers).toContain(heartbeatTimer);
    expect(clearedTimers).toContain(pollTimer);

    // clearInterval should have been called before deregister
    expect(deregisterCalledAt).toBe(2); // both clearInterval calls happened before deregister
  });
});

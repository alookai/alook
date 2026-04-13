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
    env: {
      ALOOK_WORKSPACE_ID: "ws1",
      ALOOK_AGENT_ID: "agent1",
      ALOOK_TASK_ID: "t1",
      ALOOK_CONVERSATION_ID: "c1",
      ALOOK_HEALTH_PORT: "19514",
    },
  })),
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

import { startDaemon } from "./daemon.js";

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

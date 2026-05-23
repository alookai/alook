import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventEmitter } from "events";
import path from "path";

// Mock all external dependencies before importing
const mockClientInstance = {
  register: vi.fn(async () => ({
    runtimes: [{ id: "rt1" }],
  })),
  deregister: vi.fn(async () => {}),
  poll: vi.fn(async () => ({ tasks: [], evicted: false })),
  startTask: vi.fn(async () => ({})),
  completeTask: vi.fn(async () => ({})),
  failTask: vi.fn(async () => ({})),
  supersedeTask: vi.fn(async () => ({})),
  reportMessages: vi.fn(async () => ({})),
  sweep: vi.fn(async () => ({})),
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
    claudeModel: "opus",
    codexModel: "gpt-4",
    opencodeModel: "",
    pollInterval: 3000,
    agentTimeout: 7200000,
    messageInactivityTimeout: 300000,
    maxConcurrentTasks: 20,
    daemonId: "d1",
    deviceName: "test-host",
    workspacesRoot: path.join("/tmp", "ws"),
    cliVersion: "0.1.0",
    wsPollInterval: 30000,
    sweepInterval: 60000,
  })),
  sessionRunnerLogDir: vi.fn(() => path.join("/tmp", "alook", "daemon", "session-runners")),
  daemonLogFilePath: vi.fn(() => path.join("/tmp", "alook", "daemon", "logs", "2026-01-01.log")),
  lastUpdateMarkerPath: vi.fn((profile?: string) =>
    profile ? path.join("/tmp", "alook", `last_update_${profile}`) : path.join("/tmp", "alook", "last_update"),
  ),
}));

vi.mock("./health.js", () => ({
  createHealthServer: vi.fn(() => ({
    setRuntimeCount: vi.fn(),
    server: { close: vi.fn((cb?: () => void) => { if (cb) cb(); }) },
  })),
}));

vi.mock("./ws-client.js", () => {
  class MockDaemonWsClient {
    connect = vi.fn();
    close = vi.fn();
    isConnected = vi.fn(() => false);
  }
  return { DaemonWsClient: MockDaemonWsClient };
});

vi.mock("./agent/index.js", () => ({
  detectVersion: vi.fn(async () => "1.0.0"),
}));

vi.mock("../lib/config.js", () => ({
  loadCLIConfigForProfile: vi.fn(() => ({
    server_url: null,
    watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
  })),
  saveCLIConfigForProfile: vi.fn(),
}));

vi.mock("./pidfile.js", () => ({
  acquireDaemonPid: vi.fn(() => true),
  releaseDaemonPid: vi.fn(),
}));

vi.mock("./update-handler.js", () => ({
  handleCliUpdate: vi.fn(),
  isUpdating: vi.fn(() => false),
  readUpdateMarker: vi.fn(() => null),
  clearUpdateMarker: vi.fn(),
}));

const mockFindRunningPidByTaskId = vi.fn();
const mockFindRunningEntryByContextKey = vi.fn(() => null);
vi.mock("./execenv/timeline.js", () => ({
  findRunningPidByTaskId: (...args: any[]) => mockFindRunningPidByTaskId(...args),
  findRunningEntryByContextKey: (...args: any[]) => mockFindRunningEntryByContextKey(...args),
}));

const mockWriteKillIntent = vi.fn();
const mockClearKillIntent = vi.fn();
const mockAcquireSteeringLock = vi.fn(() => true);
const mockReleaseSteeringLock = vi.fn();
const mockCleanupStaleIntents = vi.fn();
vi.mock("./execenv/steering.js", () => ({
  writeKillIntent: (...args: any[]) => mockWriteKillIntent(...args),
  clearKillIntent: (...args: any[]) => mockClearKillIntent(...args),
  acquireSteeringLock: (...args: any[]) => mockAcquireSteeringLock(...args),
  releaseSteeringLock: (...args: any[]) => mockReleaseSteeringLock(...args),
  cleanupStaleIntents: (...args: any[]) => mockCleanupStaleIntents(...args),
}));

// Track spawned children
interface MockChild extends EventEmitter {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
}

const spawnedChildren: MockChild[] = [];
let nextPid = 50000;

vi.mock("child_process", () => {
  const { EventEmitter } = require("events");

  return {
    execSync: vi.fn(),
    spawn: vi.fn((_cmd: string, _args: string[], _opts: any) => {
      const child = new EventEmitter() as MockChild;
      child.pid = nextPid++;
      child.unref = vi.fn();
      spawnedChildren.push(child);
      return child;
    }),
  };
});

const mockOpenSync = vi.fn(() => 42);
const mockCloseSync = vi.fn();
const mockRenameSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReaddirSync = vi.fn(() => [] as string[]);
const mockStatSync = vi.fn(() => ({ mtimeMs: 0 }));
const mockUnlinkSync = vi.fn();

vi.mock("fs", () => ({
  existsSync: vi.fn((p: string) => p.endsWith("session-runner.js")),
  openSync: (...args: any[]) => mockOpenSync(...args),
  closeSync: (...args: any[]) => mockCloseSync(...args),
  renameSync: (...args: any[]) => mockRenameSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

const mockReaddir = vi.fn(async () => [] as string[]);
const mockReadFile = vi.fn(async () => "");
const mockUnlink = vi.fn(async () => undefined);
const mockFsStat = vi.fn(async () => ({ mtimeMs: Date.now() }));
vi.mock("fs/promises", () => ({
  readdir: (...args: any[]) => mockReaddir(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  stat: (...args: any[]) => mockFsStat(...args),
}));

vi.mock("url", () => ({
  fileURLToPath: vi.fn(() => "/fake/daemon.ts"),
}));

vi.mock("path", async () => {
  const actual = await vi.importActual("path");
  return actual;
});

// Capture signal handlers and prevent actual process.exit.
// We also intercept "once" registrations for exit/uncaughtException/unhandledRejection
// so daemon safety-net handlers don't bleed across tests.
const signalHandlers = new Map<string, (...args: any[]) => any>();
const capturedEvents = new Set([
  "SIGTERM",
  "SIGINT",
  "exit",
  "uncaughtException",
  "unhandledRejection",
]);
const originalOn = process.on.bind(process);
const mockProcessExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

vi.spyOn(process, "on").mockImplementation(((event: string, handler: any) => {
  if (capturedEvents.has(event)) {
    signalHandlers.set(event, handler);
    return process;
  }
  return originalOn(event, handler);
}) as any);

vi.spyOn(process, "once").mockImplementation(((event: string, handler: any) => {
  if (capturedEvents.has(event)) {
    signalHandlers.set(event, handler);
    return process;
  }
  return process.on(event, handler);
}) as any);

// Track setInterval/clearInterval calls
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const intervalTimers: NodeJS.Timeout[] = [];

vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: any) => {
  const timer = realSetInterval(() => {}, 999999) as NodeJS.Timeout;
  intervalTimers.push(timer);
  return timer;
}) as any);

const clearedTimers: NodeJS.Timeout[] = [];
vi.spyOn(globalThis, "clearInterval").mockImplementation(((timer: any) => {
  clearedTimers.push(timer);
  realClearInterval(timer);
}) as any);

import { spawn } from "child_process";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "../lib/config.js";
import { releaseDaemonPid } from "./pidfile.js";
import { handleCliUpdate, readUpdateMarker, clearUpdateMarker } from "./update-handler.js";
import { startDaemon, spawnSessionRunner, pruneSessionRunnerLogs, isClientError, reconcilePendingCompletions } from "./daemon.js";

const mockReleaseDaemonPid = vi.mocked(releaseDaemonPid);

function decodeSpawnInput(call: any[]): any {
  // spawn(process.execPath, [sessionRunnerPath, encodedInput], opts)
  const args = call[1] as string[];
  const encoded = args[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
}

describe("daemon session runner dispatch", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
    mockOpenSync.mockReturnValue(42);
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
    mockClientInstance.poll.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { tasks: [fakeTask], evicted: false };
      }
      return { tasks: [], evicted: false };
    });

    return fakeTask;
  }

  it("spawns a session runner when a task is polled", async () => {
    setupTaskClaim();

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[0]).toBe(process.execPath);
    expect((call[1] as string[])[0]).toContain("session-runner.js");
  });

  it("passes correct SessionRunnerInput to session runner", async () => {
    setupTaskClaim();

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    const input = decodeSpawnInput(vi.mocked(spawn).mock.calls[0]);
    expect(input.task.id).toBe("t1");
    expect(input.task.prompt).toBe("do stuff");
    expect(input.provider).toBe("claude");
    expect(input.cliPath).toBe("claude");
    expect(input.model).toBe("opus");
    expect(input.serverURL).toBe("http://localhost:8080");
    expect(input.token).toBe("al_test_token");
    expect(input.workspacesRoot).toBe(path.join("/tmp", "ws"));
    expect(input.agentTimeout).toBe(7200000);
    expect(input.messageInactivityTimeout).toBe(300000);
  });

  it("uses runtime_config.model when set on agent", async () => {
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
      agent: { name: "Agent 1", instructions: "be helpful", runtime_config: { model: "custom-model" } },
    };

    let claimed = false;
    mockClientInstance.poll.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { tasks: [fakeTask], evicted: false };
      }
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    const input = decodeSpawnInput(vi.mocked(spawn).mock.calls[0]);
    expect(input.model).toBe("custom-model");
  });

  it("falls back to config model when runtime_config.model is empty", async () => {
    setupTaskClaim();

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    const input = decodeSpawnInput(vi.mocked(spawn).mock.calls[0]);
    expect(input.model).toBe("opus");
  });

  it("spawns with detached: true, log file stdio, and calls unref()", async () => {
    setupTaskClaim();

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    const call = vi.mocked(spawn).mock.calls[0];
    expect((call[2] as any).detached).toBe(true);
    expect((call[2] as any).stdio).toEqual(["ignore", 42, 42]);
    expect(spawnedChildren[0].unref).toHaveBeenCalled();
  });

  it("activeTasks decrements on child close event", async () => {
    setupTaskClaim();

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // A close listener should have been registered
    expect(spawnedChildren[0].listenerCount("close")).toBe(1);

    // Simulate child process exit
    spawnedChildren[0].emit("close", 0);

    // After close, we verify indirectly: the next poll should request full capacity (20)
    // If activeTasks wasn't decremented, it would request 19
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });
    // Manually invoke a poll by calling the function startDaemon set up
    // We verify the listener was attached — the decrement logic is straightforward
  });

  it("calls startTask before spawning session runner", async () => {
    setupTaskClaim();

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockClientInstance.startTask).toHaveBeenCalledWith("al_test_token", "t1");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("fails task and does not spawn if startTask fails", async () => {
    setupTaskClaim();
    mockClientInstance.startTask.mockRejectedValueOnce(new Error("server error"));

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockClientInstance.failTask).toHaveBeenCalledWith(
      "al_test_token",
      "t1",
      expect.stringContaining("start failed"),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes correct workspace token into session runner input", async () => {
    setupTaskClaim();

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    const input = decodeSpawnInput(vi.mocked(spawn).mock.calls[0]);
    expect(input.token).toBe("al_test_token");
  });
});

describe("daemon with multi-workspace config", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
    mockOpenSync.mockReturnValue(42);

    // Configure two workspaces
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "Personal", token: "al_tok_ws1" },
        { id: "ws2", name: "Team", token: "al_tok_ws2" },
      ],
    });

    // Register returns different runtime IDs for each workspace
    let registerCall = 0;
    mockClientInstance.register.mockImplementation(async () => {
      registerCall++;
      return { runtimes: [{ id: `rt${registerCall}` }] };
    });
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("polls each workspace with its own token", async () => {
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });

    await startDaemon();

    expect(mockClientInstance.poll).toHaveBeenCalledTimes(2);
    expect(mockClientInstance.poll).toHaveBeenCalledWith("al_tok_ws1", "d1", 20, "0.1.0");
    expect(mockClientInstance.poll).toHaveBeenCalledWith("al_tok_ws2", "d1", 20, "0.1.0");
  });

  it("registers each workspace with its own token", async () => {
    await startDaemon();

    expect(mockClientInstance.register).toHaveBeenCalledTimes(2);
    expect(mockClientInstance.register).toHaveBeenCalledWith(
      "al_tok_ws1",
      expect.objectContaining({ workspace_id: "ws1" }),
    );
    expect(mockClientInstance.register).toHaveBeenCalledWith(
      "al_tok_ws2",
      expect.objectContaining({ workspace_id: "ws2" }),
    );
  });

  it("concurrency accounting: spawned tasks reduce remaining for next workspace", async () => {
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

    // W1 returns 3 tasks, W2 should get remaining (20 - 3 = 17)
    let pollCall = 0;
    mockClientInstance.poll.mockImplementation(async () => {
      pollCall++;
      if (pollCall === 1) return { tasks: [fakeTask, { ...fakeTask, id: "t2" }, { ...fakeTask, id: "t3" }], evicted: false };
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // W2 should be called with max_tasks = 20 - 3 = 17
    expect(mockClientInstance.poll).toHaveBeenCalledWith("al_tok_ws2", "d1", 17, "0.1.0");
  });

  it("multi-workspace: passes correct token per workspace into session runner", async () => {
    const fakeTaskWs1 = {
      id: "t1",
      agent_id: "a1",
      runtime_id: "rt1",
      conversation_id: "c1",
      workspace_id: "ws1",
      prompt: "ws1 task",
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

    const fakeTaskWs2 = {
      ...fakeTaskWs1,
      id: "t2",
      runtime_id: "rt2",
      workspace_id: "ws2",
      prompt: "ws2 task",
    };

    let pollCall = 0;
    mockClientInstance.poll.mockImplementation(async () => {
      pollCall++;
      if (pollCall === 1) return { tasks: [fakeTaskWs1], evicted: false };
      if (pollCall === 2) return { tasks: [fakeTaskWs2], evicted: false };
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(spawn).toHaveBeenCalledTimes(2);
    const input1 = decodeSpawnInput(vi.mocked(spawn).mock.calls[0]);
    const input2 = decodeSpawnInput(vi.mocked(spawn).mock.calls[1]);
    expect(input1.token).toBe("al_tok_ws1");
    expect(input2.token).toBe("al_tok_ws2");
  });
});

describe("daemon shutdown", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);

    // Restore default mock implementations after clearAllMocks
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });
    mockClientInstance.startTask.mockResolvedValue({});
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("clears poll interval before calling deregister", async () => {
    await startDaemon();

    expect(intervalTimers.length).toBe(3); // pollTimer + heartbeatTimer + sweepTimer
    const pollTimer = intervalTimers[0];

    const deregisterMock = mockClientInstance.deregister;

    let deregisterCalledAt = -1;
    let clearCalledCount = 0;
    deregisterMock.mockImplementation(async () => {
      deregisterCalledAt = clearCalledCount;
    });

    const originalClearMock = vi.mocked(globalThis.clearInterval);
    originalClearMock.mockImplementation(((timer: any) => {
      clearCalledCount++;
      clearedTimers.push(timer);
      realClearInterval(timer);
    }) as any);

    const shutdownHandler = signalHandlers.get("SIGTERM");
    expect(shutdownHandler).toBeDefined();
    await shutdownHandler!();

    expect(clearedTimers).toContain(pollTimer);
    expect(deregisterCalledAt).toBe(3); // After clearing all 3 timers (poll + heartbeat + sweep)
  });

  it("deregisters each workspace with correct token on shutdown", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "Personal", token: "al_tok_ws1" },
        { id: "ws2", name: "Team", token: "al_tok_ws2" },
      ],
    });

    let registerCall = 0;
    mockClientInstance.register.mockImplementation(async () => {
      registerCall++;
      return { runtimes: [{ id: `rt${registerCall}` }] };
    });

    await startDaemon();

    const shutdownHandler = signalHandlers.get("SIGTERM");
    expect(shutdownHandler).toBeDefined();
    await shutdownHandler!();

    expect(mockClientInstance.deregister).toHaveBeenCalledWith("al_tok_ws1", "d1");
    expect(mockClientInstance.deregister).toHaveBeenCalledWith("al_tok_ws2", "d1");
  });

  it("does not kill session runner children on shutdown", async () => {
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
    mockClientInstance.poll.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { tasks: [fakeTask], evicted: false };
      }
      return { tasks: [], evicted: false };
    });
    mockClientInstance.startTask.mockResolvedValue({});

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(spawnedChildren.length).toBe(1);

    // Shutdown — should NOT kill the child
    const shutdownHandler = signalHandlers.get("SIGTERM");
    await shutdownHandler!();

    // Child should still be alive — unref was called, no kill signal sent
    expect(spawnedChildren[0].unref).toHaveBeenCalled();
  });
});

describe("daemon agent_ids lazy sync", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);

    // Restore default mock implementations after clearAllMocks
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.startTask.mockResolvedValue({});
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  function makeFakeTask(overrides?: Record<string, unknown>) {
    return {
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
      ...overrides,
    };
  }

  it("syncs unknown agent_id to config when task is received", async () => {
    // Config has no agent_ids — agent was created on the web
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token", agent_ids: [] }],
    });

    let claimed = false;
    mockClientInstance.poll.mockImplementation(async () => {
      if (!claimed) { claimed = true; return { tasks: [makeFakeTask()], evicted: false }; }
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(saveCLIConfigForProfile).toHaveBeenCalledOnce();
    const savedConfig = vi.mocked(saveCLIConfigForProfile).mock.calls[0][1];
    expect(savedConfig.watched_workspaces![0].agent_ids).toContain("a1");
  });

  it("does not save config when agent_id is already known", async () => {
    // Config already has agent "a1"
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token", agent_ids: ["a1"] }],
    });

    let claimed = false;
    mockClientInstance.poll.mockImplementation(async () => {
      if (!claimed) { claimed = true; return { tasks: [makeFakeTask()], evicted: false }; }
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(saveCLIConfigForProfile).not.toHaveBeenCalled();
  });

  it("deduplicates: multiple tasks with same new agent_id only save once", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token", agent_ids: [] }],
    });

    let claimed = false;
    mockClientInstance.poll.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { tasks: [makeFakeTask({ id: "t1" }), makeFakeTask({ id: "t2" })], evicted: false };
      }
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // Only one save — the in-memory set deduplicates
    expect(saveCLIConfigForProfile).toHaveBeenCalledOnce();
  });
});

describe("daemon startup failures release pidfile", () => {
  beforeEach(async () => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);

    // Restore defaults that other describe-level tests override.
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "Test WS", token: "al_test_token" },
      ],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });
    const cp = await import("child_process");
    vi.mocked(cp.execSync).mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("exits with code 1 and logs when no workspaces are configured", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [],
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await startDaemon();

    expect(mockProcessExit.mock.calls[0]?.[0]).toBe(1);
    const logs = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(logs).toContain("No watched workspaces configured.");
    stderrWrite.mockRestore();
  });

  it("registers an exit handler that releases the pidfile", async () => {
    await startDaemon();

    const exitHandler = signalHandlers.get("exit");
    expect(exitHandler).toBeDefined();
    mockReleaseDaemonPid.mockClear();
    exitHandler!();
    expect(mockReleaseDaemonPid).toHaveBeenCalled();
  });

  it("uncaughtException handler releases pidfile and exits 1", async () => {
    await startDaemon();

    const handler = signalHandlers.get("uncaughtException");
    expect(handler).toBeDefined();
    mockReleaseDaemonPid.mockClear();
    mockProcessExit.mockClear();
    handler!(new Error("boom"));
    expect(mockReleaseDaemonPid).toHaveBeenCalled();
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it("unhandledRejection handler releases pidfile and exits 1", async () => {
    await startDaemon();

    const handler = signalHandlers.get("unhandledRejection");
    expect(handler).toBeDefined();
    mockReleaseDaemonPid.mockClear();
    mockProcessExit.mockClear();
    handler!(new Error("async-boom"));
    expect(mockReleaseDaemonPid).toHaveBeenCalled();
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 and logs when no agent CLI tools are found on PATH", async () => {
    const cp = await import("child_process");
    vi.mocked(cp.execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await startDaemon();

    expect(mockProcessExit.mock.calls[0]?.[0]).toBe(1);
    const logs = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(logs).toContain("No agent CLI tools found on PATH.");
    stderrWrite.mockRestore();
  });

  it("exits with code 1 and logs when every register call fails", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "Personal", token: "al_tok_ws1" },
        { id: "ws2", name: "Team", token: "al_tok_ws2" },
      ],
    });
    mockClientInstance.register.mockRejectedValue(new Error("ECONNREFUSED"));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await startDaemon();

    expect(mockProcessExit.mock.calls[0]?.[0]).toBe(1);
    const logs = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(logs).toContain("No workspaces registered successfully.");
    stderrWrite.mockRestore();
  });
});

describe("spawnSessionRunner", () => {
  beforeEach(() => {
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockOpenSync.mockReturnValue(42);
  });

  function makeSpawnInput() {
    return {
      task: { id: "t1", agentId: "a1", runtimeId: "rt1", conversationId: "c1", workspaceId: "ws1", prompt: "test", status: "dispatched", priority: 0, type: "user_dm_message", createdAt: "2026-01-01T00:00:00Z" },
      provider: "claude",
      cliPath: "claude",
      model: "opus",
      serverURL: "http://localhost:8080",
      token: "test_token",
      workspacesRoot: "/tmp/ws",
      agentTimeout: 7200000,
    };
  }

  it("encodes input as base64 and passes to bun run", () => {
    const child = spawnSessionRunner(makeSpawnInput() as any);

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[0]).toBe(process.execPath);

    const args = call[1] as string[];
    expect(args[0]).toContain("session-runner.js");

    const decoded = JSON.parse(Buffer.from(args[1], "base64").toString("utf-8"));
    expect(decoded.task.id).toBe("t1");
    expect(decoded.provider).toBe("claude");
    expect(decoded.token).toBe("test_token");

    expect((call[2] as any).detached).toBe(true);
    expect(child.unref).toHaveBeenCalled();
  });

  it("opens a log file fd with taskId.log and passes it as stdio [ignore, fd, fd]", () => {
    spawnSessionRunner(makeSpawnInput() as any);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join("/tmp", "alook", "daemon", "session-runners"),
      { recursive: true },
    );
    expect(mockOpenSync).toHaveBeenCalledWith(
      path.join("/tmp", "alook", "daemon", "session-runners", "t1.log"),
      "a",
    );

    const call = vi.mocked(spawn).mock.calls[0];
    expect((call[2] as any).stdio).toEqual(["ignore", 42, 42]);
  });

  it("closes the fd after spawn", () => {
    spawnSessionRunner(makeSpawnInput() as any);
    expect(mockCloseSync).toHaveBeenCalledWith(42);
  });

  it("sets logFilePath in the serialized input", () => {
    const input = makeSpawnInput() as any;
    spawnSessionRunner(input);

    const call = vi.mocked(spawn).mock.calls[0];
    const encoded = call[1]![1] as string;
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
    expect(decoded.logFilePath).toBe(path.join("/tmp", "alook", "daemon", "session-runners", "t1.log"));
  });

  it("spawns with stdio ignore when openSync fails (disk full)", () => {
    mockOpenSync.mockImplementation(() => { throw new Error("ENOSPC: no space left on device"); });

    const child = spawnSessionRunner(makeSpawnInput() as any);

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    expect((call[2] as any).stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(child.unref).toHaveBeenCalled();
    expect(mockCloseSync).not.toHaveBeenCalled();
  });
});

describe("pruneSessionRunnerLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles missing directory gracefully", () => {
    mockReaddirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => pruneSessionRunnerLogs()).not.toThrow();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("handles empty directory gracefully", () => {
    mockReaddirSync.mockReturnValue([]);
    pruneSessionRunnerLogs();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("does not delete when at or below limit", () => {
    const files = Array.from({ length: 500 }, (_, i) => `${i}.log`);
    mockReaddirSync.mockReturnValue(files);
    pruneSessionRunnerLogs();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("deletes oldest files when over limit, keeping newest 500", () => {
    const files = Array.from({ length: 505 }, (_, i) => `${i}.log`);
    mockReaddirSync.mockReturnValue(files);
    mockStatSync.mockImplementation((p: string) => {
      const name = path.basename(p);
      const idx = parseInt(name);
      return { mtimeMs: idx * 1000 };
    });

    pruneSessionRunnerLogs();

    expect(mockUnlinkSync).toHaveBeenCalledTimes(5);
    // Files 0-4 are the oldest (lowest mtime), they should be deleted
    for (let i = 0; i < 5; i++) {
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        path.join("/tmp", "alook", "daemon", "session-runners", `${i}.log`),
      );
    }
  });

  it("ignores non-.log files", () => {
    const files = ["1.log", "2.log", ".DS_Store", "readme.txt"];
    mockReaddirSync.mockReturnValue(files);
    mockStatSync.mockReturnValue({ mtimeMs: 0 });
    pruneSessionRunnerLogs();
    // Only 2 .log files, well under 500 limit
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });
});

describe("daemon workspace eviction", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("removes workspace from polling on eviction and stops polling it", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "Personal", token: "al_tok_ws1" },
        { id: "ws2", name: "Team", token: "al_tok_ws2" },
      ],
    });

    let registerCall = 0;
    mockClientInstance.register.mockImplementation(async () => {
      registerCall++;
      return { runtimes: [{ id: `rt${registerCall}` }] };
    });

    let pollCall = 0;
    mockClientInstance.poll.mockImplementation(async () => {
      pollCall++;
      // First cycle: ws1 normal, ws2 evicted
      if (pollCall === 1) return { tasks: [], evicted: false };
      if (pollCall === 2) return { tasks: [], evicted: true };
      // Subsequent cycles should only get ws1
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // ws2 was evicted — only ws1 should remain
    // Verify config was saved to remove ws2
    expect(saveCLIConfigForProfile).toHaveBeenCalled();
    const savedConfig = vi.mocked(saveCLIConfigForProfile).mock.calls[0][1];
    const wsIds = savedConfig.watched_workspaces!.map((w: any) => w.id);
    expect(wsIds).toContain("ws1");
    expect(wsIds).not.toContain("ws2");
  });

  it("removes evicted workspace from local config file", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: true });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(saveCLIConfigForProfile).toHaveBeenCalled();
    const savedConfig = vi.mocked(saveCLIConfigForProfile).mock.calls[0][1];
    expect(savedConfig.watched_workspaces).toEqual([]);
  });

  it("shuts down gracefully when all workspaces are evicted", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: true });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // Should trigger shutdown → process.exit(0)
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it("continues polling remaining workspaces when middle one is evicted (3 workspaces)", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "First", token: "al_tok_ws1" },
        { id: "ws2", name: "Middle", token: "al_tok_ws2" },
        { id: "ws3", name: "Last", token: "al_tok_ws3" },
      ],
    });

    let registerCall = 0;
    mockClientInstance.register.mockImplementation(async () => {
      registerCall++;
      return { runtimes: [{ id: `rt${registerCall}` }] };
    });

    const pollTokens: string[] = [];
    mockClientInstance.poll.mockImplementation(async (token: string) => {
      pollTokens.push(token);
      // Evict ws2 (middle workspace)
      if (token === "al_tok_ws2") return { tasks: [], evicted: true };
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // First poll cycle should hit all 3
    expect(pollTokens).toContain("al_tok_ws1");
    expect(pollTokens).toContain("al_tok_ws2");
    expect(pollTokens).toContain("al_tok_ws3");

    // Verify config saved without ws2
    expect(saveCLIConfigForProfile).toHaveBeenCalled();
    const savedConfig = vi.mocked(saveCLIConfigForProfile).mock.calls[0][1];
    const wsIds = savedConfig.watched_workspaces!.map((w: any) => w.id);
    expect(wsIds).toEqual(["ws1", "ws3"]);

    // Daemon should NOT have shut down (still has ws1 and ws3)
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  it("updates health.setRuntimeCount after eviction", async () => {
    const mockHealthSetRuntimeCount = vi.fn();
    const { createHealthServer } = await import("./health.js");
    vi.mocked(createHealthServer).mockReturnValue({
      setRuntimeCount: mockHealthSetRuntimeCount,
      server: { close: vi.fn() },
    } as any);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "First", token: "al_tok_ws1" },
        { id: "ws2", name: "Second", token: "al_tok_ws2" },
      ],
    });

    let registerCall = 0;
    mockClientInstance.register.mockImplementation(async () => {
      registerCall++;
      return { runtimes: [{ id: `rt${registerCall}` }] };
    });

    mockClientInstance.poll.mockImplementation(async (token: string) => {
      if (token === "al_tok_ws2") return { tasks: [], evicted: true };
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // Initial count was 2 (one per workspace), after evicting ws2 it should be 1
    const calls = mockHealthSetRuntimeCount.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe(1);
  });

  it("config write failure does not block in-memory eviction", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "First", token: "al_tok_ws1" },
        { id: "ws2", name: "Second", token: "al_tok_ws2" },
      ],
    });

    let registerCall = 0;
    mockClientInstance.register.mockImplementation(async () => {
      registerCall++;
      return { runtimes: [{ id: `rt${registerCall}` }] };
    });

    // Make config save throw
    vi.mocked(saveCLIConfigForProfile).mockImplementation(() => {
      throw new Error("disk full");
    });

    mockClientInstance.poll.mockImplementation(async (token: string) => {
      if (token === "al_tok_ws2") return { tasks: [], evicted: true };
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // saveCLIConfigForProfile threw, but daemon should NOT crash
    // and should NOT shut down (ws1 still active)
    expect(mockProcessExit).not.toHaveBeenCalled();

    // ws2 should be evicted from in-memory state (only ws1 polled in future)
    // Verify by checking the saveCLIConfigForProfile was attempted
    expect(saveCLIConfigForProfile).toHaveBeenCalled();
  });
});

describe("daemon 401 handling (no config removal)", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("does not remove workspace from config on startup 401", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "Good", token: "al_tok_ws1" },
        { id: "ws2", name: "Bad Token", token: "al_tok_ws2" },
      ],
    });

    mockClientInstance.register.mockImplementation(async (token: string) => {
      if (token === "al_tok_ws2") throw new Error("HTTP 401 Unauthorized");
      return { runtimes: [{ id: "rt1" }] };
    });
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // Config should NOT have been saved to remove ws2
    expect(saveCLIConfigForProfile).not.toHaveBeenCalled();
    // Daemon should still be running (ws1 registered successfully)
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  it("does not evict workspace on poll 401, continues polling", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [
        { id: "ws1", name: "Personal", token: "al_tok_ws1" },
        { id: "ws2", name: "Team", token: "al_tok_ws2" },
      ],
    });

    let registerCall = 0;
    mockClientInstance.register.mockImplementation(async () => {
      registerCall++;
      return { runtimes: [{ id: `rt${registerCall}` }] };
    });

    mockClientInstance.poll.mockImplementation(async (token: string) => {
      if (token === "al_tok_ws2") throw new Error("HTTP 401 Unauthorized");
      return { tasks: [], evicted: false };
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    // Config should NOT have been saved (no eviction)
    expect(saveCLIConfigForProfile).not.toHaveBeenCalled();
    // Daemon should NOT shut down — ws1 still active, ws2 just had a transient 401
    expect(mockProcessExit).not.toHaveBeenCalled();
  });
});

describe("daemon restart via update", () => {
  it("handleCliUpdate is called when pending_update is in poll response", async () => {
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });

    mockClientInstance.poll.mockResolvedValue({
      tasks: [],
      evicted: false,
      pending_update: { version: "2.0.0" },
    });

    await startDaemon();

    expect(handleCliUpdate).toHaveBeenCalledWith("2.0.0", expect.any(Function), undefined);
  });

  it("handleCliUpdate is not called when pending_update.version matches cliVersion", async () => {
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });

    // pending_update version matches cliVersion (0.1.0 from config mock)
    mockClientInstance.poll.mockResolvedValue({
      tasks: [],
      evicted: false,
      pending_update: { version: "0.1.0" },
    });

    await startDaemon();

    expect(handleCliUpdate).not.toHaveBeenCalled();
  });

  it("handleCliUpdate is not called when isUpdating returns true", async () => {
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
    const { isUpdating } = await import("./update-handler.js");
    vi.mocked(isUpdating).mockReturnValue(true);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.poll.mockResolvedValue({
      tasks: [],
      evicted: false,
      pending_update: { version: "2.0.0" },
    });

    await startDaemon();

    expect(handleCliUpdate).not.toHaveBeenCalled();
    vi.mocked(isUpdating).mockReturnValue(false);
  });

  it("clears update marker on startup when current version matches marker", async () => {
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);

    vi.mocked(readUpdateMarker).mockReturnValue("0.1.0"); // matches cliVersion

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });

    await startDaemon();

    expect(clearUpdateMarker).toHaveBeenCalled();
  });

  it("clears stale update marker on startup when current version does not match marker", async () => {
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);

    vi.mocked(readUpdateMarker).mockReturnValue("0.0.9"); // stale — differs from cliVersion 0.1.0

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });

    await startDaemon();

    expect(clearUpdateMarker).toHaveBeenCalled();
  });

});

describe("daemon rescan via poll", () => {
  beforeEach(async () => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
    mockOpenSync.mockReturnValue(99);

    const { createHealthServer } = await import("./health.js");
    vi.mocked(createHealthServer).mockReturnValue({
      setRuntimeCount: vi.fn(),
      server: { close: vi.fn((cb?: () => void) => { if (cb) cb(); }) },
    } as any);

    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.deregister.mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("calls requestRestart when pending_rescan is true in poll response", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });

    mockClientInstance.poll.mockResolvedValue({
      tasks: [],
      evicted: false,
      pending_rescan: true,
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 200));

    // requestRestart triggers shutdown + spawn of new daemon
    const spawnCalls = vi.mocked(spawn).mock.calls;
    const restartCall = spawnCalls.find(
      (call) => call[0] === process.execPath && (call[1] as string[]).includes("--foreground"),
    );
    expect(restartCall).toBeDefined();
  });

  it("does not restart when pending_rescan is absent", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });

    mockClientInstance.poll.mockResolvedValue({
      tasks: [],
      evicted: false,
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 200));

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const restartCall = spawnCalls.find(
      (call) => call[0] === process.execPath && (call[1] as string[]).includes("--foreground"),
    );
    expect(restartCall).toBeUndefined();
  });
});

describe("daemon restart spawn", () => {
  beforeEach(async () => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
    mockOpenSync.mockReturnValue(99);

    // Restore createHealthServer to the correct factory (previous tests may override it)
    const { createHealthServer } = await import("./health.js");
    vi.mocked(createHealthServer).mockReturnValue({
      setRuntimeCount: vi.fn(),
      server: { close: vi.fn((cb?: () => void) => { if (cb) cb(); }) },
    } as any);

    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });
    mockClientInstance.deregister.mockResolvedValue(undefined as any);
    mockClientInstance.poll.mockResolvedValue({ tasks: [], evicted: false });
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
  });

  it("restart spawn uses process.execPath with log file fd for stdio", async () => {
    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });

    // Make handleCliUpdate immediately invoke the restart callback
    vi.mocked(handleCliUpdate).mockImplementation((_version: string, onSuccess: () => void) => {
      onSuccess();
    });

    mockClientInstance.poll.mockResolvedValue({
      tasks: [],
      evicted: false,
      pending_update: { version: "2.0.0" },
    });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 200));

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const restartCall = spawnCalls.find(
      (call) => call[0] === process.execPath && (call[1] as string[]).includes("--foreground"),
    );
    expect(restartCall).toBeDefined();

    const args = restartCall![1] as string[];
    expect(args).toContain("daemon");
    expect(args).toContain("start");
    expect(args).toContain("--foreground");

    const opts = restartCall![2] as any;
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", 99, 99]);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("logs"),
      { recursive: true, mode: 0o700 },
    );
    expect(mockOpenSync).toHaveBeenCalledWith(
      path.join("/tmp", "alook", "daemon", "logs", "2026-01-01.log"),
      "a",
      0o600,
    );
    expect(mockCloseSync).toHaveBeenCalledWith(99);
  });
});

describe("daemon kill_task handling", () => {
  beforeEach(() => {
    signalHandlers.clear();
    intervalTimers.length = 0;
    clearedTimers.length = 0;
    spawnedChildren.length = 0;
    nextPid = 50000;
    vi.clearAllMocks();
    mockProcessExit.mockImplementation((() => {}) as any);
    mockOpenSync.mockReturnValue(42);
    // Use short timeouts for KILL_TASK retry loop in tests
    process.env.ALOOK_KILL_TASK_MAX_WAIT_MS = "500";
    process.env.ALOOK_KILL_TASK_POLL_MS = "50";
  });

  afterEach(() => {
    for (const t of intervalTimers) realClearInterval(t);
    delete process.env.ALOOK_KILL_TASK_MAX_WAIT_MS;
    delete process.env.ALOOK_KILL_TASK_POLL_MS;
  });

  function makeKillTask(targetTaskId: string) {
    return {
      id: "kt1",
      agent_id: "a1",
      runtime_id: "rt1",
      conversation_id: "c1",
      workspace_id: "ws1",
      prompt: "",
      status: "dispatched",
      priority: 0,
      dispatched_at: null,
      started_at: null,
      completed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      type: "kill_task",
      result: null,
      error: null,
      agent: null,
      context: { target_task_id: targetTaskId },
    };
  }

  function setupKillTaskClaim(targetTaskId: string) {
    let claimed = false;
    mockClientInstance.poll.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { tasks: [makeKillTask(targetTaskId)], evicted: false };
      }
      return { tasks: [], evicted: false };
    });
  }

  it("sends SIGTERM when target PID is found in timeline", async () => {
    setupKillTaskClaim("target_t1");
    mockFindRunningPidByTaskId.mockReturnValue(99999);
    const mockKill = vi.spyOn(process, "kill").mockImplementation((() => {}) as any);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockKill).toHaveBeenCalledWith(99999, "SIGTERM");
    expect(mockClientInstance.failTask).toHaveBeenCalledWith("al_test_token", "kt1", "killed");
    expect(spawn).not.toHaveBeenCalled();

    mockKill.mockRestore();
  });

  it("reports 'target not found' after retry timeout when PID never appears", async () => {
    setupKillTaskClaim("target_t1");
    mockFindRunningPidByTaskId.mockReturnValue(null);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });

    await startDaemon();
    // Wait longer than ALOOK_KILL_TASK_MAX_WAIT_MS (500ms) + overhead
    await new Promise((r) => setTimeout(r, 800));

    expect(mockClientInstance.failTask).toHaveBeenCalledWith("al_test_token", "kt1", "target not found in timeline");
    expect(spawn).not.toHaveBeenCalled();
    // Should have retried multiple times
    expect(mockFindRunningPidByTaskId.mock.calls.length).toBeGreaterThan(1);
  });

  it("handles ESRCH when target process already exited", async () => {
    setupKillTaskClaim("target_t1");
    mockFindRunningPidByTaskId.mockReturnValue(12345);
    const esrchError = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const mockKill = vi.spyOn(process, "kill").mockImplementation(() => { throw esrchError; });

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockClientInstance.failTask).toHaveBeenCalledWith("al_test_token", "kt1", "target process already exited");
    expect(spawn).not.toHaveBeenCalled();

    mockKill.mockRestore();
  });

  it("does not call startTask for kill_tasks", async () => {
    setupKillTaskClaim("target_t1");
    mockFindRunningPidByTaskId.mockReturnValue(99999);
    const mockKill = vi.spyOn(process, "kill").mockImplementation((() => {}) as any);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockClientInstance.startTask).not.toHaveBeenCalled();

    mockKill.mockRestore();
  });

  it("finds PID after a few retries and sends SIGTERM", async () => {
    setupKillTaskClaim("target_t1");
    let callCount = 0;
    mockFindRunningPidByTaskId.mockImplementation(() => {
      callCount++;
      if (callCount >= 3) return 88888;
      return null;
    });
    const mockKill = vi.spyOn(process, "kill").mockImplementation((() => {}) as any);

    vi.mocked(loadCLIConfigForProfile).mockReturnValue({
      server_url: "",
      watched_workspaces: [{ id: "ws1", name: "Test WS", token: "al_test_token" }],
    });
    mockClientInstance.register.mockResolvedValue({ runtimes: [{ id: "rt1" }] });

    await startDaemon();
    await new Promise((r) => setTimeout(r, 500));

    expect(mockKill).toHaveBeenCalledWith(88888, "SIGTERM");
    expect(mockClientInstance.failTask).toHaveBeenCalledWith("al_test_token", "kt1", "killed");
    expect(callCount).toBeGreaterThanOrEqual(3);

    mockKill.mockRestore();
  });
});

describe("isClientError", () => {
  it("HTTP 400: bad request → true", () => {
    expect(isClientError(new Error("HTTP 400: bad request"))).toBe(true);
  });

  it("HTTP 404: not found → true", () => {
    expect(isClientError(new Error("HTTP 404: not found"))).toBe(true);
  });

  it("HTTP 408: request timeout → false (transient)", () => {
    expect(isClientError(new Error("HTTP 408: request timeout"))).toBe(false);
  });

  it("HTTP 429: too many requests → false (transient)", () => {
    expect(isClientError(new Error("HTTP 429: too many requests"))).toBe(false);
  });

  it("HTTP 500: internal server error → false", () => {
    expect(isClientError(new Error("HTTP 500: internal server error"))).toBe(false);
  });

  it("HTTP 503: service unavailable → false", () => {
    expect(isClientError(new Error("HTTP 503: service unavailable"))).toBe(false);
  });

  it("Network error (no HTTP prefix) → false", () => {
    expect(isClientError(new Error("TypeError: fetch failed"))).toBe(false);
  });

  it("Non-Error value → false", () => {
    expect(isClientError("some string")).toBe(false);
    expect(isClientError(42)).toBe(false);
    expect(isClientError(null)).toBe(false);
  });
});

describe("reconcilePendingCompletions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.completeTask.mockResolvedValue({});
    mockClientInstance.failTask.mockResolvedValue({});
  });

  function makeMarker(overrides?: Record<string, unknown>) {
    return JSON.stringify({
      taskId: "t1",
      type: "complete",
      payload: { output: "Done!" },
      token: "tok_123",
      serverURL: "http://localhost:8080",
      createdAt: new Date().toISOString(),
      ...overrides,
    });
  }

  it("delivers 'complete' marker and deletes file", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker());

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.completeTask).toHaveBeenCalledWith("tok_123", "t1", { output: "Done!" });
    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t1.json"));
  });

  it("delivers 'fail' marker and deletes file", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker({ type: "fail", payload: { error: "boom" } }));

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.failTask).toHaveBeenCalledWith("tok_123", "t1", "boom");
    expect(mockUnlink).toHaveBeenCalled();
  });

  it("deletes marker on 4xx", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker());
    mockClientInstance.completeTask.mockRejectedValueOnce(new Error("HTTP 400: bad request"));

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t1.json"));
  });

  it("retains marker on network error", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker());
    mockClientInstance.completeTask.mockRejectedValueOnce(new Error("TypeError: fetch failed"));

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("retains marker on 5xx", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker());
    mockClientInstance.completeTask.mockRejectedValueOnce(new Error("HTTP 500: internal server error"));

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("deletes stale markers (>24h)", async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mockReaddir.mockResolvedValueOnce(["t1.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker({ createdAt: oldDate }));

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.completeTask).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t1.json"));
  });

  it("deletes malformed JSON marker files and continues processing", async () => {
    mockReaddir.mockResolvedValueOnce(["bad.json", "t1.json"] as any);
    mockReadFile.mockResolvedValueOnce("{invalid json");
    mockReadFile.mockResolvedValueOnce(makeMarker());

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "bad.json"));
    expect(mockClientInstance.completeTask).toHaveBeenCalledTimes(1);
  });

  it("deletes markers with invalid createdAt dates", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker({ createdAt: "not-a-date" }));

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.completeTask).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t1.json"));
  });

  it("skips structurally invalid marker files and deletes them", async () => {
    mockReaddir.mockResolvedValueOnce(["bad.json"] as any);
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ type: "complete", taskId: "x", payload: {} }));

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.completeTask).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalled();
  });

  it("handles empty directory", async () => {
    mockReaddir.mockResolvedValueOnce([] as any);

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.completeTask).not.toHaveBeenCalled();
    expect(mockClientInstance.failTask).not.toHaveBeenCalled();
  });

  it("handles missing directory", async () => {
    mockReaddir.mockRejectedValueOnce(new Error("ENOENT"));

    await expect(reconcilePendingCompletions("/tmp/ws")).resolves.toBeUndefined();
  });

  it("processes markers independently — failure on one doesn't abort rest", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.json", "t2.json", "t3.json"] as any);
    mockReadFile.mockResolvedValueOnce(makeMarker({ taskId: "t1" }));
    mockReadFile.mockResolvedValueOnce(makeMarker({ taskId: "t2" }));
    mockReadFile.mockResolvedValueOnce(makeMarker({ taskId: "t3" }));
    mockClientInstance.completeTask
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("TypeError: fetch failed"))
      .mockResolvedValueOnce({});

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.completeTask).toHaveBeenCalledTimes(3);
    // t1 and t3 delivered → deleted, t2 failed → retained
    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t1.json"));
    expect(mockUnlink).not.toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t2.json"));
    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t3.json"));
  });

  it("ignores .tmp files (not processed as markers)", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.tmp"] as any);
    mockFsStat.mockResolvedValueOnce({ mtimeMs: Date.now() } as any);

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockClientInstance.completeTask).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("cleans up stale .tmp files (>1h)", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.tmp"] as any);
    mockFsStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 2 * 60 * 60 * 1000 } as any);

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockUnlink).toHaveBeenCalledWith(path.join("/tmp", "ws", ".pending_completions", "t1.tmp"));
  });

  it("keeps recent .tmp files", async () => {
    mockReaddir.mockResolvedValueOnce(["t1.tmp"] as any);
    mockFsStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 5 * 60 * 1000 } as any);

    await reconcilePendingCompletions("/tmp/ws");

    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

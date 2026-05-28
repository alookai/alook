import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLoadCLIConfigForProfile = vi.fn();
const mockSaveCLIConfigForProfile = vi.fn();
const mockReadDaemonPid = vi.fn();
const mockIsProcessAlive = vi.fn();

vi.mock("../lib/config.js", () => ({
  loadCLIConfigForProfile: (...args: any[]) => mockLoadCLIConfigForProfile(...args),
  saveCLIConfigForProfile: (...args: any[]) => mockSaveCLIConfigForProfile(...args),
}));

vi.mock("../daemon/pidfile.js", () => ({
  readDaemonPid: (...args: any[]) => mockReadDaemonPid(...args),
  isProcessAlive: (...args: any[]) => mockIsProcessAlive(...args),
}));

vi.mock("../lib/env.js", () => ({
  cmdPrefix: () => "alook",
  isDev: () => false,
}));

vi.mock("../lib/runtimes.js", () => ({
  isCommandAvailable: vi.fn(() => true),
  detectRuntimes: vi.fn(() => [{ type: "claude", version: "4.0.0" }]),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes("which claude")) return "/usr/bin/claude";
    if (cmd.includes("claude --version")) return "4.0.0";
    throw new Error("not found");
  }),
}));

import { registerCommand } from "./register";

describe("alook register", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    mockKill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    mockExit.mockRestore();
    mockKill.mockRestore();
    vi.unstubAllGlobals();
  });

  function mockFetch(responses: Record<string, { status: number; body: unknown }>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      for (const [pattern, resp] of Object.entries(responses)) {
        if (urlStr.includes(pattern)) {
          return {
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            json: async () => resp.body,
            text: async (): Promise<string> => JSON.stringify(resp.body),
          };
        }
      }
      return { ok: false, status: 404, text: async (): Promise<string> => "not found" };
    }));
  }

  it("stores workspace_id from activate response in config", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [],
    });
    mockReadDaemonPid.mockReturnValue(null);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": {
        status: 200,
        body: { daemon_id: "host1", workspace_id: "sp_new123", runtimes: [{ id: "r1", provider: "claude" }] },
      },
      "/api/workspaces": { status: 200, body: [{ id: "sp_new123", name: "New WS" }] },
      "/api/agents": { status: 200, body: [] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_testtoken123", "--server", "http://localhost:3000"]);

    expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        watched_workspaces: [
          { id: "sp_new123", name: "New WS", token: "al_testtoken123", agent_ids: [] },
        ],
      }),
    );
  });

  it("appends new workspace to existing config (does not replace)", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [
        { id: "sp_existing", name: "Existing", token: "al_old", agent_ids: ["ag_1"] },
      ],
    });
    mockReadDaemonPid.mockReturnValue(null);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": {
        status: 200,
        body: { daemon_id: "host1", workspace_id: "sp_second", runtimes: [{ id: "r1", provider: "claude" }] },
      },
      "/api/workspaces": {
        status: 200,
        body: [
          { id: "sp_existing", name: "Existing" },
          { id: "sp_second", name: "Second WS" },
        ],
      },
      "/api/agents": { status: 200, body: [{ id: "ag_new" }] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_newtoken", "--server", "http://localhost:3000"]);

    expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        watched_workspaces: [
          { id: "sp_existing", name: "Existing", token: "al_old", agent_ids: ["ag_1"] },
          { id: "sp_second", name: "Second WS", token: "al_newtoken", agent_ids: ["ag_new"] },
        ],
      }),
    );
  });

  it("updates workspace in-place when same workspace_id already exists", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [
        { id: "sp_same", name: "Old Name", token: "al_old", agent_ids: [] },
      ],
    });
    mockReadDaemonPid.mockReturnValue(null);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": {
        status: 200,
        body: { daemon_id: "host1", workspace_id: "sp_same", runtimes: [{ id: "r1", provider: "claude" }] },
      },
      "/api/workspaces": { status: 200, body: [{ id: "sp_same", name: "Updated Name" }] },
      "/api/agents": { status: 200, body: [{ id: "ag_x" }] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_renewed", "--server", "http://localhost:3000"]);

    expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        watched_workspaces: [
          { id: "sp_same", name: "Updated Name", token: "al_renewed", agent_ids: ["ag_x"] },
        ],
      }),
    );
  });

  it("sends SIGHUP when daemon is running", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [],
    });
    mockReadDaemonPid.mockReturnValue(12345);
    mockIsProcessAlive.mockReturnValue(true);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": {
        status: 200,
        body: { daemon_id: "host1", workspace_id: "sp_1", runtimes: [{ id: "r1", provider: "claude" }] },
      },
      "/api/workspaces": { status: 200, body: [{ id: "sp_1", name: "WS" }] },
      "/api/agents": { status: 200, body: [] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_test", "--server", "http://localhost:3000"]);

    expect(mockKill).toHaveBeenCalledWith(12345, "SIGHUP");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Daemon (pid 12345) notified"));
  });

  it("does not send SIGHUP when daemon is not running", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [],
    });
    mockReadDaemonPid.mockReturnValue(null);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": {
        status: 200,
        body: { daemon_id: "host1", workspace_id: "sp_1", runtimes: [{ id: "r1", provider: "claude" }] },
      },
      "/api/workspaces": { status: 200, body: [{ id: "sp_1", name: "WS" }] },
      "/api/agents": { status: 200, body: [] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_test", "--server", "http://localhost:3000"]);

    expect(mockKill).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("daemon start"));
  });
});

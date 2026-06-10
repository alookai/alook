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
  spawn: vi.fn(() => ({ unref: vi.fn() })),
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

  const activateResponse = {
    daemon_id: "host1",
    workspace_id: "ws_1",
    runtimes: [{ id: "rt_1", provider: "claude" }],
  };

  it("activates token and saves workspace to config", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [],
    });
    mockReadDaemonPid.mockReturnValue(null);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": { status: 200, body: activateResponse },
      "/api/workspaces": { status: 200, body: [{ id: "ws_1", name: "Personal" }] },
      "/api/agents": { status: 200, body: [] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_testtoken123", "--server", "http://localhost:3000"]);

    expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        server_url: "http://localhost:3000",
        watched_workspaces: [
          { id: "ws_1", name: "Personal", token: "al_testtoken123", status: "active", agent_ids: [] },
        ],
      }),
    );
  });

  it("preserves existing watched_workspaces and updates matching entry", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [
        { id: "ws_1", name: "Existing", token: "al_old", status: "active", agent_ids: ["ag_1"] },
      ],
    });
    mockReadDaemonPid.mockReturnValue(null);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": { status: 200, body: activateResponse },
      "/api/workspaces": { status: 200, body: [{ id: "ws_1", name: "Personal" }] },
      "/api/agents": { status: 200, body: [{ id: "ag_1" }] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_newtoken", "--server", "http://localhost:3000"]);

    expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        watched_workspaces: [
          { id: "ws_1", name: "Personal", token: "al_newtoken", status: "active", agent_ids: ["ag_1"] },
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
      "/api/machine-tokens/activate": { status: 200, body: activateResponse },
      "/api/workspaces": { status: 200, body: [{ id: "ws_1", name: "Personal" }] },
      "/api/agents": { status: 200, body: [] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_test", "--server", "http://localhost:3000"]);

    expect(mockKill).toHaveBeenCalledWith(12345, "SIGHUP");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Daemon (pid 12345) notified"));
  });

  it("auto-starts daemon when not running", async () => {
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [],
    });
    mockReadDaemonPid.mockReturnValue(null);

    mockFetch({
      "/api/me": { status: 200, body: { id: "u1", email: "test@test.com" } },
      "/api/machine-tokens/activate": { status: 200, body: activateResponse },
      "/api/workspaces": { status: 200, body: [{ id: "ws_1", name: "Personal" }] },
      "/api/agents": { status: 200, body: [] },
    });

    const cmd = registerCommand();
    await cmd.parseAsync(["node", "register", "--token", "al_test", "--server", "http://localhost:3000"]);

    expect(mockKill).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Starting daemon"));
  });
});

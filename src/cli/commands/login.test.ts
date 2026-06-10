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
  getServerUrl: () => "http://localhost:3000",
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
  fork: vi.fn(() => ({ unref: vi.fn() })),
}));

import { loginCommand } from "./login";

describe("alook login", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    mockKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true });
    mockLoadCLIConfigForProfile.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [],
    });
    mockReadDaemonPid.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    mockExit.mockRestore();
    mockKill.mockRestore();
    vi.unstubAllGlobals();
  });

  function mockFetchSequence(responses: { url: string; status: number; body: unknown }[]) {
    const queue = [...responses];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const idx = queue.findIndex((r) => urlStr.includes(r.url));
      if (idx >= 0) {
        const resp = queue[idx];
        queue.splice(idx, 1);
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async (): Promise<string> => JSON.stringify(resp.body),
        };
      }
      return { ok: false, status: 404, text: async (): Promise<string> => "not found", json: async () => ({ error: "not_found" }) };
    }));
  }

  function deviceCodeResponse(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      device_code: "dc_123",
      user_code: "ABCD-EFGH",
      verification_uri: "http://localhost:3000/device",
      verification_uri_complete: "http://localhost:3000/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 1,
      ...overrides,
    };
  }

  function tokenSuccessResponse(token = "session_tok_123") {
    return { access_token: token, token_type: "Bearer", expires_in: 2592000, scope: "" };
  }

  function fullSuccessResponses() {
    return [
      { url: "/api/auth/device/code", status: 200, body: deviceCodeResponse() },
      { url: "/api/auth/device/token", status: 200, body: tokenSuccessResponse() },
      { url: "/api/me", status: 200, body: { id: "u1", email: "test@alook.ai" } },
      { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "My Workspace" }] },
      { url: "/api/machine-tokens", status: 201, body: { token: "al_machine_tok" } },
      { url: "/api/machine-tokens/activate", status: 200, body: { daemon_id: "host1", workspace_id: "sp_ws1", runtimes: [{ id: "r1", provider: "claude" }] } },
      { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "My Workspace" }] },
      { url: "/api/agents", status: 200, body: [{ id: "ag_1" }] },
    ];
  }

  async function runWithTimers(promise: Promise<unknown>) {
    let settled = false;
    const result = promise.finally(() => { settled = true; });
    while (!settled) {
      await vi.advanceTimersByTimeAsync(10000);
    }
    return result;
  }

  it("completes full device code flow and saves config", async () => {
    mockFetchSequence(fullSuccessResponses());

    const cmd = loginCommand();
    await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

    // syncWorkspacesToConfig stores session token + synced workspaces
    expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        server_url: "http://localhost:3000",
        session_token: "session_tok_123",
        watched_workspaces: expect.arrayContaining([
          expect.objectContaining({ id: "sp_ws1", name: "My Workspace", status: "active" }),
        ]),
      }),
    );
    // activateAndSave updates the workspace entry with the token
    expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        watched_workspaces: expect.arrayContaining([
          expect.objectContaining({ id: "sp_ws1", token: "al_machine_tok", status: "active" }),
        ]),
      }),
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Logged in as test@alook.ai"));
  });


  it("handles authorization_pending by continuing to poll", async () => {
    mockFetchSequence([
      { url: "/api/auth/device/code", status: 200, body: deviceCodeResponse() },
      { url: "/api/auth/device/token", status: 400, body: { error: "authorization_pending" } },
      { url: "/api/auth/device/token", status: 200, body: tokenSuccessResponse() },
      { url: "/api/me", status: 200, body: { id: "u1", email: "poll@alook.ai" } },
      { url: "/api/workspaces", status: 200, body: [{ id: "sp_poll", name: "Poll WS" }] },
      { url: "/api/machine-tokens", status: 201, body: { token: "al_poll_tok" } },
      { url: "/api/machine-tokens/activate", status: 200, body: { daemon_id: "host1", workspace_id: "sp_poll", runtimes: [{ id: "r1", provider: "claude" }] } },
      { url: "/api/workspaces", status: 200, body: [{ id: "sp_poll", name: "Poll WS" }] },
      { url: "/api/agents", status: 200, body: [] },
    ]);

    const cmd = loginCommand();
    await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

    expect(mockSaveCLIConfigForProfile).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Logged in as poll@alook.ai"));
  });

  it("handles slow_down by increasing polling interval", async () => {
    mockFetchSequence([
      { url: "/api/auth/device/code", status: 200, body: deviceCodeResponse() },
      { url: "/api/auth/device/token", status: 400, body: { error: "slow_down" } },
      { url: "/api/auth/device/token", status: 200, body: tokenSuccessResponse() },
      { url: "/api/me", status: 200, body: { id: "u1", email: "slow@alook.ai" } },
      { url: "/api/workspaces", status: 200, body: [{ id: "sp_slow", name: "Slow WS" }] },
      { url: "/api/machine-tokens", status: 201, body: { token: "al_slow_tok" } },
      { url: "/api/machine-tokens/activate", status: 200, body: { daemon_id: "host1", workspace_id: "sp_slow", runtimes: [{ id: "r1", provider: "claude" }] } },
      { url: "/api/workspaces", status: 200, body: [{ id: "sp_slow", name: "Slow WS" }] },
      { url: "/api/agents", status: 200, body: [] },
    ]);

    const cmd = loginCommand();
    await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Logged in as slow@alook.ai"));
  });

  it("sends SIGHUP when daemon is running after login", async () => {
    mockReadDaemonPid.mockReturnValue(99999);
    mockIsProcessAlive.mockReturnValue(true);
    mockFetchSequence(fullSuccessResponses());

    const cmd = loginCommand();
    await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

    expect(mockKill).toHaveBeenCalledWith(99999, "SIGHUP");
  });

  it("displays verification URL and user code", async () => {
    mockFetchSequence(fullSuccessResponses());

    const cmd = loginCommand();
    await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("http://localhost:3000/device?user_code=ABCD-EFGH"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ABCD-EFGH"));
  });

  describe("already authenticated", () => {
    it("exits early when token is still valid", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [{ id: "sp_ws1", name: "My Workspace", token: "al_existing_tok" }],
      });

      mockFetchSequence([
        { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "My Workspace" }] },
        { url: "/api/me", status: 200, body: { email: "user@alook.ai" } },
      ]);

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(consoleSpy).toHaveBeenCalledWith(
        "Already logged in as user@alook.ai (workspace: My Workspace).",
      );
      expect(mockSaveCLIConfigForProfile).not.toHaveBeenCalled();
    });

    it("proceeds with login when --force is set", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [{ id: "sp_ws1", name: "My Workspace", token: "al_existing_tok" }],
      });

      mockFetchSequence(fullSuccessResponses());

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000", "--force"]));

      expect(mockSaveCLIConfigForProfile).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Logged in as test@alook.ai"));
    });

    it("proceeds with login when token is invalid/expired", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [{ id: "sp_ws1", name: "My Workspace", token: "al_expired_tok" }],
      });

      mockFetchSequence([
        { url: "/api/workspaces", status: 401, body: { error: "unauthorized" } },
        { url: "/api/auth/device/code", status: 200, body: deviceCodeResponse() },
        { url: "/api/auth/device/token", status: 200, body: tokenSuccessResponse() },
        { url: "/api/me", status: 200, body: { id: "u1", email: "test@alook.ai" } },
        { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "My Workspace" }] },
        { url: "/api/machine-tokens", status: 201, body: { token: "al_new_tok" } },
        { url: "/api/machine-tokens/activate", status: 200, body: { daemon_id: "host1", workspace_id: "sp_ws1", runtimes: [{ id: "r1", provider: "claude" }] } },
        { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "My Workspace" }] },
        { url: "/api/agents", status: 200, body: [] },
      ]);

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(mockSaveCLIConfigForProfile).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Logged in as test@alook.ai"));
    });

    it("proceeds with login when no workspaces in config", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [],
      });

      mockFetchSequence(fullSuccessResponses());

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(mockSaveCLIConfigForProfile).toHaveBeenCalled();
    });

    it("shows message without email when /api/me fails", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [{ id: "sp_ws1", name: "My Workspace", token: "al_existing_tok" }],
      });

      mockFetchSequence([
        { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "My Workspace" }] },
        { url: "/api/me", status: 500, body: { error: "internal" } },
      ]);

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(consoleSpy).toHaveBeenCalledWith(
        "Already logged in (workspace: My Workspace).",
      );
      expect(mockSaveCLIConfigForProfile).not.toHaveBeenCalled();
    });

    it("shows message without email when /api/me throws network error", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [{ id: "sp_ws1", name: "My Workspace", token: "al_existing_tok" }],
      });

      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        callCount++;
        if (urlStr.includes("/api/workspaces")) {
          return { ok: true, status: 200, json: async () => [{ id: "sp_ws1" }], text: async () => "[]" };
        }
        if (urlStr.includes("/api/me")) {
          throw new Error("network error");
        }
        return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
      }));

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(consoleSpy).toHaveBeenCalledWith(
        "Already logged in (workspace: My Workspace).",
      );
    });

    it("proceeds with login when token field is empty", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [{ id: "sp_ws1", name: "My Workspace", token: "" }],
      });

      mockFetchSequence(fullSuccessResponses());

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(mockSaveCLIConfigForProfile).toHaveBeenCalled();
    });

    it("works correctly in non-TTY mode with early exit", async () => {
      Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        watched_workspaces: [{ id: "sp_ws1", name: "My Workspace", token: "al_valid_tok" }],
      });

      mockFetchSequence([
        { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "My Workspace" }] },
        { url: "/api/me", status: 200, body: { email: "agent@alook.ai" } },
      ]);

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(consoleSpy).toHaveBeenCalledWith(
        "Already logged in as agent@alook.ai (workspace: My Workspace).",
      );
      expect(mockSaveCLIConfigForProfile).not.toHaveBeenCalled();
    });
  });

  describe("session token and workspace sync", () => {
    it("stores session_token in config after login", async () => {
      mockFetchSequence(fullSuccessResponses());

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ session_token: "session_tok_123" }),
      );
    });

    it("syncs server workspaces to local config during login", async () => {
      mockFetchSequence([
        { url: "/api/auth/device/code", status: 200, body: deviceCodeResponse() },
        { url: "/api/auth/device/token", status: 200, body: tokenSuccessResponse() },
        { url: "/api/me", status: 200, body: { id: "u1", email: "test@alook.ai" } },
        { url: "/api/workspaces", status: 200, body: [
          { id: "sp_ws1", name: "Work" },
          { id: "sp_ws2", name: "Personal" },
        ] },
        { url: "/api/machine-tokens", status: 201, body: { token: "al_mt" } },
        { url: "/api/machine-tokens/activate", status: 200, body: { daemon_id: "h1", workspace_id: "sp_ws1", runtimes: [{ id: "r1", provider: "claude" }] } },
        { url: "/api/workspaces", status: 200, body: [
          { id: "sp_ws1", name: "Work" },
          { id: "sp_ws2", name: "Personal" },
        ] },
        { url: "/api/agents", status: 200, body: [] },
      ]);

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          watched_workspaces: expect.arrayContaining([
            expect.objectContaining({ id: "sp_ws1", name: "Work", status: "active" }),
            expect.objectContaining({ id: "sp_ws2", name: "Personal", status: "active" }),
          ]),
        }),
      );
    });

    it("syncs workspaces when existing auth valid but no local workspace id", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        session_token: "old_session_tok",
        watched_workspaces: [{ id: null, name: null, token: "al_reg_tok", status: "registered" }],
      });

      mockFetchSequence([
        { url: "/api/workspaces", status: 200, body: [{ id: "sp_synced", name: "Synced WS" }] },
        { url: "/api/me", status: 200, body: { email: "sync@alook.ai" } },
      ]);

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(mockSaveCLIConfigForProfile).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          watched_workspaces: expect.arrayContaining([
            expect.objectContaining({ id: "sp_synced", name: "Synced WS", status: "active" }),
          ]),
        }),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Already logged in as sync@alook.ai (workspace: Synced WS).",
      );
    });

    it("uses session token for auth check when machine token not available", async () => {
      mockLoadCLIConfigForProfile.mockReturnValue({
        server_url: "http://localhost:3000",
        session_token: "session_valid",
        watched_workspaces: [{ id: "sp_ws1", name: "Session WS", token: "" }],
      });

      mockFetchSequence([
        { url: "/api/workspaces", status: 200, body: [{ id: "sp_ws1", name: "Session WS" }] },
        { url: "/api/me", status: 200, body: { email: "session@alook.ai" } },
      ]);

      const cmd = loginCommand();
      await runWithTimers(cmd.parseAsync(["node", "login", "--server", "http://localhost:3000"]));

      expect(consoleSpy).toHaveBeenCalledWith(
        "Already logged in as session@alook.ai (workspace: Session WS).",
      );
    });
  });
});

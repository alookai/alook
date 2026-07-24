import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", async (importActual) => ({
  ...(await importActual<typeof import("./config.js")>()),
  loadCLIConfigForProfile: vi.fn(),
}));

vi.mock("./env.js", () => ({
  cmdPrefix: () => "npx @alook/cli",
}));

import { resolveClientOpts } from "./resolve-client.js";
import { loadCLIConfigForProfile } from "./config.js";

const mockedLoadConfig = vi.mocked(loadCLIConfigForProfile);

function makeCommand(opts: Record<string, unknown> = {}) {
  return { parent: null, opts: () => opts } as any;
}

function makeNestedCommand(rootOpts: Record<string, unknown> = {}) {
  const root = { parent: null, opts: () => rootOpts } as any;
  const child = { parent: root, opts: () => ({}) } as any;
  return { parent: child, opts: () => ({}) } as any;
}

describe("resolveClientOpts", () => {
  const envKeys = ["ALOOK_SERVER_URL", "ALOOK_WORKSPACE_ID", "ALOOK_TOKEN"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    mockedLoadConfig.mockReturnValue({
      server_url: "",
      watched_workspaces: [],
    });
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
  });

  it("resolves from env vars when no config exists", () => {
    process.env.ALOOK_SERVER_URL = "https://self-hosted.example.com";
    process.env.ALOOK_WORKSPACE_ID = "ws_env";
    process.env.ALOOK_TOKEN = "tok_env";

    const result = resolveClientOpts(makeCommand(), { agentId: "ag1" });

    expect(result.serverUrl).toBe("https://self-hosted.example.com");
    expect(result.workspaceId).toBe("ws_env");
    expect(result.token).toBe("tok_env");
  });

  it("env token takes priority over config token", () => {
    process.env.ALOOK_TOKEN = "tok_env";
    mockedLoadConfig.mockReturnValue({
      server_url: "https://config.example.com",
      watched_workspaces: [
        { id: "ws1", name: "WS1", token: "tok_config", agent_ids: ["ag1"] },
      ],
    });

    const result = resolveClientOpts(makeCommand(), { agentId: "ag1" });

    expect(result.token).toBe("tok_env");
    expect(result.workspaceId).toBe("ws1");
  });

  it("flag > env > config for server URL", () => {
    process.env.ALOOK_SERVER_URL = "https://env.example.com";
    mockedLoadConfig.mockReturnValue({
      server_url: "https://config.example.com",
      watched_workspaces: [
        { id: "ws1", name: "WS1", token: "tok1", agent_ids: ["ag1"] },
      ],
    });

    const result = resolveClientOpts(
      makeCommand({ server: "https://flag.example.com" }),
      { agentId: "ag1" },
    );

    expect(result.serverUrl).toBe("https://flag.example.com");
  });

  it("resolves workspace by agent_id from config", () => {
    mockedLoadConfig.mockReturnValue({
      server_url: "https://alook.ai",
      watched_workspaces: [
        { id: "ws1", name: "WS1", token: "tok1", agent_ids: ["ag1"] },
        { id: "ws2", name: "WS2", token: "tok2", agent_ids: ["ag2"] },
      ],
    });

    const result = resolveClientOpts(makeCommand(), { agentId: "ag2" });

    expect(result.workspaceId).toBe("ws2");
    expect(result.token).toBe("tok2");
  });

  it("falls back to single workspace when agent not found", () => {
    mockedLoadConfig.mockReturnValue({
      server_url: "https://alook.ai",
      watched_workspaces: [
        { id: "ws1", name: "WS1", token: "tok1", agent_ids: ["other"] },
      ],
    });

    const result = resolveClientOpts(makeCommand(), { agentId: "ag_unknown" });

    expect(result.workspaceId).toBe("ws1");
    expect(result.token).toBe("tok1");
  });

  it("resolves via env when agent_id not in config and no single fallback", () => {
    process.env.ALOOK_WORKSPACE_ID = "ws_env";
    process.env.ALOOK_TOKEN = "tok_env";
    mockedLoadConfig.mockReturnValue({
      server_url: "https://alook.ai",
      watched_workspaces: [
        { id: "ws1", name: "WS1", token: "tok1", agent_ids: ["other1"] },
        { id: "ws2", name: "WS2", token: "tok2", agent_ids: ["other2"] },
      ],
    });

    const result = resolveClientOpts(makeCommand(), { agentId: "ag_self_hosted" });

    expect(result.workspaceId).toBe("ws_env");
    expect(result.token).toBe("tok_env");
  });

  it("exits with error when nothing available", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolveClientOpts(makeCommand(), { agentId: "ag1" })).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("traverses to root command for parent opts", () => {
    process.env.ALOOK_TOKEN = "tok_env";
    process.env.ALOOK_WORKSPACE_ID = "ws_env";

    const cmd = makeNestedCommand({ server: "https://from-root.example.com" });
    const result = resolveClientOpts(cmd, { agentId: "ag1" });

    expect(result.serverUrl).toBe("https://from-root.example.com");
  });

  it("workspace flag selects specific workspace from config", () => {
    mockedLoadConfig.mockReturnValue({
      server_url: "https://alook.ai",
      watched_workspaces: [
        { id: "ws1", name: "WS1", token: "tok1", agent_ids: ["ag1"] },
        { id: "ws2", name: "WS2", token: "tok2", agent_ids: ["ag2"] },
      ],
    });

    const result = resolveClientOpts(makeCommand(), { workspace: "ws2", agentId: "ag1" });

    expect(result.workspaceId).toBe("ws2");
    expect(result.token).toBe("tok2");
  });

  it("errors with workspace guidance when token is set but workspace cannot be determined", () => {
    process.env.ALOOK_TOKEN = "tok_env";
    // No ALOOK_WORKSPACE_ID, no config match, multiple workspaces
    mockedLoadConfig.mockReturnValue({
      server_url: "https://alook.ai",
      watched_workspaces: [
        { id: "ws1", name: "WS1", token: "tok1", agent_ids: ["other1"] },
        { id: "ws2", name: "WS2", token: "tok2", agent_ids: ["other2"] },
      ],
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolveClientOpts(makeCommand(), { agentId: "ag_missing" })).toThrow("__exit__");
    expect(errSpy).toHaveBeenCalledWith(
      "Error: cannot determine workspace. Set ALOOK_WORKSPACE_ID env var or use --workspace flag.",
    );

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

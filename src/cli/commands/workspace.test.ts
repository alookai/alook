import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

const { getJSONMock, postJSONMock } = vi.hoisted(() => ({
  getJSONMock: vi.fn(),
  postJSONMock: vi.fn(),
}));

vi.mock("../lib/client.js", () => ({
  APIClient: class {
    getJSON(...a: unknown[]) { return getJSONMock(...a); }
    postJSON(...a: unknown[]) { return postJSONMock(...a); }
  },
}));

vi.mock("../lib/resolve-client.js", () => ({
  resolveClientOpts: vi.fn(() => ({
    serverUrl: "http://localhost:3000",
    token: "test-token",
    workspaceId: "ws_test",
  })),
  resolveClientOptsPartial: vi.fn(() => ({
    serverUrl: "http://localhost:3000",
    token: "test-token",
    workspaceId: "ws_test",
  })),
}));

vi.mock("../lib/config.js", () => ({
  loadCLIConfigForProfile: vi.fn(() => ({
    server_url: "http://localhost:3000",
    watched_workspaces: [{ id: "ws_test", name: "Test", token: "test-token", status: "active" }],
  })),
  saveCLIConfigForProfile: vi.fn(),
}));

vi.mock("../lib/command-utils.js", () => ({
  getRootOpts: vi.fn(() => ({})),
}));

import { workspaceCommand } from "./workspace";
import { resolveClientOptsPartial } from "../lib/resolve-client.js";
import { loadCLIConfigForProfile } from "../lib/config.js";

const mockedResolvePartial = vi.mocked(resolveClientOptsPartial);
const mockedLoadConfig = vi.mocked(loadCLIConfigForProfile);

const TMP_DIR = "/tmp/alook-workspace-test";

describe("workspace init", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(TMP_DIR, { recursive: true });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExit = vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`process.exit(${code})`); });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    mockExit.mockRestore();
  });

  function writeJson(filename: string, data: unknown) {
    const path = join(TMP_DIR, filename);
    writeFileSync(path, JSON.stringify(data));
    return path;
  }

  async function runInit(args: string[]) {
    const cmd = workspaceCommand();
    await cmd.parseAsync(["node", "workspace", "init", ...args]);
  }

  it("reads local JSON file and creates workspace", async () => {
    const jsonPath = writeJson("valid.json", {
      name: "Test WS",
      members: [
        { role: "leader", instructions: "You lead" },
        { role: "engineer", instructions: "You code", relationship: "delegate\n\nreport" },
      ],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }]) // runtimes
      .mockResolvedValueOnce([]); // agents (empty = no existing agents)

    postJSONMock.mockResolvedValueOnce({
      studio: { name: "Test WS" },
      workspace: { id: "ws_test", name: "Test WS", slug: "test-ws" },
      agents: [
        { id: "ag1", name: "Alice", email_handle: "alice" },
        { id: "ag2", name: "Bob", email_handle: "bob" },
      ],
      links: [],
    });

    await runInit(["--json-file", jsonPath]);

    expect(postJSONMock).toHaveBeenCalledWith("/api/studios", expect.objectContaining({
      name: "Test WS",
      members: expect.arrayContaining([
        expect.objectContaining({ role: "leader", runtime_id: "rt1" }),
      ]),
    }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Workspace initialized"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("alice@alook.ai"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("http://localhost:3000/w/test-ws"));
  });

  it("errors when JSON file does not exist", async () => {
    await expect(runInit(["--json-file", "/tmp/nonexistent-file.json"])).rejects.toThrow("process.exit(1)");
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("cannot read file"));
  });

  it("errors when JSON is malformed", async () => {
    const path = join(TMP_DIR, "bad.json");
    writeFileSync(path, "not json {{{");

    await expect(runInit(["--json-file", path])).rejects.toThrow("process.exit(1)");
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"));
  });

  it("errors when members array is missing", async () => {
    const jsonPath = writeJson("no-members.json", { name: "Test" });

    await expect(runInit(["--json-file", jsonPath])).rejects.toThrow("process.exit(1)");
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("members"));
  });

  it("errors when no runtimes are registered", async () => {
    const jsonPath = writeJson("valid.json", {
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock.mockResolvedValueOnce([]); // empty runtimes

    await expect(runInit(["--json-file", jsonPath])).rejects.toThrow("process.exit(1)");
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("No daemon registered"));
  });

  it("creates new workspace and re-fetches runtimes from it", async () => {
    const jsonPath = writeJson("valid.json", {
      name: "New WS",
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }]) // runtimes (old ws)
      .mockResolvedValueOnce([{ id: "existing-agent" }]) // existing agents
      .mockResolvedValueOnce([{ id: "rt_new", machineLastSeenAt: new Date().toISOString() }]); // runtimes (new ws)

    postJSONMock
      .mockResolvedValueOnce({ id: "ws_new", name: "New WS" }) // POST /api/workspaces
      .mockResolvedValueOnce({ // POST /api/studios
        studio: { name: "New WS" },
        workspace: { id: "ws_new", name: "New WS", slug: "new-ws" },
        agents: [{ id: "ag1", name: "Charlie", email_handle: "charlie" }],
        links: [],
      });

    await runInit(["--json-file", jsonPath]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("existing agents"));
    expect(postJSONMock).toHaveBeenCalledWith("/api/workspaces", expect.objectContaining({ name: "New WS" }));
    expect(postJSONMock).toHaveBeenCalledWith("/api/studios", expect.objectContaining({
      members: expect.arrayContaining([
        expect.objectContaining({ runtime_id: "rt_new" }),
      ]),
    }));
  });

  it("registers runtime in new workspace when none exist there", async () => {
    const jsonPath = writeJson("valid.json", {
      name: "Fresh WS",
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "rt_orig", machineLastSeenAt: new Date().toISOString() }]) // runtimes (old ws)
      .mockResolvedValueOnce([{ id: "existing-agent" }]) // existing agents
      .mockResolvedValueOnce([]); // runtimes (new ws) — empty

    postJSONMock
      .mockResolvedValueOnce({ id: "ws_fresh", name: "Fresh WS" }) // POST /api/workspaces
      .mockResolvedValueOnce(undefined) // POST /api/runtimes (register)
      .mockResolvedValueOnce({ // POST /api/studios
        studio: { name: "Fresh WS" },
        workspace: { id: "ws_fresh", name: "Fresh WS", slug: "fresh-ws" },
        agents: [{ id: "ag1", name: "Dave", email_handle: "dave" }],
        links: [],
      });

    await runInit(["--json-file", jsonPath]);

    expect(postJSONMock).toHaveBeenCalledWith("/api/runtimes", { id: "rt_orig" });
    expect(postJSONMock).toHaveBeenCalledWith("/api/studios", expect.objectContaining({
      members: expect.arrayContaining([
        expect.objectContaining({ runtime_id: "rt_orig" }),
      ]),
    }));
  });

  it("warns but continues when runtime re-fetch fails in new workspace", async () => {
    const jsonPath = writeJson("valid.json", {
      name: "Warn WS",
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }]) // runtimes (old ws)
      .mockResolvedValueOnce([{ id: "existing-agent" }]) // existing agents
      .mockRejectedValueOnce(new Error("timeout")); // runtimes (new ws) fails

    postJSONMock
      .mockResolvedValueOnce({ id: "ws_warn", name: "Warn WS" }) // POST /api/workspaces
      .mockResolvedValueOnce({ // POST /api/studios
        studio: { name: "Warn WS" },
        workspace: { id: "ws_warn", name: "Warn WS", slug: "warn-ws" },
        agents: [{ id: "ag1", name: "Eve", email_handle: "eve" }],
        links: [],
      });

    await runInit(["--json-file", jsonPath]);

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("could not refresh runtimes"));
    expect(postJSONMock).toHaveBeenCalledWith("/api/studios", expect.objectContaining({
      members: expect.arrayContaining([
        expect.objectContaining({ runtime_id: "rt1" }),
      ]),
    }));
  });

  it("warns when agent existence check fails", async () => {
    const jsonPath = writeJson("valid.json", {
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }]) // runtimes
      .mockRejectedValueOnce(new Error("network error")); // agents check fails

    postJSONMock.mockResolvedValueOnce({
      studio: { name: "" },
      workspace: { id: "ws_test", name: "Workspace", slug: "workspace" },
      agents: [{ id: "ag1", name: "X", email_handle: "x" }],
      links: [],
    });

    await runInit(["--json-file", jsonPath]);

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("could not check existing agents"));
  });

  it("errors when runtime fetch fails", async () => {
    const jsonPath = writeJson("valid.json", {
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(runInit(["--json-file", jsonPath])).rejects.toThrow("process.exit(1)");
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to fetch runtimes"));
  });

  it("errors when studios POST fails", async () => {
    const jsonPath = writeJson("valid.json", {
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }])
      .mockResolvedValueOnce([]);

    postJSONMock.mockRejectedValueOnce(new Error("500 internal server error"));

    await expect(runInit(["--json-file", jsonPath])).rejects.toThrow("process.exit(1)");
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to create workspace"));
  });

  it("selects online runtime over offline one", async () => {
    const jsonPath = writeJson("valid.json", {
      members: [{ role: "leader", instructions: "x" }],
    });

    const oldDate = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago (offline)
    const recentDate = new Date().toISOString(); // now (online)

    getJSONMock
      .mockResolvedValueOnce([
        { id: "rt_offline", machineLastSeenAt: oldDate },
        { id: "rt_online", machineLastSeenAt: recentDate },
      ])
      .mockResolvedValueOnce([]); // no existing agents

    postJSONMock.mockResolvedValueOnce({
      studio: { name: "" },
      workspace: { id: "ws_test", name: "WS", slug: "ws" },
      agents: [{ id: "ag1", name: "Y", email_handle: "y" }],
      links: [],
    });

    await runInit(["--json-file", jsonPath]);

    // The online runtime should be selected
    expect(postJSONMock).toHaveBeenCalledWith("/api/studios", expect.objectContaining({
      members: expect.arrayContaining([
        expect.objectContaining({ runtime_id: "rt_online" }),
      ]),
    }));
  });
});

describe("workspace init — self-resolve (no workspaceId)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(TMP_DIR, { recursive: true });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExit = vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`process.exit(${code})`); });

    // Return no workspaceId — triggers self-resolve path
    mockedResolvePartial.mockReturnValue({
      serverUrl: "http://localhost:3000",
      token: "test-token",
      workspaceId: undefined,
    });
    mockedLoadConfig.mockReturnValue({
      server_url: "http://localhost:3000",
      watched_workspaces: [{ id: "sp_ws1", name: "Existing", token: "test-token", status: "active" }],
    });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    mockExit.mockRestore();
  });

  function writeJson(filename: string, data: unknown) {
    const path = join(TMP_DIR, filename);
    writeFileSync(path, JSON.stringify(data));
    return path;
  }

  async function runInit(args: string[]) {
    const cmd = workspaceCommand();
    await cmd.parseAsync(["node", "workspace", "init", ...args]);
  }

  it("finds empty workspace from server and uses it", async () => {
    const jsonPath = writeJson("valid.json", {
      name: "My WS",
      members: [{ role: "leader", instructions: "You lead" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "sp_ws1", name: "Existing WS" }]) // GET /api/workspaces
      .mockResolvedValueOnce([]) // GET /api/agents?workspace_id=sp_ws1 (empty!)
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }]); // GET /api/runtimes

    postJSONMock
      .mockResolvedValueOnce({ // POST /api/studios
        studio: { name: "My WS" },
        workspace: { id: "sp_ws1", name: "My WS", slug: "my-ws" },
        agents: [{ id: "ag1", name: "Leader", email_handle: "leader" }],
      });

    await runInit(["--json-file", jsonPath]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Workspace initialized"));
  });

  it("creates new workspace when all existing ones have agents", async () => {
    const jsonPath = writeJson("valid.json", {
      name: "Fresh WS",
      members: [{ role: "leader", instructions: "You lead" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "sp_ws1", name: "Full WS" }]) // GET /api/workspaces
      .mockResolvedValueOnce([{ id: "ag_existing" }]) // GET /api/agents?workspace_id=sp_ws1 (has agents)
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }]); // GET /api/runtimes (polling)

    postJSONMock
      .mockResolvedValueOnce({ id: "sp_new", name: "Fresh WS" }) // POST /api/workspaces
      .mockResolvedValueOnce({ // POST /api/studios
        studio: { name: "Fresh WS" },
        workspace: { id: "sp_new", name: "Fresh WS", slug: "fresh-ws" },
        agents: [{ id: "ag1", name: "Leader", email_handle: "leader" }],
      });

    await runInit(["--json-file", jsonPath]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Created workspace"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Workspace initialized"));
  });

  it("creates workspace with 'Personal' name when no name configured", async () => {
    const jsonPath = writeJson("valid.json", {
      members: [{ role: "leader", instructions: "You lead" }],
    });

    getJSONMock
      .mockResolvedValueOnce([]) // GET /api/workspaces (empty — new user)
      .mockResolvedValueOnce([{ id: "rt1", machineLastSeenAt: new Date().toISOString() }]); // GET /api/runtimes

    postJSONMock
      .mockResolvedValueOnce({ id: "sp_personal", name: "Personal" }) // POST /api/workspaces
      .mockResolvedValueOnce({ // POST /api/studios
        studio: { name: "Personal" },
        workspace: { id: "sp_personal", name: "Personal", slug: "personal" },
        agents: [{ id: "ag1", name: "Leader", email_handle: "leader" }],
      });

    await runInit(["--json-file", jsonPath]);

    expect(postJSONMock).toHaveBeenCalledWith("/api/workspaces", expect.objectContaining({ name: "Personal" }));
  });

  it("polls for runtimes and errors if none appear", async () => {
    vi.useFakeTimers();
    const jsonPath = writeJson("valid.json", {
      members: [{ role: "leader", instructions: "x" }],
    });

    getJSONMock
      .mockResolvedValueOnce([{ id: "sp_ws1", name: "WS" }]) // GET /api/workspaces
      .mockResolvedValueOnce([]) // GET /api/agents (empty)
      .mockResolvedValue([]); // GET /api/runtimes (always empty)

    postJSONMock.mockResolvedValueOnce({}); // POST /api/machine-tokens/bind-workspace

    const promise = runInit(["--json-file", jsonPath]).catch((e) => e);
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1100);
    }
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("process.exit(1)");
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("No daemon registered after waiting"));
    vi.useRealTimers();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const mockState = { home: "/tmp" };

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => mockState.home };
});

vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../lib/config.js", () => ({
  configDir: () => join(tmpdir(), "alook-skill-scanner-test-config-" + process.pid),
}));

import { startSkillScanner, stopSkillScanner, parseFrontmatter } from "./skill-scanner.js";
import type { DaemonClient } from "./client.js";

describe("parseFrontmatter", () => {
  it("parses name and description", () => {
    const content = `---\nname: my-skill\ndescription: Does stuff\n---\nBody`;
    expect(parseFrontmatter(content)).toEqual({ name: "my-skill", description: "Does stuff" });
  });

  it("returns null without frontmatter", () => {
    expect(parseFrontmatter("Just text")).toBeNull();
  });
});

describe("runScan global skills syncs to all workspaces", () => {
  let tempDir: string;
  let workspacesRoot: string;
  let mockClient: { syncSkills: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skill-scan-"));
    workspacesRoot = join(tempDir, "workspaces");
    mkdirSync(workspacesRoot, { recursive: true });
    mockClient = {
      syncSkills: vi.fn(async () => ({})),
    };
  });

  afterEach(() => {
    stopSkillScanner();
    try { rmSync(tempDir, { recursive: true }); } catch { /* ok */ }
  });

  it("syncs global skills to multiple workspaces", async () => {
    const home = join(tempDir, "home");
    mockState.home = home;

    const skillDir = join(home, ".claude", "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: test-skill\ndescription: A test\n---\nContent");

    const ws1Dir = join(workspacesRoot, "ws1", "agent1");
    const ws2Dir = join(workspacesRoot, "ws2", "agent2");
    mkdirSync(join(ws1Dir, "workdir"), { recursive: true });
    mkdirSync(join(ws2Dir, "workdir"), { recursive: true });

    startSkillScanner(mockClient as unknown as DaemonClient, {
      workspacesRoot,
      workspaces: [
        { workspaceId: "ws1", token: "token-ws1", agentIds: ["agent1"] },
        { workspaceId: "ws2", token: "token-ws2", agentIds: ["agent2"] },
      ],
      runtimes: ["claude"],
      daemonId: "test-daemon",
    }, 999_999);

    await new Promise((r) => setTimeout(r, 100));

    const globalCalls = mockClient.syncSkills.mock.calls.filter(
      (args) => (args[1] as { scope: string }).scope === "global"
    );
    expect(globalCalls.length).toBe(2);

    const tokens = globalCalls.map((args) => args[0] as string);
    expect(tokens).toContain("token-ws1");
    expect(tokens).toContain("token-ws2");
  });

  it("does nothing with empty workspaces array", () => {
    startSkillScanner(mockClient as unknown as DaemonClient, {
      workspacesRoot,
      workspaces: [],
      runtimes: ["claude"],
      daemonId: "test-daemon",
    }, 999_999);

    expect(mockClient.syncSkills).not.toHaveBeenCalled();
  });

  it("scans codex and opencode runtimes", async () => {
    const home = join(tempDir, "home-multi");
    mockState.home = home;

    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode", "commands"), { recursive: true });

    const wsDir = join(workspacesRoot, "ws1", "agent1");
    mkdirSync(join(wsDir, "workdir"), { recursive: true });

    startSkillScanner(mockClient as unknown as DaemonClient, {
      workspacesRoot,
      workspaces: [
        { workspaceId: "ws1", token: "token-ws1", agentIds: ["agent1"] },
      ],
      runtimes: ["codex", "opencode"],
      daemonId: "test-daemon-multi",
    }, 999_999);

    await new Promise((r) => setTimeout(r, 100));

    const globalCalls = mockClient.syncSkills.mock.calls.filter(
      (args) => (args[1] as { scope: string }).scope === "global"
    );
    expect(globalCalls.length).toBe(2);
  });
});

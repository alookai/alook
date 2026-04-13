import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepare } from "../index.js";
import type { Task } from "../../types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    agentId: "a1",
    runtimeId: "rt1",
    conversationId: "c1",
    workspaceId: "ws1",
    prompt: "do something",
    status: "running",
    priority: 0,
    createdAt: "2026-01-01T00:00:00Z",
    agent: { name: "test-agent", instructions: "Be helpful." },
    ...overrides,
  };
}

describe("prepare", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `execenv-prepare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates workdir directory", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task, "claude");

    expect(existsSync(result.workDir)).toBe(true);
  });

  it("always constructs {root}/{wsId}/{agentId}/workdir", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task, "claude");

    expect(result.workDir).toBe(join(root, "ws1", "a1", "workdir"));
  });

  it("on existing workdir overwrites instruction file with fresh data", () => {
    const task1 = makeTask({ agent: { name: "a", instructions: "Old" } });
    prepare({ workspacesRoot: root }, task1, "claude");

    const task2 = makeTask({ agent: { name: "a", instructions: "New" } });
    const result = prepare({ workspacesRoot: root }, task2, "claude");

    const content = readFileSync(join(result.workDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("New");
    expect(content).not.toContain("Old");
  });

  it("returns logFile path at {root}/{wsId}/{agentId}/agent.log", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task, "claude");

    expect(result.logFile).toBe(join(root, "ws1", "a1", "agent.log"));
  });

  it("returns env with all expected keys", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task, "claude");

    expect(result.env).toEqual({
      ALOOK_WORKSPACE_ID: "ws1",
      ALOOK_AGENT_ID: "a1",
      ALOOK_TASK_ID: "t1",
      ALOOK_CONVERSATION_ID: "c1",
      ALOOK_HEALTH_PORT: expect.any(String),
    });
  });
});

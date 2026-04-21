import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync, lstatSync, readlinkSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepare } from "../index.js";
import { CANONICAL_FILE } from "../context.js";
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
    const result = prepare({ workspacesRoot: root }, task);

    expect(existsSync(result.workDir)).toBe(true);
  });

  it("always constructs {root}/{wsId}/{agentId}/workdir", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task);

    expect(result.workDir).toBe(join(root, "ws1", "a1", "workdir"));
  });

  it("creates AGENTS.md and CLAUDE.md symlink", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task);

    const agentsPath = join(result.workDir, CANONICAL_FILE);
    expect(existsSync(agentsPath)).toBe(true);
    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("Be helpful.");

    const claudePath = join(result.workDir, "CLAUDE.md");
    expect(lstatSync(claudePath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudePath)).toBe(CANONICAL_FILE);
  });

  it("called twice with same content — AGENTS.md mtime unchanged", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task);

    const agentsPath = join(result.workDir, CANONICAL_FILE);
    const mtime1 = statSync(agentsPath).mtimeMs;

    // Small delay to ensure mtime would differ if file were rewritten
    const start = Date.now();
    while (Date.now() - start < 50) { /* busy wait */ }

    prepare({ workspacesRoot: root }, task);
    const mtime2 = statSync(agentsPath).mtimeMs;

    expect(mtime2).toBe(mtime1);
  });

  it("creates .context_timeline/ directory inside workdir", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task);

    const timelineDir = join(result.workDir, ".context_timeline");
    expect(existsSync(timelineDir)).toBe(true);
  });

  it("returns timelineDir in result", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task);

    expect(result.timelineDir).toBe(join(result.workDir, ".context_timeline"));
  });

  it("returns env with all expected keys", () => {
    const task = makeTask();
    const result = prepare({ workspacesRoot: root }, task);

    expect(result.env).toEqual({
      ALOOK_WORKSPACE_ID: "ws1",
      ALOOK_AGENT_ID: "a1",
      ALOOK_TASK_ID: "t1",
      ALOOK_CONVERSATION_ID: "c1",
      ALOOK_HEALTH_PORT: expect.any(String),
    });
  });
});

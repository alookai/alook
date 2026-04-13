import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildInstructionContent, writeInstructionFile, cleanStaleProviderFiles } from "../context.js";
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
    agent: { name: "test-agent", instructions: "Be helpful and concise." },
    ...overrides,
  };
}

describe("buildInstructionContent", () => {
  it("assembles system section + agent instructions section", () => {
    const task = makeTask();
    const content = buildInstructionContent(task);

    expect(content).toContain("# Alook Agent Instructions");
    expect(content).toContain("## System");
    expect(content).toContain("SYSPROMPT TODO FOR ALOOK");
    expect(content).toContain("## Agent Instructions");
    expect(content).toContain("Be helpful and concise.");
  });

  it("with task.agent undefined — omits agent instructions section, keeps system section", () => {
    const task = makeTask({ agent: undefined });
    const content = buildInstructionContent(task);

    expect(content).toContain("## System");
    expect(content).toContain("SYSPROMPT TODO FOR ALOOK");
    expect(content).not.toContain("## Agent Instructions");
  });

  it("with empty instructions string — omits agent instructions section, keeps system section", () => {
    const task = makeTask({ agent: { name: "test", instructions: "" } });
    const content = buildInstructionContent(task);

    expect(content).toContain("## System");
    expect(content).not.toContain("## Agent Instructions");
  });
});

describe("writeInstructionFile", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = join(tmpdir(), `execenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("for Claude — writes CLAUDE.md with assembled content", () => {
    const task = makeTask();
    writeInstructionFile(workDir, task, "claude");

    const content = readFileSync(join(workDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Alook Agent Instructions");
    expect(content).toContain("Be helpful and concise.");
  });

  it("for OpenCode — writes AGENTS.md with assembled content", () => {
    const task = makeTask();
    writeInstructionFile(workDir, task, "opencode");

    const content = readFileSync(join(workDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("# Alook Agent Instructions");
    expect(content).toContain("Be helpful and concise.");
  });

  it("for Codex — writes AGENTS.md with assembled content", () => {
    const task = makeTask();
    writeInstructionFile(workDir, task, "codex");

    const content = readFileSync(join(workDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("# Alook Agent Instructions");
    expect(content).toContain("Be helpful and concise.");
  });

  it("overwrites existing file on re-run with new instructions", () => {
    const task1 = makeTask({ agent: { name: "a", instructions: "Old instructions" } });
    writeInstructionFile(workDir, task1, "claude");

    const task2 = makeTask({ agent: { name: "a", instructions: "New instructions" } });
    writeInstructionFile(workDir, task2, "claude");

    const content = readFileSync(join(workDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("New instructions");
    expect(content).not.toContain("Old instructions");
  });
});

describe("cleanStaleProviderFiles", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = join(tmpdir(), `execenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("for Claude — removes AGENTS.md if present", () => {
    writeFileSync(join(workDir, "AGENTS.md"), "old");
    cleanStaleProviderFiles(workDir, "claude");

    expect(existsSync(join(workDir, "AGENTS.md"))).toBe(false);
  });

  it("for OpenCode — removes CLAUDE.md if present", () => {
    writeFileSync(join(workDir, "CLAUDE.md"), "old");
    cleanStaleProviderFiles(workDir, "opencode");

    expect(existsSync(join(workDir, "CLAUDE.md"))).toBe(false);
  });

  it("for Codex — removes CLAUDE.md if present", () => {
    writeFileSync(join(workDir, "CLAUDE.md"), "old");
    cleanStaleProviderFiles(workDir, "codex");

    expect(existsSync(join(workDir, "CLAUDE.md"))).toBe(false);
  });

  it("does not throw when file does not exist", () => {
    expect(() => cleanStaleProviderFiles(workDir, "claude")).not.toThrow();
  });
});

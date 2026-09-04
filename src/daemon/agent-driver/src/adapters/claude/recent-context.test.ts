import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverClaudeRecentContext, readClaudeProjectPath } from "./recent-context.js";

const projectPath = (...segments: string[]) => path.join(path.parse(process.cwd()).root, "projects", ...segments);

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function writeSession(filePath: string, cwd: string, modifiedAt: string): void {
  writeFileSync(filePath, `{\"type\":\"queue-operation\"}\n{\"cwd\":${JSON.stringify(cwd)}}\n`);
  const date = new Date(modifiedAt);
  utimesSync(filePath, date, date);
}

describe("Claude recent-context discovery", () => {
  it("uses CLAUDE_CONFIG_DIR when the projects root is not injected", async () => {
    const configRoot = mkdtempSync(path.join(tmpdir(), "claude-config-root-"));
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configRoot;
    try {
      await expect(discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      })).resolves.toEqual({
        sessionFiles: { capability: "supported", items: [] },
        recentProjects: [],
      });
    } finally {
      if (original == null) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it("treats a missing projects root as empty", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "claude-missing-root-"));
    try {
      await expect(discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { projectsRoot: path.join(parent, "missing") })).resolves.toEqual({
        sessionFiles: { capability: "supported", items: [] },
        recentProjects: [],
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects when the projects root cannot be read as a directory", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "claude-invalid-root-"));
    const projectsRoot = path.join(parent, "projects.jsonl");
    writeFileSync(projectsRoot, "not a directory\n");
    try {
      await expect(discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { projectsRoot })).rejects.toBeInstanceOf(Error);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("distinguishes a vanished session file from another read failure", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "claude-read-error-"));
    try {
      await expect(readClaudeProjectPath(path.join(parent, "missing.jsonl"))).resolves.toBeNull();
      await expect(readClaudeProjectPath(parent)).rejects.toBeInstanceOf(Error);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("skips a vanished project directory and rejects other nested directory errors", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-nested-errors-"));
    const project = path.join(root, "encoded-project");
    mkdirSync(project);
    const rootEntries = readdirSync(root, { withFileTypes: true });
    try {
      await expect(discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, {
        projectsRoot: root,
        readDirectory: async (directory) => {
          if (directory === root) return rootEntries;
          throw fsError("ENOENT");
        },
      })).resolves.toEqual({
        sessionFiles: { capability: "supported", items: [] },
        recentProjects: [],
      });
      await expect(discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, {
        projectsRoot: root,
        readDirectory: async (directory) => {
          if (directory === root) return rootEntries;
          throw fsError("EACCES");
        },
      })).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles candidate stat disappearance without hiding other stat errors", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-stat-errors-"));
    const project = path.join(root, "encoded-project");
    mkdirSync(project);
    writeFileSync(path.join(project, "session.jsonl"), "{}\n");
    const readDirectory = async (directory: string) => readdirSync(directory, { withFileTypes: true });
    try {
      await expect(discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { projectsRoot: root, readDirectory, statPath: async () => { throw fsError("ENOENT"); } }))
        .resolves.toEqual({ sessionFiles: { capability: "supported", items: [] }, recentProjects: [] });
      await expect(discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { projectsRoot: root, readDirectory, statPath: async () => { throw fsError("EIO"); } }))
        .rejects.toMatchObject({ code: "EIO" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans root JSONL only and applies separate session/project Top-K values", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-discovery-"));
    const projectA = path.join(root, "encoded-a");
    const projectB = path.join(root, "encoded-b");
    mkdirSync(path.join(projectA, "subagents"), { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const sessionA = path.join(projectA, "a.jsonl");
    const sessionB = path.join(projectB, "b.jsonl");
    writeSession(sessionA, projectPath("a"), "2026-01-03T00:00:00Z");
    writeSession(sessionB, projectPath("b"), "2026-01-01T00:00:00Z");
    writeSession(path.join(projectA, "subagents", "child.jsonl"), projectPath("child"), "2026-01-04T00:00:00Z");
    try {
      const result = await discoverClaudeRecentContext({
        recentSessionFilesTopK: 2,
        recentProjectsTopK: 1,
      }, { projectsRoot: root });
      expect(result.sessionFiles.items.map((item) => item.sessionFilePath)).toEqual([sessionA, sessionB]);
      expect(result.recentProjects).toEqual([{
        projectPath: projectPath("a"),
        modifiedAt: "2026-01-03T00:00:00.000Z",
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips malformed and symlink entries while retaining a deleted project path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-discovery-invalid-"));
    const project = path.join(root, "encoded-project");
    mkdirSync(project);
    const malformed = path.join(project, "malformed.jsonl");
    const session = path.join(project, "root.jsonl");
    const linked = path.join(project, "linked.jsonl");
    const deletedProject = projectPath("deleted", "project");
    writeFileSync(malformed, "not-json\n");
    const newest = new Date("2026-01-04T00:00:00Z");
    utimesSync(malformed, newest, newest);
    writeSession(session, deletedProject, "2026-01-03T00:00:00Z");
    symlinkSync(session, linked);
    try {
      const result = await discoverClaudeRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { projectsRoot: root });
      expect(result.sessionFiles.items[0]?.sessionFilePath).toBe(session);
      expect(result.recentProjects[0]?.projectPath).toBe(deletedProject);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

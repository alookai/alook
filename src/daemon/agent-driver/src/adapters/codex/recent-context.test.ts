import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFirstLine } from "../../internal/recent-context.js";
import { resolveCodexHomeRootFromEnv } from "./home.js";
import { discoverCodexRecentContext } from "./recent-context.js";

const projectPath = (...segments: string[]) => path.join(path.parse(process.cwd()).root, "projects", ...segments);

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function writeRollout(filePath: string, payload: Record<string, unknown>, modifiedAt: string): void {
  writeFileSync(filePath, `${JSON.stringify({ type: "session_meta", payload })}\n{"type":"event_msg","secret":"not-read"}\n`);
  const date = new Date(modifiedAt);
  utimesSync(filePath, date, date);
}

describe("Codex recent-context discovery", () => {
  it("uses the canonical Codex home fallback for an empty CODEX_HOME", () => {
    expect(resolveCodexHomeRootFromEnv(
      { CODEX_HOME: "" },
      { defaultHomeDir: "/users/tester" },
    )).toBe(path.join("/users/tester", ".codex"));
  });

  it("uses CODEX_HOME when the sessions root is not injected", async () => {
    const codexRoot = mkdtempSync(path.join(tmpdir(), "codex-home-root-"));
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexRoot;
    try {
      await expect(discoverCodexRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      })).resolves.toEqual({
        sessionFiles: { capability: "supported", items: [] },
        recentProjects: [],
      });
    } finally {
      if (original == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = original;
      rmSync(codexRoot, { recursive: true, force: true });
    }
  });

  it("treats a missing sessions root as empty", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "codex-missing-root-"));
    try {
      await expect(discoverCodexRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { sessionsRoot: path.join(parent, "missing") })).resolves.toEqual({
        sessionFiles: { capability: "supported", items: [] },
        recentProjects: [],
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects when the sessions root cannot be read as a directory", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "codex-invalid-root-"));
    const sessionsRoot = path.join(parent, "sessions.jsonl");
    writeFileSync(sessionsRoot, "not a directory\n");
    try {
      await expect(discoverCodexRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { sessionsRoot })).rejects.toBeInstanceOf(Error);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not hide a candidate stat failure", async () => {
    const sessionsRoot = mkdtempSync(path.join(tmpdir(), "codex-stat-error-"));
    writeFileSync(path.join(sessionsRoot, "session.jsonl"), "{}\n");
    try {
      await expect(discoverCodexRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, {
        sessionsRoot,
        readDirectory: async (directory) => readdirSync(directory, { withFileTypes: true }),
        statPath: async () => { throw fsError("EIO"); },
      })).rejects.toMatchObject({ code: "EIO" });
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("scans rollouts newest-first, excludes subagents, and stops at both bounds", async () => {
    const sessionsRoot = mkdtempSync(path.join(tmpdir(), "codex-discovery-"));
    const day = path.join(sessionsRoot, "2026", "01", "03");
    mkdirSync(day, { recursive: true });
    const malformed = path.join(day, "malformed.jsonl");
    const child = path.join(day, "child.jsonl");
    const newestRoot = path.join(day, "root-new.jsonl");
    const oldRoot = path.join(day, "root-old.jsonl");
    const oldestRoot = path.join(day, "root-oldest.jsonl");
    writeFileSync(malformed, "not-json\n");
    const malformedDate = new Date("2026-01-05T00:00:00Z");
    utimesSync(malformed, malformedDate, malformedDate);
    writeRollout(child, { cwd: projectPath("child"), source: { subagent: "review" } }, "2026-01-04T00:00:00Z");
    writeRollout(newestRoot, { cwd: projectPath("a"), source: "vscode" }, "2026-01-03T00:00:00Z");
    writeRollout(oldRoot, { cwd: projectPath("b"), source: "cli" }, "2026-01-01T00:00:00Z");
    writeRollout(oldestRoot, { cwd: projectPath("c"), source: "cli" }, "2025-12-31T00:00:00Z");
    const reads: string[] = [];
    const readHeader = vi.fn(async (filePath: string) => {
      reads.push(filePath);
      return readFirstLine(filePath);
    });
    try {
      const result = await discoverCodexRecentContext({
        recentSessionFilesTopK: 2,
        recentProjectsTopK: 1,
      }, { sessionsRoot, readHeader });
      expect(result.sessionFiles.items.map((item) => item.sessionFilePath)).toEqual([newestRoot, oldRoot]);
      expect(result.recentProjects).toEqual([{
        projectPath: projectPath("a"),
        modifiedAt: "2026-01-03T00:00:00.000Z",
      }]);
      expect(reads).toEqual([malformed, child, newestRoot, oldRoot]);
      expect(reads).not.toContain(oldestRoot);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("recognizes current and compatibility child markers", async () => {
    const sessionsRoot = mkdtempSync(path.join(tmpdir(), "codex-child-markers-"));
    const current = path.join(sessionsRoot, "current.jsonl");
    const compatibility = path.join(sessionsRoot, "compatibility.jsonl");
    const root = path.join(sessionsRoot, "root.jsonl");
    writeRollout(current, { cwd: projectPath("child-a"), source: { subAgent: "review" } }, "2026-01-04T00:00:00Z");
    writeRollout(compatibility, { cwd: projectPath("child-b"), parent_thread_id: "parent" }, "2026-01-03T00:00:00Z");
    writeRollout(root, { cwd: projectPath("root"), source: "cli" }, "2026-01-02T00:00:00Z");
    try {
      const result = await discoverCodexRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { sessionsRoot });
      expect(result.sessionFiles.items[0]?.sessionFilePath).toBe(root);
      expect(result.recentProjects[0]?.projectPath).toBe(projectPath("root"));
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });
});

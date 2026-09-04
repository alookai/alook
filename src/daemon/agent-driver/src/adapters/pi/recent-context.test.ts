import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFirstLine } from "../../internal/recent-context.js";
import { discoverPiRecentContext } from "./recent-context.js";

const projectPath = (...segments: string[]) => path.join(path.parse(process.cwd()).root, "projects", ...segments);

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function writeSession(filePath: string, header: Record<string, unknown>, modifiedAt: string): void {
  writeFileSync(filePath, `${JSON.stringify(header)}\n{\"type\":\"message\",\"secret\":\"not-read\"}\n`);
  const date = new Date(modifiedAt);
  utimesSync(filePath, date, date);
}

describe("Pi recent-context discovery", () => {
  it("uses PI_CODING_AGENT_DIR when the sessions root is not injected", async () => {
    const piRoot = mkdtempSync(path.join(tmpdir(), "pi-agent-root-"));
    const originalAgentRoot = process.env.PI_CODING_AGENT_DIR;
    const originalSessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = piRoot;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      await expect(discoverPiRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      })).resolves.toEqual({
        sessionFiles: { capability: "supported", items: [] },
        recentProjects: [],
      });
    } finally {
      if (originalAgentRoot == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentRoot;
      if (originalSessionRoot == null) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionRoot;
      rmSync(piRoot, { recursive: true, force: true });
    }
  });

  it("treats a missing sessions root as empty", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "pi-missing-root-"));
    try {
      await expect(discoverPiRecentContext({
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
    const parent = mkdtempSync(path.join(tmpdir(), "pi-invalid-root-"));
    const sessionsRoot = path.join(parent, "sessions.jsonl");
    writeFileSync(sessionsRoot, "not a directory\n");
    try {
      await expect(discoverPiRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, { sessionsRoot })).rejects.toBeInstanceOf(Error);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("skips a vanished project directory and rejects other nested directory errors", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-nested-errors-"));
    const project = path.join(root, "encoded-project");
    mkdirSync(project);
    const rootEntries = readdirSync(root, { withFileTypes: true });
    try {
      await expect(discoverPiRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, {
        sessionsRoot: root,
        readDirectory: async (directory) => {
          if (directory === root) return rootEntries;
          throw fsError("ENOENT");
        },
      })).resolves.toEqual({
        sessionFiles: { capability: "supported", items: [] },
        recentProjects: [],
      });
      await expect(discoverPiRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, {
        sessionsRoot: root,
        readDirectory: async (directory) => {
          if (directory === root) return rootEntries;
          throw fsError("EACCES");
        },
      })).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not hide a candidate stat failure", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-stat-error-"));
    const project = path.join(root, "encoded-project");
    mkdirSync(project);
    writeFileSync(path.join(project, "session.jsonl"), "{}\n");
    try {
      await expect(discoverPiRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      }, {
        sessionsRoot: root,
        readDirectory: async (directory) => readdirSync(directory, { withFileTypes: true }),
        statPath: async () => { throw fsError("EIO"); },
      })).rejects.toMatchObject({ code: "EIO" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads headers newest-first, skips children, and stops once both bounds are filled", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-discovery-"));
    const project = path.join(root, "encoded-project");
    mkdirSync(project);
    const malformed = path.join(project, "malformed.jsonl");
    const child = path.join(project, "child.jsonl");
    const newestRoot = path.join(project, "root-new.jsonl");
    const oldRoot = path.join(project, "root-old.jsonl");
    writeFileSync(malformed, "not-json\n");
    const malformedDate = new Date("2026-01-05T00:00:00Z");
    utimesSync(malformed, malformedDate, malformedDate);
    writeSession(child, { type: "session", cwd: projectPath("child"), parentSession: "parent.jsonl" }, "2026-01-04T00:00:00Z");
    writeSession(newestRoot, { type: "session", cwd: projectPath("a") }, "2026-01-03T00:00:00Z");
    writeSession(oldRoot, { type: "session", cwd: projectPath("b") }, "2026-01-01T00:00:00Z");
    const reads: string[] = [];
    const readHeader = vi.fn(async (filePath: string) => {
      reads.push(filePath);
      return readFirstLine(filePath);
    });
    try {
      const result = await discoverPiRecentContext({
        recentSessionFilesTopK: 2,
        recentProjectsTopK: 1,
      }, { sessionsRoot: root, readHeader });
      expect(result.sessionFiles.items.map((item) => item.sessionFilePath)).toEqual([newestRoot, oldRoot]);
      expect(result.recentProjects).toHaveLength(1);
      expect(reads).toEqual([malformed, child, newestRoot, oldRoot]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats PI_CODING_AGENT_SESSION_DIR as a direct session directory", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pi-custom-session-dir-"));
    const child = path.join(directory, "child.jsonl");
    const root = path.join(directory, "root.jsonl");
    writeSession(child, { type: "session", cwd: projectPath("child"), parentSession: "parent.jsonl" }, "2026-01-04T00:00:00Z");
    writeSession(root, { type: "session", cwd: projectPath("root") }, "2026-01-03T00:00:00Z");
    const original = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
    try {
      const result = await discoverPiRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      });
      expect(result.sessionFiles.items).toEqual([{
        sessionFilePath: root,
        projectPath: projectPath("root"),
        modifiedAt: "2026-01-03T00:00:00.000Z",
      }]);
      expect(result.recentProjects).toEqual([{
        projectPath: projectPath("root"),
        modifiedAt: "2026-01-03T00:00:00.000Z",
      }]);
    } finally {
      if (original == null) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = original;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("expands a tilde in PI_CODING_AGENT_SESSION_DIR", async () => {
    const directory = mkdtempSync(path.join(homedir(), ".pi-custom-session-dir-"));
    const root = path.join(directory, "root.jsonl");
    writeSession(root, { type: "session", cwd: projectPath("root") }, "2026-01-03T00:00:00Z");
    const original = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = `~/${path.basename(directory)}`;
    try {
      const result = await discoverPiRecentContext({
        recentSessionFilesTopK: 1,
        recentProjectsTopK: 1,
      });
      expect(result.sessionFiles.items[0]?.sessionFilePath).toBe(root);
    } finally {
      if (original == null) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = original;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

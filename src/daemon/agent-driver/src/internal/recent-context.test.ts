import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidRecentContextTopK,
  readFirstLine,
  RecentContextCollector,
  sanitizeRecentContextData,
} from "./recent-context.js";

const absolutePath = (...segments: string[]) => path.join(path.parse(process.cwd()).root, ...segments);

describe("recent context normalization", () => {
  it("validates bounded counts without coercion", () => {
    expect(isValidRecentContextTopK(0)).toBe(true);
    expect(isValidRecentContextTopK(3)).toBe(true);
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isValidRecentContextTopK(value)).toBe(false);
    }
  });

  it("applies independent limits and deduplicates projects at their newest time", () => {
    const sessionOne = absolutePath("sessions", "one");
    const sessionTwo = absolutePath("sessions", "two");
    const projectA = absolutePath("projects", "a");
    const collector = new RecentContextCollector({
      recentSessionFilesTopK: 2,
      recentProjectsTopK: 1,
    }, "supported");
    collector.add({ sessionFilePath: sessionOne, projectPath: projectA, modifiedAt: "2026-01-02T00:00:00Z" });
    collector.add({ sessionFilePath: sessionTwo, projectPath: projectA, modifiedAt: "2026-01-01T00:00:00Z" });
    collector.add({ sessionFilePath: "relative", projectPath: absolutePath("projects", "b"), modifiedAt: "invalid" });

    expect(collector.satisfied).toBe(true);
    expect(collector.result()).toEqual({
      sessionFiles: {
        capability: "supported",
        items: [
          { sessionFilePath: sessionOne, projectPath: projectA, modifiedAt: "2026-01-02T00:00:00.000Z" },
          { sessionFilePath: sessionTwo, projectPath: projectA, modifiedAt: "2026-01-01T00:00:00.000Z" },
        ],
      },
      recentProjects: [
        { projectPath: projectA, modifiedAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
  });

  it("normalizes numeric timestamps", () => {
    const project = absolutePath("projects", "numeric-time");
    const collector = new RecentContextCollector({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, "supported");
    collector.add({ projectPath: project, modifiedAt: Date.parse("2026-01-02T00:00:00Z") });

    expect(collector.result().recentProjects).toEqual([{
      projectPath: project,
      modifiedAt: "2026-01-02T00:00:00.000Z",
    }]);
  });

  it("ignores timestamps with unsupported value types", () => {
    const collector = new RecentContextCollector({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, "supported");
    collector.add({
      projectPath: absolutePath("projects", "invalid-time-type"),
      modifiedAt: true,
    });

    expect(collector.result().recentProjects).toEqual([]);
  });

  it("reads only the first JSONL line", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recent-context-line-"));
    const filePath = path.join(directory, "session.jsonl");
    try {
      writeFileSync(filePath, "{\"type\":\"session\"}\nthis line must not be parsed\n");
      await expect(readFirstLine(filePath)).resolves.toBe("{\"type\":\"session\"}");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a concurrently missing file as absent and propagates other read errors", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "recent-context-read-errors-"));
    try {
      await expect(readFirstLine(path.join(directory, "missing.jsonl"))).resolves.toBeNull();
      await expect(readFirstLine(directory)).rejects.toBeInstanceOf(Error);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("strips adapter-only fields and reapplies both public bounds", () => {
    const sessionOne = absolutePath("sessions", "one");
    const sessionTwo = absolutePath("sessions", "two");
    const projectOne = absolutePath("projects", "one");
    const projectTwo = absolutePath("projects", "two");
    const sanitized = sanitizeRecentContextData({
      secret: "drop",
      sessionFiles: {
        capability: "supported",
        items: [
          { sessionFilePath: sessionOne, projectPath: projectOne, modifiedAt: "2026-01-02", preview: "drop" },
          { sessionFilePath: sessionTwo, projectPath: projectTwo, modifiedAt: "2026-01-01" },
        ],
      },
      recentProjects: [
        { projectPath: projectOne, modifiedAt: "2026-01-02", title: "drop" },
        { projectPath: projectTwo, modifiedAt: "2026-01-01" },
      ],
    }, { recentSessionFilesTopK: 1, recentProjectsTopK: 1 });
    expect(sanitized).toEqual({
      sessionFiles: {
        capability: "supported",
        items: [{ sessionFilePath: sessionOne, projectPath: projectOne, modifiedAt: "2026-01-02T00:00:00.000Z" }],
      },
      recentProjects: [{ projectPath: projectOne, modifiedAt: "2026-01-02T00:00:00.000Z" }],
    });
  });

  it("takes the true newest items from an unordered extension adapter result", () => {
    const oldSession = absolutePath("sessions", "old");
    const newSession = absolutePath("sessions", "new");
    const oldProject = absolutePath("projects", "old");
    const newProject = absolutePath("projects", "new");
    const sanitized = sanitizeRecentContextData({
      sessionFiles: {
        capability: "supported",
        items: [
          { sessionFilePath: oldSession, projectPath: oldProject, modifiedAt: "2026-01-01" },
          { sessionFilePath: newSession, projectPath: newProject, modifiedAt: "2026-01-03" },
        ],
      },
      recentProjects: [
        { projectPath: oldProject, modifiedAt: "2026-01-01" },
        { projectPath: newProject, modifiedAt: "2026-01-03" },
        { projectPath: newProject, modifiedAt: "2026-01-02" },
      ],
    }, { recentSessionFilesTopK: 1, recentProjectsTopK: 1 });
    expect(sanitized).toEqual({
      sessionFiles: {
        capability: "supported",
        items: [{ sessionFilePath: newSession, projectPath: newProject, modifiedAt: "2026-01-03T00:00:00.000Z" }],
      },
      recentProjects: [{ projectPath: newProject, modifiedAt: "2026-01-03T00:00:00.000Z" }],
    });
  });

  it("rejects malformed session-file containers", () => {
    expect(sanitizeRecentContextData({
      sessionFiles: null,
      recentProjects: [],
    }, { recentSessionFilesTopK: 1, recentProjectsTopK: 1 })).toBeNull();
    expect(sanitizeRecentContextData({
      sessionFiles: { capability: "invalid", items: [] },
      recentProjects: [],
    }, { recentSessionFilesTopK: 1, recentProjectsTopK: 1 })).toBeNull();
  });
});

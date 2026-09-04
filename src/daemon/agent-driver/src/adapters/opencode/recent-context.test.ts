import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnedProcessHandle } from "../../internal/adapter.js";
import { discoverOpenCodeRecentContext } from "./recent-context.js";
import path from "node:path";

const projectPath = (...segments: string[]) => path.join(path.parse(process.cwd()).root, "projects", ...segments);
const killTreeMocks = vi.hoisted(() => ({ killProcessTree: vi.fn(async () => {}) }));

vi.mock("../../internal/killTree.js", async () => {
  const actual = await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js");
  return { ...actual, killProcessTree: killTreeMocks.killProcessTree };
});

function fakeCommandProcess(output?: string | readonly Buffer[], delayMs = 0): SpawnedProcessHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null,
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as SpawnedProcessHandle;
  if (output !== undefined) {
    setTimeout(() => {
      const chunks = typeof output === "string" ? [output] : output;
      for (const chunk of chunks) stdout.write(chunk);
      (process as { exitCode: number | null }).exitCode = 0;
      (process as unknown as EventEmitter).emit("close", 0, null);
    }, delayMs);
  }
  return process;
}

describe("OpenCode recent-context discovery", () => {
  beforeEach(() => killTreeMocks.killProcessTree.mockClear());

  it("decodes string and Uint8Array stdout chunks and flushes stream end", async () => {
    const expectedProjectPath = projectPath("mixed-chunks");
    const payload = JSON.stringify([{
      directory: expectedProjectPath,
      updated: Date.parse("2026-01-01T00:00:00Z"),
    }]);
    const process = fakeCommandProcess();
    setTimeout(() => {
      const stdout = process.stdout as unknown as EventEmitter;
      stdout.emit("data", payload.slice(0, 1));
      stdout.emit("data", new Uint8Array(Buffer.from(payload.slice(1))));
      stdout.emit("end");
      (process as unknown as EventEmitter).emit("close", 0, null);
    }, 0);
    const result = await discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => process, cleanup: async () => {} });
    expect(result.recentProjects[0]?.projectPath).toBe(expectedProjectPath);
  });

  it("preserves a UTF-8 project path split across stdout chunks", async () => {
    const unicodeProjectPath = projectPath("中文-🚀");
    const payload = Buffer.from(JSON.stringify([
      { directory: unicodeProjectPath, updated: Date.parse("2026-01-01T00:00:00Z") },
    ]));
    const markerAt = payload.indexOf(Buffer.from("中"));
    expect(markerAt).toBeGreaterThanOrEqual(0);
    const result = await discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, {
      spawn: () => fakeCommandProcess([
        payload.subarray(0, markerAt + 1),
        payload.subarray(markerAt + 1),
      ]),
      cleanup: async () => {},
    });
    expect(result.recentProjects[0]?.projectPath).toBe(unicodeProjectPath);
  });

  it("uses an async bounded global list and returns deduplicated projects only", async () => {
    const spawn = vi.fn((_command: string, _args: string[]) => fakeCommandProcess(JSON.stringify([
      { id: "one", directory: projectPath("a"), updated: Date.parse("2026-01-03T00:00:00Z") },
      { id: "two", directory: projectPath("a"), updated: Date.parse("2026-01-02T00:00:00Z") },
      { id: "three", directory: projectPath("b"), updated: Date.parse("2026-01-01T00:00:00Z") },
    ])));
    const cleanup = vi.fn(async () => {});
    const result = await discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 9,
      recentProjectsTopK: 2,
      command: "/bin/opencode-test",
    }, { spawn, cleanup });
    expect(spawn).toHaveBeenCalledWith("/bin/opencode-test", [
      "session", "list", "--format", "json", "--max-count", "20", "--pure",
    ], expect.objectContaining({ stdin: "ignore" }));
    expect(result.sessionFiles).toEqual({ capability: "unavailable", items: [] });
    expect(result.recentProjects).toEqual([
      { projectPath: projectPath("a"), modifiedAt: "2026-01-03T00:00:00.000Z" },
      { projectPath: projectPath("b"), modifiedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("fails closed on invalid JSON", async () => {
    await expect(discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => fakeCommandProcess("not-json"), cleanup: async () => {} }))
      .rejects.toThrow("invalid JSON");
  });

  it("fails closed on a non-array response", async () => {
    await expect(discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => fakeCommandProcess("{}"), cleanup: async () => {} }))
      .rejects.toThrow("invalid response");
  });

  it("expands the bounded prefix when more than 10K recent sessions share one project", async () => {
    const sessions = [
      ...Array.from({ length: 21 }, (_, index) => ({
        id: `a-${index}`,
        directory: projectPath("a"),
        updated: Date.parse("2026-01-03T00:00:00Z") - index,
      })),
      { id: "b", directory: projectPath("b"), updated: Date.parse("2026-01-01T00:00:00Z") },
    ];
    const requestedPrefixes: number[] = [];
    const spawn = vi.fn((_command: string, args: string[]) => {
      const maxCount = Number(args[args.indexOf("--max-count") + 1]);
      requestedPrefixes.push(maxCount);
      return fakeCommandProcess(JSON.stringify(sessions.slice(0, maxCount)));
    });

    const result = await discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 2,
    }, { spawn, cleanup: async () => {} });
    expect(requestedPrefixes).toEqual([20, 40]);
    expect(result.recentProjects.map((item) => item.projectPath)).toEqual([projectPath("a"), projectPath("b")]);
  });

  it("keeps the event loop live while a listing is pending", async () => {
    let timerAdvanced = false;
    const discovery = discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, {
      spawn: () => fakeCommandProcess(JSON.stringify([
        { directory: projectPath("a"), updated: Date.parse("2026-01-01T00:00:00Z") },
      ]), 10),
      cleanup: async () => {},
    });
    setTimeout(() => { timerAdvanced = true; }, 0);
    await discovery;
    expect(timerAdvanced).toBe(true);
  });

  it("times out a pending process and still cleans it up", async () => {
    const cleanup = vi.fn(async () => {});
    await expect(discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => fakeCommandProcess(), cleanup, timeoutMs: 5 }))
      .rejects.toThrow("timed out");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects successful output when cleanup fails", async () => {
    await expect(discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, {
      spawn: () => fakeCommandProcess(JSON.stringify([])),
      cleanup: async () => { throw new Error("private cleanup detail"); },
    })).rejects.toThrow("OpenCode discovery cleanup failed");
  });

  it("uses complete default cleanup for pid and pid-less processes", async () => {
    const withPid = fakeCommandProcess("[]");
    (withPid as { pid?: number }).pid = 4242;
    await expect(discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => withPid })).resolves.toMatchObject({ recentProjects: [] });
    expect(killTreeMocks.killProcessTree).toHaveBeenCalledWith(4242, { graceMs: 250 });

    const withoutPid = fakeCommandProcess();
    (withoutPid.kill as ReturnType<typeof vi.fn>).mockReturnValue(false);
    setTimeout(() => {
      (withoutPid.stdout as PassThrough).write("[]");
      (withoutPid as unknown as EventEmitter).emit("close", 0, null);
    }, 0);
    await expect(discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => withoutPid })).rejects.toThrow("cleanup failed");
  });

  it("bounds combined process output", async () => {
    await expect(discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, {
      spawn: () => fakeCommandProcess("[]"),
      cleanup: async () => {},
      outputMaxBytes: 1,
    })).rejects.toThrow("output exceeded its bound");

    const noisyStderr = fakeCommandProcess();
    const bounded = discoverOpenCodeRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => noisyStderr, cleanup: async () => {}, outputMaxBytes: 1 });
    (noisyStderr.stderr as unknown as EventEmitter).emit("data", Buffer.from("too much"));
    await expect(bounded).rejects.toThrow("output exceeded its bound");
  });
});

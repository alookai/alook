import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnedProcessHandle } from "../../internal/adapter.js";
import { discoverCursorRecentContext } from "./recent-context.js";
import path from "node:path";

const projectPath = (...segments: string[]) => path.join(path.parse(process.cwd()).root, "projects", ...segments);
const killTreeMocks = vi.hoisted(() => ({ killProcessTree: vi.fn(async () => {}) }));

vi.mock("../../internal/killTree.js", async () => {
  const actual = await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js");
  return { ...actual, killProcessTree: killTreeMocks.killProcessTree };
});

type RpcRequest = { id: number; method: string; params: Record<string, unknown> };

function fakeRpcProcess(
  onRequest: (request: RpcRequest, respond: (result: unknown) => void) => void,
  writeResponse: (stdout: PassThrough, payload: Buffer) => void = (stdout, payload) => { stdout.write(payload); },
) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const requests: RpcRequest[] = [];
  let buffer = "";
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as SpawnedProcessHandle;
  stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as RpcRequest;
      requests.push(request);
      onRequest(request, (result) => queueMicrotask(() => {
        writeResponse(stdout, Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`));
      }));
    }
  });
  return { process, requests };
}

describe("Cursor recent-context discovery", () => {
  beforeEach(() => killTreeMocks.killProcessTree.mockClear());

  it("decodes string and Uint8Array stdout chunks", async () => {
    let responseIndex = 0;
    const expectedProjectPath = projectPath("mixed-chunks");
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      return respond({ sessions: [{ cwd: expectedProjectPath, updatedAt: "2026-01-01T00:00:00Z" }] });
    }, (stdout, payload) => {
      responseIndex += 1;
      if (responseIndex === 1) stdout.emit("data", payload.toString("utf8"));
      else if (responseIndex === 2) stdout.emit("data", new Uint8Array(payload));
      else stdout.write(payload);
    });

    const result = await discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => rpc.process, cleanup: async () => {} });
    expect(result.recentProjects[0]?.projectPath).toBe(expectedProjectPath);
  });

  it("preserves a UTF-8 project path split across stdout chunks", async () => {
    const unicodeProjectPath = projectPath("中文-🚀");
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      return respond({ sessions: [{ cwd: unicodeProjectPath, updatedAt: "2026-01-01T00:00:00Z" }] });
    }, (stdout, payload) => {
      const marker = Buffer.from("中");
      const markerAt = payload.indexOf(marker);
      if (markerAt < 0) {
        stdout.write(payload);
        return;
      }
      stdout.write(payload.subarray(0, markerAt + 1));
      stdout.write(payload.subarray(markerAt + 1));
    });

    const result = await discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => rpc.process, cleanup: async () => {} });
    expect(result.recentProjects[0]?.projectPath).toBe(unicodeProjectPath);
  });

  it("accepts the compatibility data field from session/list", async () => {
    const expectedProjectPath = projectPath("compatibility-data");
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      return respond({ data: [{ cwd: expectedProjectPath, updatedAt: "2026-01-01T00:00:00Z" }] });
    });

    const result = await discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => rpc.process, cleanup: async () => {} });
    expect(result.recentProjects[0]?.projectPath).toBe(expectedProjectPath);
  });

  it("treats a session/list result without an array as empty", async () => {
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      return respond({});
    });

    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => rpc.process, cleanup: async () => {} })).resolves.toEqual({
      sessionFiles: { capability: "unavailable", items: [] },
      recentProjects: [],
    });
  });

  it("authenticates, paginates, and returns deduplicated projects with unavailable files", async () => {
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: {} } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      if (request.params.cursor === "next") {
        return respond({
          sessions: [{ sessionId: "b", cwd: projectPath("b"), updatedAt: "2026-01-01T00:00:00Z" }],
        });
      }
      return respond({
        sessions: [
          { sessionId: "relative", cwd: "relative", updatedAt: "2026-01-05T00:00:00Z" },
          { sessionId: "invalid-time", cwd: projectPath("invalid"), updatedAt: "not-a-time" },
          { sessionId: "a1", cwd: projectPath("a"), updatedAt: "2026-01-03T00:00:00Z" },
          { sessionId: "a2", cwd: projectPath("a"), updatedAt: "2026-01-02T00:00:00Z" },
        ],
        nextCursor: "next",
      });
    });
    const cleanup = vi.fn(async () => {});
    const result = await discoverCursorRecentContext({
      recentSessionFilesTopK: 9,
      recentProjectsTopK: 2,
    }, { spawn: () => rpc.process, cleanup });

    expect(result.sessionFiles).toEqual({ capability: "unavailable", items: [] });
    expect(result.recentProjects.map((item) => item.projectPath)).toEqual([projectPath("a"), projectPath("b")]);
    expect(rpc.requests.map((request) => request.method)).toEqual([
      "initialize", "authenticate", "session/list", "session/list",
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects a successful listing when process cleanup fails", async () => {
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      return respond({ sessions: [] });
    });
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, {
      spawn: () => rpc.process,
      cleanup: async () => { throw new Error("private cleanup detail"); },
    })).rejects.toThrow("Cursor discovery cleanup failed");
  });

  it("uses complete default cleanup for pid and pid-less processes", async () => {
    const respondWithEmptyList = (request: RpcRequest, respond: (result: unknown) => void) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      return respond({ sessions: [] });
    };
    const withPid = fakeRpcProcess(respondWithEmptyList);
    (withPid.process as { pid?: number }).pid = 4242;
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => withPid.process })).resolves.toMatchObject({ recentProjects: [] });
    expect(killTreeMocks.killProcessTree).toHaveBeenCalledWith(4242, { graceMs: 250 });

    const withoutPid = fakeRpcProcess(respondWithEmptyList);
    (withoutPid.process.kill as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => withoutPid.process })).rejects.toThrow("cleanup failed");
  });

  it("fails closed for unavailable transport, write failure, session listing, and authentication", async () => {
    const unavailable = fakeRpcProcess(() => {});
    (unavailable.process as { stdin: null }).stdin = null;
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => unavailable.process, cleanup: async () => {} }))
      .rejects.toThrow("transport is unavailable");

    const writeFailure = fakeRpcProcess(() => {});
    (writeFailure.process.stdin as unknown as { write: () => never }).write = () => { throw new Error("EPIPE"); };
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => writeFailure.process, cleanup: async () => {} }))
      .rejects.toThrow("transport write failed");

    const noListing = fakeRpcProcess((_request, respond) => respond({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: {} },
      authMethods: [{ id: "cursor_login" }],
    }));
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => noListing.process, cleanup: async () => {} }))
      .rejects.toThrow("session listing is unavailable");

    const noAuthentication = fakeRpcProcess((_request, respond) => respond({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { list: true } },
      authMethods: [],
    }));
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => noAuthentication.process, cleanup: async () => {} }))
      .rejects.toThrow("authentication is unavailable");
  });

  it("flushes a final response without a newline", async () => {
    const expectedProjectPath = projectPath("flushed");
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        return respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cursor_login" }],
        });
      }
      if (request.method === "authenticate") return respond({});
      return respond({ sessions: [{ cwd: expectedProjectPath, updatedAt: "2026-01-01T00:00:00Z" }] });
    }, (stdout, payload) => {
      if (!payload.includes(Buffer.from(expectedProjectPath))) {
        stdout.write(payload);
        return;
      }
      stdout.end(payload.subarray(0, -1));
    });
    const result = await discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => rpc.process, cleanup: async () => {} });
    expect(result.recentProjects[0]?.projectPath).toBe(expectedProjectPath);
  });

  it("turns stdin stream errors into a discovery failure", async () => {
    const rpc = fakeRpcProcess(() => {});
    const discovery = discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => rpc.process, cleanup: async () => {} });
    (rpc.process.stdin as unknown as { emit(event: string, error: Error): boolean })
      .emit("error", new Error("private EPIPE detail"));
    await expect(discovery).rejects.toThrow("Cursor discovery transport failed");

    const exited = fakeRpcProcess(() => {});
    const exitedDiscovery = discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => exited.process, cleanup: async () => {} });
    (exited.process as unknown as EventEmitter).emit("exit", 1, null);
    await expect(exitedDiscovery).rejects.toThrow("process exited early");
  });

  it("rejects an incompatible ACP protocol after cleanup", async () => {
    const rpc = fakeRpcProcess((_request, respond) => respond({ protocolVersion: 2 }));
    const cleanup = vi.fn(async () => {});
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => rpc.process, cleanup })).rejects.toThrow("protocol is incompatible");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not spawn when the project bound is zero", async () => {
    const spawn = vi.fn();
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 5,
      recentProjectsTopK: 0,
    }, { spawn })).resolves.toEqual({
      sessionFiles: { capability: "unavailable", items: [] },
      recentProjects: [],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("enforces timeout and output bounds", async () => {
    const pending = fakeRpcProcess(() => {});
    await expect(discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => pending.process, cleanup: async () => {}, timeoutMs: 5 }))
      .rejects.toThrow("timed out");

    const noisy = fakeRpcProcess(() => {});
    const bounded = discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => noisy.process, cleanup: async () => {}, outputMaxBytes: 1 });
    (noisy.process.stdout as unknown as { emit(event: string, chunk: Buffer): boolean })
      .emit("data", Buffer.from("too much"));
    await expect(bounded).rejects.toThrow("output exceeded its bound");

    const noisyStderr = fakeRpcProcess(() => {});
    const stderrBounded = discoverCursorRecentContext({
      recentSessionFilesTopK: 0,
      recentProjectsTopK: 1,
    }, { spawn: () => noisyStderr.process, cleanup: async () => {}, outputMaxBytes: 1 });
    (noisyStderr.process.stderr as unknown as { emit(event: string, chunk: Buffer): boolean })
      .emit("data", Buffer.from("too much"));
    await expect(stderrBounded).rejects.toThrow("output exceeded its bound");
  });
});

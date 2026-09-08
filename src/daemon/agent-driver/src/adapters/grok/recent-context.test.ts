import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SpawnedProcessHandle } from "../../internal/adapter.js";
import { discoverGrokRecentContext } from "./recent-context.js";

type RpcRequest = { id: number; method: string; params: Record<string, unknown> };

function fakeRpcProcess(onRequest: (request: RpcRequest, respond: (result: unknown) => void) => void) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests: RpcRequest[] = [];
  let buffer = "";
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
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
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }));
    }
  });
  return { process, requests };
}

describe("Grok recent-context discovery", () => {
  it("uses the persistent ACP list API, paginates, deduplicates, and cleans up", async () => {
    const root = path.parse(process.cwd()).root;
    const projectA = path.join(root, "projects", "grok-a");
    const projectB = path.join(root, "projects", "grok-b");
    const rpc = fakeRpcProcess((request, respond) => {
      if (request.method === "initialize") {
        respond({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: true } },
          authMethods: [{ id: "cached_token" }],
        });
      } else if (request.method === "authenticate") {
        respond({});
      } else if (request.params.cursor === "next") {
        respond({ sessions: [{ cwd: projectB, updatedAt: "2026-09-02T00:00:00Z" }] });
      } else {
        respond({
          sessions: [
            { cwd: projectA, updatedAt: "2026-09-03T00:00:00Z" },
            { cwd: projectA, updatedAt: "2026-09-01T00:00:00Z" },
            { cwd: "relative", updatedAt: "2026-09-04T00:00:00Z" },
          ],
          nextCursor: "next",
        });
      }
    });
    const cleanup = vi.fn(async () => {});
    const spawn = vi.fn(() => rpc.process);

    const result = await discoverGrokRecentContext({
      recentSessionFilesTopK: 5,
      recentProjectsTopK: 2,
      command: "/opt/grok build",
    }, { spawn, cleanup, cwd: projectA });

    expect(result).toEqual({
      sessionFiles: { capability: "unavailable", items: [] },
      recentProjects: [
        { projectPath: projectA, modifiedAt: "2026-09-03T00:00:00.000Z" },
        { projectPath: projectB, modifiedAt: "2026-09-02T00:00:00.000Z" },
      ],
    });
    expect(spawn).toHaveBeenCalledWith("/opt/grok build", ["agent", "--no-leader", "stdio"], expect.objectContaining({
      cwd: projectA,
      env: expect.objectContaining({ GROK_DISABLE_AUTOUPDATER: "1" }),
      shell: false,
    }));
    expect(rpc.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/list",
      "session/list",
    ]);
    expect(rpc.requests.some((request) => request.method === "session/new")).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("fails closed when list or authentication capability is missing", async () => {
    for (const initialize of [
      { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token" }] },
      { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: true } }, authMethods: [] },
    ]) {
      const rpc = fakeRpcProcess((_request, respond) => respond(initialize));
      await expect(discoverGrokRecentContext({
        recentSessionFilesTopK: 0,
        recentProjectsTopK: 1,
      }, { spawn: () => rpc.process, cleanup: async () => {} })).rejects.toThrow(/unavailable/);
    }
  });
});

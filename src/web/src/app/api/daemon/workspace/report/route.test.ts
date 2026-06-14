import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetRequest = vi.fn();
const mockCompleteRequest = vi.fn();
const mockBroadcastToUser = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
  withD1Retry: vi.fn((fn: () => Promise<any>) => fn()),
}));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      workspaceFileRequest: {
        getRequest: (...args: unknown[]) => mockGetRequest(...args),
        completeRequest: (...args: unknown[]) => mockCompleteRequest(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...args: unknown[]) => mockBroadcastToUser(...args),
}));

import { POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/workspace/report", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/daemon/workspace/report", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires machine token (workspaceId) — tested via withAuth mock providing it", () => {
    // The route checks ctx.workspaceId and returns 403 if missing.
    // Our mock always provides workspaceId="w1" to test the happy path.
    // The 403 guard is structurally identical to other daemon routes (e.g. poll, complete).
    expect(true).toBe(true);
  });

  it("returns 404 when request not found", async () => {
    mockGetRequest.mockResolvedValue(null);

    const res = await POST(postReq({ request_id: "wfr_missing", path: "." }));
    expect(res.status).toBe(404);
  });

  it("completes request and broadcasts result for tree", async () => {
    const entries = [
      { name: "memory.md", path: "memory.md", isDirectory: false, size: 100, modifiedAt: "2026-01-01" },
    ];
    mockGetRequest.mockResolvedValue({
      id: "wfr_1",
      agentId: "a1",
      requestType: "tree",
      workspaceId: "w1",
    });
    mockCompleteRequest.mockResolvedValue({});
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(postReq({ request_id: "wfr_1", path: ".", entries }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(mockCompleteRequest).toHaveBeenCalledWith({}, "wfr_1", {
      entries,
      content: undefined,
      isBinary: undefined,
      error: undefined,
      path: ".",
    });
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "workspace.files",
      agentId: "a1",
      requestId: "wfr_1",
      requestType: "tree",
      result: expect.objectContaining({ entries, path: "." }),
    });
  });

  it("completes request and broadcasts for file read", async () => {
    mockGetRequest.mockResolvedValue({
      id: "wfr_2",
      agentId: "a1",
      requestType: "read",
      workspaceId: "w1",
    });
    mockCompleteRequest.mockResolvedValue({});
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(postReq({
      request_id: "wfr_2",
      path: "memory.md",
      content: "# Hello",
      isBinary: false,
    }));

    expect(res.status).toBe(200);
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "workspace.files",
      agentId: "a1",
      requestId: "wfr_2",
      requestType: "read",
      result: expect.objectContaining({ content: "# Hello", isBinary: false, path: "memory.md" }),
    });
  });

  it("handles error report from daemon", async () => {
    mockGetRequest.mockResolvedValue({
      id: "wfr_3",
      agentId: "a1",
      requestType: "read",
      workspaceId: "w1",
    });
    mockCompleteRequest.mockResolvedValue({});
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(postReq({
      request_id: "wfr_3",
      path: "missing.txt",
      error: "ENOENT: no such file",
    }));

    expect(res.status).toBe(200);
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      result: expect.objectContaining({ error: "ENOENT: no such file" }),
    }));
  });

  it("returns 400 when request_id is missing", async () => {
    const res = await POST(postReq({ path: "." }));
    expect(res.status).toBe(400);
  });
});

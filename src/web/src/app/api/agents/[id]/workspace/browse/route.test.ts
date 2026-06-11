import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockCreateRequest = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      agent: { getAgent: (...args: unknown[]) => mockGetAgent(...args) },
      runtime: { getAgentRuntime: vi.fn() },
      workspaceFileRequest: { createRequest: (...args: unknown[]) => mockCreateRequest(...args) },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/cache", () => ({
  cacheKeys: { hasPendingFileRequest: (ws: string) => `pfr:${ws}` },
}));

vi.mock("@/lib/broadcast", () => ({
  broadcastToDaemon: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "./route";

function postReq(agentId: string, body: unknown) {
  return new NextRequest(
    `http://localhost/api/agents/${agentId}/workspace/browse`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("POST /api/agents/[id]/workspace/browse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const res = await POST(postReq("a1", { request_type: "tree", path: "." }), {
      params: Promise.resolve({ id: "a1" }),
    });
    expect(res.status).toBe(404);
    expect(mockGetAgent).toHaveBeenCalledWith({}, "a1", "w1", "u1");
  });

  it("creates a file request and returns request_id for tree", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockCreateRequest.mockResolvedValue({ id: "wfr_abc123" });

    const res = await POST(postReq("a1", { request_type: "tree", path: "." }), {
      params: Promise.resolve({ id: "a1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request_id).toBe("wfr_abc123");
    expect(mockCreateRequest).toHaveBeenCalledWith({}, {
      workspaceId: "w1",
      agentId: "a1",
      requestType: "tree",
      path: ".",
    });
  });

  it("creates a file request for read with custom path", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockCreateRequest.mockResolvedValue({ id: "wfr_def456" });

    const res = await POST(postReq("a1", { request_type: "read", path: "memory.md" }), {
      params: Promise.resolve({ id: "a1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request_id).toBe("wfr_def456");
    expect(mockCreateRequest).toHaveBeenCalledWith({}, {
      workspaceId: "w1",
      agentId: "a1",
      requestType: "read",
      path: "memory.md",
    });
  });

  it("returns 400 for invalid request_type", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });

    const res = await POST(postReq("a1", { request_type: "delete", path: "." }), {
      params: Promise.resolve({ id: "a1" }),
    });
    expect(res.status).toBe(400);
  });
});

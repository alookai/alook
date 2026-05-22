import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgentRuntimeForWorkspace = vi.fn();
const mockSetPendingRescan = vi.fn();
const mockGetMemberByUserAndWorkspace = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    runtime: {
      getAgentRuntimeForWorkspace: (...args: any[]) =>
        mockGetAgentRuntimeForWorkspace(...args),
    },
    machine: {
      setPendingRescan: (...args: any[]) =>
        mockSetPendingRescan(...args),
    },
    member: {
      getMemberByUserAndWorkspace: (...args: any[]) =>
        mockGetMemberByUserAndWorkspace(...args),
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async (req: any) => {
    const wsId = req.nextUrl.searchParams.get("workspace_id");
    if (!wsId) {
      const { NextResponse } = await import("next/server");
      return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
    }
    const member = await mockGetMemberByUserAndWorkspace({}, "u1", wsId);
    if (!member) {
      const { NextResponse } = await import("next/server");
      return NextResponse.json({ error: "workspace not found" }, { status: 404 });
    }
    return { workspaceId: wsId };
  }),
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/broadcast", () => ({
  broadcastToDaemon: vi.fn(() => Promise.resolve({ sent: 1 })),
}));

import { POST } from "./route";

function makeReq(runtimeId: string, workspaceId: string) {
  const url = `http://localhost/api/runtimes/${runtimeId}/rescan?workspace_id=${workspaceId}`;
  return new NextRequest(url, { method: "POST" });
}

describe("POST /api/runtimes/[runtimeId]/rescan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
  });

  it("returns 200 with pending_rescan: true", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({
      id: "rt1",
      daemonId: "d1",
    });
    mockSetPendingRescan.mockResolvedValue(undefined);

    const res = await POST(makeReq("rt1", "w1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending_rescan).toBe(true);
    expect(mockSetPendingRescan).toHaveBeenCalledWith({}, "d1", "w1");
  });

  it("returns 404 for non-existent runtime", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);

    const res = await POST(makeReq("nonexistent", "w1"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("not found");
  });

  it("returns 404 for runtime in another workspace", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);

    const res = await POST(makeReq("rt1", "w-other"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("workspace not found");
  });

  it("returns 400 when runtime id is missing from URL", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);
    const url = `http://localhost/api/runtimes//rescan?workspace_id=w1`;
    const req = new NextRequest(url, { method: "POST" });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("runtime id required");
  });
});

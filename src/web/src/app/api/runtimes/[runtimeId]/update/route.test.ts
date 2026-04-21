import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgentRuntimeForWorkspace = vi.fn();
const mockSetPendingUpdateVersion = vi.fn();
const mockClearPendingUpdateVersion = vi.fn();
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
      setPendingUpdateVersion: (...args: any[]) =>
        mockSetPendingUpdateVersion(...args),
      clearPendingUpdateVersion: (...args: any[]) =>
        mockClearPendingUpdateVersion(...args),
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

// Mock global fetch for npm registry
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { POST, DELETE } from "./route";

function makeReq(method: string, runtimeId: string, workspaceId: string) {
  const url = `http://localhost/api/runtimes/${runtimeId}/update?workspace_id=${workspaceId}`;
  return new NextRequest(url, { method });
}

describe("POST /api/runtimes/[runtimeId]/update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
  });

  it("returns 200 with pending_update_version", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({
      id: "rt1",
      daemonId: "d1",
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.0.0" }),
    });
    mockSetPendingUpdateVersion.mockResolvedValue(undefined);

    const res = await POST(makeReq("POST", "rt1", "w1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending_update_version).toBe("1.0.0");
    expect(mockSetPendingUpdateVersion).toHaveBeenCalledWith({}, "d1", "1.0.0");
  });

  it("returns 404 for non-existent runtime", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);

    const res = await POST(makeReq("POST", "nonexistent", "w1"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("not found");
  });

  it("returns 502 when npm registry is unreachable", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({
      id: "rt1",
      daemonId: "d1",
    });
    mockFetch.mockResolvedValue({ ok: false });

    const res = await POST(makeReq("POST", "rt1", "w1"));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("npm");
  });

  it("returns 404 for runtime in another workspace", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);

    const res = await POST(makeReq("POST", "rt1", "w-other"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("workspace not found");
  });
});

describe("DELETE /api/runtimes/[runtimeId]/update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
  });

  it("returns 204 when cancelling update", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({
      id: "rt1",
      daemonId: "d1",
    });
    mockClearPendingUpdateVersion.mockResolvedValue(undefined);

    const res = await DELETE(makeReq("DELETE", "rt1", "w1"));

    expect(res.status).toBe(204);
    expect(mockClearPendingUpdateVersion).toHaveBeenCalledWith({}, "d1");
  });

  it("returns 404 for non-existent runtime", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);

    const res = await DELETE(makeReq("DELETE", "nonexistent", "w1"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("not found");
  });
});

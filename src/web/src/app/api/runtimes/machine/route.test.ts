import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockDeleteRuntimesByDaemonId = vi.fn();
const mockDeleteMachine = vi.fn();
const mockGetMemberByUserAndWorkspace = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    runtime: {
      deleteRuntimesByDaemonId: (...args: any[]) =>
        mockDeleteRuntimesByDaemonId(...args),
    },
    machine: {
      deleteMachine: (...args: any[]) =>
        mockDeleteMachine(...args),
    },
    member: {
      getMemberByUserAndWorkspace: (...args: any[]) =>
        mockGetMemberByUserAndWorkspace(...args),
    },
  },
}));
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params =
      ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
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
    // Check member mock
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
  broadcastToUser: vi.fn().mockResolvedValue(undefined),
  broadcastToDaemon: vi.fn().mockResolvedValue({ sent: 1 }),
}));

import { DELETE } from "./route";

function makeReq(params: Record<string, string>) {
  const url = new URL("http://localhost/api/runtimes/machine");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString(), { method: "DELETE" });
}

describe("DELETE /api/runtimes/machine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when daemon_id is missing", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });

    const res = await DELETE(makeReq({ workspace_id: "w1" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("daemon_id");
  });

  it("returns 400 when workspace_id is missing", async () => {
    const res = await DELETE(makeReq({ daemon_id: "d1" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("workspace_id");
  });

  it("returns 404 when user is not a workspace member", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);

    const res = await DELETE(makeReq({ daemon_id: "d1", workspace_id: "w-other" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("workspace not found");
  });

  it("returns 204 on successful delete", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
    mockDeleteRuntimesByDaemonId.mockResolvedValue(undefined);
    mockDeleteMachine.mockResolvedValue(undefined);

    const res = await DELETE(
      makeReq({ daemon_id: "d1", workspace_id: "w1" })
    );

    expect(res.status).toBe(204);
  });

  it("passes correct daemon_id with dots and dashes", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
    mockDeleteRuntimesByDaemonId.mockResolvedValue(undefined);
    mockDeleteMachine.mockResolvedValue(undefined);

    const daemonId = "my-daemon.v2.host-01";
    await DELETE(makeReq({ daemon_id: daemonId, workspace_id: "w1" }));

    expect(mockDeleteRuntimesByDaemonId).toHaveBeenCalledWith(
      {},
      daemonId,
      "w1"
    );
  });

  it("calls deleteRuntimesByDaemonId exactly once", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
    mockDeleteRuntimesByDaemonId.mockResolvedValue(undefined);
    mockDeleteMachine.mockResolvedValue(undefined);

    await DELETE(makeReq({ daemon_id: "d1", workspace_id: "w1" }));

    expect(mockDeleteRuntimesByDaemonId).toHaveBeenCalledOnce();
  });

  it("returns 500 when deleteRuntimesByDaemonId throws", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
    mockDeleteRuntimesByDaemonId.mockRejectedValue(new Error("DB exploded"));

    const res = await DELETE(
      makeReq({ daemon_id: "d1", workspace_id: "w1" })
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("Failed to remove machine");
  });

  it("broadcasts daemon.evict on successful delete", async () => {
    const { broadcastToDaemon } = await import("@/lib/broadcast");
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m1" });
    mockDeleteRuntimesByDaemonId.mockResolvedValue(undefined);
    mockDeleteMachine.mockResolvedValue(undefined);

    await DELETE(makeReq({ daemon_id: "d1", workspace_id: "w1" }));

    expect(broadcastToDaemon).toHaveBeenCalledWith("d1", {
      type: "daemon.evict",
      workspaceId: "w1",
    });
  });
});

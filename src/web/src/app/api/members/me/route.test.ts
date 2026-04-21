import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetMemberByUserAndWorkspace = vi.fn();
const mockUpdateMemberGlobalInstruction = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    createDb: vi.fn(() => ({})),
    queries: {
      member: {
        getMemberByUserAndWorkspace: (...args: unknown[]) => mockGetMemberByUserAndWorkspace(...args),
        updateMemberGlobalInstruction: (...args: unknown[]) => mockUpdateMemberGlobalInstruction(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/middleware/workspace", async () => {
  const real = await vi.importActual<typeof import("@/lib/middleware/workspace")>("@/lib/middleware/workspace");
  return {
    ...real,
    withWorkspaceMember: vi.fn(async (req: any) => {
      const workspaceId =
        new URL(req.url).searchParams.get("workspace_id") ||
        req.headers.get("X-Workspace-ID");
      if (!workspaceId) {
        const { NextResponse } = await import("next/server");
        return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
      }
      return { workspaceId };
    }),
  };
});

import { GET, PATCH } from "./route";

function getReq(workspaceId?: string) {
  const url = workspaceId
    ? `http://localhost/api/members/me?workspace_id=${workspaceId}`
    : "http://localhost/api/members/me";
  return new NextRequest(url, { method: "GET" });
}

function patchReq(body: unknown, workspaceId = "w1") {
  return new NextRequest(`http://localhost/api/members/me?workspace_id=${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("GET /api/members/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns global_instruction for the current user", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({
      globalInstruction: "always speak chinese",
    });

    const res = await GET(getReq("w1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.global_instruction).toBe("always speak chinese");
  });

  it("returns 400 when workspace_id is missing", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(400);
  });

  it("returns 404 when member not found", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);

    const res = await GET(getReq("w1"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/members/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves and returns updated global instruction", async () => {
    mockUpdateMemberGlobalInstruction.mockResolvedValue({
      globalInstruction: "new instruction",
    });

    const res = await PATCH(patchReq({ global_instruction: "new instruction" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.global_instruction).toBe("new instruction");
    expect(mockUpdateMemberGlobalInstruction).toHaveBeenCalledWith({}, "u1", "w1", "new instruction");
  });

  it("returns 400 for invalid body", async () => {
    const res = await PATCH(patchReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 404 when member not found", async () => {
    mockUpdateMemberGlobalInstruction.mockResolvedValue(null);

    const res = await PATCH(patchReq({ global_instruction: "something" }));
    expect(res.status).toBe(404);
  });
});

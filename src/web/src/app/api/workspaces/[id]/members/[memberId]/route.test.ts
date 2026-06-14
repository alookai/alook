import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetMember = vi.fn();
const mockDeleteMember = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      member: {
        getMember: (...args: unknown[]) => mockGetMember(...args),
        deleteMember: (...args: unknown[]) => mockDeleteMember(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceOwner: vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" })),
}));

import { DELETE } from "./route";

function makeReq(memberId: string) {
  return new NextRequest(`http://localhost/api/workspaces/w1/members/${memberId}`, { method: "DELETE" });
}

describe("DELETE /api/workspaces/[id]/members/[memberId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes a member successfully", async () => {
    mockGetMember.mockResolvedValue({ id: "m2", userId: "u2", role: "member" });
    mockDeleteMember.mockResolvedValue({ id: "m2" });

    const res = await DELETE(makeReq("m2"), { params: Promise.resolve({ id: "w1", memberId: "m2" }) } as any);
    expect(res.status).toBe(204);
    expect(mockDeleteMember).toHaveBeenCalledWith({}, "m2", "w1");
  });

  it("returns 404 when member not found", async () => {
    mockGetMember.mockResolvedValue(null);

    const res = await DELETE(makeReq("m-unknown"), { params: Promise.resolve({ id: "w1", memberId: "m-unknown" }) } as any);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("member not found");
  });

  it("returns 400 when trying to remove yourself", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", role: "owner" });

    const res = await DELETE(makeReq("m1"), { params: Promise.resolve({ id: "w1", memberId: "m1" }) } as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot remove yourself");
  });

  it("returns 403 when trying to remove an owner", async () => {
    mockGetMember.mockResolvedValue({ id: "m3", userId: "u3", role: "owner" });

    const res = await DELETE(makeReq("m3"), { params: Promise.resolve({ id: "w1", memberId: "m3" }) } as any);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("cannot remove a workspace owner");
  });
});

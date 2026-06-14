import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockDeleteInvite = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      workspaceInvite: {
        deleteInvite: (...args: unknown[]) => mockDeleteInvite(...args),
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

describe("DELETE /api/workspaces/[id]/invites/[inviteId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("revokes invite and returns 204", async () => {
    mockDeleteInvite.mockResolvedValue({ id: "inv1" });

    const req = new NextRequest("http://localhost/api/workspaces/w1/invites/inv1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "w1", inviteId: "inv1" }) } as any);

    expect(res.status).toBe(204);
    expect(mockDeleteInvite).toHaveBeenCalledWith({}, "inv1", "w1");
  });

  it("returns 404 when invite not found", async () => {
    mockDeleteInvite.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/workspaces/w1/invites/inv-gone", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "w1", inviteId: "inv-gone" }) } as any);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("invite not found");
  });
});

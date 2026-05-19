import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockRemoveGreylist = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    greylist: {
      removeGreylist: (...args: unknown[]) => mockRemoveGreylist(...args),
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  const actual = await vi.importActual("@/lib/middleware/helpers");
  return {
    ...actual,
    writeError: (msg: string, status: number) => NextResponse.json({ error: msg }, { status }),
  };
});

import { DELETE } from "./route";

describe("DELETE /api/agents/[id]/greylist/[greylistId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes greylist entry and returns 204", async () => {
    mockRemoveGreylist.mockResolvedValue({ id: "g1", email: "grey@test.com" });

    const req = new NextRequest("http://localhost/api/agents/a1/greylist/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "a1", greylistId: "g1" }) } as any);

    expect(res.status).toBe(204);
    expect(mockRemoveGreylist).toHaveBeenCalledWith({}, "g1", "a1", "w1");
  });

  it("returns 404 when greylist entry not found", async () => {
    mockRemoveGreylist.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/greylist/g999", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "a1", greylistId: "g999" }) } as any);

    expect(res.status).toBe(404);
  });
});

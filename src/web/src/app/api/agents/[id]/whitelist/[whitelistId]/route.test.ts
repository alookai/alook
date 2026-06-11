import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockRemoveWhitelist = vi.fn();
const mockGetAgent = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    whitelist: {
      removeWhitelist: (...args: unknown[]) => mockRemoveWhitelist(...args),
    },
    agent: { getAgent: (...args: unknown[]) => mockGetAgent(...args) },
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

import { DELETE } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue({ id: "a1", visibility: "public", ownerId: "u1" });
});

describe("DELETE /api/agents/[id]/whitelist/[whitelistId]", () => {
  it("removes entry and returns 204", async () => {
    mockRemoveWhitelist.mockResolvedValue({ id: "wl1", email: "alice@co.com" });

    const req = new NextRequest("http://localhost/api/agents/a1/whitelist/wl1", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", whitelistId: "wl1" }) };
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(204);
    expect(mockRemoveWhitelist).toHaveBeenCalledWith(
      expect.anything(),
      "wl1",
      "a1",
      "w1",
    );
  });

  it("returns 404 for non-existent entry", async () => {
    mockRemoveWhitelist.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/whitelist/wl999", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", whitelistId: "wl999" }) };
    const res = await DELETE(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("whitelist entry not found");
  });
});

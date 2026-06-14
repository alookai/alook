import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetFlaggedCount = vi.fn();

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    messageFlag: {
      getFlaggedCount: (...args: unknown[]) => mockGetFlaggedCount(...args),
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" })),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

import { GET } from "./route";

describe("GET /api/flags/count", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the flagged message count", async () => {
    mockGetFlaggedCount.mockResolvedValue(5);

    const req = new NextRequest("http://localhost/api/flags/count");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 5 });
    expect(mockGetFlaggedCount).toHaveBeenCalledWith({}, "u1", "w1");
  });

  it("returns zero when no flagged messages", async () => {
    mockGetFlaggedCount.mockResolvedValue(0);

    const req = new NextRequest("http://localhost/api/flags/count");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });
});

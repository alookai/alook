import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockUnflagMessage = vi.fn();

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    messageFlag: {
      unflagMessage: (...args: unknown[]) => mockUnflagMessage(...args),
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

import { DELETE } from "./route";

describe("DELETE /api/flags/[messageId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when messageId param is missing", async () => {
    const req = new NextRequest("http://localhost/api/flags/", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({}) } as any);

    expect(res.status).toBe(400);
  });

  it("unflag message and returns 204", async () => {
    mockUnflagMessage.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/flags/m1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ messageId: "m1" }) } as any);

    expect(res.status).toBe(204);
    expect(mockUnflagMessage).toHaveBeenCalledWith({}, "m1", "u1", "w1");
  });
});

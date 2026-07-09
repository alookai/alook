import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetUser = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    user: { getUserSelf: (...args: unknown[]) => mockGetUser(...args) },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

vi.mock("@/lib/api/responses", () => ({
  userToResponse: vi.fn((u: any) => ({ id: u.id, name: u.name, email: u.email })),
}));

import { GET } from "./route";

describe("GET /api/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns user data when authenticated", async () => {
    mockGetUser.mockResolvedValue({ id: "u1", name: "Alice", email: "a@b.com" });

    const req = new NextRequest("http://localhost/api/me");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "u1", name: "Alice", email: "a@b.com" });
    expect(mockGetUser).toHaveBeenCalledWith({}, "u1");
  });
});

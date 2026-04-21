import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetWorkspace = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    workspace: { getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args) },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
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
  workspaceToResponse: vi.fn((w: any) => ({ id: w.id, name: w.name, slug: w.slug })),
}));

import { GET } from "./route";

describe("GET /api/workspaces/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns workspace", async () => {
    mockGetWorkspace.mockResolvedValue({ id: "w1", name: "Acme", slug: "acme" });

    const req = new NextRequest("http://localhost/api/workspaces/w1");
    const res = await GET(req, { params: Promise.resolve({ id: "w1" }) } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "w1", name: "Acme", slug: "acme" });
    expect(mockGetWorkspace).toHaveBeenCalledWith({}, "w1");
  });

  it("returns 404 when not found", async () => {
    mockGetWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/workspaces/w999");
    const res = await GET(req, { params: Promise.resolve({ id: "w999" }) } as any);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workspace not found" });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockListAgentRuntimes = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));


vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    runtime: {
      listAgentRuntimes: (...args: unknown[]) => mockListAgentRuntimes(...args),
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

vi.mock("@/lib/api/responses", () => ({
  runtimeToResponse: vi.fn((rt: any) => ({ id: rt.id, status: rt.status })),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

import { GET } from "./route";

describe("GET /api/runtimes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists runtimes in workspace", async () => {
    mockListAgentRuntimes.mockResolvedValue([
      { id: "r1", status: "online" },
      { id: "r2", status: "offline" },
    ]);

    const req = new NextRequest("http://localhost/api/runtimes");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "r1", status: "online" },
      { id: "r2", status: "offline" },
    ]);
    expect(mockListAgentRuntimes).toHaveBeenCalledWith({}, "w1");
  });
});

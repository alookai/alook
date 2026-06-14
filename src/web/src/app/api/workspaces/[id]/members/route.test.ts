import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListMembers = vi.fn();

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
        listMembers: (...args: unknown[]) => mockListMembers(...args),
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "member" })),
}));

vi.mock("@/lib/api/responses", async () =>
  await vi.importActual<typeof import("@/lib/api/responses")>("@/lib/api/responses")
);

import { GET } from "./route";

function makeReq() {
  return new NextRequest("http://localhost/api/workspaces/w1/members", { method: "GET" });
}

describe("GET /api/workspaces/[id]/members", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of members", async () => {
    mockListMembers.mockResolvedValue([
      {
        id: "m1",
        userId: "u1",
        role: "owner",
        createdAt: "2024-01-01T00:00:00Z",
        userName: "Alice",
        userEmail: "alice@example.com",
        userImage: null,
      },
      {
        id: "m2",
        userId: "u2",
        role: "member",
        createdAt: "2024-01-02T00:00:00Z",
        userName: "Bob",
        userEmail: "bob@example.com",
        userImage: "http://example.com/bob.png",
      },
    ]);

    const res = await GET(makeReq(), { params: Promise.resolve({ id: "w1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("m1");
    expect(body[0].user_id).toBe("u1");
    expect(body[0].role).toBe("owner");
    expect(body[1].id).toBe("m2");
    expect(mockListMembers).toHaveBeenCalledWith({}, "w1");
  });

  it("returns empty array when workspace has no members", async () => {
    mockListMembers.mockResolvedValue([]);

    const res = await GET(makeReq(), { params: Promise.resolve({ id: "w1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});

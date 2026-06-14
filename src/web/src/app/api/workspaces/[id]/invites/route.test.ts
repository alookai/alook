import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListActiveInvites = vi.fn();
const mockCreateInvite = vi.fn();

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
        listActiveInvites: (...args: unknown[]) => mockListActiveInvites(...args),
        createInvite: (...args: unknown[]) => mockCreateInvite(...args),
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

vi.mock("@/lib/api/responses", async () =>
  await vi.importActual<typeof import("@/lib/api/responses")>("@/lib/api/responses")
);

import { GET, POST } from "./route";

const sampleInvite = {
  id: "inv1",
  token: "tok-abc",
  createdBy: "u1",
  usedBy: null,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  createdAt: "2024-01-01T00:00:00Z",
};

describe("GET /api/workspaces/[id]/invites", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of active invites", async () => {
    mockListActiveInvites.mockResolvedValue([sampleInvite]);

    const req = new NextRequest("http://localhost/api/workspaces/w1/invites", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ id: "w1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("inv1");
    expect(body[0].token).toBe("tok-abc");
    expect(mockListActiveInvites).toHaveBeenCalledWith({}, "w1");
  });

  it("returns empty array when no active invites", async () => {
    mockListActiveInvites.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/workspaces/w1/invites", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ id: "w1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe("POST /api/workspaces/[id]/invites", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a new invite and returns 201", async () => {
    mockCreateInvite.mockResolvedValue(sampleInvite);

    const req = new NextRequest("http://localhost/api/workspaces/w1/invites", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: "w1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.id).toBe("inv1");
    expect(body.token).toBe("tok-abc");
    expect(mockCreateInvite).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: "w1", createdBy: "u1" })
    );
  });
});

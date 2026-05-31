import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGet = vi.fn();
const mockDelete = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      meetingSession: {
        getMeetingSession: (...a: unknown[]) => mockGet(...a),
        deleteMeetingSession: (...a: unknown[]) => mockDelete(...a),
      },
    },
  };
});
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));
vi.mock("@/lib/api/responses", () => ({ meetingToResponse: (m: any) => ({ id: m.id }) }));

import { GET, DELETE } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents/[id]/meetings/[meetingId]", () => {
  it("returns a meeting scoped to workspace", async () => {
    mockGet.mockResolvedValue({ id: "m1" });
    const res = await GET(new NextRequest("http://localhost/x"), { params: { id: "a1", meetingId: "m1" } });
    expect(res.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith({}, "m1", "w1");
  });

  it("400 when meeting id missing", async () => {
    const res = await GET(new NextRequest("http://localhost/x"), { params: { id: "a1" } });
    expect(res.status).toBe(400);
  });

  it("404 when meeting not in workspace (IDOR guard)", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/x"), { params: { id: "a1", meetingId: "m1" } });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/agents/[id]/meetings/[meetingId]", () => {
  it("deletes a scoped meeting", async () => {
    mockDelete.mockResolvedValue({ id: "m1" });
    const res = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: { id: "a1", meetingId: "m1" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith({}, "m1", "w1");
  });

  it("404 when meeting not found in workspace", async () => {
    mockDelete.mockResolvedValue(null);
    const res = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: { id: "a1", meetingId: "m1" },
    });
    expect(res.status).toBe(404);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockList = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      artifact: {
        listArtifactsByConversation: (...a: unknown[]) => mockList(...a),
        artifactToResponse: (a: any) => ({ id: a.id }),
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

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/artifacts", () => {
  it("lists artifacts for a conversation scoped to workspace", async () => {
    mockList.mockResolvedValue([{ id: "art_1" }, { id: "art_2" }]);
    const req = new NextRequest("http://localhost/api/artifacts?conversation_id=c1");
    const res = await GET(req, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "art_1" }, { id: "art_2" }]);
    expect(mockList).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("400 when conversation_id missing", async () => {
    const req = new NextRequest("http://localhost/api/artifacts");
    const res = await GET(req, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("conversation_id is required");
  });
});

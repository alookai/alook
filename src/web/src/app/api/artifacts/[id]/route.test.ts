import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetArtifact = vi.fn();
const mockGetAgent = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      artifact: {
        getArtifact: (...a: unknown[]) => mockGetArtifact(...a),
        artifactToResponse: (row: any) => ({ id: row.id, filename: row.filename }),
      },
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  },
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/artifacts/[id]", () => {
  it("returns artifact metadata for machine-token workspace access", async () => {
    mockGetArtifact.mockResolvedValue({ id: "art_1", agentId: "ag1", filename: "brief.md" });
    mockGetAgent.mockResolvedValue({ id: "ag1" });
    const res = await GET(new NextRequest("http://localhost/api/artifacts/art_1?workspace_id=w1"), { params: { id: "art_1" } } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "art_1", filename: "brief.md" });
    expect(mockGetArtifact).toHaveBeenCalledWith({}, "art_1", "w1");
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetArtifact = vi.fn();
const mockGetAgent = vi.fn();
const mockBucketGet = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_BUCKET: { get: (...a: unknown[]) => mockBucketGet(...a) },
    },
  })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      artifact: { getArtifact: (...a: unknown[]) => mockGetArtifact(...a) },
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  },
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/artifacts/[id]/thumbnail", () => {
  it("serves thumbnail JPEG with aggressive cache headers", async () => {
    mockGetArtifact.mockResolvedValue({
      id: "art_1",
      agentId: "ag1",
      thumbnailR2Key: "artifacts/w1/ag1/c1/art_1/thumbnail.jpg",
    });
    mockGetAgent.mockResolvedValue({ id: "ag1" });
    mockBucketGet.mockResolvedValue({ body: new Blob([new Uint8Array(100)]).stream() });

    const res = await GET(
      new NextRequest("http://localhost/api/artifacts/art_1/thumbnail?workspace_id=w1"),
      { params: { id: "art_1" } } as any,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(mockBucketGet).toHaveBeenCalledWith("artifacts/w1/ag1/c1/art_1/thumbnail.jpg");
  });

  it("returns 404 when artifact has no thumbnail", async () => {
    mockGetArtifact.mockResolvedValue({
      id: "art_1",
      agentId: "ag1",
      thumbnailR2Key: null,
    });
    mockGetAgent.mockResolvedValue({ id: "ag1" });

    const res = await GET(
      new NextRequest("http://localhost/api/artifacts/art_1/thumbnail?workspace_id=w1"),
      { params: { id: "art_1" } } as any,
    );

    expect(res.status).toBe(404);
    expect(mockBucketGet).not.toHaveBeenCalled();
  });

  it("returns 404 when artifact not found", async () => {
    mockGetArtifact.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/artifacts/art_missing/thumbnail?workspace_id=w1"),
      { params: { id: "art_missing" } } as any,
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 when agent not accessible to user", async () => {
    mockGetArtifact.mockResolvedValue({
      id: "art_1",
      agentId: "ag1",
      thumbnailR2Key: "artifacts/w1/ag1/c1/art_1/thumbnail.jpg",
    });
    mockGetAgent.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/artifacts/art_1/thumbnail?workspace_id=w1"),
      { params: { id: "art_1" } } as any,
    );

    expect(res.status).toBe(404);
  });
});

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
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  },
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/artifacts/[id]/content", () => {
  it("downloads artifact content for machine-token workspace access", async () => {
    mockGetArtifact.mockResolvedValue({
      id: "art_1",
      agentId: "ag1",
      r2Key: "artifacts/w1/ag1/c1/art_1/brief.md",
      filename: "brief.md",
      contentType: "text/markdown",
      size: 5,
    });
    mockGetAgent.mockResolvedValue({ id: "ag1" });
    mockBucketGet.mockResolvedValue({ body: new Blob(["hello"]).stream() });

    const res = await GET(new NextRequest("http://localhost/api/artifacts/art_1/content?workspace_id=w1"), { params: { id: "art_1" } } as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown");
    expect(await res.text()).toBe("hello");
    expect(mockBucketGet).toHaveBeenCalledWith("artifacts/w1/ag1/c1/art_1/brief.md");
  });

  it("serves non-ASCII filenames with RFC 5987 content disposition", async () => {
    mockGetArtifact.mockResolvedValue({
      id: "art_1",
      agentId: "ag1",
      r2Key: "artifacts/w1/ag1/c1/art_1/report.pdf",
      filename: "深圳市小汽车增量指标证明文件.pdf",
      contentType: "application/pdf",
      size: 5,
    });
    mockGetAgent.mockResolvedValue({ id: "ag1" });
    mockBucketGet.mockResolvedValue({ body: new Blob(["hello"]).stream() });

    const res = await GET(new NextRequest("http://localhost/api/artifacts/art_1/content?workspace_id=w1&download"), { params: { id: "art_1" } } as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment; filename=");
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%E6%B7%B1%E5%9C%B3");
  });
});

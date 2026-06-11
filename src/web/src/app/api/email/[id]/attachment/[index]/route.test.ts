import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockBucketGet = vi.fn();
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {}, EMAIL_BUCKET: { get: mockBucketGet } } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockParse = vi.fn();
vi.mock("postal-mime", () => ({ default: { parse: (...a: unknown[]) => mockParse(...a) } }));

const mockGetById = vi.fn();
const mockFilter = vi.fn();
const mockGetAgent = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    filterDownloadableAttachments: (...a: unknown[]) => mockFilter(...a),
    queries: {
      email: { getEmailById: (...a: unknown[]) => mockGetById(...a) },
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
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

const get = (params: Record<string, string>) => GET(new NextRequest("http://localhost/x"), { params });

describe("GET /api/email/[id]/attachment/[index]", () => {
  it("400 when email id missing", async () => {
    const res = await get({ index: "0" });
    expect(res.status).toBe(400);
  });

  it("400 when index is not a valid number", async () => {
    const res = await get({ id: "e1", index: "abc" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid attachment index");
  });

  it("404 when email not in workspace", async () => {
    mockGetById.mockResolvedValue(null);
    const res = await get({ id: "e1", index: "0" });
    expect(res.status).toBe(404);
    expect(mockGetById).toHaveBeenCalledWith({}, "e1", "w1");
  });

  it("404 when R2 object is missing", async () => {
    mockGetById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "k" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockBucketGet.mockResolvedValue(null);
    const res = await get({ id: "e1", index: "0" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("email content not available");
  });

  it("404 when the index is out of range", async () => {
    mockGetById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "k" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockBucketGet.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) });
    mockParse.mockResolvedValue({ attachments: [] });
    mockFilter.mockReturnValue([]);
    const res = await get({ id: "e1", index: "0" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("attachment not found");
  });

  it("streams the attachment with content headers", async () => {
    mockGetById.mockResolvedValue({ id: "e1", agentId: "a1", r2Key: "k" });
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockBucketGet.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) });
    mockParse.mockResolvedValue({ attachments: [{}] });
    mockFilter.mockReturnValue([
      { filename: "report.pdf", mimeType: "application/pdf", content: new ArrayBuffer(3) },
    ]);
    const res = await get({ id: "e1", index: "0" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("report.pdf");
  });
});

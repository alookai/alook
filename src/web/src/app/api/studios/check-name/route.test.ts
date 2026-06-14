import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetWorkspaceBySlug = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      workspace: {
        getWorkspaceBySlug: (...args: unknown[]) => mockGetWorkspaceBySlug(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@test.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/studios/check-name", () => {
  it("returns available=true for unused slug", async () => {
    mockGetWorkspaceBySlug.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/studios/check-name?name=Atlas%20Lab&workspace_id=w1");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.suggested_slug).toBe("atlas-lab");
  });

  it("returns available=true if slug belongs to current workspace", async () => {
    mockGetWorkspaceBySlug.mockResolvedValue({ id: "w1", name: "Atlas Lab", slug: "atlas-lab" });

    const req = new NextRequest("http://localhost/api/studios/check-name?name=Atlas%20Lab&workspace_id=w1");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
  });

  it("returns available=false for taken slug", async () => {
    mockGetWorkspaceBySlug.mockResolvedValue({ id: "other-ws", name: "Other", slug: "atlas-lab" });

    const req = new NextRequest("http://localhost/api/studios/check-name?name=Atlas%20Lab&workspace_id=w1");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.conflict_reason).toBe("slug_taken");
  });

  it("returns 400 if name is missing", async () => {
    const req = new NextRequest("http://localhost/api/studios/check-name?workspace_id=w1");
    const res = await GET(req, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 if name produces invalid slug", async () => {
    const req = new NextRequest("http://localhost/api/studios/check-name?name=!!!&workspace_id=w1");
    const res = await GET(req, {});
    expect(res.status).toBe(400);
  });
});

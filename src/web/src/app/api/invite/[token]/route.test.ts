import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetInviteByToken = vi.fn();
const mockGetMemberByUserAndWorkspace = vi.fn();
const mockRedeemInvite = vi.fn();
const mockCreateMember = vi.fn();

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
        getInviteByToken: (...args: unknown[]) => mockGetInviteByToken(...args),
        redeemInvite: (...args: unknown[]) => mockRedeemInvite(...args),
      },
      member: {
        getMemberByUserAndWorkspace: (...args: unknown[]) => mockGetMemberByUserAndWorkspace(...args),
        createMember: (...args: unknown[]) => mockCreateMember(...args),
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

import { GET, POST } from "./route";

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const pastDate = new Date(Date.now() - 1000).toISOString();

const sampleInvite = {
  id: "inv1",
  workspaceId: "w1",
  workspaceName: "Acme Corp",
  workspaceSlug: "acme",
  token: "tok-abc",
  createdBy: "u2",
  creatorName: "Alice",
  creatorEmail: "alice@example.com",
  usedBy: null,
  usedAt: null,
  expiresAt: futureDate,
  createdAt: "2024-01-01T00:00:00Z",
};

describe("GET /api/invite/[token]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invite info for a valid token", async () => {
    mockGetInviteByToken.mockResolvedValue(sampleInvite);

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_name).toBe("Acme Corp");
    expect(body.workspace_id).toBe("w1");
    expect(body.invited_by).toBe("Alice");
  });

  it("uses creator email when creator name is null", async () => {
    mockGetInviteByToken.mockResolvedValue({ ...sampleInvite, creatorName: null });

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    const body = await res.json();

    expect(body.invited_by).toBe("alice@example.com");
  });

  it("returns 404 when invite not found", async () => {
    mockGetInviteByToken.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/invite/bad-token", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ token: "bad-token" }) } as any);
    expect(res.status).toBe(404);
  });

  it("returns 410 when invite is already used", async () => {
    mockGetInviteByToken.mockResolvedValue({ ...sampleInvite, usedBy: "u2" });

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("invite already used");
  });

  it("returns 410 when invite is expired", async () => {
    mockGetInviteByToken.mockResolvedValue({ ...sampleInvite, expiresAt: pastDate });

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("invite expired");
  });
});

describe("POST /api/invite/[token]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a valid invite and creates membership", async () => {
    mockGetInviteByToken.mockResolvedValue(sampleInvite);
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);
    mockRedeemInvite.mockResolvedValue({ ...sampleInvite, usedBy: "u1" });
    mockCreateMember.mockResolvedValue({ id: "m-new" });

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("w1");
    expect(body.workspace_slug).toBe("acme");
    expect(mockRedeemInvite).toHaveBeenCalledWith({}, "tok-abc", "u1");
    expect(mockCreateMember).toHaveBeenCalledWith(
      {},
      { workspaceId: "w1", userId: "u1", role: "member" }
    );
  });

  it("returns 409 when user is already a member", async () => {
    mockGetInviteByToken.mockResolvedValue(sampleInvite);
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "m-existing" });

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already a member of this workspace");
  });

  it("returns 410 when invite is already used", async () => {
    mockGetInviteByToken.mockResolvedValue({ ...sampleInvite, usedBy: "u3" });

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    expect(res.status).toBe(410);
  });

  it("returns 410 when invite is expired", async () => {
    mockGetInviteByToken.mockResolvedValue({ ...sampleInvite, expiresAt: pastDate });

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("invite expired");
  });

  it("returns 404 when invite token not found", async () => {
    mockGetInviteByToken.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/invite/bad-token", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ token: "bad-token" }) } as any);
    expect(res.status).toBe(404);
  });

  it("returns 410 when redeemInvite returns null (race condition)", async () => {
    mockGetInviteByToken.mockResolvedValue(sampleInvite);
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);
    mockRedeemInvite.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/invite/tok-abc", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ token: "tok-abc" }) } as any);
    expect(res.status).toBe(410);
  });
});

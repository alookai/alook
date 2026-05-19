import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetAgent = vi.fn();
const mockGetGreylist = vi.fn();
const mockAddGreylist = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    agent: {
      getAgent: (...args: unknown[]) => mockGetAgent(...args),
    },
    greylist: {
      getGreylist: (...args: unknown[]) => mockGetGreylist(...args),
      addGreylist: (...args: unknown[]) => mockAddGreylist(...args),
    },
  },
  AddGreylistRequestSchema: {
    parse(data: unknown) {
      const d = data as Record<string, unknown>;
      if (!d || typeof d !== "object" || typeof d.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
        const err = new Error("validation");
        (err as any).issues = [{ path: ["email"], message: "Invalid email" }];
        throw err;
      }
      return { email: String(d.email) };
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  const actual = await vi.importActual("@/lib/middleware/helpers");
  return {
    ...actual,
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (msg: string, status: number) => NextResponse.json({ error: msg }, { status }),
  };
});

import { GET, POST } from "./route";

describe("GET /api/agents/[id]/greylist", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns greylist entries for agent", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockGetGreylist.mockResolvedValue([
      { id: "g1", email: "grey@test.com", createdAt: "2026-01-01T00:00:00Z" },
      { id: "g2", email: "grey2@test.com", createdAt: "2026-01-02T00:00:00Z" },
    ]);

    const req = new NextRequest("http://localhost/api/agents/a1/greylist");
    const res = await GET(req, { params: Promise.resolve({ id: "a1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual(expect.objectContaining({ id: "g1", email: "grey@test.com" }));
    expect(body[1]).toEqual(expect.objectContaining({ id: "g2", email: "grey2@test.com" }));
  });

  it("returns empty array when no greylist entries", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockGetGreylist.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/agents/a1/greylist");
    const res = await GET(req, { params: Promise.resolve({ id: "a1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/greylist");
    const res = await GET(req, { params: Promise.resolve({ id: "a1" }) } as any);

    expect(res.status).toBe(404);
  });
});

describe("POST /api/agents/[id]/greylist", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds email to greylist", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockAddGreylist.mockResolvedValue({
      ok: true,
      entry: { id: "g1", agentId: "a1", workspaceId: "w1", email: "new@test.com", createdAt: "2026-01-01T00:00:00Z" },
    });

    const req = new NextRequest("http://localhost/api/agents/a1/greylist", {
      method: "POST",
      body: JSON.stringify({ email: "new@test.com" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "a1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual(expect.objectContaining({ id: "g1", email: "new@test.com" }));
    expect(mockAddGreylist).toHaveBeenCalledWith({}, "a1", "w1", "new@test.com");
  });

  it("normalizes email to lowercase", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockAddGreylist.mockResolvedValue({
      ok: true,
      entry: { id: "g1", agentId: "a1", workspaceId: "w1", email: "upper@test.com", createdAt: "2026-01-01T00:00:00Z" },
    });

    const req = new NextRequest("http://localhost/api/agents/a1/greylist", {
      method: "POST",
      body: JSON.stringify({ email: "UPPER@TEST.COM" }),
    });
    await POST(req, { params: Promise.resolve({ id: "a1" }) } as any);

    expect(mockAddGreylist).toHaveBeenCalledWith({}, "a1", "w1", "upper@test.com");
  });

  it("returns 409 when email is already whitelisted", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockAddGreylist.mockResolvedValue({ ok: false, reason: "whitelisted" });

    const req = new NextRequest("http://localhost/api/agents/a1/greylist", {
      method: "POST",
      body: JSON.stringify({ email: "wl@test.com" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "a1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("whitelisted");
  });

  it("returns 409 when email is already greylisted", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "w1" });
    mockAddGreylist.mockResolvedValue({ ok: false, reason: "already_greylisted" });

    const req = new NextRequest("http://localhost/api/agents/a1/greylist", {
      method: "POST",
      body: JSON.stringify({ email: "dup@test.com" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "a1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("already greylisted");
  });

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/greylist", {
      method: "POST",
      body: JSON.stringify({ email: "new@test.com" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "a1" }) } as any);

    expect(res.status).toBe(404);
  });
});

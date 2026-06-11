import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockListWorkspaces = vi.fn();
const mockCreateWorkspace = vi.fn();
const mockCreateMember = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    queries: {
      workspace: {
        listWorkspaces: (...args: unknown[]) => mockListWorkspaces(...args),
        createWorkspace: (...args: unknown[]) => mockCreateWorkspace(...args),
      },
      member: {
        createMember: (...args: unknown[]) => mockCreateMember(...args),
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

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  const actual = await vi.importActual("@/lib/middleware/helpers");
  return {
    ...actual,
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

vi.mock("@/lib/api/responses", () => ({
  workspaceToResponse: vi.fn((w: any) => ({ id: w.id, name: w.name, slug: w.slug })),
}));

import { GET, POST } from "./route";

describe("GET /api/workspaces", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists user workspaces", async () => {
    mockListWorkspaces.mockResolvedValue([
      { id: "w1", name: "Acme", slug: "acme" },
      { id: "w2", name: "Beta", slug: "beta" },
    ]);

    const req = new NextRequest("http://localhost/api/workspaces");
    const res = await GET(req, {} as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "w1", name: "Acme", slug: "acme" },
      { id: "w2", name: "Beta", slug: "beta" },
    ]);
    expect(mockListWorkspaces).toHaveBeenCalledWith({}, "u1");
  });
});

describe("POST /api/workspaces", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates workspace with member and returns 201", async () => {
    mockCreateWorkspace.mockResolvedValue({ id: "w-new", name: "New", slug: "new" });
    mockCreateMember.mockResolvedValue({});

    const req = new NextRequest("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "New", slug: "new" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "w-new", name: "New", slug: "new" });
    expect(mockCreateWorkspace).toHaveBeenCalledWith({}, { name: "New", slug: "new" });
    expect(mockCreateMember).toHaveBeenCalledWith({}, {
      workspaceId: "w-new",
      userId: "u1",
      role: "owner",
    });
  });

  it("returns 400 for missing name", async () => {
    const req = new NextRequest("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ slug: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation error");
    expect(body.details).toContainEqual(expect.stringContaining("name"));
  });

  it("auto-generates slug when not provided", async () => {
    mockCreateWorkspace.mockResolvedValue({ id: "sp_1", name: "Test", slug: "auto-slug", onboarded: 0, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" });
    mockCreateMember.mockResolvedValue({});

    const req = new NextRequest("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(201);
  });

  it("retries with suffixed slug on duplicate and returns 201", async () => {
    const uniqueError = new Error("UNIQUE constraint failed: workspaces.slug");
    mockCreateWorkspace
      .mockRejectedValueOnce(uniqueError)
      .mockResolvedValueOnce({ id: "w-retry", name: "Dup", slug: "dup-abcd" });
    mockCreateMember.mockResolvedValue({});

    const req = new NextRequest("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", slug: "dup" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(201);
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(2);
    // First call uses original slug
    expect(mockCreateWorkspace.mock.calls[0][1].slug).toBe("dup");
    // Second call uses a suffixed slug
    expect(mockCreateWorkspace.mock.calls[1][1].slug).toMatch(/^dup-.+/);
  });

  it("returns 409 after all slug retries exhausted", async () => {
    const uniqueError = new Error("UNIQUE constraint failed: workspaces.slug");
    // 1 initial + 9 retries = 10 rejections
    mockCreateWorkspace.mockRejectedValue(uniqueError);

    const req = new NextRequest("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", slug: "dup" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "workspace slug already exists" });
    // 1 initial + 9 retries
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(10);
  });

  it("retries with escalating suffix lengths", async () => {
    const uniqueError = new Error("UNIQUE constraint failed: workspaces.slug");
    // Fail 7 times (1 original + 3 nanoid(4) + 3 nanoid(8)), succeed on 8th
    const rejections = Array.from({ length: 7 }, () => uniqueError);
    mockCreateWorkspace
      .mockRejectedValueOnce(rejections[0])
      .mockRejectedValueOnce(rejections[1])
      .mockRejectedValueOnce(rejections[2])
      .mockRejectedValueOnce(rejections[3])
      .mockRejectedValueOnce(rejections[4])
      .mockRejectedValueOnce(rejections[5])
      .mockRejectedValueOnce(rejections[6])
      .mockResolvedValueOnce({ id: "w-long", name: "Dup", slug: "dup-longsuffix123456" });
    mockCreateMember.mockResolvedValue({});

    const req = new NextRequest("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", slug: "dup" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(201);
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(8);
    // Verify suffix length escalation
    const slugs = mockCreateWorkspace.mock.calls.map((c: any) => c[1].slug as string);
    expect(slugs[0]).toBe("dup"); // original
    // nanoid(4) attempts: suffix part should be 4 chars
    for (let i = 1; i <= 3; i++) {
      const suffix = slugs[i].replace("dup-", "");
      expect(suffix).toHaveLength(4);
    }
    // nanoid(8) attempts: suffix part should be 8 chars
    for (let i = 4; i <= 6; i++) {
      const suffix = slugs[i].replace("dup-", "");
      expect(suffix).toHaveLength(8);
    }
    // 8th call succeeds with nanoid(16) suffix
    const lastSuffix = slugs[7].replace("dup-", "");
    expect(lastSuffix).toHaveLength(16);
  });

  it("retries on duplicate slug wrapped with cause", async () => {
    const cause = new Error("UNIQUE constraint failed: workspaces.slug");
    const wrapped = new Error("Failed query: INSERT INTO ...");
    (wrapped as any).cause = cause;
    mockCreateWorkspace
      .mockRejectedValueOnce(wrapped)
      .mockResolvedValueOnce({ id: "w-retry2", name: "Dup", slug: "dup-xyz" });
    mockCreateMember.mockResolvedValue({});

    const req = new NextRequest("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", slug: "dup" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, {} as any);

    expect(res.status).toBe(201);
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(2);
  });
});

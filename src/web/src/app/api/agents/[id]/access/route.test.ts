import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockListAgentAccess = vi.fn();
const mockGrantAgentAccess = vi.fn();
const mockAddWhitelist = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
      agentAccess: {
        listAgentAccess: (...args: unknown[]) => mockListAgentAccess(...args),
        grantAgentAccess: (...args: unknown[]) => mockGrantAgentAccess(...args),
      },
      whitelist: {
        addWhitelist: (...args: unknown[]) => mockAddWhitelist(...args),
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

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1", memberRole: "member" })),
}));

import { GET, POST } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents/[id]/access", () => {
  it("returns access list for agent owner", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockListAgentAccess.mockResolvedValue([
      { id: "ac1", userId: "u2", userName: "Bob", userEmail: "bob@example.com", createdAt: "2024-01-01T00:00:00Z" },
    ]);

    const req = new NextRequest("http://localhost/api/agents/a1/access");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({ id: "ac1", user_id: "u2", name: "Bob", email: "bob@example.com", created_at: "2024-01-01T00:00:00Z" });
  });

  it("returns 403 when user is not agent owner", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "other-user" });

    const req = new NextRequest("http://localhost/api/agents/a1/access");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("agent owner access required");
  });

  it("returns 403 when agent has null ownerId", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: null });

    const req = new NextRequest("http://localhost/api/agents/a1/access");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("agent owner access required");
  });

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/missing/access");
    const ctx = { params: Promise.resolve({ id: "missing" }) };
    const res = await GET(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });
});

describe("POST /api/agents/[id]/access", () => {
  it("grants access and returns 201", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockGrantAgentAccess.mockResolvedValue({ id: "ac1", userId: "u2" });
    mockListAgentAccess.mockResolvedValue([{ userId: "u2", userEmail: "u2@test.com" }]);
    mockAddWhitelist.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/access", {
      method: "POST",
      body: JSON.stringify({ user_id: "u2" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ id: "ac1", user_id: "u2" });
    expect(mockGrantAgentAccess).toHaveBeenCalledWith(
      {},
      { agentId: "a1", workspaceId: "w1", userId: "u2" }
    );
    expect(mockAddWhitelist).toHaveBeenCalledWith({}, "a1", "w1", "u2@test.com");
  });

  it("does not add whitelist when member has no email", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockGrantAgentAccess.mockResolvedValue({ id: "ac1", userId: "u2" });
    mockListAgentAccess.mockResolvedValue([{ userId: "u2", userEmail: undefined }]);

    const req = new NextRequest("http://localhost/api/agents/a1/access", {
      method: "POST",
      body: JSON.stringify({ user_id: "u2" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx as any);

    expect(res.status).toBe(201);
    expect(mockAddWhitelist).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not agent owner", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "other-user" });

    const req = new NextRequest("http://localhost/api/agents/a1/access", {
      method: "POST",
      body: JSON.stringify({ user_id: "u2" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("agent owner access required");
  });

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/access", {
      method: "POST",
      body: JSON.stringify({ user_id: "u2" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("returns 400 for invalid body", async () => {
    const req = new NextRequest("http://localhost/api/agents/a1/access", {
      method: "POST",
      body: JSON.stringify({ user_id: "" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx as any);

    expect(res.status).toBe(400);
  });
});

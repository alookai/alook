import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockListAgentAccess = vi.fn();
const mockRevokeAgentAccess = vi.fn();
const mockRemoveWhitelistByEmail = vi.fn();

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
        revokeAgentAccess: (...args: unknown[]) => mockRevokeAgentAccess(...args),
      },
      whitelist: {
        removeWhitelistByEmail: (...args: unknown[]) => mockRemoveWhitelistByEmail(...args),
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

import { DELETE } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/agents/[id]/access/[userId]", () => {
  it("revokes access and returns 204 without removing whitelist", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockListAgentAccess.mockResolvedValue([{ userId: "u2", userEmail: "u2@test.com" }]);
    mockRevokeAgentAccess.mockResolvedValue({ id: "ac1", userId: "u2" });

    const req = new NextRequest("http://localhost/api/agents/a1/access/u2?workspace_id=w1", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", userId: "u2" }) };
    const res = await DELETE(req, ctx as any);

    expect(res.status).toBe(204);
    expect(mockRevokeAgentAccess).toHaveBeenCalledWith({}, "a1", "w1", "u2");
    expect(mockRemoveWhitelistByEmail).not.toHaveBeenCalled();
  });

  it("also removes whitelist when remove_whitelist=true", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockListAgentAccess.mockResolvedValue([{ userId: "u2", userEmail: "u2@test.com" }]);
    mockRevokeAgentAccess.mockResolvedValue({ id: "ac1", userId: "u2" });
    mockRemoveWhitelistByEmail.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/access/u2?workspace_id=w1&remove_whitelist=true", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", userId: "u2" }) };
    const res = await DELETE(req, ctx as any);

    expect(res.status).toBe(204);
    expect(mockRemoveWhitelistByEmail).toHaveBeenCalledWith({}, "a1", "w1", "u2@test.com");
  });

  it("does not remove whitelist when member has no email even with remove_whitelist=true", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockListAgentAccess.mockResolvedValue([{ userId: "u2" }]);
    mockRevokeAgentAccess.mockResolvedValue({ id: "ac1", userId: "u2" });

    const req = new NextRequest("http://localhost/api/agents/a1/access/u2?workspace_id=w1&remove_whitelist=true", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", userId: "u2" }) };
    const res = await DELETE(req, ctx as any);

    expect(res.status).toBe(204);
    expect(mockRemoveWhitelistByEmail).not.toHaveBeenCalled();
  });

  it("returns 404 when access record not found", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockListAgentAccess.mockResolvedValue([]);
    mockRevokeAgentAccess.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/access/u2", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", userId: "u2" }) };
    const res = await DELETE(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("access record not found");
  });

  it("returns 403 when user is not agent owner", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "other-user" });

    const req = new NextRequest("http://localhost/api/agents/a1/access/u2", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", userId: "u2" }) };
    const res = await DELETE(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("agent owner access required");
  });

  it("returns 404 when agent not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/access/u2", {
      method: "DELETE",
    });
    const ctx = { params: Promise.resolve({ id: "a1", userId: "u2" }) };
    const res = await DELETE(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });
});

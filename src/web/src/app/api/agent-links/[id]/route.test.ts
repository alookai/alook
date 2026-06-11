import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockUpdate = vi.fn();
const mockRemove = vi.fn();
const mockGetById = vi.fn();
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
      agent: {
        getAgent: (...a: unknown[]) => mockGetAgent(...a),
      },
      agentLink: {
        getById: (...a: unknown[]) => mockGetById(...a),
        update: (...a: unknown[]) => mockUpdate(...a),
        remove: (...a: unknown[]) => mockRemove(...a),
      },
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "ws1" })),
}));

vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn(),
  cacheKeys: {
    allColleagues: (ws: string) => `allColleagues:${ws}`,
    agentLinks: (ws: string) => `agentLinks:${ws}`,
  },
}));

vi.mock("@/lib/api/responses", () => ({
  agentLinkToResponse: (row: any) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    source_agent_id: row.sourceAgentId,
    target_agent_id: row.targetAgentId,
    instruction: row.instruction,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }),
}));

import { PATCH, DELETE } from "./route";

describe("PATCH /api/agent-links/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates instruction", async () => {
    mockGetById.mockResolvedValue({
      id: "al_1",
      workspaceId: "ws1",
      sourceAgentId: "ag_a",
      targetAgentId: "ag_b",
      instruction: "old instruction",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    mockGetAgent.mockResolvedValue({ id: "ag_a" });
    mockUpdate.mockResolvedValue({
      id: "al_1",
      workspaceId: "ws1",
      sourceAgentId: "ag_a",
      targetAgentId: "ag_b",
      instruction: "new instruction",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
    });
    const req = new NextRequest("http://localhost/api/agent-links/al_1", {
      method: "PATCH",
      body: JSON.stringify({ instruction: "new instruction" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: { id: "al_1" } } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instruction).toBe("new instruction");
  });

  it("returns 404 when link not found", async () => {
    mockGetById.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/agent-links/al_nope", {
      method: "PATCH",
      body: JSON.stringify({ instruction: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: { id: "al_nope" } } as any);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/agent-links/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a link", async () => {
    mockGetById.mockResolvedValue({
      id: "al_1",
      workspaceId: "ws1",
      sourceAgentId: "ag_a",
      targetAgentId: "ag_b",
      instruction: "",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    mockGetAgent.mockResolvedValue({ id: "ag_a" });
    mockRemove.mockResolvedValue({
      id: "al_1",
      workspaceId: "ws1",
      sourceAgentId: "ag_a",
      targetAgentId: "ag_b",
      instruction: "",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    const req = new NextRequest("http://localhost/api/agent-links/al_1", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: { id: "al_1" } } as any);
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown link", async () => {
    mockGetById.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/agent-links/al_nope", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: { id: "al_nope" } } as any);
    expect(res.status).toBe(404);
  });
});

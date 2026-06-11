import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockListByWorkspace = vi.fn();
const mockCreate = vi.fn();
const mockUpsertByPair = vi.fn();
const mockGetByPair = vi.fn();
const mockUpdate = vi.fn();
const mockInvalidate = vi.fn();
const mockGetAllAgentsForWorkspace = vi.fn();
const mockGetAllAgentAccessForWorkspace = vi.fn();
const mockFilterVisibleAgents = vi.fn();

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
        getAllAgentsForWorkspace: (...a: unknown[]) => mockGetAllAgentsForWorkspace(...a),
      },
      agentAccess: {
        getAllAgentAccessForWorkspace: (...a: unknown[]) => mockGetAllAgentAccessForWorkspace(...a),
      },
      agentLink: {
        listByWorkspace: (...a: unknown[]) => mockListByWorkspace(...a),
        create: (...a: unknown[]) => mockCreate(...a),
        upsertByPair: (...a: unknown[]) => mockUpsertByPair(...a),
        getByPair: (...a: unknown[]) => mockGetByPair(...a),
        update: (...a: unknown[]) => mockUpdate(...a),
      },
    },
  };
});

vi.mock("@/lib/cache", () => ({
  invalidate: (...a: unknown[]) => mockInvalidate(...a),
  cached: (_k: string, _t: number, fn: () => unknown) => fn(),
  cacheKeys: {
    agentLinks: (ws: string) => `agentLinks:${ws}`,
    allColleagues: (ws: string) => `allColleagues:${ws}`,
    allAgents: (ws: string) => `allAgents:${ws}`,
    allAgentAccess: (ws: string) => `allAgentAccess:${ws}`,
  },
}));

vi.mock("@/lib/agent-visibility", () => ({
  filterVisibleAgents: (...a: unknown[]) => mockFilterVisibleAgents(...a),
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  },
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "ws1" })),
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

import { GET, POST, PUT } from "./route";

describe("GET /api/agent-links", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists links scoped to workspace", async () => {
    mockGetAllAgentsForWorkspace.mockResolvedValue([{ id: "ag_a" }, { id: "ag_b" }]);
    mockGetAllAgentAccessForWorkspace.mockResolvedValue([]);
    mockFilterVisibleAgents.mockReturnValue([{ id: "ag_a" }, { id: "ag_b" }]);
    mockListByWorkspace.mockResolvedValue([
      {
        id: "al_1",
        workspaceId: "ws1",
        sourceAgentId: "ag_a",
        targetAgentId: "ag_b",
        instruction: "collaborate",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ]);
    const req = new NextRequest("http://localhost/api/agent-links?workspace_id=ws1");
    const res = await GET(req, {} as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("al_1");
    expect(body[0].source_agent_id).toBe("ag_a");
  });
});

describe("POST /api/agent-links", () => {
  beforeEach(() => vi.clearAllMocks());

  async function post(body: unknown) {
    const req = new NextRequest("http://localhost/api/agent-links", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    return POST(req, {} as any);
  }

  it("creates a link between two agents", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_a" });
    mockCreate.mockImplementation((_db: any, data: any) => ({
      id: "al_1",
      ...data,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    }));
    const res = await post({
      source_agent_id: "ag_a",
      target_agent_id: "ag_b",
      instruction: "share data",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("al_1");
  });

  it("rejects self-link", async () => {
    const res = await post({
      source_agent_id: "ag_a",
      target_agent_id: "ag_a",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("itself");
  });

  it("returns 404 when source agent not found", async () => {
    mockGetAgent.mockResolvedValueOnce(null);
    const res = await post({
      source_agent_id: "ag_nope",
      target_agent_id: "ag_b",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when target agent not found", async () => {
    mockGetAgent.mockResolvedValueOnce({ id: "ag_a" }).mockResolvedValueOnce(null);
    const res = await post({
      source_agent_id: "ag_a",
      target_agent_id: "ag_nope",
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 for duplicate link", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_a" });
    const uniqueErr = new Error("UNIQUE constraint failed");
    (uniqueErr as any).code = "SQLITE_CONSTRAINT_UNIQUE";
    mockCreate.mockRejectedValue(uniqueErr);
    const res = await post({
      source_agent_id: "ag_a",
      target_agent_id: "ag_b",
    });
    expect(res.status).toBe(409);
  });
});

describe("PUT /api/agent-links (upsert)", () => {
  beforeEach(() => vi.clearAllMocks());

  function put(body: unknown, query = "?agentId=ag_a") {
    const req = new NextRequest(`http://localhost/api/agent-links${query}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    return PUT(req, {} as any);
  }

  // TC5
  it("returns 400 when agentId query param is missing", async () => {
    const res = await put({ target_agent_id: "ag_b", instruction: "x" }, "");
    expect(res.status).toBe(400);
  });

  // TC6
  it("returns 400 for self-link", async () => {
    const res = await put({ target_agent_id: "ag_a", instruction: "x" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("itself");
  });

  // TC7 — caller not in workspace
  it("returns 404 when calling agent not found", async () => {
    mockGetAgent.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "ag_b" });
    const res = await put({ target_agent_id: "ag_b", instruction: "x" });
    expect(res.status).toBe(404);
  });

  // TC7 — target not in workspace
  it("returns 404 when target agent not found", async () => {
    mockGetAgent.mockResolvedValueOnce({ id: "ag_a" }).mockResolvedValueOnce(null);
    const res = await put({ target_agent_id: "ag_nope", instruction: "x" });
    expect(res.status).toBe(404);
  });

  // TC8
  it("creates a new pair -> 201, created:true, invalidates caches", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_x" });
    mockUpsertByPair.mockResolvedValue({
      row: {
        id: "al_1",
        workspaceId: "ws1",
        sourceAgentId: "ag_a",
        targetAgentId: "ag_b",
        instruction: "delegate",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      created: true,
    });
    const res = await put({ target_agent_id: "ag_b", instruction: "delegate" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.instruction).toBe("delegate");
    expect(mockInvalidate).toHaveBeenCalledWith("allColleagues:ws1");
    expect(mockInvalidate).toHaveBeenCalledWith("agentLinks:ws1");
  });

  // TC9
  it("updates an existing pair -> 200, created:false, replaced instruction", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_x" });
    mockUpsertByPair.mockResolvedValue({
      row: {
        id: "al_1",
        workspaceId: "ws1",
        sourceAgentId: "ag_a",
        targetAgentId: "ag_b",
        instruction: "new instruction",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T01:00:00.000Z",
      },
      created: false,
    });
    const res = await put({ target_agent_id: "ag_b", instruction: "new instruction" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.instruction).toBe("new instruction");
  });

  // TC10
  it("falls back to update on a concurrent-create unique race (no throw)", async () => {
    mockGetAgent.mockResolvedValue({ id: "ag_x" });
    const uniqueErr = new Error("UNIQUE constraint failed");
    (uniqueErr as any).code = "SQLITE_CONSTRAINT_UNIQUE";
    mockUpsertByPair.mockRejectedValue(uniqueErr);
    mockGetByPair.mockResolvedValue({ id: "al_1", workspaceId: "ws1" });
    mockUpdate.mockResolvedValue({
      id: "al_1",
      workspaceId: "ws1",
      sourceAgentId: "ag_a",
      targetAgentId: "ag_b",
      instruction: "raced",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T02:00:00.000Z",
    });
    const res = await put({ target_agent_id: "ag_b", instruction: "raced" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.instruction).toBe("raced");
    expect(mockUpdate).toHaveBeenCalled();
  });
});

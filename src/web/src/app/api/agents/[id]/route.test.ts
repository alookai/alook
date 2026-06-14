import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetAgent = vi.fn();
const mockDeleteAgent = vi.fn();
const mockUpdateAgent = vi.fn();
const mockGetAgentRuntimeForWorkspace = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    queries: {
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
        deleteAgent: (...args: unknown[]) => mockDeleteAgent(...args),
        updateAgent: (...args: unknown[]) => mockUpdateAgent(...args),
      },
      runtime: {
        getAgentRuntimeForWorkspace: (...args: unknown[]) => mockGetAgentRuntimeForWorkspace(...args),
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

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/api/responses", () => ({
  agentToResponse: vi.fn((a: any) => ({ id: a.id, name: a.name })),
}));

import { GET, DELETE, PATCH } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents/[id]", () => {
  it("returns agent", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });

    const req = new NextRequest("http://localhost/api/agents/a1");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "a1", name: "Agent 1" });
  });

  it("returns 404 when not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });
});

describe("DELETE /api/agents/[id]", () => {
  it("returns 204 on successful deletion", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockDeleteAgent.mockResolvedValue(true);

    const req = new NextRequest("http://localhost/api/agents/a1", { method: "DELETE" });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(204);
  });

  it("returns 404 for non-existent agent", async () => {
    mockDeleteAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1", { method: "DELETE" });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await DELETE(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("returns 403 when user is not agent owner", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "other-user" });

    const req = new NextRequest("http://localhost/api/agents/a1", { method: "DELETE" });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await DELETE(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("agent owner access required");
  });
});

describe("PATCH /api/agents/[id]", () => {
  it("updates agent and returns response", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockUpdateAgent.mockResolvedValue({ id: "a1", name: "Updated" });

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "a1", name: "Updated" });
  });

  it("returns 404 for non-existent agent", async () => {
    mockUpdateAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("returns 400 when no fields provided", async () => {
    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ unknown_field: "value" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("validation error");
  });

  it("returns 400 for invalid request body", async () => {
    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: "not json",
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid request body");
  });

  it("accepts and persists runtime_config", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockUpdateAgent.mockResolvedValue({ id: "a1", name: "Agent" });

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Agent", runtime_config: { model: "claude-sonnet-4-6" } }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(200);
    expect(mockUpdateAgent).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({ runtimeConfig: { model: "claude-sonnet-4-6" } }),
      "u1",
    );
  });

  it("runtime_config alone is a valid update", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockUpdateAgent.mockResolvedValue({ id: "a1", name: "Agent" });

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ runtime_config: { model: "x" } }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(200);
    expect(mockUpdateAgent).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({ runtimeConfig: { model: "x" } }),
      "u1",
    );
  });

  it("TC-6: PATCH with valid runtime_id (own runtime) updates agent successfully", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "u1" });
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({ id: "rt1", workspaceId: "w1" });
    mockUpdateAgent.mockResolvedValue({ id: "a1", name: "Agent" });

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ runtime_id: "rt1" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(200);
    expect(mockGetAgentRuntimeForWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "rt1",
      "w1",
      "u1",
    );
    expect(mockUpdateAgent).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({ runtimeId: "rt1" }),
      "u1",
    );
  });

  it("TC-5: PATCH with runtime_id belonging to another member returns 400", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ runtime_id: "rt_other_user" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("runtime not found in workspace");
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it("PATCH with nonexistent runtime_id returns 400", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ runtime_id: "rt_nonexistent" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("runtime not found in workspace");
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not agent owner", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", ownerId: "other-user" });

    const req = new NextRequest("http://localhost/api/agents/a1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New" }),
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await PATCH(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("agent owner access required");
  });

});

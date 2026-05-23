import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockListAgents = vi.fn();
const mockCreateAgent = vi.fn();
const mockGetAgent = vi.fn();
const mockGetAgentRuntimeForWorkspace = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    isOnline: vi.fn((t: string | null) => !!t && Date.now() - new Date(t).getTime() < 30_000),
    queries: {
      agent: {
        listAgents: (...args: unknown[]) => mockListAgents(...args),
        getAllAgentsForWorkspace: (...args: unknown[]) => mockListAgents(...args),
        createAgent: (...args: unknown[]) => mockCreateAgent(...args),
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
      agentAccess: {
        getAllAgentAccessForWorkspace: vi.fn().mockResolvedValue([]),
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
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/api/responses", () => ({
  agentToResponse: vi.fn((a: any) => ({ id: a.id, name: a.name })),
}));

const mockReconcileAgentStatus = vi.fn();
vi.mock("@/lib/services/task", () => {
  const Svc = function () {
    return { reconcileAgentStatus: mockReconcileAgentStatus };
  };
  return { TaskService: Svc };
});

vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn(),
  cached: vi.fn((_key: string, _ttl: number, fn: () => Promise<any>) => fn()),
  cacheKeys: {
    allAgents: (ws: string) => `agents:${ws}`,
    allAgentAccess: (ws: string) => `aa:${ws}`,
    allHandles: (ws: string) => `handles:${ws}`,
    overviewTaskStats: (ws: string, d: string) => `ov_task:${ws}:${d}`,
  },
}));

vi.mock("@/lib/agent-visibility", () => ({
  filterVisibleAgents: vi.fn((agents: any[]) => agents),
}));

import { GET, POST } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents", () => {
  it("lists agents in workspace", async () => {
    mockListAgents.mockResolvedValue([
      { id: "a1", name: "Agent 1" },
      { id: "a2", name: "Agent 2" },
    ]);

    const req = new NextRequest("http://localhost/api/agents");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "a1", name: "Agent 1" },
      { id: "a2", name: "Agent 2" },
    ]);
  });
});

describe("POST /api/agents", () => {
  const validBody = { name: "New Agent", runtime_id: "r1" };

  it("creates agent with valid input", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({ machineLastSeenAt: null, runtimeMode: "local" });
    mockCreateAgent.mockResolvedValue({ id: "a1", name: "New Agent" });

    const req = new NextRequest("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify(validBody),
    });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ id: "a1", name: "New Agent" });
  });

  it("returns 400 for missing name", async () => {
    const req = new NextRequest("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ runtime_id: "r1" }),
    });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("validation error");
    expect(body.details).toContainEqual(expect.stringContaining("name"));
  });

  it("returns 400 for missing runtime_id", async () => {
    const req = new NextRequest("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Agent" }),
    });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("validation error");
    expect(body.details).toContainEqual(expect.stringContaining("runtime_id"));
  });

  it("returns 404 when runtime not in workspace", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify(validBody),
    });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("runtime not found in workspace");
  });

  it("creates agent with reconcile when runtime is online", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({ machineLastSeenAt: new Date().toISOString(), runtimeMode: "local" });
    mockCreateAgent.mockResolvedValue({ id: "a1", name: "New Agent" });
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Reconciled Agent" });

    const req = new NextRequest("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify(validBody),
    });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockReconcileAgentStatus).toHaveBeenCalledWith("a1", "w1");
    expect(body).toEqual({ id: "a1", name: "Reconciled Agent" });
  });

  it("creates agent without reconcile when runtime is offline", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({ machineLastSeenAt: null, runtimeMode: "local" });
    mockCreateAgent.mockResolvedValue({ id: "a1", name: "New Agent" });

    const req = new NextRequest("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify(validBody),
    });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockReconcileAgentStatus).not.toHaveBeenCalled();
    expect(body).toEqual({ id: "a1", name: "New Agent" });
  });

  it("passes runtime_config through to createAgent", async () => {
    mockGetAgentRuntimeForWorkspace.mockResolvedValue({ machineLastSeenAt: null, runtimeMode: "local" });
    mockCreateAgent.mockResolvedValue({ id: "a1", name: "New Agent" });

    const req = new NextRequest("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({
        ...validBody,
        runtime_config: { model: "claude-sonnet-4-6" },
      }),
    });
    const res = await POST(req, {});

    expect(res.status).toBe(201);
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeConfig: { model: "claude-sonnet-4-6" },
      }),
    );
  });
});

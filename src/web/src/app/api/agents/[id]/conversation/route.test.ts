import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetAgent = vi.fn();
const mockGetOrCreateAgentConversation = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    agent: {
      getAgent: (...args: unknown[]) => mockGetAgent(...args),
    },
    conversation: {
      getOrCreateAgentConversation: (...args: unknown[]) =>
        mockGetOrCreateAgentConversation(...args),
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

vi.mock("@/lib/api/responses", () => ({
  conversationToResponse: vi.fn((c: any) => ({
    id: c.id,
    agent_id: c.agentId,
    title: c.title,
    created_at: c.createdAt,
  })),
}));

import { POST } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/agents/[id]/conversation", () => {
  it("returns 200 with existing conversation", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });
    mockGetOrCreateAgentConversation.mockResolvedValue({
      id: "c1",
      agentId: "a1",
      title: "Existing",
      createdAt: "2024-01-01T00:00:00.000Z",
    });

    const req = new NextRequest("http://localhost/api/agents/a1/conversation", {
      method: "POST",
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      id: "c1",
      agent_id: "a1",
      title: "Existing",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(mockGetOrCreateAgentConversation).toHaveBeenCalledWith(
      {},
      "w1",
      "u1",
      "a1"
    );
  });

  it("creates conversation when none exists", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });
    mockGetOrCreateAgentConversation.mockResolvedValue({
      id: "c-new",
      agentId: "a1",
      title: "",
      createdAt: "2024-01-02T00:00:00.000Z",
    });

    const req = new NextRequest("http://localhost/api/agents/a1/conversation", {
      method: "POST",
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe("c-new");
    expect(body.title).toBe("");
  });

  it("returns 404 for non-existent agent", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/conversation", {
      method: "POST",
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("returns same conversation on second call", async () => {
    const conv = {
      id: "c1",
      agentId: "a1",
      title: "Hello",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });
    mockGetOrCreateAgentConversation.mockResolvedValue(conv);

    const req1 = new NextRequest("http://localhost/api/agents/a1/conversation", {
      method: "POST",
    });
    const req2 = new NextRequest("http://localhost/api/agents/a1/conversation", {
      method: "POST",
    });
    const ctx = { params: Promise.resolve({ id: "a1" }) };

    const res1 = await POST(req1, ctx);
    const body1 = await res1.json();

    const ctx2 = { params: Promise.resolve({ id: "a1" }) };
    const res2 = await POST(req2, ctx2);
    const body2 = await res2.json();

    expect(body1.id).toBe(body2.id);
  });
});

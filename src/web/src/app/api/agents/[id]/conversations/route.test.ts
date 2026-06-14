import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetAgent = vi.fn();
const mockListConversationsByAgent = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    agent: {
      getAgent: (...args: unknown[]) => mockGetAgent(...args),
    },
    conversation: {
      listConversationsByAgent: (...args: unknown[]) => mockListConversationsByAgent(...args),
    },
  },
}));

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
  conversationToResponse: vi.fn((c: any) => ({ id: c.id, title: c.title })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents/[id]/conversations", () => {
  it("returns 200 with filtered conversations", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });
    mockListConversationsByAgent.mockResolvedValue([
      { id: "c1", title: "Conv 1" },
      { id: "c2", title: "Conv 2" },
    ]);

    const req = new NextRequest("http://localhost/api/agents/a1/conversations");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "c1", title: "Conv 1" },
      { id: "c2", title: "Conv 2" },
    ]);
  });

  it("returns 404 for non-existent agent", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/conversations");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("returns empty array for agent with no conversations", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", name: "Agent 1" });
    mockListConversationsByAgent.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/agents/a1/conversations");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});

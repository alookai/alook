import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetAgent = vi.fn();
const mockListTaskHistory = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    queries: {
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
      task: {
        listTaskHistory: (...args: unknown[]) => mockListTaskHistory(...args),
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
  taskToActivityResponse: vi.fn((t: any) => ({
    id: t.id,
    conversation_id: t.conversationId,
    type: t.type,
    status: t.status,
    prompt: t.prompt?.slice(0, 120),
    created_at: t.createdAt,
    started_at: t.startedAt,
    completed_at: t.completedAt,
    error: t.error || null,
  })),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

const makeTask = (overrides: Record<string, unknown> = {}) => ({
  id: "t1",
  agentId: "a1",
  conversationId: "c1",
  workspaceId: "w1",
  prompt: "Do something",
  type: "user_dm_message",
  status: "completed",
  createdAt: "2025-01-01T00:00:00.000Z",
  startedAt: "2025-01-01T00:00:01.000Z",
  completedAt: "2025-01-01T00:00:10.000Z",
  error: null,
  ...overrides,
});

describe("GET /api/agents/[id]/activity", () => {
  it("returns 404 for non-existent agent", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/agents/a1/activity?workspace_id=w1");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("agent not found");
  });

  it("returns tasks with has_more", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({
      tasks: [makeTask()],
      hasMore: true,
    });

    const req = new NextRequest("http://localhost/api/agents/a1/activity?workspace_id=w1");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toHaveLength(1);
    expect(body.has_more).toBe(true);
    expect(body.tasks[0].id).toBe("t1");
  });

  it("parses comma-separated status params", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({ tasks: [], hasMore: false });

    const req = new NextRequest(
      "http://localhost/api/agents/a1/activity?workspace_id=w1&status=queued,dispatched"
    );
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    await GET(req, ctx);

    expect(mockListTaskHistory).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({ status: ["queued", "dispatched"] })
    );
  });

  it("parses comma-separated type params", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({ tasks: [], hasMore: false });

    const req = new NextRequest(
      "http://localhost/api/agents/a1/activity?workspace_id=w1&type=user_dm_message,email_notification"
    );
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    await GET(req, ctx);

    expect(mockListTaskHistory).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({ type: ["user_dm_message", "email_notification"] })
    );
  });

  it("clamps limit to 1-100 range", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({ tasks: [], hasMore: false });

    const req = new NextRequest(
      "http://localhost/api/agents/a1/activity?workspace_id=w1&limit=999"
    );
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    await GET(req, ctx);

    expect(mockListTaskHistory).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({ limit: 100 })
    );
  });

  it("clamps limit minimum to 1", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({ tasks: [], hasMore: false });

    const req = new NextRequest(
      "http://localhost/api/agents/a1/activity?workspace_id=w1&limit=0"
    );
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    await GET(req, ctx);

    expect(mockListTaskHistory).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({ limit: 1 })
    );
  });

  it("passes before and before_id cursor params", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({ tasks: [], hasMore: false });

    const req = new NextRequest(
      "http://localhost/api/agents/a1/activity?workspace_id=w1&before=2025-01-01T00:00:00.000Z&before_id=t5"
    );
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    await GET(req, ctx);

    expect(mockListTaskHistory).toHaveBeenCalledWith(
      expect.anything(),
      "a1",
      "w1",
      expect.objectContaining({
        before: "2025-01-01T00:00:00.000Z",
        beforeId: "t5",
      })
    );
  });

  it("returns has_more false when no more tasks", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({
      tasks: [makeTask()],
      hasMore: false,
    });

    const req = new NextRequest("http://localhost/api/agents/a1/activity?workspace_id=w1");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(body.has_more).toBe(false);
  });

  it("taskToActivityResponse truncates prompt and omits result/context", async () => {
    const longPrompt = "x".repeat(200);
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskHistory.mockResolvedValue({
      tasks: [makeTask({ prompt: longPrompt })],
      hasMore: false,
    });

    const req = new NextRequest("http://localhost/api/agents/a1/activity?workspace_id=w1");
    const ctx = { params: Promise.resolve({ id: "a1" }) };
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(body.tasks[0].prompt.length).toBeLessThanOrEqual(120);
    expect(body.tasks[0]).not.toHaveProperty("result");
    expect(body.tasks[0]).not.toHaveProperty("context");
  });
});

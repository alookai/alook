import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockGetActiveTaskByConversation = vi.fn();
const mockTaskToResponse = vi.fn((t: any) => ({ id: t.id, status: t.status }));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    conversation: {
      getConversation: (...args: any[]) => mockGetConversation(...args),
    },
    task: {
      getActiveTaskByConversation: (...args: any[]) => mockGetActiveTaskByConversation(...args),
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
  taskToResponse: (...args: any[]) => mockTaskToResponse(...args),
}));

import { GET } from "./route";

const withParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/conversations/[id]/active-task", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns active task when one exists", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", workspaceId: "w1" });
    mockGetActiveTaskByConversation.mockResolvedValue({ id: "t1", status: "running" });

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/c1/active-task"),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "t1", status: "running" });
    expect(mockGetActiveTaskByConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("returns 204 when no active task", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", workspaceId: "w1" });
    mockGetActiveTaskByConversation.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/c1/active-task"),
      withParams("c1")
    );

    expect(res.status).toBe(204);
  });

  it("returns 404 when conversation not found", async () => {
    mockGetConversation.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/c1/active-task"),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("conversation not found");
  });
});

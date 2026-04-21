import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTask = vi.fn();
const mockListTaskMessages = vi.fn();
const mockListTaskMessagesSince = vi.fn();
const mockTaskMessageToResponse = vi.fn((m: any) => ({
  id: m.id,
  task_id: m.taskId,
  seq: m.seq,
  type: m.type,
  content: m.content,
}));

vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
  writeError: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    task: {
      getTask: (...args: any[]) => mockGetTask(...args),
    },
    taskMessage: {
      listTaskMessages: (...args: any[]) => mockListTaskMessages(...args),
      listTaskMessagesSince: (...args: any[]) => mockListTaskMessagesSince(...args),
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
  taskMessageToResponse: (...args: any[]) => mockTaskMessageToResponse(...args),
}));

import { GET } from "./route";

describe("GET /api/tasks/[id]/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes workspaceId to getTask", async () => {
    const task = { id: "t1", workspaceId: "w1" };
    mockGetTask.mockResolvedValue(task);
    mockListTaskMessages.mockResolvedValue([]);
    await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    expect(mockGetTask).toHaveBeenCalledWith({}, "t1", "w1");
  });

  it("lists all messages", async () => {
    const task = { id: "t1", workspaceId: "w1" };
    const messages = [
      { id: "m1", taskId: "t1", seq: 1, type: "text", content: "hello" },
      { id: "m2", taskId: "t1", seq: 2, type: "text", content: "world" },
    ];
    mockGetTask.mockResolvedValue(task);
    mockListTaskMessages.mockResolvedValue(messages);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "m1", task_id: "t1", seq: 1, type: "text", content: "hello" },
      { id: "m2", task_id: "t1", seq: 2, type: "text", content: "world" },
    ]);
    expect(mockListTaskMessages).toHaveBeenCalledWith({}, "t1");
  });

  it("filters by since parameter", async () => {
    const task = { id: "t1", workspaceId: "w1" };
    const messages = [
      { id: "m3", taskId: "t1", seq: 6, type: "text", content: "new msg" },
    ];
    mockGetTask.mockResolvedValue(task);
    mockListTaskMessagesSince.mockResolvedValue(messages);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages?since=5"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "m3", task_id: "t1", seq: 6, type: "text", content: "new msg" },
    ]);
    expect(mockListTaskMessagesSince).toHaveBeenCalledWith({}, "t1", 5);
    expect(mockListTaskMessages).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid since parameter", async () => {
    const task = { id: "t1", workspaceId: "w1" };
    mockGetTask.mockResolvedValue(task);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages?since=abc"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid since parameter");
  });

  it("returns 404 when task not found", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("task not found");
  });
});

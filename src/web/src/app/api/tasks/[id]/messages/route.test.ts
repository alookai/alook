import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTask = vi.fn();
const mockStoreListMessages = vi.fn();
const mockTaskMessageToResponse = vi.fn((m: any) => ({
  id: m.id,
  task_id: m.task_id,
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
  getCloudflareContext: vi.fn(() => ({
    env: { DB: {}, TASK_MESSAGE_BUCKET: {}, CACHE_KV: {} },
  })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    task: {
      getTask: (...args: any[]) => mockGetTask(...args),
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
vi.mock("@/lib/task-message-store", () => ({
  TaskMessageStore: class {
    listMessages(...args: any[]) { return mockStoreListMessages(...args); }
    appendMessages() { return Promise.resolve(); }
    deleteMessages() { return Promise.resolve(); }
  },
}));

import { GET } from "./route";

describe("GET /api/tasks/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreListMessages.mockResolvedValue([]);
  });

  it("passes workspaceId to getTask", async () => {
    const task = { id: "t1", workspaceId: "w1" };
    mockGetTask.mockResolvedValue(task);
    await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    expect(mockGetTask).toHaveBeenCalledWith({}, "t1", "w1");
  });

  it("lists all messages from store", async () => {
    const task = { id: "t1", workspaceId: "w1" };
    const messages = [
      { id: "m1", task_id: "t1", seq: 1, type: "text", content: "hello" },
      { id: "m2", task_id: "t1", seq: 2, type: "text", content: "world" },
    ];
    mockGetTask.mockResolvedValue(task);
    mockStoreListMessages.mockResolvedValue(messages);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(mockStoreListMessages).toHaveBeenCalledWith("t1", {
      since: undefined,
      excludeTypes: ["tool-result"],
    });
  });

  it("passes since parameter to store", async () => {
    const task = { id: "t1", workspaceId: "w1" };
    mockGetTask.mockResolvedValue(task);
    mockStoreListMessages.mockResolvedValue([
      { id: "m3", task_id: "t1", seq: 6, type: "text", content: "new msg" },
    ]);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages?since=5"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(mockStoreListMessages).toHaveBeenCalledWith("t1", {
      since: 5,
      excludeTypes: ["tool-result"],
    });
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

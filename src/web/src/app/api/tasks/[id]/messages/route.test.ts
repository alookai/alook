import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTask = vi.fn();
const mockGetAgent = vi.fn();
const mockListTaskMessages = vi.fn();
const mockListTaskMessagesSince = vi.fn();
const mockTaskMessageToResponse = vi.fn((m: any) => ({
  id: m.id,
  seq: m.seq,
  type: m.type,
  content: m.content,
  output: m.output || "",
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
    agent: {
      getAgent: (...args: any[]) => mockGetAgent(...args),
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
    const task = { id: "t1", agentId: "a1", workspaceId: "w1" };
    mockGetTask.mockResolvedValue(task);
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskMessages.mockResolvedValue([]);
    await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    expect(mockGetTask).toHaveBeenCalledWith({}, "t1", "w1");
  });

  it("lists all messages", async () => {
    const task = { id: "t1", agentId: "a1", workspaceId: "w1" };
    const messages = [
      { id: "m1", taskId: "t1", seq: 1, type: "text", content: "hello" },
      { id: "m2", taskId: "t1", seq: 2, type: "text", content: "world" },
    ];
    mockGetTask.mockResolvedValue(task);
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskMessages.mockResolvedValue(messages);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "m1", seq: 1, type: "text", content: "hello", output: "" },
      { id: "m2", seq: 2, type: "text", content: "world", output: "" },
    ]);
    expect(mockListTaskMessages).toHaveBeenCalledWith({}, "t1");
  });

  it("filters by since parameter", async () => {
    const task = { id: "t1", agentId: "a1", workspaceId: "w1" };
    const messages = [
      { id: "m3", taskId: "t1", seq: 6, type: "text", content: "new msg" },
    ];
    mockGetTask.mockResolvedValue(task);
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskMessagesSince.mockResolvedValue(messages);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages?since=5"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([
      { id: "m3", seq: 6, type: "text", content: "new msg", output: "" },
    ]);
    expect(mockListTaskMessagesSince).toHaveBeenCalledWith({}, "t1", 5);
    expect(mockListTaskMessages).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid since parameter", async () => {
    const task = { id: "t1", agentId: "a1", workspaceId: "w1" };
    mockGetTask.mockResolvedValue(task);
    mockGetAgent.mockResolvedValue({ id: "a1" });

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
    expect(body.error).toBe("not found");
  });

  it("only returns text and error messages (tool-result, tool-use, thinking filtered at query level)", async () => {
    const task = { id: "t1", agentId: "a1", workspaceId: "w1" };
    const messages = [
      { id: "m1", taskId: "t1", seq: 1, type: "text", content: "hello" },
    ];
    mockGetTask.mockResolvedValue(task);
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskMessages.mockResolvedValue(messages);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("text");
  });

  it("only returns text and error messages with since parameter (filtered at query level)", async () => {
    const task = { id: "t1", agentId: "a1", workspaceId: "w1" };
    const messages = [
      { id: "m4", taskId: "t1", seq: 7, type: "text", content: "new update" },
    ];
    mockGetTask.mockResolvedValue(task);
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockListTaskMessagesSince.mockResolvedValue(messages);

    const res = await GET(
      new NextRequest("http://localhost/api/tasks/t1/messages?since=5"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("text");
  });
});

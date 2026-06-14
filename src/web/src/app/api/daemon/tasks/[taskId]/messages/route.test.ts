import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListTaskMessages = vi.fn();
const mockCreateTaskMessage = vi.fn();
const mockGetTask = vi.fn();
const mockTaskMessageToResponse = vi.fn((m: any) => m);

let mockAuthCtx: Record<string, unknown> = { env: {}, userId: "u1", email: "u@t.com", workspaceId: "w1" };

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: { withSession: () => ({}) } } })),
}));
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
  withD1Retry: vi.fn((fn: () => Promise<any>) => fn()),
}));
const mockGetConversation = vi.fn();
vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    createDb: vi.fn(() => ({})),
    queries: {
      taskMessage: {
        listTaskMessages: (...args: any[]) => mockListTaskMessages(...args),
        createTaskMessage: (...args: any[]) => mockCreateTaskMessage(...args),
      },
      task: {
        getTask: (...args: any[]) => mockGetTask(...args),
      },
      conversation: {
        getConversation: (...args: any[]) => mockGetConversation(...args),
      },
    },
  };
});
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params =
      ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { ...mockAuthCtx, params });
  }),
}));
vi.mock("@/lib/middleware/helpers", async () => {
  return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
    "@/lib/middleware/helpers"
  );
});
vi.mock("@/lib/api/responses", () => ({
  taskMessageToResponse: (...args: any[]) => mockTaskMessageToResponse(...args),
}));
const mockBroadcastToUser = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...args: any[]) => mockBroadcastToUser(...args),
}));
vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { GET, POST } from "./route";

const withParams = (taskId: string) => ({
  params: Promise.resolve({ taskId }),
});

describe("GET /api/daemon/tasks/[taskId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthCtx = { env: {}, userId: "u1", email: "u@t.com", workspaceId: "w1" };
  });

  it("returns messages for workspace-scoped task", async () => {
    const msgs = [{ id: "m1", seq: 1, content: "hi" }];
    mockListTaskMessages.mockResolvedValue(msgs);

    const res = await GET(
      new NextRequest("http://localhost/api/daemon/tasks/t1/messages"),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(mockListTaskMessages).toHaveBeenCalledWith({}, "t1", "w1");
  });

  it("returns 403 when workspaceId is missing (session auth)", async () => {
    mockAuthCtx = { env: {}, userId: "u1", email: "u@t.com" };

    const res = await GET(
      new NextRequest("http://localhost/api/daemon/tasks/t1/messages"),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: machine token required");
    expect(mockListTaskMessages).not.toHaveBeenCalled();
  });
});

describe("POST /api/daemon/tasks/[taskId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthCtx = { env: {}, userId: "u1", email: "u@t.com", workspaceId: "w1" };
  });

  it("creates messages for workspace-scoped task", async () => {
    mockGetTask.mockResolvedValue({ id: "t1", workspaceId: "w1", conversationId: "c1" });
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "owner-u2" });
    mockCreateTaskMessage.mockResolvedValue({ id: "m1" });

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ seq: 1, type: "text", content: "hello" }],
        }),
      }),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(mockGetTask).toHaveBeenCalledWith({}, "t1", "w1");
  });

  it("returns 403 when workspaceId is missing (session auth)", async () => {
    mockAuthCtx = { env: {}, userId: "u1", email: "u@t.com" };

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ seq: 1, type: "text", content: "hello" }],
        }),
      }),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: machine token required");
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  it("returns 404 when task belongs to another workspace", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t-other/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ seq: 1, type: "text", content: "hello" }],
        }),
      }),
      withParams("t-other")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("task not found");
    expect(mockCreateTaskMessage).not.toHaveBeenCalled();
  });

  it("only broadcasts text and error messages via WebSocket to conversation owner", async () => {
    mockGetTask.mockResolvedValue({ id: "t1", workspaceId: "w1", conversationId: "c1" });
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "owner-u2" });
    mockCreateTaskMessage.mockResolvedValue({ id: "m1" });

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { seq: 1, type: "text", content: "hello" },
            { seq: 2, type: "tool-result", content: "large payload" },
            { seq: 3, type: "tool-use", tool: "grep", content: "" },
          ],
        }),
      }),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(mockCreateTaskMessage).toHaveBeenCalledTimes(3);
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToUser.mock.calls[0][0]).toBe("owner-u2");
    const broadcastPayload = mockBroadcastToUser.mock.calls[0][1];
    expect(broadcastPayload.messages).toHaveLength(1);
    expect(broadcastPayload.messages[0].type).toBe("text");
  });

  it("stores thinking messages but does not broadcast them", async () => {
    mockGetTask.mockResolvedValue({ id: "t1", workspaceId: "w1", conversationId: "c1" });
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "owner-u2" });
    mockCreateTaskMessage.mockResolvedValue({ id: "m1" });

    const res = await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { seq: 1, type: "text", content: "hello" },
            { seq: 2, type: "thinking", content: "hmm" },
          ],
        }),
      }),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(mockCreateTaskMessage).toHaveBeenCalledTimes(2);
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1);
    const broadcastPayload = mockBroadcastToUser.mock.calls[0][1];
    expect(broadcastPayload.messages).toHaveLength(1);
    expect(broadcastPayload.messages[0].type).toBe("text");
  });

  it("does not broadcast when all messages are tool-result", async () => {
    mockGetTask.mockResolvedValue({ id: "t1", workspaceId: "w1", conversationId: "c1" });
    mockGetConversation.mockResolvedValue({ id: "c1", userId: "owner-u2" });
    mockCreateTaskMessage.mockResolvedValue({ id: "m1" });

    await POST(
      new NextRequest("http://localhost/api/daemon/tasks/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { seq: 1, type: "tool-result", content: "result1" },
            { seq: 2, type: "tool-result", content: "result2" },
          ],
        }),
      }),
      withParams("t1")
    );

    expect(mockBroadcastToUser).not.toHaveBeenCalled();
  });
});

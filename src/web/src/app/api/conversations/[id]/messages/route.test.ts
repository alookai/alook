import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockUpdateConversationTitle = vi.fn();
const mockListMessages = vi.fn();
const mockCreateMessage = vi.fn();
const mockEnqueueTask = vi.fn();
const mockMessageToResponse = vi.fn((m: any) => ({ id: m.id, content: m.content }));
const mockTaskToResponse = vi.fn((t: any) => ({ id: t.id, status: t.status }));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    createLogger: () => log,
    TASK_TYPES: {
      USER_DM_MESSAGE: "user_dm_message",
      EMAIL_NOTIFICATION: "email_notification",
      CALENDAR_EVENT: "calendar_event",
    },
    buildEmailMapKey: (agentId: string, threadId: string) => `email:${agentId}:${threadId}`,
    queries: {
      conversation: {
        getConversation: (...args: any[]) => mockGetConversation(...args),
        updateConversationTitle: (...args: any[]) => mockUpdateConversationTitle(...args),
      },
      message: {
        listMessages: (...args: any[]) => mockListMessages(...args),
        createMessage: (...args: any[]) => mockCreateMessage(...args),
        updateMessageTaskId: vi.fn().mockResolvedValue(undefined),
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
  messageToResponse: (...args: any[]) => mockMessageToResponse(...args),
  taskToResponse: (...args: any[]) => mockTaskToResponse(...args),
}));
vi.mock("@/lib/services/task", () => {
  return {
    TaskService: class {
      enqueueTask(...args: any[]) { return mockEnqueueTask(...args); }
    },
  };
});
vi.mock("@/lib/logger", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { GET, POST } from "./route";

const withParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/conversations/[id]/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists messages", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    const msgs = [
      { id: "m1", content: "Hello" },
      { id: "m2", content: "World" },
    ];
    mockGetConversation.mockResolvedValue(conv);
    mockListMessages.mockResolvedValue({ messages: msgs, has_more: false });

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/c1/messages"),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      messages: [
        { id: "m1", content: "Hello" },
        { id: "m2", content: "World" },
      ],
      has_more: false,
    });
    expect(mockListMessages).toHaveBeenCalledWith({}, "c1", {
      limit: undefined,
      before: undefined,
      beforeId: undefined,
    });
  });

  it("passes limit and before params when provided", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);
    mockListMessages.mockResolvedValue({ messages: [], has_more: false });

    const res = await GET(
      new NextRequest(
        "http://localhost/api/conversations/c1/messages?workspace_id=w1&limit=5&before=2024-01-01T00:00:00.000Z"
      ),
      withParams("c1")
    );

    expect(res.status).toBe(200);
    expect(mockListMessages).toHaveBeenCalledWith({}, "c1", {
      limit: 5,
      before: "2024-01-01T00:00:00.000Z",
      beforeId: undefined,
    });
  });

  it("passes before_id param for compound cursor", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);
    mockListMessages.mockResolvedValue({ messages: [], has_more: false });

    const res = await GET(
      new NextRequest(
        "http://localhost/api/conversations/c1/messages?workspace_id=w1&before=2024-01-01T00:00:00.000Z&before_id=m5"
      ),
      withParams("c1")
    );

    expect(res.status).toBe(200);
    expect(mockListMessages).toHaveBeenCalledWith({}, "c1", {
      limit: undefined,
      before: "2024-01-01T00:00:00.000Z",
      beforeId: "m5",
    });
  });

  it("clamps limit to max 100", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);
    mockListMessages.mockResolvedValue({ messages: [], has_more: false });

    await GET(
      new NextRequest(
        "http://localhost/api/conversations/c1/messages?workspace_id=w1&limit=999"
      ),
      withParams("c1")
    );

    expect(mockListMessages).toHaveBeenCalledWith({}, "c1", {
      limit: 100,
      before: undefined,
      beforeId: undefined,
    });
  });

  it("returns has_more true when more messages exist", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    const msgs = [{ id: "m1", content: "Hello" }];
    mockGetConversation.mockResolvedValue(conv);
    mockListMessages.mockResolvedValue({ messages: msgs, has_more: true });

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/c1/messages"),
      withParams("c1")
    );
    const body = await res.json();

    expect(body.has_more).toBe(true);
    expect(body.messages).toHaveLength(1);
  });
});

describe("POST /api/conversations/[id]/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends message and enqueues task, returns 201", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    const msg = { id: "m1", content: "Hi there" };
    const task = { id: "t1", status: "pending" };
    mockGetConversation.mockResolvedValue(conv);
    mockCreateMessage.mockResolvedValue(msg);
    mockUpdateConversationTitle.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue(task);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({ content: "Hi there" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.message).toEqual({ id: "m1", content: "Hi there" });
    expect(body.task).toEqual({ id: "t1", status: "pending" });
    expect(mockEnqueueTask).toHaveBeenCalledWith("a1", "c1", "w1", "Hi there", "user_dm_message", expect.objectContaining({ contextKey: "c1", traceId: expect.stringMatching(/^tr_/), parentTaskId: null }));
  });

  it("auto-titles conversation with truncated first message", async () => {
    const longContent = "A ".repeat(40).trim();
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);
    mockCreateMessage.mockResolvedValue({ id: "m1", content: longContent });
    mockUpdateConversationTitle.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue({ id: "t1", status: "pending" });

    await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({ content: longContent }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );

    const titleArg = mockUpdateConversationTitle.mock.calls[0][2] as string;
    expect(titleArg.endsWith("...")).toBe(true);
    expect(titleArg.length).toBeLessThanOrEqual(53);
  });

  it("short messages are not truncated", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);
    mockCreateMessage.mockResolvedValue({ id: "m1", content: "short" });
    mockUpdateConversationTitle.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue({ id: "t1", status: "pending" });

    await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({ content: "short" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );

    const titleArg = mockUpdateConversationTitle.mock.calls[0][2] as string;
    expect(titleArg).toBe("short");
    expect(titleArg.endsWith("...")).toBe(false);
  });

  it("returns 400 for missing content", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("validation error");
    expect(body.details).toContainEqual(expect.stringContaining("content"));
  });

  it("returns 404 when conversation not found", async () => {
    mockGetConversation.mockResolvedValue(null);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
  });

  it("passes workspaceId to getConversation", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    mockGetConversation.mockResolvedValue(conv);
    mockCreateMessage.mockResolvedValue({ id: "m1", content: "hello" });
    mockUpdateConversationTitle.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue({ id: "t1", status: "pending" });

    await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );

    expect(mockGetConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });

  it("TC2: passes metadata.quote to createMessage and adds quoted_message to task context", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    const msg = { id: "m1", content: "Can you fix this?" };
    const task = { id: "t1", status: "pending" };
    mockGetConversation.mockResolvedValue(conv);
    mockCreateMessage.mockResolvedValue(msg);
    mockUpdateConversationTitle.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue(task);

    const res = await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({
          content: "Can you fix this?",
          metadata: { quote: { messageId: "msg_orig", excerpt: "The auth module has a bug" } },
        }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );

    expect(res.status).toBe(201);
    expect(mockCreateMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        content: "Can you fix this?",
        metadata: JSON.stringify({ quote: { messageId: "msg_orig", excerpt: "The auth module has a bug" } }),
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "c1", "w1", "Can you fix this?", "user_dm_message",
      expect.objectContaining({
        context: expect.objectContaining({
          message_id: "m1",
          quoted_message: { message_id: "msg_orig", excerpt: "The auth module has a bug" },
        }),
      }),
    );
  });

  it("TC3: message without metadata has no quote in metadata or task context", async () => {
    const conv = { id: "c1", workspaceId: "w1", agentId: "a1", userId: "u1" };
    const msg = { id: "m1", content: "Hello" };
    const task = { id: "t1", status: "pending" };
    mockGetConversation.mockResolvedValue(conv);
    mockCreateMessage.mockResolvedValue(msg);
    mockUpdateConversationTitle.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue(task);

    await POST(
      new NextRequest("http://localhost/api/conversations/c1/messages", {
        method: "POST",
        body: JSON.stringify({ content: "Hello" }),
        headers: { "Content-Type": "application/json" },
      }),
      withParams("c1")
    );

    expect(mockCreateMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ metadata: null }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "c1", "w1", "Hello", "user_dm_message",
      expect.objectContaining({
        context: { message_id: "m1" },
      }),
    );
  });
});

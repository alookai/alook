import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockCreateEmail = vi.fn();
const mockGetConversation = vi.fn();
const mockCreateConversation = vi.fn();
const mockCreateMessage = vi.fn();
const mockCreateMeetingSession = vi.fn();
const mockFindByKey = vi.fn();
const mockCreateMapping = vi.fn();
const mockEnqueueTask = vi.fn();
const mockGetUser = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
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
      email: {
        createEmail: (...args: unknown[]) => mockCreateEmail(...args),
      },
      conversation: {
        getConversation: (...args: unknown[]) => mockGetConversation(...args),
        createConversation: (...args: unknown[]) => mockCreateConversation(...args),
      },
      message: {
        createMessage: (...args: unknown[]) => mockCreateMessage(...args),
        updateMessageTaskId: vi.fn().mockResolvedValue(undefined),
      },
      meetingSession: {
        createMeetingSession: (...args: unknown[]) => mockCreateMeetingSession(...args),
      },
      conversationMap: {
        findByKey: (...args: unknown[]) => mockFindByKey(...args),
        createMapping: (...args: unknown[]) => mockCreateMapping(...args),
      },
      user: {
        getUser: (...args: unknown[]) => mockGetUser(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  const actual = await vi.importActual("@/lib/middleware/helpers");
  return {
    ...actual,
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (msg: string, status: number) => NextResponse.json({ error: msg }, { status }),
  };
});

vi.mock("@/lib/services/task", () => {
  return {
    TaskService: class {
      enqueueTask(...args: any[]) { return mockEnqueueTask(...args); }
    },
  };
});

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api/responses", () => ({
  taskToResponse: (t: unknown) => t,
}));

import { POST } from "./route";

function makeNotifyReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/email/notify", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const baseBody = {
  agentId: "a1",
  workspaceId: "ws1",
  r2Key: "emails/fake/raw",
  from: "sender@test.com",
  subject: "Test email",
  isWhitelisted: true,
  messageId: "<msg1@test.com>",
  inReplyTo: "",
  references: "",
};

describe("POST /api/email/notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEmail.mockImplementation((_db: unknown, data: Record<string, unknown>) => Promise.resolve({
      id: "e1",
      fromEmail: data.fromEmail ?? "",
      toEmail: data.toEmail ?? "",
      subject: data.subject ?? "",
      messageId: data.messageId ?? "",
      inReplyTo: data.inReplyTo ?? "",
      references: data.references ?? "",
      agentId: data.agentId ?? "",
      workspaceId: data.workspaceId ?? "",
    }));
    mockCreateMessage.mockResolvedValue({ id: "m1", conversationId: "c1", role: "event", content: "", taskId: null, createdAt: "2026-01-01T00:00:00Z" });
    mockFindByKey.mockResolvedValue(null);
    mockCreateMapping.mockResolvedValue(undefined);
  });

  it("creates new conversation when no mapping found", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockCreateConversation.mockResolvedValue({ id: "conv_new" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockFindByKey).toHaveBeenCalledWith(
      expect.anything(),
      "email:a1:<msg1@test.com>",
      "ws1",
    );
    expect(mockCreateConversation).toHaveBeenCalledOnce();
    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "event" }),
    );
    expect(mockCreateMapping).toHaveBeenCalledWith(expect.anything(), {
      key: "email:a1:<msg1@test.com>",
      workspaceId: "ws1",
      conversationId: "conv_new",
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_new", "ws1",
      expect.any(String),
      "email_notification",
      expect.objectContaining({ contextKey: "conv_new", context: { conversationType: "email_notification", emailId: "e1" }, traceId: expect.stringMatching(/^tr_/), parentTaskId: null }),
    );
  });

  it("reuses existing conversation when mapping is found (email_notification type)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockFindByKey.mockResolvedValue("conv_existing");
    mockGetConversation.mockResolvedValue({ id: "conv_existing", type: "email_notification", userId: "u1" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockCreateMapping).not.toHaveBeenCalled();
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_existing", "ws1",
      expect.any(String),
      "email_notification",
      expect.objectContaining({ contextKey: "conv_existing", context: { conversationType: "email_notification", emailId: "e1" }, traceId: expect.stringMatching(/^tr_/), parentTaskId: null }),
    );
  });

  // TC4 (the bug): a human replies from their own mail client. Their reply carries
  // In-Reply-To = the wire Message-ID of the agent's original email. Because the worker
  // now puts that SAME id on the wire AND registers it in conversationMap, the inbound
  // lookup keys on In-Reply-To and resolves back to the original conversation — instead
  // of opening a brand-new one (the reported bug).
  it("threads a human reply into the original conversation via In-Reply-To (no new conversation)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    const WIRE_ID = "<wire-abc@alook.ai>"; // the id the agent put on the wire + registered
    // The map was registered (on send) keyed on the wire id → the original conversation.
    mockFindByKey.mockImplementation((_db: unknown, key: string) =>
      key === `email:a1:${WIRE_ID}` ? "conv_original" : null,
    );
    mockGetConversation.mockResolvedValue({ id: "conv_original", type: "email_notification", userId: "u1" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq({
      ...baseBody,
      messageId: "<human-reply-999@gmail.com>", // the human's own new Message-ID
      inReplyTo: WIRE_ID,                         // points at the agent's wire id
      references: "",
    }));
    expect(res.status).toBe(200);

    // Lookup keyed on the In-Reply-To (the wire id), NOT the human's own message id.
    expect(mockFindByKey).toHaveBeenCalledWith(expect.anything(), `email:a1:${WIRE_ID}`, "ws1");
    // Threaded into the original conversation — no new conversation, no new mapping.
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockCreateMapping).not.toHaveBeenCalled();
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_original", "ws1",
      expect.any(String),
      "email_notification",
      expect.objectContaining({ contextKey: "conv_original" }),
    );
  });

  it("reuses existing DM conversation and includes dmUser in context", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockFindByKey.mockResolvedValue("conv_dm");
    mockGetConversation.mockResolvedValue({ id: "conv_dm", type: "user_dm_message", userId: "u1" });
    mockGetUser.mockResolvedValue({ id: "u1", name: "Alice", email: "alice@example.com" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockGetConversation).toHaveBeenCalledWith(expect.anything(), "conv_dm", "ws1");
    expect(mockGetUser).toHaveBeenCalledWith(expect.anything(), "u1");
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_dm", "ws1",
      expect.any(String),
      "email_notification",
      expect.objectContaining({ contextKey: "conv_dm", context: { conversationType: "user_dm_message", dmUser: { name: "Alice", email: "alice@example.com" }, emailId: "e1" }, traceId: expect.stringMatching(/^tr_/), parentTaskId: null }),
    );
  });

  it("DM conversation without user still enqueues with conversationType", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockFindByKey.mockResolvedValue("conv_dm");
    mockGetConversation.mockResolvedValue({ id: "conv_dm", type: "user_dm_message", userId: "u1" });
    mockGetUser.mockResolvedValue(null);
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_dm", "ws1",
      expect.any(String),
      "email_notification",
      expect.objectContaining({ contextKey: "conv_dm", context: { conversationType: "user_dm_message", emailId: "e1" }, traceId: expect.stringMatching(/^tr_/), parentTaskId: null }),
    );
  });

  it("same thread, two different agents get separate conversations", async () => {
    // Agent A
    mockGetAgent.mockResolvedValueOnce({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockFindByKey.mockResolvedValueOnce(null);
    mockCreateConversation.mockResolvedValueOnce({ id: "conv_a" });
    mockEnqueueTask.mockResolvedValueOnce({ id: "t1" });

    await POST(makeNotifyReq(baseBody));

    expect(mockFindByKey).toHaveBeenCalledWith(expect.anything(), "email:a1:<msg1@test.com>", "ws1");
    expect(mockCreateMapping).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      key: "email:a1:<msg1@test.com>",
      conversationId: "conv_a",
    }));

    vi.clearAllMocks();
    mockCreateEmail.mockImplementation((_db: unknown, data: Record<string, unknown>) => Promise.resolve({
      id: "e2",
      fromEmail: data.fromEmail ?? "",
      toEmail: data.toEmail ?? "",
      subject: data.subject ?? "",
      messageId: data.messageId ?? "",
      inReplyTo: data.inReplyTo ?? "",
      references: data.references ?? "",
      agentId: data.agentId ?? "",
      workspaceId: data.workspaceId ?? "",
    }));

    // Agent B - same email thread
    mockGetAgent.mockResolvedValueOnce({ id: "a2", workspaceId: "ws1", runtimeId: "r2", ownerId: "u2" });
    mockFindByKey.mockResolvedValueOnce(null);
    mockCreateConversation.mockResolvedValueOnce({ id: "conv_b" });
    mockEnqueueTask.mockResolvedValueOnce({ id: "t2" });

    await POST(makeNotifyReq({ ...baseBody, agentId: "a2" }));

    expect(mockFindByKey).toHaveBeenCalledWith(expect.anything(), "email:a2:<msg1@test.com>", "ws1");
    expect(mockCreateMapping).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      key: "email:a2:<msg1@test.com>",
      conversationId: "conv_b",
    }));
  });

  it("does not create conversation or task when not whitelisted", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockFindByKey).not.toHaveBeenCalled();
  });

  it("does not create conversation or task when agent has no runtime", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: null, ownerId: "u1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("does not create conversation or task when agent has no ownerId", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: null });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockFindByKey).not.toHaveBeenCalled();
  });

  it("returns conversationId in response when whitelisted agent path creates conversation (TC5)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockCreateConversation.mockResolvedValue({ id: "conv_new" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.conversationId).toBe("conv_new");
  });

  it("returns no conversationId for non-whitelisted path (TC6)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.conversationId).toBeUndefined();
  });

  it("stamps targetConversationId in inbound metadata when senderConversationId provided (TC2)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a2", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockCreateConversation.mockResolvedValue({ id: "conv_b" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq({
      ...baseBody,
      agentId: "a2",
      isInternal: true,
      senderConversationId: "conv_a",
      senderAgentId: "a1",
    }));
    expect(res.status).toBe(200);

    const metadataArg = mockCreateMessage.mock.calls[0]![1] as { metadata: string };
    const parsed = JSON.parse(metadataArg.metadata);
    expect(parsed.targetConversationId).toBe("conv_a");
    expect(parsed.targetAgentId).toBe("a1");
  });

  it("does NOT stamp targetConversationId for external emails (TC3)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockCreateConversation.mockResolvedValue({ id: "conv_ext" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    await POST(makeNotifyReq(baseBody));

    const metadataArg = mockCreateMessage.mock.calls[0]![1] as { metadata: string };
    const parsed = JSON.parse(metadataArg.metadata);
    expect(parsed.targetConversationId).toBeUndefined();
    expect(parsed.targetAgentId).toBeUndefined();
  });

  it("does NOT stamp targetConversationId for self-send (TC16)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockCreateConversation.mockResolvedValue({ id: "conv_self" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    await POST(makeNotifyReq({
      ...baseBody,
      isInternal: true,
      senderConversationId: "conv_a",
      senderAgentId: "a1",
    }));

    const metadataArg = mockCreateMessage.mock.calls[0]![1] as { metadata: string };
    const parsed = JSON.parse(metadataArg.metadata);
    expect(parsed.targetConversationId).toBeUndefined();
    expect(parsed.targetAgentId).toBeUndefined();
  });

  it("uses References header thread root for mapping lookup", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockFindByKey.mockResolvedValue("conv_thread");
    mockGetConversation.mockResolvedValue({ id: "conv_thread", type: "email_notification", userId: "u1" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const bodyWithRefs = {
      ...baseBody,
      messageId: "<reply@test.com>",
      inReplyTo: "<msg1@test.com>",
      references: "<root@test.com> <msg1@test.com>",
    };

    await POST(makeNotifyReq(bodyWithRefs));

    expect(mockFindByKey).toHaveBeenCalledWith(
      expect.anything(),
      "email:a1:<root@test.com>",
      "ws1",
    );
  });
});

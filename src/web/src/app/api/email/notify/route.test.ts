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
const mockR2Get = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_BUCKET: {
        get: (...args: unknown[]) => mockR2Get(...args),
      },
    },
  })),
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

function mockRawMime(bodyText = "Please review the attached invoice.") {
  const rawMime = [
    "From: sender@test.com",
    "To: myagent@alook.ai",
    "Subject: Test email",
    "Content-Type: text/plain; charset=utf-8",
    "",
    bodyText,
  ].join("\r\n");
  mockR2Get.mockResolvedValue({
    arrayBuffer: async () => new TextEncoder().encode(rawMime).buffer,
  });
}

describe("POST /api/email/notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEmail.mockResolvedValue({ id: "e1" });
    mockCreateMessage.mockResolvedValue({ id: "m1", conversationId: "c1", role: "event", content: "", taskId: null, createdAt: "2026-01-01T00:00:00Z" });
    mockFindByKey.mockResolvedValue(null);
    mockCreateMapping.mockResolvedValue(undefined);
    mockR2Get.mockResolvedValue(null);
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
    mockCreateEmail.mockResolvedValue({ id: "e2" });

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

  it("enqueues email_triage for non-whitelisted inbound email", async () => {
    mockRawMime();
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1", emailHandle: "myagent" });
    mockCreateConversation.mockResolvedValue({ id: "conv_triage" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockCreateEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox: "draft", isWhitelisted: false }),
    );
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "email_triage",
        userId: "u1",
        agentId: "a1",
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1",
      "conv_triage",
      "ws1",
      expect.stringContaining("sender@test.com"),
      "email_triage",
      expect.objectContaining({
        context: expect.objectContaining({
          inboundEmailId: "e1",
          from: "sender@test.com",
          subject: "Test email",
          messageId: "<msg1@test.com>",
        }),
      }),
    );
    expect(mockFindByKey).not.toHaveBeenCalled();
  });

  it("does not enqueue email_triage when raw MIME is missing from R2", async () => {
    mockR2Get.mockResolvedValue(null);
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1", emailHandle: "myagent" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockCreateEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox: "draft", isWhitelisted: false }),
    );
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("does not enqueue email_triage when reading raw MIME throws", async () => {
    mockR2Get.mockRejectedValue(new Error("R2 unavailable"));
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1", emailHandle: "myagent" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockCreateEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox: "draft", isWhitelisted: false }),
    );
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("does not enqueue email_triage when parsed MIME has no usable body or attachment metadata", async () => {
    const rawMime = [
      "From: sender@test.com",
      "To: myagent@alook.ai",
      "Subject: Test email",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "   ",
    ].join("\r\n");
    mockR2Get.mockResolvedValue({
      arrayBuffer: async () => new TextEncoder().encode(rawMime).buffer,
    });
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1", emailHandle: "myagent" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockCreateEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox: "draft", isWhitelisted: false }),
    );
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("enqueues email_triage when MIME only has usable attachment metadata", async () => {
    const rawMime = [
      "From: sender@test.com",
      "To: myagent@alook.ai",
      "Subject: Test email",
      "Content-Type: multipart/mixed; boundary=\"outer\"",
      "",
      "--outer",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=\"invoice.pdf\"",
      "",
      "fake-pdf",
      "--outer--",
    ].join("\r\n");
    mockR2Get.mockResolvedValue({
      arrayBuffer: async () => new TextEncoder().encode(rawMime).buffer,
    });
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1", emailHandle: "myagent" });
    mockCreateConversation.mockResolvedValue({ id: "conv_triage" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1",
      "conv_triage",
      "ws1",
      expect.stringContaining("sender@test.com"),
      "email_triage",
      expect.objectContaining({
        context: expect.objectContaining({
          attachmentSummaries: [
            expect.objectContaining({ filename: "invoice.pdf", type: "application/pdf" }),
          ],
        }),
      }),
    );
  });

  it("includes parsed MIME body and attachment summaries in email_triage context", async () => {
    const rawMime = [
      "From: sender@test.com",
      "To: myagent@alook.ai",
      "Subject: Test email",
      "Content-Type: multipart/mixed; boundary=\"outer\"",
      "",
      "--outer",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please review the attached invoice.",
      "--outer",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Please review the attached invoice.</p>",
      "--outer",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=\"invoice.pdf\"",
      "",
      "fake-pdf",
      "--outer--",
    ].join("\r\n");
    mockR2Get.mockResolvedValue({
      arrayBuffer: async () => new TextEncoder().encode(rawMime).buffer,
    });
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1", emailHandle: "myagent" });
    mockCreateConversation.mockResolvedValue({ id: "conv_triage" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockR2Get).toHaveBeenCalledWith("emails/fake/raw");
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1",
      "conv_triage",
      "ws1",
      expect.stringContaining("Please review the attached invoice."),
      "email_triage",
      expect.objectContaining({
        context: expect.objectContaining({
          bodyText: expect.stringContaining("Please review the attached invoice."),
          bodyHtml: expect.stringContaining("<p>Please review the attached invoice.</p>"),
          attachmentSummaries: [
            expect.objectContaining({ filename: "invoice.pdf", type: "application/pdf" }),
          ],
        }),
      }),
    );
  });

  it("still enqueues email_notification for whitelisted inbound email", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockCreateConversation.mockResolvedValue({ id: "conv_new" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1",
      "conv_new",
      "ws1",
      expect.any(String),
      "email_notification",
      expect.any(Object),
    );
  });

  it("does not enqueue triage when non-whitelisted agent has no runtime", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: null, ownerId: "u1" });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockCreateEmail).toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("does not enqueue triage when non-whitelisted agent has no ownerId", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: null });

    const res = await POST(makeNotifyReq({ ...baseBody, isWhitelisted: false }));
    expect(res.status).toBe(200);

    expect(mockCreateEmail).toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("stores whitelisted inbound email in the inbox mailbox", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" });
    mockCreateConversation.mockResolvedValue({ id: "conv_new" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeNotifyReq(baseBody));
    expect(res.status).toBe(200);

    expect(mockCreateEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox: "inbox", isWhitelisted: true }),
    );
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

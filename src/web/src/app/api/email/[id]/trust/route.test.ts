import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetEmailById = vi.fn();
const mockUpdateEmailWhitelisted = vi.fn();
const mockGetAgent = vi.fn();
const mockGetConversation = vi.fn();
const mockCreateConversation = vi.fn();
const mockCreateMessage = vi.fn();
const mockFindByKey = vi.fn();
const mockCreateMapping = vi.fn();
const mockEnqueueTask = vi.fn();
const mockGetUser = vi.fn();
const mockGetTask = vi.fn();

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
      agent: { getAgent: (...args: unknown[]) => mockGetAgent(...args) },
      email: {
        getEmailById: (...args: unknown[]) => mockGetEmailById(...args),
        updateEmailWhitelisted: (...args: unknown[]) => mockUpdateEmailWhitelisted(...args),
      },
      conversation: {
        getConversation: (...args: unknown[]) => mockGetConversation(...args),
        createConversation: (...args: unknown[]) => mockCreateConversation(...args),
      },
      message: {
        createMessage: (...args: unknown[]) => mockCreateMessage(...args),
        updateMessageTaskId: vi.fn().mockResolvedValue(undefined),
      },
      conversationMap: {
        findByKey: (...args: unknown[]) => mockFindByKey(...args),
        createMapping: (...args: unknown[]) => mockCreateMapping(...args),
      },
      user: { getUser: (...args: unknown[]) => mockGetUser(...args) },
      task: { getTask: (...args: unknown[]) => mockGetTask(...args) },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: Function) =>
    (req: NextRequest) =>
      handler(req, { userId: "u1", email: "u1@test.com", params: { id: req.url.split("/email/")[1]?.split("/")[0] } }),
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn().mockResolvedValue({ workspaceId: "ws1", memberRole: "owner" }),
}));

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (msg: string, status: number) => NextResponse.json({ error: msg }, { status }),
  };
});

vi.mock("@/lib/services/task", () => ({
  TaskService: class {
    enqueueTask(...args: any[]) { return mockEnqueueTask(...args); }
  },
}));

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api/responses", () => ({
  emailToResponse: (e: unknown) => e,
  taskToResponse: (t: unknown) => t,
}));

vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  cacheKeys: {
    overviewEmailStats: (wsId: string) => `email_stats:${wsId}`,
    overviewTaskStats: (wsId: string, d: string) => `task_stats:${wsId}:${d}`,
  },
}));

import { POST } from "./route";

const baseEmail = {
  id: "e1",
  agentId: "a1",
  workspaceId: "ws1",
  fromEmail: "sender@test.com",
  toEmail: "agent@alook.ai",
  subject: "Test email",
  r2Key: "emails/fake/raw",
  isWhitelisted: false,
  forwarded: false,
  messageId: "<msg1@test.com>",
  inReplyTo: "",
  references: "",
  direction: "inbound" as const,
  status: "unread",
};

const baseAgent = { id: "a1", workspaceId: "ws1", runtimeId: "r1", ownerId: "u1" };

function makeTrustReq(emailId: string) {
  return new NextRequest(`http://localhost/api/email/${emailId}/trust`, { method: "POST" });
}

describe("POST /api/email/[id]/trust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMessage.mockResolvedValue({ id: "m1", conversationId: "c1", role: "event", content: "", taskId: null, createdAt: "2026-01-01T00:00:00Z" });
    mockFindByKey.mockResolvedValue(null);
    mockCreateMapping.mockResolvedValue(undefined);
  });

  it("TC1: trusts an untrust email — 200, conversation created, task enqueued", async () => {
    mockGetEmailById.mockResolvedValue({ ...baseEmail });
    mockGetAgent.mockResolvedValue(baseAgent);
    mockUpdateEmailWhitelisted.mockResolvedValue({ ...baseEmail, isWhitelisted: true });
    mockCreateConversation.mockResolvedValue({ id: "conv_new" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeTrustReq("e1"));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.conversationId).toBe("conv_new");
    expect(json.email.isWhitelisted).toBe(true);

    expect(mockUpdateEmailWhitelisted).toHaveBeenCalledWith(expect.anything(), "e1", "ws1", true);
    expect(mockCreateConversation).toHaveBeenCalledOnce();
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_new", "ws1",
      expect.stringContaining("New email from sender@test.com"),
      "email_notification",
      expect.objectContaining({ contextKey: "conv_new" }),
    );
  });

  it("TC2: already trusted — 400", async () => {
    mockGetEmailById.mockResolvedValue({ ...baseEmail, isWhitelisted: true });

    const res = await POST(makeTrustReq("e1"));
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/already trusted/);

    expect(mockUpdateEmailWhitelisted).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it("TC3: outbound email — 400", async () => {
    mockGetEmailById.mockResolvedValue({ ...baseEmail, direction: "outbound" });

    const res = await POST(makeTrustReq("e1"));
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/only inbound/);
  });

  it("TC4: email not found — 404", async () => {
    mockGetEmailById.mockResolvedValue(null);

    const res = await POST(makeTrustReq("nonexistent"));
    expect(res.status).toBe(404);
  });

  it("TC5: agent has no runtime — 404", async () => {
    mockGetEmailById.mockResolvedValue({ ...baseEmail });
    mockGetAgent.mockResolvedValue({ ...baseAgent, runtimeId: null });

    const res = await POST(makeTrustReq("e1"));
    expect(res.status).toBe(404);

    expect(mockUpdateEmailWhitelisted).not.toHaveBeenCalled();
  });

  it("TC7: thread resolution — reply threads into existing conversation", async () => {
    const replyEmail = {
      ...baseEmail,
      id: "e_reply",
      messageId: "<reply1@test.com>",
      inReplyTo: "<msg1@test.com>",
      references: "<root@test.com> <msg1@test.com>",
    };
    mockGetEmailById.mockResolvedValue(replyEmail);
    mockGetAgent.mockResolvedValue(baseAgent);
    mockUpdateEmailWhitelisted.mockResolvedValue({ ...replyEmail, isWhitelisted: true });
    mockFindByKey.mockResolvedValue("conv_existing");
    mockGetConversation.mockResolvedValue({ id: "conv_existing", type: "email_notification", userId: "u1" });
    mockEnqueueTask.mockResolvedValue({ id: "t1" });

    const res = await POST(makeTrustReq("e_reply"));
    expect(res.status).toBe(200);

    expect(mockFindByKey).toHaveBeenCalledWith(
      expect.anything(),
      "email:a1:<root@test.com>",
      "ws1",
    );
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      "a1", "conv_existing", "ws1",
      expect.any(String),
      "email_notification",
      expect.objectContaining({ contextKey: "conv_existing" }),
    );
  });

  it("TC2b: idempotent — second trust call returns 400, no duplicate task", async () => {
    mockGetEmailById.mockResolvedValue({ ...baseEmail, isWhitelisted: true });

    const res = await POST(makeTrustReq("e1"));
    expect(res.status).toBe(400);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("TC5b: agent not found — 404", async () => {
    mockGetEmailById.mockResolvedValue({ ...baseEmail });
    mockGetAgent.mockResolvedValue(null);

    const res = await POST(makeTrustReq("e1"));
    expect(res.status).toBe(404);
  });
});

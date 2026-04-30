import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockGetAgentByHandle = vi.fn();
const mockCreateEmail = vi.fn();
const mockIsWhitelisted = vi.fn();
const mockGetEmailAccountsByAgent = vi.fn();
const mockGetEmailAccountScoped = vi.fn();
const mockEmailWorkerFetch = vi.fn();
const mockEmailBucketGet = vi.fn();
const mockEmailBucketPut = vi.fn();
const mockWorkerSelfRefFetch = vi.fn();
const mockCreateMapping = vi.fn();
const mockGetConversation = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_WORKER: { fetch: (...args: unknown[]) => mockEmailWorkerFetch(...args) },
      EMAIL_BUCKET: {
        get: (...args: unknown[]) => mockEmailBucketGet(...args),
        put: (...args: unknown[]) => mockEmailBucketPut(...args),
      },
      WORKER_SELF_REFERENCE: { fetch: (...args: unknown[]) => mockWorkerSelfRefFetch(...args) },
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
      email: {
        createEmail: (...args: unknown[]) => mockCreateEmail(...args),
      },
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
        getAgentByHandle: (...args: unknown[]) => mockGetAgentByHandle(...args),
      },
      whitelist: {
        isWhitelisted: (...args: unknown[]) => mockIsWhitelisted(...args),
      },
      emailAccount: {
        getEmailAccountsByAgent: (...args: unknown[]) => mockGetEmailAccountsByAgent(...args),
        getEmailAccountScoped: (...args: unknown[]) => mockGetEmailAccountScoped(...args),
      },
      conversation: {
        getConversation: (...args: unknown[]) => mockGetConversation(...args),
      },
      conversationMap: {
        createMapping: (...args: unknown[]) => mockCreateMapping(...args),
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "ws1" })),
}));

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  const actual = await vi.importActual("@/lib/middleware/helpers");
  return {
    ...actual,
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

vi.mock("@/lib/api/responses", () => ({
  emailToResponse: (e: any) => e,
}));

import { POST } from "./route";

function makeReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/email/send", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends email via EMAIL_WORKER and returns the created record", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
    mockEmailWorkerFetch.mockResolvedValue(
      Response.json({ ok: true, r2Key: "emails/abc/raw" }),
    );
    mockCreateEmail.mockResolvedValue({
      id: "e1", agentId: "a1", fromEmail: "test-agent@alook.ai",
      toEmail: "user@example.com", subject: "Hello",
    });

    const req = makeReq({
      agentId: "a1",
      to: "user@example.com",
      subject: "Hello",
      htmlBody: "<p>Hi there</p>",
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(200);

    // Verify EMAIL_WORKER was called
    expect(mockEmailWorkerFetch).toHaveBeenCalledOnce();
    const [url, init] = mockEmailWorkerFetch.mock.calls[0];
    expect(url).toBe("http://internal/send/agent");
    expect(init.method).toBe("POST");
    const fetchBody = JSON.parse(init.body);
    expect(fetchBody.agentId).toBe("a1");
    expect(fetchBody.to).toBe("user@example.com");
    expect(fetchBody.subject).toBe("Hello");
    expect(fetchBody.htmlBody).toBe("<p>Hi there</p>");
    expect(fetchBody.attachmentKeys).toBeUndefined();

    // Verify DB record created with r2Key from email worker
    expect(mockCreateEmail).toHaveBeenCalledOnce();
    const createArgs = mockCreateEmail.mock.calls[0]![1] as any;
    expect(createArgs.r2Key).toBe("emails/abc/raw");
  });

  it("sends email with attachments via EMAIL_WORKER", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
    mockEmailWorkerFetch.mockResolvedValue(
      Response.json({ ok: true, r2Key: "emails/def/raw" }),
    );
    mockCreateEmail.mockResolvedValue({ id: "e1" });

    const attachments = [
      { key: "emails/drafts/x/doc.txt", filename: "doc.txt", size: 12, contentType: "text/plain" },
    ];

    const req = makeReq({
      agentId: "a1",
      to: "user@example.com",
      subject: "With attachment",
      htmlBody: "<p>See attached</p>",
      attachments,
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(200);

    // Verify attachmentKeys sent to email worker
    const fetchBody = JSON.parse(mockEmailWorkerFetch.mock.calls[0][1].body);
    expect(fetchBody.attachmentKeys).toEqual([
      { key: "emails/drafts/x/doc.txt", filename: "doc.txt", contentType: "text/plain" },
    ]);

    // Verify full attachments stored in DB record
    const createArgs = mockCreateEmail.mock.calls[0]![1] as any;
    expect(createArgs.attachments).toBe(JSON.stringify(attachments));
  });

  it("returns error when EMAIL_WORKER fails", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
    mockEmailWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "agent not found" }), { status: 404 }),
    );

    const req = makeReq({
      agentId: "a1",
      to: "user@example.com",
      subject: "Hello",
      htmlBody: "<p>Hi</p>",
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(404);
  });

  it("returns 400 when agent has no emailHandle", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: null });

    const req = makeReq({
      agentId: "a1",
      to: "user@example.com",
      subject: "Hello",
      htmlBody: "<p>Hi</p>",
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(400);
  });

  it("returns 404 when agent not in workspace", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = makeReq({
      agentId: "a1",
      to: "user@example.com",
      subject: "Hello",
      htmlBody: "<p>Hi</p>",
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(404);
  });

  it("returns 400 when required fields are missing", async () => {
    const req = makeReq({ agentId: "a1" });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(400);
  });

  // --- Local delivery tests ---

  describe("local delivery shortcut", () => {
    it("delivers locally when recipient is same-workspace @alook.ai agent", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(true);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1", direction: "outbound" });

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "Hello local",
        htmlBody: "<p>Internal</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);

      expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
      expect(mockWorkerSelfRefFetch).toHaveBeenCalledOnce();

      const [url, init] = mockWorkerSelfRefFetch.mock.calls[0];
      expect(url).toBe("http://internal/api/email/notify");
      const payload = JSON.parse(init.body);
      expect(payload.agentId).toBe("a2");
      expect(payload.workspaceId).toBe("ws1");
      expect(payload.from).toBe("sender-agent@alook.ai");
      expect(payload.to).toBe("agent-b@alook.ai");
      expect(payload.subject).toBe("Hello local");
      expect(payload.forwarded).toBe(false);
      expect(payload.r2Key).toMatch(/^emails\/.+\/raw$/);

      expect(mockCreateEmail).toHaveBeenCalledOnce();
      const createArgs = mockCreateEmail.mock.calls[0]![1] as any;
      expect(createArgs.direction).toBe("outbound");
      expect(createArgs.toEmail).toBe("agent-b@alook.ai");
    });

    it("falls through to EMAIL_WORKER when recipient is in different workspace", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws-other" });
      mockEmailWorkerFetch.mockResolvedValue(Response.json({ ok: true, r2Key: "emails/x/raw" }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "Cross workspace",
        htmlBody: "<p>Hi</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);

      expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
      expect(mockEmailWorkerFetch).toHaveBeenCalledOnce();
    });

    it("falls through to EMAIL_WORKER when handle doesn't resolve to any agent", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue(null);
      mockEmailWorkerFetch.mockResolvedValue(Response.json({ ok: true, r2Key: "emails/x/raw" }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "nonexistent@alook.ai",
        subject: "No agent",
        htmlBody: "<p>Hi</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);

      expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
      expect(mockEmailWorkerFetch).toHaveBeenCalledOnce();
    });

    it("falls through to EMAIL_WORKER when recipient is not @alook.ai", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockEmailWorkerFetch.mockResolvedValue(Response.json({ ok: true, r2Key: "emails/x/raw" }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "user@gmail.com",
        subject: "External",
        htmlBody: "<p>Hi</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);

      expect(mockGetAgentByHandle).not.toHaveBeenCalled();
      expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
      expect(mockEmailWorkerFetch).toHaveBeenCalledOnce();
    });

    it("allows self-send via local delivery", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "sender-agent@alook.ai",
        subject: "Self",
        htmlBody: "<p>Self</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);

      expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
      expect(mockWorkerSelfRefFetch).toHaveBeenCalledOnce();
    });

    it("fetches attachments from R2 and includes them in MIME for local delivery", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const fileContent = new TextEncoder().encode("hello file");
      mockEmailBucketGet.mockResolvedValue({
        arrayBuffer: () => Promise.resolve(fileContent.buffer),
      });
      mockEmailBucketPut.mockResolvedValue(undefined);

      const attachments = [
        { key: "emails/drafts/x/doc.txt", filename: "doc.txt", size: 10, contentType: "text/plain" },
      ];

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "With file",
        htmlBody: "<p>See attached</p>",
        attachments,
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);

      expect(mockEmailBucketGet).toHaveBeenCalledWith("emails/drafts/x/doc.txt");
      expect(mockEmailBucketPut).toHaveBeenCalledOnce();
      const [putKey, putBody, putOpts] = mockEmailBucketPut.mock.calls[0];
      expect(putKey).toMatch(/^emails\/.+\/raw$/);
      expect(putBody).toContain("multipart/mixed");
      expect(putBody).toContain('filename="doc.txt"');
      expect(putOpts.httpMetadata.contentType).toBe("message/rfc822");
    });

    it("checks whitelist and passes result in notify payload", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(true);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "Whitelist test",
        htmlBody: "<p>Check</p>",
      });

      await POST(req, {} as any);

      expect(mockIsWhitelisted).toHaveBeenCalledWith(
        expect.anything(), "a2", "ws1", "sender-agent@alook.ai"
      );
      const payload = JSON.parse(mockWorkerSelfRefFetch.mock.calls[0][1].body);
      expect(payload.isWhitelisted).toBe(true);
    });

    it("notify payload matches expected schema shape", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "Schema test",
        htmlBody: "<p>Schema</p>",
        inReplyTo: "<orig@alook.ai>",
        references: "<ref1@alook.ai> <ref2@alook.ai>",
      });

      await POST(req, {} as any);

      const payload = JSON.parse(mockWorkerSelfRefFetch.mock.calls[0][1].body);
      expect(payload.agentId).toBe("a2");
      expect(payload.workspaceId).toBe("ws1");
      expect(payload.from).toBe("sender-agent@alook.ai");
      expect(payload.to).toBe("agent-b@alook.ai");
      expect(payload.subject).toBe("Schema test");
      expect(payload.forwarded).toBe(false);
      expect(payload.isWhitelisted).toBe(false);
      expect(payload.r2Key).toMatch(/^emails\/.+\/raw$/);
      expect(payload.messageId).toMatch(/^<.+@alook\.ai>$/);
      expect(payload.inReplyTo).toBe("<orig@alook.ai>");
      expect(payload.references).toBe("<ref1@alook.ai> <ref2@alook.ai>");
    });

    it("generates correct messageId and r2Key in outbound record", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "IDs test",
        htmlBody: "<p>IDs</p>",
      });

      await POST(req, {} as any);

      const createArgs = mockCreateEmail.mock.calls[0]![1] as any;
      expect(createArgs.messageId).toMatch(/^<.+@alook\.ai>$/);
      expect(createArgs.r2Key).toMatch(/^emails\/.+\/raw$/);
    });

    it("skips local delivery when sender uses custom SMTP account", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetEmailAccountsByAgent.mockResolvedValue([
        { id: "acct1", emailAddress: "agent@company.com" },
      ]);
      mockEmailWorkerFetch.mockResolvedValue(Response.json({ ok: true, r2Key: "emails/x/raw" }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        from: "agent@company.com",
        to: "agent-b@alook.ai",
        subject: "Custom SMTP",
        htmlBody: "<p>Custom</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);

      expect(mockGetAgentByHandle).not.toHaveBeenCalled();
      expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
      expect(mockEmailWorkerFetch).toHaveBeenCalledOnce();
    });

    it("returns error when notify endpoint fails and does NOT create outbound record", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockEmailBucketPut.mockResolvedValue(undefined);
      mockWorkerSelfRefFetch.mockResolvedValue(
        new Response("notify validation error", { status: 400 }),
      );

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "Fail notify",
        htmlBody: "<p>Fail</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain("local delivery failed");
      expect(mockCreateEmail).not.toHaveBeenCalled();
    });
  });

  describe("conversation_map mapping creation", () => {
    it("creates mapping on local delivery when conversationId is provided", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });
      mockGetConversation.mockResolvedValue({ id: "conv_123" });

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "Map test",
        htmlBody: "<p>Map</p>",
        conversationId: "conv_123",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);
      expect(mockCreateMapping).toHaveBeenCalledOnce();
      const args = mockCreateMapping.mock.calls[0]![1] as any;
      expect(args.workspaceId).toBe("ws1");
      expect(args.conversationId).toBe("conv_123");
      expect(args.key).toMatch(/^email:a1:/);
    });

    it("does NOT create mapping on local delivery without conversationId", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "No map",
        htmlBody: "<p>No map</p>",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);
      expect(mockCreateMapping).not.toHaveBeenCalled();
    });

    it("creates mapping on remote delivery when conversationId and messageId are provided", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
      mockEmailWorkerFetch.mockResolvedValue(
        Response.json({ ok: true, r2Key: "emails/abc/raw", messageId: "<msg1@worker.com>" }),
      );
      mockCreateEmail.mockResolvedValue({ id: "e1" });
      mockGetConversation.mockResolvedValue({ id: "conv_456" });

      const req = makeReq({
        agentId: "a1",
        to: "user@example.com",
        subject: "Remote map",
        htmlBody: "<p>Remote</p>",
        conversationId: "conv_456",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);
      expect(mockCreateMapping).toHaveBeenCalledOnce();
      const args = mockCreateMapping.mock.calls[0]![1] as any;
      expect(args.workspaceId).toBe("ws1");
      expect(args.conversationId).toBe("conv_456");
      expect(args.key).toBe("email:a1:<msg1@worker.com>");
    });

    it("does NOT create mapping when conversationId does not belong to workspace", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
      mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
      mockIsWhitelisted.mockResolvedValue(false);
      mockWorkerSelfRefFetch.mockResolvedValue(Response.json({ ok: true }));
      mockCreateEmail.mockResolvedValue({ id: "e1" });
      mockGetConversation.mockResolvedValue(null);

      const req = makeReq({
        agentId: "a1",
        to: "agent-b@alook.ai",
        subject: "Bad conv",
        htmlBody: "<p>Bad</p>",
        conversationId: "conv_other_workspace",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);
      expect(mockCreateMapping).not.toHaveBeenCalled();
    });

    it("does NOT create mapping on remote delivery when messageId is undefined", async () => {
      mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
      mockEmailWorkerFetch.mockResolvedValue(
        Response.json({ ok: true, r2Key: "emails/abc/raw" }),
      );
      mockCreateEmail.mockResolvedValue({ id: "e1" });
      mockGetConversation.mockResolvedValue({ id: "conv_456" });

      const req = makeReq({
        agentId: "a1",
        to: "user@example.com",
        subject: "Remote no msgid",
        htmlBody: "<p>No id</p>",
        conversationId: "conv_456",
      });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(200);
      expect(mockCreateMapping).not.toHaveBeenCalled();
    });
  });
});

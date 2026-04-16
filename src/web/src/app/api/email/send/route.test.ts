import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockCreateEmail = vi.fn();
const mockEmailWorkerFetch = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_WORKER: { fetch: (...args: unknown[]) => mockEmailWorkerFetch(...args) },
    },
  })),
}));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    email: {
      createEmail: (...args: unknown[]) => mockCreateEmail(...args),
    },
    agent: {
      getAgent: (...args: unknown[]) => mockGetAgent(...args),
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
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "ws1" })),
}));

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server");
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

vi.mock("@/lib/api/responses", () => ({
  emailToResponse: (e: any) => e,
}));

import { POST } from "./route";

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

    const req = new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a1",
        to: "user@example.com",
        subject: "Hello",
        htmlBody: "<p>Hi there</p>",
      }),
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

    const req = new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a1",
        to: "user@example.com",
        subject: "With attachment",
        htmlBody: "<p>See attached</p>",
        attachments,
      }),
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

    const req = new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a1",
        to: "user@example.com",
        subject: "Hello",
        htmlBody: "<p>Hi</p>",
      }),
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(404);
  });

  it("returns 400 when agent has no emailHandle", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: null });

    const req = new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a1",
        to: "user@example.com",
        subject: "Hello",
        htmlBody: "<p>Hi</p>",
      }),
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(400);
  });

  it("returns 404 when agent not in workspace", async () => {
    mockGetAgent.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a1",
        to: "user@example.com",
        subject: "Hello",
        htmlBody: "<p>Hi</p>",
      }),
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(404);
  });

  it("returns 400 when required fields are missing", async () => {
    const req = new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
      method: "POST",
      body: JSON.stringify({ agentId: "a1" }),
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(400);
  });
});

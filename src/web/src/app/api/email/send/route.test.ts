import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgentInWorkspace = vi.fn();
const mockCreateEmail = vi.fn();
const mockR2Put = vi.fn();
const mockR2Get = vi.fn();
const mockSendEmailSend = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_BUCKET: {
        put: (...args: unknown[]) => mockR2Put(...args),
        get: (...args: unknown[]) => mockR2Get(...args),
      },
      SEND_EMAIL: { send: (...args: unknown[]) => mockSendEmailSend(...args) },
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
      getAgentInWorkspace: (...args: unknown[]) => mockGetAgentInWorkspace(...args),
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

  it("sends an email and returns the created record", async () => {
    mockGetAgentInWorkspace.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
    mockCreateEmail.mockResolvedValue({
      id: "e1", agentId: "a1", fromEmail: "test-agent@alook.ai",
      toEmail: "user@example.com", subject: "Hello",
    });
    mockR2Put.mockResolvedValue(undefined);
    mockSendEmailSend.mockResolvedValue({ messageId: "msg1" });

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
    expect(mockSendEmailSend).toHaveBeenCalled();
    expect(mockR2Put).toHaveBeenCalled();
    expect(mockCreateEmail).toHaveBeenCalled();

    // Verify single-part message (no boundary)
    const r2Content = mockR2Put.mock.calls[0]![1] as string;
    expect(r2Content).toContain("Content-Type: text/html; charset=utf-8");
    expect(r2Content).not.toContain("multipart");
  });

  it("sends email with attachments as MIME multipart/mixed", async () => {
    mockGetAgentInWorkspace.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
    mockCreateEmail.mockResolvedValue({ id: "e1" });
    mockR2Put.mockResolvedValue(undefined);
    mockSendEmailSend.mockResolvedValue({ messageId: "msg1" });
    mockR2Get.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("file content").buffer),
    });

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

    // Verify MIME multipart message stored in R2
    const r2Content = mockR2Put.mock.calls[0]![1] as string;
    expect(r2Content).toContain("multipart/mixed");
    expect(r2Content).toContain("Content-Disposition: attachment; filename=\"doc.txt\"");
    expect(r2Content).toContain("Content-Transfer-Encoding: base64");

    // Verify attachments passed to createEmail
    const createArgs = mockCreateEmail.mock.calls[0]![1] as any;
    expect(createArgs.attachments).toBe(JSON.stringify(attachments));
  });

  it("skips missing R2 attachments gracefully", async () => {
    mockGetAgentInWorkspace.mockResolvedValue({ id: "a1", emailHandle: "test-agent" });
    mockCreateEmail.mockResolvedValue({ id: "e1" });
    mockR2Put.mockResolvedValue(undefined);
    mockSendEmailSend.mockResolvedValue({ messageId: "msg1" });
    mockR2Get.mockResolvedValue(null); // R2 object not found

    const req = new NextRequest("http://localhost/api/email/send?workspace_id=ws1", {
      method: "POST",
      body: JSON.stringify({
        agentId: "a1",
        to: "user@example.com",
        subject: "Missing attachment",
        htmlBody: "<p>Oops</p>",
        attachments: [
          { key: "emails/drafts/gone/file.pdf", filename: "file.pdf", size: 100, contentType: "application/pdf" },
        ],
      }),
    });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(200);
  });

  it("returns 400 when agent has no emailHandle", async () => {
    mockGetAgentInWorkspace.mockResolvedValue({ id: "a1", emailHandle: null });

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
    mockGetAgentInWorkspace.mockResolvedValue(null);

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

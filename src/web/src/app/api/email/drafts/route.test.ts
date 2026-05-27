import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockGetEmailById = vi.fn();
const mockCreateEmail = vi.fn();
const mockGetEmailAccountScoped = vi.fn();

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
        getEmailById: (...args: unknown[]) => mockGetEmailById(...args),
        createEmail: (...args: unknown[]) => mockCreateEmail(...args),
      },
      emailAccount: {
        getEmailAccountScoped: (...args: unknown[]) => mockGetEmailAccountScoped(...args),
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
  emailToResponse: (e: any) => ({
    id: e.id,
    direction: e.direction,
    mailbox: e.mailbox,
    status: e.status,
    to_email: e.toEmail,
    in_reply_to: e.inReplyTo,
    references: e.references,
  }),
}));

import { POST } from "./route";

function makeReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/email/drafts?workspace_id=ws1", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/email/drafts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an outbound draft reply linked to an inbound email", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "agent" });
    mockGetEmailById.mockResolvedValue({
      id: "parent1",
      messageId: "<parent@example.com>",
      references: "<root@example.com>",
      fromEmail: "sender@example.com",
      toEmail: "agent@alook.ai",
    });
    mockCreateEmail.mockResolvedValue({
      id: "draft1",
      direction: "outbound",
      mailbox: "draft",
      status: "draft",
      toEmail: "sender@example.com",
      inReplyTo: "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
    });

    const res = await POST(makeReq({
      agentId: "a1",
      to: "sender@example.com",
      subject: "Re: Hello",
      htmlBody: "<p>Draft reply</p>",
      inReplyToEmailId: "parent1",
    }), {} as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mailbox).toBe("draft");
    expect(body.status).toBe("draft");
    expect(mockCreateEmail).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        fromEmail: "agent@alook.ai",
        direction: "outbound",
        mailbox: "draft",
        status: "draft",
        r2Key: "",
        inReplyTo: "<parent@example.com>",
        references: "<root@example.com> <parent@example.com>",
      }),
    );
  });

  it("returns 404 when the parent email is outside the workspace", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "agent" });
    mockGetEmailById.mockResolvedValue(null);

    const res = await POST(makeReq({
      agentId: "a1",
      to: "sender@example.com",
      subject: "Re: Hello",
      htmlBody: "<p>Draft reply</p>",
      inReplyToEmailId: "parent1",
    }), {} as any);

    expect(res.status).toBe(404);
    expect(mockCreateEmail).not.toHaveBeenCalled();
  });

  it("creates an outbound draft from a custom mailbox", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "agent" });
    mockGetEmailAccountScoped.mockResolvedValue({
      id: "acct1",
      agentId: "a1",
      emailAddress: "agent@company.com",
    });
    mockCreateEmail.mockResolvedValue({
      id: "draft1",
      direction: "outbound",
      mailbox: "draft",
      status: "draft",
      fromEmail: "agent@company.com",
      toEmail: "sender@example.com",
    });

    const res = await POST(makeReq({
      agentId: "a1",
      customAccountId: "acct1",
      to: "sender@example.com",
      subject: "Re: Hello",
      htmlBody: "<p>Draft reply</p>",
    }), {} as any);

    expect(res.status).toBe(200);
    expect(mockCreateEmail).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        fromEmail: "agent@company.com",
        mailbox: "draft",
        status: "draft",
      }),
    );
  });
});

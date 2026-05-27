import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAgent = vi.fn();
const mockGetAgentByHandle = vi.fn();
const mockClaimDraftForSend = vi.fn();
const mockFinalizeDraftSend = vi.fn();
const mockRestoreDraftAfterSendFailure = vi.fn();
const mockMarkDraftSendUnknown = vi.fn();
const mockEmailWorkerFetch = vi.fn();
const mockEmailBucketGet = vi.fn();
const mockEmailBucketPut = vi.fn();
const mockWorkerSelfRefFetch = vi.fn();
const mockIsWhitelisted = vi.fn();
const mockGetEmailAccountsByAgent = vi.fn();
const mockGetEmailAccountScoped = vi.fn();

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

vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: string, _ttl: number, fn: () => Promise<any>) => fn()),
  invalidate: vi.fn(() => Promise.resolve()),
  cacheKeys: {
    allEmailAccounts: (ws: string) => `ea:${ws}`,
    overviewEmailStats: (ws: string) => `ov_email:${ws}`,
  },
}));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      email: {
        claimDraftForSend: (...args: unknown[]) => mockClaimDraftForSend(...args),
        finalizeDraftSend: (...args: unknown[]) => mockFinalizeDraftSend(...args),
        restoreDraftAfterSendFailure: (...args: unknown[]) => mockRestoreDraftAfterSendFailure(...args),
        markDraftSendUnknown: (...args: unknown[]) => mockMarkDraftSendUnknown(...args),
      },
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
        getAgentByHandle: (...args: unknown[]) => mockGetAgentByHandle(...args),
      },
      whitelist: {
        isWhitelisted: (...args: unknown[]) => mockIsWhitelisted(...args),
      },
      emailAccount: {
        getEmailAccountScoped: (...args: unknown[]) => mockGetEmailAccountScoped(...args),
        getAllEmailAccountsForWorkspace: (...args: unknown[]) => mockGetEmailAccountsByAgent(...args),
      },
      conversation: {
        getConversation: vi.fn(),
      },
      conversationMap: {
        createMapping: vi.fn(),
      },
      message: {
        createMessage: vi.fn(),
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

function claimedDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft1",
    agentId: "a1",
    workspaceId: "ws1",
    direction: "outbound",
    mailbox: "draft",
    status: "sending",
    fromEmail: "test-agent@alook.ai",
    toEmail: "user@example.com",
    subject: "Draft subject",
    htmlBody: "<p>Draft body</p>",
    inReplyTo: "",
    references: "",
    attachments: "[]",
    ...overrides,
  };
}

function sendDraftReq() {
  return makeReq({
    agentId: "a1",
    draftEmailId: "draft1",
    to: "ignored@example.com",
    subject: "Ignored",
    htmlBody: "<p>Ignored</p>",
  });
}

describe("POST /api/email/send draft state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "test-agent", workspaceId: "ws1" });
    mockEmailBucketPut.mockResolvedValue(undefined);
  });

  it("claims an outbound draft before external delivery and finalizes it", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft());
    mockEmailWorkerFetch.mockResolvedValue(
      Response.json({ ok: true, r2Key: "emails/draft/raw", messageId: "<sent@example.com>" }),
    );
    mockFinalizeDraftSend.mockResolvedValue({ id: "draft1", mailbox: "sent", status: "sent" });

    const res = await POST(sendDraftReq(), {} as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mailbox).toBe("sent");
    expect(mockClaimDraftForSend).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockEmailWorkerFetch).toHaveBeenCalledOnce();
    expect(mockFinalizeDraftSend).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
      patch: expect.objectContaining({
        r2Key: "emails/draft/raw",
        status: "sent",
        mailbox: "sent",
      }),
    });
  });

  it("does not send when a draft cannot be claimed", async () => {
    mockClaimDraftForSend.mockResolvedValue(null);

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(409);
    expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
    expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
    expect(mockFinalizeDraftSend).not.toHaveBeenCalled();
  });

  it("uses a custom draft sender identity when sending", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({ fromEmail: "agent@company.com" }));
    mockGetEmailAccountsByAgent.mockResolvedValue([
      { id: "acct1", agentId: "a1", emailAddress: "agent@company.com" },
    ]);
    mockEmailWorkerFetch.mockResolvedValue(
      Response.json({ ok: true, r2Key: "emails/draft/raw", messageId: "<sent@example.com>" }),
    );
    mockFinalizeDraftSend.mockResolvedValue({ id: "draft1", mailbox: "sent", status: "sent" });

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(200);
    const fetchBody = JSON.parse(mockEmailWorkerFetch.mock.calls[0][1].body);
    expect(fetchBody.customAccountId).toBe("acct1");
  });

  it("restores a claimed draft when sender resolution returns an error", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({ fromEmail: "missing@company.com" }));
    mockGetEmailAccountsByAgent.mockResolvedValue([]);

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(400);
    expect(mockRestoreDraftAfterSendFailure).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
  });

  it("restores a claimed draft when sender resolution throws", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({ fromEmail: "agent@company.com" }));
    mockGetEmailAccountsByAgent.mockRejectedValue(new Error("db failed"));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockRestoreDraftAfterSendFailure).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
  });

  it("restores a claimed draft when attachment JSON parse fails before external delivery", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({ attachments: "not-json" }));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockRestoreDraftAfterSendFailure).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockMarkDraftSendUnknown).not.toHaveBeenCalled();
    expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
  });

  it("restores a claimed draft when local getAgentByHandle throws before notify", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({
      fromEmail: "sender-agent@alook.ai",
      toEmail: "agent-b@alook.ai",
    }));
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
    mockGetAgentByHandle.mockRejectedValue(new Error("lookup failed"));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockRestoreDraftAfterSendFailure).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
  });

  it("restores a claimed draft when whitelist lookup throws before local notify", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({
      fromEmail: "sender-agent@alook.ai",
      toEmail: "agent-b@alook.ai",
    }));
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
    mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
    mockIsWhitelisted.mockRejectedValue(new Error("whitelist failed"));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockRestoreDraftAfterSendFailure).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
  });

  it("restores a claimed draft when local R2 preparation fails before notify", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({
      fromEmail: "sender-agent@alook.ai",
      toEmail: "agent-b@alook.ai",
    }));
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
    mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
    mockEmailBucketPut.mockRejectedValue(new Error("r2 failed"));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockRestoreDraftAfterSendFailure).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockMarkDraftSendUnknown).not.toHaveBeenCalled();
    expect(mockWorkerSelfRefFetch).not.toHaveBeenCalled();
  });

  it("marks a claimed draft send_unknown when email worker returns non-2xx", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft());
    mockEmailWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "smtp failed" }), { status: 500 }),
    );

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockMarkDraftSendUnknown).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockRestoreDraftAfterSendFailure).not.toHaveBeenCalled();
  });

  it("marks a claimed draft send_unknown when local notify returns non-2xx", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft({
      fromEmail: "sender-agent@alook.ai",
      toEmail: "agent-b@alook.ai",
    }));
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "sender-agent", workspaceId: "ws1" });
    mockGetAgentByHandle.mockResolvedValue({ id: "a2", emailHandle: "agent-b", workspaceId: "ws1" });
    mockIsWhitelisted.mockResolvedValue(true);
    mockWorkerSelfRefFetch.mockResolvedValue(new Response("notify failed", { status: 500 }));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockMarkDraftSendUnknown).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockRestoreDraftAfterSendFailure).not.toHaveBeenCalled();
  });

  it("marks a claimed draft send_unknown when worker success response is not JSON", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft());
    mockEmailWorkerFetch.mockResolvedValue(new Response("not json", { status: 200 }));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(502);
    expect(mockMarkDraftSendUnknown).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
  });

  it("marks a claimed draft send_unknown when finalize cannot transition after delivery", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft());
    mockEmailWorkerFetch.mockResolvedValue(
      Response.json({ ok: true, r2Key: "emails/draft/raw", messageId: "<sent@example.com>" }),
    );
    mockFinalizeDraftSend.mockResolvedValue(null);

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(409);
    expect(mockMarkDraftSendUnknown).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
  });

  it("marks a claimed draft send_unknown when finalize throws after delivery", async () => {
    mockClaimDraftForSend.mockResolvedValue(claimedDraft());
    mockEmailWorkerFetch.mockResolvedValue(
      Response.json({ ok: true, r2Key: "emails/draft/raw", messageId: "<sent@example.com>" }),
    );
    mockFinalizeDraftSend.mockRejectedValue(new Error("db failed"));

    const res = await POST(sendDraftReq(), {} as any);

    expect(res.status).toBe(500);
    expect(mockMarkDraftSendUnknown).toHaveBeenCalledWith({}, {
      id: "draft1",
      agentId: "a1",
      workspaceId: "ws1",
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockEmailWorkerFetch = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: { DB: {}, ENCRYPTION_KEY: "test-key", EMAIL_WORKER: { fetch: mockEmailWorkerFetch } },
  })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@alook/shared/crypto", () => ({ encrypt: vi.fn((v: string) => `enc(${v})`) }));

const mockGetAgent = vi.fn();
const mockGetAccounts = vi.fn();
const mockCreateAccount = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
      emailAccount: {
        getEmailAccountsByAgent: (...a: unknown[]) => mockGetAccounts(...a),
        createEmailAccount: (...a: unknown[]) => mockCreateAccount(...a),
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
vi.mock("@/lib/cache", () => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  cacheKeys: {
    allEmailAccounts: (w: string) => `ea:${w}`,
    overviewEmailAccounts: (w: string) => `ov_ea:${w}`,
  },
}));

import { GET, POST } from "./route";

const ACCOUNT_ROW = {
  id: "acc1", agentId: "a1", workspaceId: "w1", emailAddress: "x@t.com", displayName: "X",
  imapHost: "imap", imapPort: 993, imapTls: 1, smtpHost: "smtp", smtpPort: 465, smtpTls: 1,
  pollIntervalSeconds: 60, lastSyncedAt: null, status: "active", errorMessage: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

const VALID_BODY = {
  emailAddress: "x@t.com", displayName: "X", imapHost: "imap", imapPort: 993,
  imapUsername: "u", imapPassword: "p", imapTls: true, smtpHost: "smtp", smtpPort: 465,
  smtpUsername: "su", smtpPassword: "sp", smtpTls: 1, pollIntervalSeconds: 60,
};

beforeEach(() => vi.clearAllMocks());

describe("GET /api/agents/[id]/email-accounts", () => {
  it("lists accounts scoped to agent + workspace", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockGetAccounts.mockResolvedValue([ACCOUNT_ROW]);
    const req = new NextRequest("http://localhost/api/agents/a1/email-accounts");
    const res = await GET(req, { params: { id: "a1" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body[0].id).toBe("acc1");
    expect(mockGetAccounts).toHaveBeenCalledWith({}, "a1", "w1");
  });

  it("400 when agent id missing", async () => {
    const req = new NextRequest("http://localhost/api/agents/x/email-accounts");
    const res = await GET(req, { params: {} });
    expect(res.status).toBe(400);
  });

  it("404 when agent not in workspace", async () => {
    mockGetAgent.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/agents/a1/email-accounts");
    const res = await GET(req, { params: { id: "a1" } });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/agents/[id]/email-accounts", () => {
  function post(body: unknown) {
    return POST(
      new NextRequest("http://localhost/api/agents/a1/email-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: { id: "a1" } },
    );
  }

  it("creates an account, encrypts credentials, starts the worker (201)", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    mockCreateAccount.mockResolvedValue(ACCOUNT_ROW);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(201);
    const createArgs = mockCreateAccount.mock.calls[0]![1] as Record<string, unknown>;
    expect(createArgs.workspaceId).toBe("w1");
    expect(createArgs.imapPassword).toBe("enc(p)");
    expect(mockEmailWorkerFetch).toHaveBeenCalled();
  });

  it("404 when agent not in workspace", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(404);
  });

  it("400 on invalid body", async () => {
    mockGetAgent.mockResolvedValue({ id: "a1" });
    const res = await post({ emailAddress: "x@t.com" });
    expect(res.status).toBe(400);
  });
});

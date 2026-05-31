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

const mockGetScoped = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      emailAccount: {
        getEmailAccountScoped: (...a: unknown[]) => mockGetScoped(...a),
        updateEmailAccount: (...a: unknown[]) => mockUpdate(...a),
        deleteEmailAccount: (...a: unknown[]) => mockDelete(...a),
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

import { PATCH, DELETE } from "./route";

const ROW = {
  id: "acc1", agentId: "a1", workspaceId: "w1", emailAddress: "x@t.com", displayName: "X",
  imapHost: "imap", imapPort: 993, imapTls: 1, smtpHost: "smtp", smtpPort: 465, smtpTls: 1,
  pollIntervalSeconds: 60, lastSyncedAt: null, status: "active", errorMessage: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

beforeEach(() => vi.clearAllMocks());

const params = { id: "a1", accountId: "acc1" };

describe("PATCH /api/agents/[id]/email-accounts/[accountId]", () => {
  function patch(body: unknown, p = params) {
    return PATCH(
      new NextRequest("http://localhost/api/agents/a1/email-accounts/acc1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: p },
    );
  }

  it("updates a scoped account (display name only, no worker restart)", async () => {
    mockGetScoped.mockResolvedValue(ROW);
    mockUpdate.mockResolvedValue(ROW);
    const res = await patch({ displayName: "New" });
    expect(res.status).toBe(200);
    expect(mockGetScoped).toHaveBeenCalledWith({}, "acc1", "a1", "w1");
    expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
  });

  it("restarts the worker when credentials change", async () => {
    mockGetScoped.mockResolvedValue(ROW);
    mockUpdate.mockResolvedValue(ROW);
    const res = await patch({ imapPassword: "newpass" });
    expect(res.status).toBe(200);
    // stop + start
    expect(mockEmailWorkerFetch).toHaveBeenCalledTimes(2);
  });

  it("400 when params missing", async () => {
    const res = await patch({ displayName: "x" }, { id: "a1" } as any);
    expect(res.status).toBe(400);
  });

  it("404 when account not scoped to agent/workspace (IDOR guard)", async () => {
    mockGetScoped.mockResolvedValue(null);
    const res = await patch({ displayName: "x" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/agents/[id]/email-accounts/[accountId]", () => {
  function del(p = params) {
    return DELETE(
      new NextRequest("http://localhost/api/agents/a1/email-accounts/acc1", { method: "DELETE" }),
      { params: p },
    );
  }

  it("stops the worker and deletes a scoped account", async () => {
    mockGetScoped.mockResolvedValue(ROW);
    mockDelete.mockResolvedValue(ROW);
    const res = await del();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith({}, "acc1", "w1");
    expect(mockEmailWorkerFetch).toHaveBeenCalled();
  });

  it("404 when account not scoped", async () => {
    mockGetScoped.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
  });

  it("400 when params missing", async () => {
    const res = await del({ id: "a1" } as any);
    expect(res.status).toBe(400);
  });
});

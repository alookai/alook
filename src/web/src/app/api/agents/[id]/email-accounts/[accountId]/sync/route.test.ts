import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockEmailWorkerFetch = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: { DB: {}, EMAIL_WORKER: { fetch: mockEmailWorkerFetch } },
  })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetScoped = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: { emailAccount: { getEmailAccountScoped: (...a: unknown[]) => mockGetScoped(...a) } },
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

import { POST } from "./route";

beforeEach(() => vi.clearAllMocks());

function post(params: Record<string, string>) {
  return POST(
    new NextRequest("http://localhost/api/agents/a1/email-accounts/acc1/sync", { method: "POST" }),
    { params },
  );
}

describe("POST .../email-accounts/[accountId]/sync", () => {
  it("triggers a worker sync for a scoped account", async () => {
    mockGetScoped.mockResolvedValue({ id: "acc1" });
    const res = await post({ id: "a1", accountId: "acc1" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockGetScoped).toHaveBeenCalledWith({}, "acc1", "a1", "w1");
    expect(mockEmailWorkerFetch).toHaveBeenCalledWith(
      expect.stringContaining("/imap/sync?accountId=acc1"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("400 when params missing", async () => {
    const res = await post({ id: "a1" });
    expect(res.status).toBe(400);
  });

  it("404 when account not scoped (IDOR guard)", async () => {
    mockGetScoped.mockResolvedValue(null);
    const res = await post({ id: "a1", accountId: "acc1" });
    expect(res.status).toBe(404);
    expect(mockEmailWorkerFetch).not.toHaveBeenCalled();
  });
});

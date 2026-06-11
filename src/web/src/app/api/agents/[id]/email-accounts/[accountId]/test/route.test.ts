import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockEmailWorkerFetch = vi.fn();
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: { DB: {}, EMAIL_WORKER: { fetch: mockEmailWorkerFetch } },
  })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetScoped = vi.fn();
const mockGetAgent = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      emailAccount: { getEmailAccountScoped: (...a: unknown[]) => mockGetScoped(...a) },
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
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

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue({ id: "a1", visibility: "public", ownerId: "u1" });
});

function post(params: Record<string, string>) {
  return POST(
    new NextRequest("http://localhost/api/agents/a1/email-accounts/acc1/test", { method: "POST" }),
    { params },
  );
}

describe("POST .../email-accounts/[accountId]/test", () => {
  it("forwards the worker test result and its status", async () => {
    mockGetScoped.mockResolvedValue({ id: "acc1" });
    mockEmailWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, folders: 3 }), { status: 200 }),
    );
    const res = await post({ id: "a1", accountId: "acc1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folders: 3 });
  });

  it("propagates a non-200 worker status (e.g. failed auth → 401)", async () => {
    mockGetScoped.mockResolvedValue({ id: "acc1" });
    mockEmailWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "auth failed" }), { status: 401 }),
    );
    const res = await post({ id: "a1", accountId: "acc1" });
    expect(res.status).toBe(401);
  });

  it("400 when params missing", async () => {
    const res = await post({ id: "a1" });
    expect(res.status).toBe(400);
  });

  it("404 when account not scoped", async () => {
    mockGetScoped.mockResolvedValue(null);
    const res = await post({ id: "a1", accountId: "acc1" });
    expect(res.status).toBe(404);
  });
});

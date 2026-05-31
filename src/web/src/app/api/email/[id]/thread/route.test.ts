import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetById = vi.fn();
const mockGetByMessageId = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      email: {
        getEmailById: (...a: unknown[]) => mockGetById(...a),
        getEmailByMessageId: (...a: unknown[]) => mockGetByMessageId(...a),
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
vi.mock("@/lib/api/responses", () => ({ emailToResponse: (e: any) => ({ id: e.id }) }));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

const get = (params: Record<string, string>) => GET(new NextRequest("http://localhost/x"), { params });

describe("GET /api/email/[id]/thread", () => {
  it("400 when email id missing", async () => {
    const res = await get({});
    expect(res.status).toBe(400);
  });

  it("404 when email not in workspace", async () => {
    mockGetById.mockResolvedValue(null);
    const res = await get({ id: "e1" });
    expect(res.status).toBe(404);
    expect(mockGetById).toHaveBeenCalledWith({}, "e1", "w1");
  });

  it("returns [] when the email has no parent", async () => {
    mockGetById.mockResolvedValue({ id: "e1", inReplyTo: null });
    const res = await get({ id: "e1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("walks the reply chain oldest-first", async () => {
    mockGetById.mockResolvedValue({ id: "e3", inReplyTo: "msg2" });
    mockGetByMessageId
      .mockResolvedValueOnce({ id: "e2", inReplyTo: "msg1" })
      .mockResolvedValueOnce({ id: "e1", inReplyTo: null });
    const res = await get({ id: "e3" });
    expect(await res.json()).toEqual([{ id: "e1" }, { id: "e2" }]);
  });

  it("stops at a cycle without infinite looping", async () => {
    mockGetById.mockResolvedValue({ id: "e2", inReplyTo: "msgSelf" });
    // parent points back to a message id already seen → loop guard breaks
    mockGetByMessageId.mockResolvedValue({ id: "e1", inReplyTo: "msgSelf" });
    const res = await get({ id: "e2" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

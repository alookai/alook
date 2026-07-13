import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetExistingHandles = vi.fn();
const mockGetAgentByHandle = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agent: {
        getExistingHandles: (...args: unknown[]) => mockGetExistingHandles(...args),
        getAgentByHandle: (...args: unknown[]) => mockGetAgentByHandle(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@test.com", params });
  }),
}));

import { POST } from "./route";

function makeReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/studios/check-handles", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/studios/check-handles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExistingHandles.mockResolvedValue([]);
  });

  it("returns unique handles for each member keyed by uid when none exist", async () => {
    const req = makeReq({ members: [{ uid: "a", name: "Alice" }, { uid: "b", name: "Bob" }] });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].uid).toBe("a");
    expect(body[0].handle).toBeTruthy();
    expect(body[1].uid).toBe("b");
    expect(body[1].handle).toBeTruthy();
    expect(body[0].handle).not.toBe(body[1].handle);
  });

  it("returns distinct handles for two same-name members keyed by uid", async () => {
    const req = makeReq({ members: [{ uid: "a", name: "Ada" }, { uid: "b", name: "Ada" }] });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].uid).toBe("a");
    expect(body[1].uid).toBe("b");
    expect(body[0].handle).toBeTruthy();
    expect(body[1].handle).toBeTruthy();
    expect(body[0].handle).not.toBe(body[1].handle);
  });

  it("skips handles that already exist in DB", async () => {
    mockGetExistingHandles.mockResolvedValue(["alice"]);

    const req = makeReq({ members: [{ uid: "a", name: "Alice" }] });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body[0].handle).not.toBe("alice");
    expect(body[0].handle).toBeTruthy();
  });

  it("batch-fetches all candidates in a single call", async () => {
    const req = makeReq({ members: [{ uid: "a", name: "Alice" }, { uid: "b", name: "Bob" }, { uid: "c", name: "Charlie" }] });
    await POST(req, {});

    expect(mockGetExistingHandles).toHaveBeenCalledTimes(1);
    const handles = mockGetExistingHandles.mock.calls[0][1] as string[];
    expect(handles.length).toBeGreaterThan(3);
  });

  it("returns 400 if members array is empty", async () => {
    const req = makeReq({ members: [] });
    const res = await POST(req, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 if members array exceeds 4", async () => {
    const req = makeReq({ members: [{ uid: "a", name: "a" }, { uid: "b", name: "b" }, { uid: "c", name: "c" }, { uid: "d", name: "d" }, { uid: "e", name: "e" }] });
    const res = await POST(req, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid request body", async () => {
    const req = new NextRequest("http://localhost/api/studios/check-handles", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req, {});
    expect(res.status).toBe(400);
  });

  it("falls back to nanoid suffix when all candidates are taken", async () => {
    mockGetExistingHandles.mockImplementation((_db: any, handles: string[]) =>
      Promise.resolve(handles)
    );

    const req = makeReq({ members: [{ uid: "a", name: "Alice" }] });
    const res = await POST(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body[0].handle).toMatch(/^alice-.{6}$/);
  });
});

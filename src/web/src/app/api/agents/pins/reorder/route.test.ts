import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockListPins = vi.fn();
const mockReorderPins = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      agentPin: {
        listPins: (...a: unknown[]) => mockListPins(...a),
        reorderPins: (...a: unknown[]) => mockReorderPins(...a),
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
  cacheKeys: { pins: (w: string, u: string) => `pins:${w}:${u}` },
}));

import { PUT } from "./route";

beforeEach(() => vi.clearAllMocks());

function put(body: unknown) {
  return PUT(new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }), {});
}

describe("PUT /api/agents/pins/reorder", () => {
  it("reorders pins when all ids are pinned (204)", async () => {
    mockListPins.mockResolvedValue([{ agentId: "a1" }, { agentId: "a2" }]);
    const res = await put({ ordered_agent_ids: ["a2", "a1"] });
    expect(res.status).toBe(204);
    expect(mockReorderPins).toHaveBeenCalledWith({}, "w1", "u1", ["a2", "a1"]);
  });

  it("400 on invalid JSON body", async () => {
    const res = await PUT(new NextRequest("http://localhost/x", { method: "PUT", body: "nope" }), {});
    expect(res.status).toBe(400);
  });

  it("400 when ordered_agent_ids is not a non-empty string array", async () => {
    const res = await put({ ordered_agent_ids: [] });
    expect(res.status).toBe(400);
  });

  it("400 when an id is not pinned", async () => {
    mockListPins.mockResolvedValue([{ agentId: "a1" }]);
    const res = await put({ ordered_agent_ids: ["a1", "a2"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not pinned");
  });
});

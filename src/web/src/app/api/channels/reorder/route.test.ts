import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

const mockListChannels = vi.fn();
const mockReorderChannels = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      channel: {
        listChannels: (...a: unknown[]) => mockListChannels(...a),
        reorderChannels: (...a: unknown[]) => mockReorderChannels(...a),
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

import { PUT } from "./route";

beforeEach(() => vi.clearAllMocks());

const put = (body: unknown) =>
  PUT(new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }), {});

describe("PUT /api/channels/reorder", () => {
  it("reorders existing workspace channels (204)", async () => {
    mockListChannels.mockResolvedValue([{ id: "ch1" }, { id: "ch2" }]);
    const res = await put({ ordered_channel_ids: ["ch2", "ch1"] });
    expect(res.status).toBe(204);
    expect(mockReorderChannels).toHaveBeenCalledWith({}, "w1", ["ch2", "ch1"]);
  });

  it("400 when trying to reorder the default channel", async () => {
    const res = await put({ ordered_channel_ids: ["ch_default", "ch1"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("default channel");
  });

  it("400 when a channel id does not exist in the workspace", async () => {
    mockListChannels.mockResolvedValue([{ id: "ch1" }]);
    const res = await put({ ordered_channel_ids: ["ch1", "ghost"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not found");
  });

  it("400 on invalid body", async () => {
    const res = await put({ ordered_channel_ids: "nope" });
    expect(res.status).toBe(400);
  });
});

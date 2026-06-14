import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetChannelById = vi.fn();
const mockRenameChannel = vi.fn();
const mockDeleteChannel = vi.fn();
const mockChannelToResponse = vi.fn((c: any) => ({
  id: c.id,
  workspace_id: c.workspaceId,
  name: c.name,
  created_at: c.createdAt,
}));

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
      channel: {
        getChannelById: (...args: any[]) => mockGetChannelById(...args),
        renameChannel: (...args: any[]) => mockRenameChannel(...args),
        deleteChannel: (...args: any[]) => mockDeleteChannel(...args),
      },
    },
  };
});
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));
vi.mock("@/lib/api/responses", () => ({
  channelToResponse: (...args: any[]) => mockChannelToResponse(...args),
}));

import { PATCH, DELETE } from "./route";

const CH = { id: "ch_1", workspaceId: "w1", name: "work", createdAt: "2024-01-01T00:00:00Z" };
const DEFAULT_CH = { id: "ch_0", workspaceId: "w1", name: "default", createdAt: "2024-01-01T00:00:00Z" };

function patchReq(id: string, body: any) {
  return [
    new NextRequest(`http://localhost/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

function deleteReq(id: string) {
  return [
    new NextRequest(`http://localhost/api/channels/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

describe("PATCH /api/channels/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames a channel", async () => {
    mockGetChannelById.mockResolvedValue(CH);
    mockRenameChannel.mockResolvedValue({ ...CH, name: "projects" });

    const [req, ctx] = patchReq("ch_1", { name: "projects" });
    const res = await PATCH(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.name).toBe("projects");
    expect(mockRenameChannel).toHaveBeenCalledWith({}, "ch_1", "w1", "projects");
  });

  it("returns 404 when channel not found", async () => {
    mockGetChannelById.mockResolvedValue(null);

    const [req, ctx] = patchReq("ch_999", { name: "new" });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("channel not found");
  });

  it("returns 400 when renaming the default channel", async () => {
    mockGetChannelById.mockResolvedValue(DEFAULT_CH);

    const [req, ctx] = patchReq("ch_0", { name: "renamed" });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot rename the default channel");
  });

  it("returns 400 when renaming to 'default'", async () => {
    mockGetChannelById.mockResolvedValue(CH);

    const [req, ctx] = patchReq("ch_1", { name: "default" });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot rename to 'default'");
  });

  it("returns 400 for missing name", async () => {
    const [req, ctx] = patchReq("ch_1", {});
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name is required");
  });

  it("returns 400 for empty name", async () => {
    const [req, ctx] = patchReq("ch_1", { name: "  " });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name is required");
  });

  it("returns 400 for name exceeding 32 characters", async () => {
    const [req, ctx] = patchReq("ch_1", { name: "a".repeat(33) });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name must be 32 characters or less");
  });

  it("returns 400 for name with invalid characters", async () => {
    const [req, ctx] = patchReq("ch_1", { name: "my channel" });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name can only contain letters, digits, dashes, and underscores");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/channels/ch_1", {
      method: "PATCH",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "ch_1" }) } as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid request body");
  });

  it("returns 409 for duplicate channel name", async () => {
    mockGetChannelById.mockResolvedValue(CH);
    mockRenameChannel.mockRejectedValue(new Error("UNIQUE constraint failed: channel.name"));

    const [req, ctx] = patchReq("ch_1", { name: "existing" });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("a channel with this name already exists");
  });

  it("returns 404 when renameChannel returns null", async () => {
    mockGetChannelById.mockResolvedValue(CH);
    mockRenameChannel.mockResolvedValue(null);

    const [req, ctx] = patchReq("ch_1", { name: "new-name" });
    const res = await PATCH(req, ctx as any);

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/channels/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a channel", async () => {
    mockGetChannelById.mockResolvedValue(CH);
    mockDeleteChannel.mockResolvedValue(CH);

    const [req, ctx] = deleteReq("ch_1");
    const res = await DELETE(req, ctx as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockDeleteChannel).toHaveBeenCalledWith({}, "ch_1", "w1");
  });

  it("returns 404 when channel not found", async () => {
    mockGetChannelById.mockResolvedValue(null);

    const [req, ctx] = deleteReq("ch_999");
    const res = await DELETE(req, ctx as any);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("channel not found");
  });

  it("returns 400 when deleting the default channel", async () => {
    mockGetChannelById.mockResolvedValue(DEFAULT_CH);

    const [req, ctx] = deleteReq("ch_0");
    const res = await DELETE(req, ctx as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot delete the default channel");
  });
});

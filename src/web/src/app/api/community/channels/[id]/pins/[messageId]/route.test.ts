import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetChannel = vi.fn();
const mockGetMember = vi.fn();
const mockUnpinMessage = vi.fn();
const mockLogAction = vi.fn();
const mockFanOut = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      communityChannel: { getChannel: (...a: unknown[]) => mockGetChannel(...a) },
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityPin: { unpinMessage: (...a: unknown[]) => mockUnpinMessage(...a) },
    },
  };
});

vi.mock("@/lib/community/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAction(...a),
}));

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOut(...a),
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server");
  const actual = await vi.importActual("@/lib/middleware/helpers");
  return {
    ...actual,
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

import { DELETE } from "./route";

function delReq() {
  return new NextRequest("http://localhost/api/community/channels/c1/pins/m1", { method: "DELETE" });
}
const ctx = { params: { id: "c1", messageId: "m1" } } as any;

describe("DELETE /api/community/channels/[id]/pins/[messageId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text" });
    mockGetMember.mockResolvedValue({ userId: "u1", role: "admin" });
    mockUnpinMessage.mockResolvedValue(undefined);
    mockFanOut.mockResolvedValue(undefined);
  });

  it("unpins a message and returns 204", async () => {
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(204);
    expect(mockUnpinMessage).toHaveBeenCalledWith(expect.anything(), { channelId: "c1", messageId: "m1" });
    expect(mockFanOut).toHaveBeenCalled();
  });

  it("returns 404 when the channel does not exist", async () => {
    mockGetChannel.mockResolvedValue(null);
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(404);
    expect(mockUnpinMessage).not.toHaveBeenCalled();
  });

  it("unpins a message in a forum top-level (phase2 forum≡thread write-guard reversal — forum is now a message-bearing surface)", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum" });
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(204);
    expect(mockUnpinMessage).toHaveBeenCalledWith(expect.anything(), { channelId: "c1", messageId: "m1" });
  });

  it("returns 400 in a DM (governance model does not fit)", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: null, type: "dm" });
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(400);
    expect(mockUnpinMessage).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not a server admin", async () => {
    mockGetMember.mockResolvedValue({ userId: "u1", role: "member" });
    const res = await DELETE(delReq(), ctx);
    expect(res.status).toBe(403);
    expect(mockUnpinMessage).not.toHaveBeenCalled();
  });
});

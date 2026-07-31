import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetMessage = vi.fn();
const mockGetChannelType = vi.fn();
const mockGetChannelForMember = vi.fn();
const mockGetDM = vi.fn();
const mockAddReaction = vi.fn();
const mockRemoveReaction = vi.fn();
const mockFanOutToChannel = vi.fn();
const mockFanOutToDM = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: { getMessage: (...a: unknown[]) => mockGetMessage(...a) },
      communityChannel: { getChannelType: (...a: unknown[]) => mockGetChannelType(...a) },
      communityReaction: {
        addReaction: (...a: unknown[]) => mockAddReaction(...a),
        removeReaction: (...a: unknown[]) => mockRemoveReaction(...a),
      },
    },
  };
});

vi.mock("@/lib/community/permissions", () => ({
  requireChannelMember: (...a: unknown[]) => mockGetChannelForMember(...a),
  requireDMAccess: (...a: unknown[]) => mockGetDM(...a),
}));

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  fanOutToDM: (...a: unknown[]) => mockFanOutToDM(...a),
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
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

import { PUT, DELETE } from "./route";

const ctx = { params: { id: "m1", emoji: encodeURIComponent("👍") } } as any;
function req(method: string) {
  return new NextRequest("http://localhost/api/community/messages/m1/reactions/%F0%9F%91%8D", { method });
}

describe("reactions [emoji] surface guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1" });
    mockGetChannelForMember.mockResolvedValue({ ok: true, value: { id: "c1" } });
    mockGetDM.mockResolvedValue({ ok: true });
    mockAddReaction.mockResolvedValue({ messageId: "m1", userId: "u1", emoji: "👍" });
    mockRemoveReaction.mockResolvedValue(undefined);
    mockFanOutToChannel.mockResolvedValue(undefined);
    mockFanOutToDM.mockResolvedValue(undefined);
  });

  it("PUT rejects reacting on a forum top-level with 400", async () => {
    mockGetChannelType.mockResolvedValue("forum");
    const res = await PUT(req("PUT"), ctx);
    expect(res.status).toBe(400);
    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("PUT allows reacting in a DM (bearing surface, block-checked)", async () => {
    mockGetChannelType.mockResolvedValue("dm");
    const res = await PUT(req("PUT"), ctx);
    expect(res.status).toBe(200);
    expect(mockGetDM).toHaveBeenCalled();
    expect(mockAddReaction).toHaveBeenCalled();
    expect(mockFanOutToDM).toHaveBeenCalled();
  });

  it("PUT allows reacting in a text channel", async () => {
    mockGetChannelType.mockResolvedValue("text");
    const res = await PUT(req("PUT"), ctx);
    expect(res.status).toBe(200);
    expect(mockAddReaction).toHaveBeenCalled();
    expect(mockFanOutToChannel).toHaveBeenCalled();
  });

  it("DELETE (un-react) rejects a forum top-level with 400", async () => {
    mockGetChannelType.mockResolvedValue("forum");
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(400);
    expect(mockRemoveReaction).not.toHaveBeenCalled();
  });

  it("DELETE (un-react) works in a DM", async () => {
    mockGetChannelType.mockResolvedValue("dm");
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(204);
    expect(mockRemoveReaction).toHaveBeenCalled();
  });
});

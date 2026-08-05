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
      communityMessage: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessageByChannelAndSeq: (...a: unknown[]) => mockGetMessageByChannelAndSeq(...a),
      },
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

const mockGetMessageByChannelAndSeq = vi.fn();
const mockResolveTargetForMember = vi.fn();

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}));

// Dual-actor: crk_ bearer → bot, else human (mirrors the real wrapper). The bot
// arm reaches resolveTargetForMember + getMessageByChannelAndSeq; the human arm
// carries the messageId in the path.
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    const authz = req?.headers?.get?.("Authorization") ?? "";
    const actor = authz.startsWith("Bearer crk_")
      ? { kind: "bot", userId: "bot_1", ownerUserId: "o_1", machineId: "m_1" }
      : { kind: "human", userId: "u1", email: "u@t.com" };
    return handler(req, { env: { DB: {} }, actor, params });
  },
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

// Bot PUT: crk_ bearer + `{ channel, seq }` body (folded reactAdd); the path id
// is the `resolve` placeholder.
const ctxResolve = { params: { id: "resolve", emoji: encodeURIComponent("👍") } } as any;
function botReq(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/community/messages/resolve/reactions/%F0%9F%91%8D", {
    method,
    headers: { Authorization: "Bearer crk_abc", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
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

  // ── bot arm (folded reactAdd `{channel,seq,emoji}`): ref+seq → member-scoped
  //    404, never a 403 leak (①-C). ──

  it("bot PUT resolves ref+seq via resolveTargetForMember, then reacts", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" });
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m1" });
    mockGetChannelType.mockResolvedValue("text");
    const res = await PUT(botReq("PUT", { channel: "/s/general", seq: 42 }), ctxResolve);
    expect(res.status).toBe(200);
    expect(mockResolveTargetForMember).toHaveBeenCalledWith({}, "bot_1", "/s/general", {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    });
    expect(mockGetMessageByChannelAndSeq).toHaveBeenCalledWith({}, { channelId: "c1" }, 42);
    expect(mockAddReaction).toHaveBeenCalled();
  });

  it("①-C: bot PUT ref to an UNREACHABLE channel → 404 (resolve member-scoped, not 403)", async () => {
    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "channel not found: general" });
    const res = await PUT(botReq("PUT", { channel: "/s/general", seq: 42 }), ctxResolve);
    expect(res.status).toBe(404);
    // never reaches the messageId-keyed authorizeReaction / addReaction.
    expect(mockGetMessageByChannelAndSeq).not.toHaveBeenCalled();
    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("bot PUT ref resolves but seq absent → 404", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" });
    mockGetMessageByChannelAndSeq.mockResolvedValue(null);
    const res = await PUT(botReq("PUT", { channel: "/s/general", seq: 999 }), ctxResolve);
    expect(res.status).toBe(404);
    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("bot PUT rejects a body missing channel/seq with 400", async () => {
    const res = await PUT(botReq("PUT", { seq: 42 }), ctxResolve);
    expect(res.status).toBe(400);
    expect(mockResolveTargetForMember).not.toHaveBeenCalled();
  });

  it("bot DELETE (no react-remove verb) → defensive 404, never the 403 leak", async () => {
    const res = await DELETE(botReq("DELETE"), ctxResolve);
    expect(res.status).toBe(404);
    // opaque — no message/channel lookup runs for the bot arm.
    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockRemoveReaction).not.toHaveBeenCalled();
  });
});

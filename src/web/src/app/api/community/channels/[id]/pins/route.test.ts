import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetChannel = vi.fn();
const mockGetChannelForMember = vi.fn();
const mockGetMember = vi.fn();
const mockGetMessage = vi.fn();
const mockPinMessage = vi.fn();
const mockListPins = vi.fn();
const mockFanOut = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

// Keep the real isUniqueConstraintError; only stub the query functions.
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityMessage: { getMessage: (...a: unknown[]) => mockGetMessage(...a) },
      communityPin: {
        pinMessage: (...a: unknown[]) => mockPinMessage(...a),
        listPins: (...a: unknown[]) => mockListPins(...a),
      },
    },
  };
});


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
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

import { GET, POST } from "./route";

function getReq() {
  return new NextRequest("http://localhost/api/community/channels/c1/pins", { method: "GET" });
}

function postReq(messageId?: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1/pins", {
    method: "POST",
    body: JSON.stringify(messageId === undefined ? {} : { messageId }),
    headers: { "Content-Type": "application/json" },
  });
}
const ctx = { params: { id: "c1" } } as any;

describe("POST /api/community/channels/[id]/pins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text" });
    // Pinning is admin-only — every happy path starts with an admin caller.
    mockGetMember.mockResolvedValue({ userId: "u1", role: "admin" });
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1" });
    mockFanOut.mockResolvedValue(undefined);
  });

  it("pins a message and returns 201", async () => {
    mockPinMessage.mockResolvedValue({ channelId: "c1", messageId: "m1", pinnedBy: "u1" });

    const res = await POST(postReq("m1"), ctx);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ channelId: "c1", messageId: "m1", pinnedBy: "u1" });
    expect(mockFanOut).toHaveBeenCalled();
  });

  it("returns 409 when the message is already pinned (UNIQUE constraint)", async () => {
    mockPinMessage.mockRejectedValue(new Error("UNIQUE constraint failed: community_pin.message_id"));

    const res = await POST(postReq("m1"), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "message already pinned" });
    expect(mockFanOut).not.toHaveBeenCalled();
  });

  it("returns 409 when the UNIQUE error is wrapped as .cause (DrizzleQueryError)", async () => {
    const wrapped = new Error("Failed query: INSERT INTO community_pin ...");
    (wrapped as any).cause = new Error("UNIQUE constraint failed: community_pin.message_id");
    mockPinMessage.mockRejectedValue(wrapped);

    const res = await POST(postReq("m1"), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "message already pinned" });
  });

  it("rethrows non-constraint errors", async () => {
    mockPinMessage.mockRejectedValue(new Error("db offline"));
    await expect(POST(postReq("m1"), ctx)).rejects.toThrow("db offline");
  });

  it("returns 400 when messageId is missing", async () => {
    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(400);
    expect(mockPinMessage).not.toHaveBeenCalled();
  });

  it("pins a message in a forum top-level (phase2 forum≡thread write-guard reversal — forum is now a message-bearing surface)", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum" });
    mockPinMessage.mockResolvedValue({ channelId: "c1", messageId: "m1", pinnedBy: "u1" });
    const res = await POST(postReq("m1"), ctx);
    expect(res.status).toBe(201);
    expect(mockPinMessage).toHaveBeenCalled();
  });

  it("returns 400 when pinning in a DM (governance model does not fit)", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: null, type: "dm" });
    const res = await POST(postReq("m1"), ctx);
    expect(res.status).toBe(400);
    expect(mockPinMessage).not.toHaveBeenCalled();
  });

  it("returns 404 when the channel does not exist", async () => {
    mockGetChannel.mockResolvedValue(null);
    const res = await POST(postReq("m1"), ctx);
    expect(res.status).toBe(404);
  });

  it("returns 403 when the user is not a member", async () => {
    mockGetMember.mockResolvedValue(null);
    const res = await POST(postReq("m1"), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 403 when the user is a regular member (not admin)", async () => {
    mockGetMember.mockResolvedValue({ userId: "u1", role: "member" });
    const res = await POST(postReq("m1"), ctx);
    expect(res.status).toBe(403);
    expect(mockPinMessage).not.toHaveBeenCalled();
  });

  it("returns 404 when the message does not belong to the channel", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "other" });
    const res = await POST(postReq("m1"), ctx);
    expect(res.status).toBe(404);
    expect(mockPinMessage).not.toHaveBeenCalled();
  });
});

describe("GET /api/community/channels/[id]/pins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "text" });
  });

  it("returns each pin's authorId so the client can derive a beam avatar", async () => {
    // A pinned message whose author has no uploaded image — the client needs
    // authorId as the beam seed; without it the pinned panel drew a blank
    // avatar (the bug this field fixes).
    mockListPins.mockResolvedValue([
      {
        pin: { channelId: "c1", messageId: "m1" },
        message: { id: "m1", seq: 42, content: "hi", createdAt: "2026-08-04T00:00:00Z" },
        author: { id: "u42", name: "Ada", image: null },
      },
    ]);

    const res = await GET(getReq(), ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pins: Array<{ id: string; seq: number; authorId: string; authorName: string }> };
    expect(body.pins).toHaveLength(1);
    expect(body.pins[0].authorId).toBe("u42");
    expect(body.pins[0].id).toBe("m1");
    expect(body.pins[0].authorName).toBe("Ada");
    // seq lets the client jumpToSeq to the pinned message (scroll+highlight, or
    // open the context sheet if it's outside the loaded window).
    expect(body.pins[0].seq).toBe(42);
  });

  it("returns 403 when the caller can't see the channel", async () => {
    mockGetChannelForMember.mockResolvedValue(null);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(403);
    expect(mockListPins).not.toHaveBeenCalled();
  });
});

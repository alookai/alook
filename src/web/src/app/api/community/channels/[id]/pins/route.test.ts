import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

const mockGetChannel = vi.fn();
const mockGetMember = vi.fn();
const mockGetMessage = vi.fn();
const mockPinMessage = vi.fn();
const mockLogAction = vi.fn();
const mockFanOut = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

// Keep the real isUniqueConstraintError; only stub the query functions.
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      communityChannel: { getChannel: (...a: unknown[]) => mockGetChannel(...a) },
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityMessage: { getMessage: (...a: unknown[]) => mockGetMessage(...a) },
      communityPin: { pinMessage: (...a: unknown[]) => mockPinMessage(...a) },
      communityAuditLog: { logAction: (...a: unknown[]) => mockLogAction(...a) },
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
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  };
});

import { POST } from "./route";

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
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" });
    // Pinning is admin-only — every happy path starts with an admin caller.
    mockGetMember.mockResolvedValue({ userId: "u1", role: "admin" });
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1" });
    mockFanOut.mockResolvedValue(undefined);
    mockLogAction.mockResolvedValue(undefined);
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

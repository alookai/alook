import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getUser = vi.fn()
const getUserInternal = vi.fn()
const getUserByNameAndDiscriminator = vi.fn()
const getUserByNameCaseInsensitive = vi.fn()
const isBlocked = vi.fn()
const sendRequest = vi.fn()
const broadcastToUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      user: {
        getUser: (...a: unknown[]) => getUser(...a),
        getUserInternal: (...a: unknown[]) => getUserInternal(...a),
        getUserByNameAndDiscriminator: (...a: unknown[]) => getUserByNameAndDiscriminator(...a),
        getUserByNameCaseInsensitive: (...a: unknown[]) => getUserByNameCaseInsensitive(...a),
      },
      communityFriendship: {
        sendRequest: (...a: unknown[]) => sendRequest(...a),
        isBlocked: (...a: unknown[]) => isBlocked(...a),
      },
      communityBot: {
        findPendingFriendRequest: vi.fn().mockResolvedValue(null),
        createApprovalRequestStatement: vi.fn(),
      },
      communityDm: {
        createOrGetDM: vi.fn(),
      },
      communityMessage: {
        createMessage: vi.fn(),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => broadcastToUser(...a),
}))

import { POST } from "./route"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/friends/request", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("POST /api/community/friends/request", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getUser.mockResolvedValue({ id: "u2" })
    getUserInternal.mockResolvedValue({
      id: "u2",
      isBot: false,
      ownerUserId: null,
      deletedAt: null,
    })
    isBlocked.mockResolvedValue(false)
    broadcastToUser.mockResolvedValue(undefined)
  })

  it("creates a pending friendship and broadcasts friend.request (201)", async () => {
    sendRequest.mockResolvedValue({
      kind: "created",
      friendship: { id: "f1", requesterId: "u1", addresseeId: "u2", status: "pending" },
    })
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe("f1")
    expect(broadcastToUser).toHaveBeenCalledWith(
      "u2",
      expect.objectContaining({ type: "community:friend.request" }),
    )
  })

  it("friend.request payload is the projected shape (no blockerId / updatedAt)", async () => {
    // Simulate the full DB row, including columns the client should not see.
    sendRequest.mockResolvedValue({
      kind: "created",
      friendship: {
        id: "f1",
        requesterId: "u1",
        addresseeId: "u2",
        status: "pending",
        createdAt: "2026-07-02T00:00:00.000Z",
        blockerId: null,
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    })
    await POST(postReq({ userId: "u2" }), {} as never)
    const call = broadcastToUser.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "community:friend.request",
    )
    expect(call).toBeDefined()
    const payload = call![1] as { friendship: Record<string, unknown> }
    expect(payload.friendship).toEqual({
      id: "f1",
      requesterId: "u1",
      addresseeId: "u2",
      status: "pending",
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    expect(payload.friendship).not.toHaveProperty("blockerId")
    expect(payload.friendship).not.toHaveProperty("updatedAt")
  })

  it("auto-accepts when the reverse-direction request already exists (200 + friend.accept)", async () => {
    // The query layer reports it promoted an existing reverse pending row.
    sendRequest.mockResolvedValue({
      kind: "auto_accepted",
      friendship: { id: "f1", requesterId: "u2", addresseeId: "u1", status: "accepted" },
    })
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(200)
    expect(broadcastToUser).toHaveBeenCalledWith(
      "u2",
      expect.objectContaining({ type: "community:friend.accept", friendshipId: "f1" }),
    )
  })

  it("returns 403 when the query reports the pair is blocked", async () => {
    sendRequest.mockRejectedValue(new Error("blocked"))
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(403)
  })

  it("returns 409 when the query reports the users are already friends", async () => {
    sendRequest.mockRejectedValue(new Error("already friends"))
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(409)
  })

  it("returns 409 when the UNIQUE constraint already covers this direction", async () => {
    sendRequest.mockRejectedValue(new Error("UNIQUE constraint failed: community_friendship..."))
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(409)
  })

  it("returns 409 when the UNIQUE error is wrapped as .cause (DrizzleQueryError shape)", async () => {
    // The real driver error hides behind DrizzleQueryError.cause on 0.44+.
    // isUniqueConstraintError walks the cause chain; the previous substring
    // hack manually concatenated `err.cause.message` — this test guards that
    // the helper preserves that behaviour.
    const wrapped = new Error("failed query: insert into community_friendship")
      ; (wrapped as { cause?: unknown }).cause = new Error(
        "UNIQUE constraint failed: community_friendship.requester_id",
      )
    sendRequest.mockRejectedValue(wrapped)
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(409)
  })

  it("returns 409 when the driver reports SQLITE_CONSTRAINT_UNIQUE via .code", async () => {
    // Only reachable through the helper — the old substring hack would have
    // rethrown this because "UNIQUE" is not in the message.
    const codeErr = new Error("constraint violation")
      ; (codeErr as { code?: string }).code = "SQLITE_CONSTRAINT_UNIQUE"
    sendRequest.mockRejectedValue(codeErr)
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(409)
  })

  it("returns 400 when the target equals the caller", async () => {
    const res = await POST(postReq({ userId: "u1" }), {} as never)
    expect(res.status).toBe(400)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it("returns 404 when the target user doesn't exist", async () => {
    getUser.mockResolvedValue(null)
    getUserInternal.mockResolvedValue(null)
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(404)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller is blocked by the target (or vice versa)", async () => {
    isBlocked.mockResolvedValue(true)
    const res = await POST(postReq({ userId: "u2" }), {} as never)
    expect(res.status).toBe(403)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  describe("username resolution (name#0042 exact match, else case-insensitive bare-name fallback)", () => {
    it("resolves a name#0042 handle via getUserByNameAndDiscriminator, skipping the bare-name fallback", async () => {
      getUserByNameAndDiscriminator.mockResolvedValue({ id: "u2" })
      sendRequest.mockResolvedValue({
        kind: "created",
        friendship: { id: "f1", requesterId: "u1", addresseeId: "u2", status: "pending" },
      })

      const res = await POST(postReq({ username: "Alex#0002" }), {} as never)

      expect(res.status).toBe(201)
      expect(getUserByNameAndDiscriminator).toHaveBeenCalledWith({}, "Alex", "0002")
      expect(getUserByNameCaseInsensitive).not.toHaveBeenCalled()
      expect(sendRequest).toHaveBeenCalledWith({}, { requesterId: "u1", addresseeId: "u2" })
    })

    it("404s when the name#0042 handle doesn't resolve to anyone (no bare-name fallback on a well-formed handle)", async () => {
      getUserByNameAndDiscriminator.mockResolvedValue(null)

      const res = await POST(postReq({ username: "Alex#0002" }), {} as never)

      expect(res.status).toBe(404)
      expect(getUserByNameCaseInsensitive).not.toHaveBeenCalled()
      expect(sendRequest).not.toHaveBeenCalled()
    })

    it("falls back to case-insensitive bare-name match when no #dddd suffix is present", async () => {
      getUserByNameCaseInsensitive.mockResolvedValue({ id: "u2" })
      sendRequest.mockResolvedValue({
        kind: "created",
        friendship: { id: "f1", requesterId: "u1", addresseeId: "u2", status: "pending" },
      })

      const res = await POST(postReq({ username: "alex" }), {} as never)

      expect(res.status).toBe(201)
      expect(getUserByNameAndDiscriminator).not.toHaveBeenCalled()
      expect(getUserByNameCaseInsensitive).toHaveBeenCalledWith({}, "alex")
    })

    it("404s when the bare-name fallback finds no one", async () => {
      getUserByNameCaseInsensitive.mockResolvedValue(null)

      const res = await POST(postReq({ username: "nobody" }), {} as never)

      expect(res.status).toBe(404)
      expect(sendRequest).not.toHaveBeenCalled()
    })
  })
})

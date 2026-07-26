import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

/**
 * Accept/reject gated-refusal + DELETE role behavior for the unified friendship
 * flow. See plans/agent-friendship-approval-gate.md §test cases (Existing
 * human-path routes).
 */

const getFriendship = vi.fn()
const acceptRequest = vi.fn()
const rejectRequest = vi.fn()
const removeFriend = vi.fn()
const cancelPendingRequest = vi.fn()
const getUserInternal = vi.fn()
const broadcastToUserSafe = vi.fn()
const logAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: {
        getFriendship: (...a: unknown[]) => getFriendship(...a),
        acceptRequest: (...a: unknown[]) => acceptRequest(...a),
        rejectRequest: (...a: unknown[]) => rejectRequest(...a),
        removeFriend: (...a: unknown[]) => removeFriend(...a),
        cancelPendingRequest: (...a: unknown[]) => cancelPendingRequest(...a),
      },
      user: { getUserInternal: (...a: unknown[]) => getUserInternal(...a) },
    },
  }
})

vi.mock("@/lib/community/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
  COMMUNITY_AUDIT_ACTIONS: { BOT_FRIEND_CANCELLED: "community.bot.friend_cancelled" },
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    // caller id supplied per test via a header, defaults to alice
    const uid = req.headers?.get?.("x-test-uid") ?? "u_alice"
    return handler(req, { env: {}, userId: uid, email: "a@t.com", user: { isBot: false }, params })
  }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/community/fanout", () => ({ broadcastToUserSafe: (...a: unknown[]) => broadcastToUserSafe(...a) }))

import { POST as acceptPost } from "./accept/route"
import { POST as rejectPost } from "./reject/route"
import { DELETE as deleteFriend } from "./route"

function reqAs(uid: string) {
  return new NextRequest("http://x/api/community/friends/fr_1", {
    method: "POST",
    headers: { "x-test-uid": uid },
  })
}
const ctx = { params: { id: "fr_1" } } as any

describe("accept — gated refusal", () => {
  beforeEach(() => vi.clearAllMocks())

  it("403 when the incoming row is still owner-gated (needsOwnerApproval != null)", async () => {
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_zoe", addresseeId: "u_alice", status: "pending", needsOwnerApproval: "owner_bob",
    })
    const res = await acceptPost(reqAs("u_alice"), ctx)
    expect(res.status).toBe(403)
    expect(acceptRequest).not.toHaveBeenCalled()
  })

  it("accepts an ungated pending row and relays broadcasts", async () => {
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_zoe", addresseeId: "u_alice", status: "pending", needsOwnerApproval: null,
    })
    acceptRequest.mockResolvedValue({ ok: true, friendship: { id: "fr_1", status: "accepted" }, broadcasts: [] })
    const res = await acceptPost(reqAs("u_alice"), ctx)
    expect(res.status).toBe(200)
    expect(acceptRequest).toHaveBeenCalled()
  })
})

describe("reject — gated refusal (symmetric with accept)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("403 when the incoming row is still owner-gated", async () => {
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_zoe", addresseeId: "u_alice", status: "pending", needsOwnerApproval: "owner_bob",
    })
    const res = await rejectPost(reqAs("u_alice"), ctx)
    expect(res.status).toBe(403)
    expect(rejectRequest).not.toHaveBeenCalled()
  })

  it("J2 reject rehydrates the owner's approve-card to Denied", async () => {
    // Bot requester → human addressee, owner already approved (ungated pending);
    // a card sits in the owner↔bot DM. Alice rejects → owner's card flips.
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "bot_bob", addresseeId: "u_alice", status: "pending", needsOwnerApproval: null,
    })
    rejectRequest.mockResolvedValue({
      row: { id: "fr_1", status: "denied" },
      broadcasts: [
        { userId: "owner_bob", event: { type: "community:dm.message_updated", dmConversationId: "dm_1", messageId: "m_1", approval: { status: "denied" } } },
      ],
    })
    const res = await rejectPost(reqAs("u_alice"), ctx)
    expect(res.status).toBe(200)
    // FRIEND_REJECT to the other party + card rehydration to the owner.
    expect(broadcastToUserSafe).toHaveBeenCalledWith("bot_bob", expect.objectContaining({ type: expect.any(String), friendshipId: "fr_1" }))
    expect(broadcastToUserSafe).toHaveBeenCalledWith("owner_bob", expect.objectContaining({ type: "community:dm.message_updated" }))
  })
})

describe("DELETE — one path per role", () => {
  beforeEach(() => vi.clearAllMocks())

  it("requester cancels their own ungated pending outgoing → hard delete", async () => {
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_alice", addresseeId: "u_zoe", status: "pending", needsOwnerApproval: null,
    })
    removeFriend.mockResolvedValue({ id: "fr_1" })
    const res = await deleteFriend(reqAs("u_alice"), ctx)
    expect(res.status).toBe(204)
    expect(removeFriend).toHaveBeenCalled()
    expect(cancelPendingRequest).not.toHaveBeenCalled()
  })

  it("requester cancels a gated pending request → soft-cancel + rehydrate owner's card + audit", async () => {
    // Human→bot request gated on the bot's owner: an actionable Approve/Deny
    // card is sitting in the owner's DM. Withdrawing must flip that card, not
    // orphan it. See plans/friend-cancel-card-cleanup.md.
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_alice", addresseeId: "bot_yara", status: "pending", needsOwnerApproval: "owner_carol",
    })
    cancelPendingRequest.mockResolvedValue({
      row: { id: "fr_1", status: "cancelled" },
      broadcasts: [
        { userId: "owner_carol", event: { type: "community:dm.message_updated", dmConversationId: "dm_1", messageId: "m_1", approval: { status: "cancelled" } } },
      ],
    })
    const res = await deleteFriend(reqAs("u_alice"), ctx)
    expect(res.status).toBe(204)
    expect(cancelPendingRequest).toHaveBeenCalledWith(expect.anything(), "fr_1")
    expect(removeFriend).not.toHaveBeenCalled()
    // Owner's card rehydrates; the bot (no session) gets nothing.
    expect(broadcastToUserSafe).toHaveBeenCalledWith("owner_carol", expect.objectContaining({ type: "community:dm.message_updated" }))
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "community.bot.friend_cancelled", actorId: "u_alice", targetId: "fr_1",
    }))
  })

  it("the bot's owner cancels a pending row their bot created → soft-cancel", async () => {
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "bot_zoe", addresseeId: "u_alice", status: "pending", needsOwnerApproval: "owner_bob",
    })
    getUserInternal.mockResolvedValue({ id: "bot_zoe", isBot: true, ownerUserId: "owner_bob" })
    cancelPendingRequest.mockResolvedValue({ row: { id: "fr_1", status: "cancelled" }, broadcasts: [] })
    const res = await deleteFriend(reqAs("owner_bob"), ctx)
    expect(res.status).toBe(204)
    expect(cancelPendingRequest).toHaveBeenCalled()
    expect(removeFriend).not.toHaveBeenCalled()
  })

  it("either party removes an accepted friendship → hard delete + friend.remove", async () => {
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_alice", addresseeId: "u_zoe", status: "accepted", needsOwnerApproval: null,
    })
    removeFriend.mockResolvedValue({ id: "fr_1" })
    const res = await deleteFriend(reqAs("u_alice"), ctx)
    expect(res.status).toBe(204)
    expect(removeFriend).toHaveBeenCalled()
    expect(cancelPendingRequest).not.toHaveBeenCalled()
    expect(broadcastToUserSafe).toHaveBeenCalledWith("u_zoe", expect.objectContaining({ friendshipId: "fr_1" }))
  })

  it("cancelPendingRequest no-ops (row already gone) → still 204, no broadcast/audit", async () => {
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_alice", addresseeId: "bot_yara", status: "pending", needsOwnerApproval: "owner_carol",
    })
    cancelPendingRequest.mockResolvedValue({ row: null, broadcasts: [] })
    const res = await deleteFriend(reqAs("u_alice"), ctx)
    expect(res.status).toBe(204)
    expect(broadcastToUserSafe).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("target-owner may NOT DELETE an inbound pending (uses owner-decision) → 403", async () => {
    // Row where requester is a human, addressee is Carol's bot; Carol tries to
    // DELETE. She's neither requester nor requester-owner → 403.
    getFriendship.mockResolvedValue({
      id: "fr_1", requesterId: "u_alice", addresseeId: "bot_yara", status: "pending", needsOwnerApproval: "owner_carol",
    })
    getUserInternal.mockResolvedValue({ id: "u_alice", isBot: false, ownerUserId: null })
    const res = await deleteFriend(reqAs("owner_carol"), ctx)
    expect(res.status).toBe(403)
    expect(removeFriend).not.toHaveBeenCalled()
    expect(cancelPendingRequest).not.toHaveBeenCalled()
  })
})

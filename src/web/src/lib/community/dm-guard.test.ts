import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetUserInternal = vi.fn()
const mockAreFriends = vi.fn()
const mockIsBlocked = vi.fn()

vi.mock("@alook/shared", () => ({
  queries: {
    user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
    communityFriendship: {
      areFriends: (...a: unknown[]) => mockAreFriends(...a),
      isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
    },
  },
}))

import { guardDmOpen } from "./dm-guard"

const db = {} as never

describe("guardDmOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("400 cannot_dm_self when senderId === peerId", async () => {
    const res = await guardDmOpen(db, "u_1", "u_1")
    expect(res).toEqual({ ok: false, status: 400, error: "cannot DM yourself", code: "cannot_dm_self" })
    expect(mockGetUserInternal).not.toHaveBeenCalled()
  })

  it("404 user_not_found when peer is missing", async () => {
    mockGetUserInternal.mockResolvedValue(null)
    const res = await guardDmOpen(db, "u_1", "u_missing")
    expect(res).toEqual({ ok: false, status: 404, error: "user not found", code: "user_not_found" })
  })

  it("404 user_not_found when peer is soft-deleted", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "u_2", isBot: false, deletedAt: "2026-01-01" })
    const res = await guardDmOpen(db, "u_1", "u_2")
    expect(res).toEqual({ ok: false, status: 404, error: "user not found", code: "user_not_found" })
  })

  it("human ↔ human: not-blocked check runs, blocked → 403", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "u_2", isBot: false, deletedAt: null })
    mockIsBlocked.mockResolvedValue(true)
    const res = await guardDmOpen(db, "u_1", "u_2")
    expect(res).toEqual({ ok: false, status: 403, error: "blocked", code: "blocked" })
  })

  it("human ↔ human: not blocked → ok", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "u_2", isBot: false, deletedAt: null })
    mockIsBlocked.mockResolvedValue(false)
    const res = await guardDmOpen(db, "u_1", "u_2")
    expect(res).toEqual({ ok: true })
  })

  describe("peer is a bot", () => {
    it("sender is the bot's owner → allowed, skips both friend and block checks", async () => {
      mockGetUserInternal.mockResolvedValue({ id: "bot_1", isBot: true, ownerUserId: "u_owner", deletedAt: null })
      const res = await guardDmOpen(db, "u_owner", "bot_1")
      expect(res).toEqual({ ok: true })
      expect(mockAreFriends).not.toHaveBeenCalled()
      expect(mockIsBlocked).not.toHaveBeenCalled()
    })

    it("not the owner, not friends, callerKind human (default) → 404 user_not_found (pass-as-human)", async () => {
      mockGetUserInternal.mockResolvedValue({ id: "bot_1", isBot: true, ownerUserId: "u_owner", deletedAt: null })
      mockAreFriends.mockResolvedValue(false)
      const res = await guardDmOpen(db, "u_stranger", "bot_1")
      expect(res).toEqual({ ok: false, status: 404, error: "user not found", code: "user_not_found" })
    })

    it("not the owner, not friends, callerKind bot → 403 not_friends", async () => {
      mockGetUserInternal.mockResolvedValue({ id: "bot_1", isBot: true, ownerUserId: "u_owner", deletedAt: null })
      mockAreFriends.mockResolvedValue(false)
      const res = await guardDmOpen(db, "bot_caller", "bot_1", { callerKind: "bot" })
      expect(res).toEqual({ ok: false, status: 403, error: "not friends with this bot", code: "not_friends" })
    })

    it("friends with the bot → block-gated, then ok", async () => {
      mockGetUserInternal.mockResolvedValue({ id: "bot_1", isBot: true, ownerUserId: "u_owner", deletedAt: null })
      mockAreFriends.mockResolvedValue(true)
      mockIsBlocked.mockResolvedValue(false)
      const res = await guardDmOpen(db, "u_friend", "bot_1", { callerKind: "bot" })
      expect(res).toEqual({ ok: true })
      expect(mockIsBlocked).toHaveBeenCalled()
    })

    it("friends with the bot but blocked → 403 blocked", async () => {
      mockGetUserInternal.mockResolvedValue({ id: "bot_1", isBot: true, ownerUserId: "u_owner", deletedAt: null })
      mockAreFriends.mockResolvedValue(true)
      mockIsBlocked.mockResolvedValue(true)
      const res = await guardDmOpen(db, "u_friend", "bot_1", { callerKind: "bot" })
      expect(res).toEqual({ ok: false, status: 403, error: "blocked", code: "blocked" })
    })
  })
})

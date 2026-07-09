import { describe, it, expect, vi, beforeEach } from "vitest"

const getMember = vi.fn()
const getChannelForMember = vi.fn()
const getDM = vi.fn()
const isBlocked = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => getMember(...a) },
      communityChannel: { getChannelForMember: (...a: unknown[]) => getChannelForMember(...a) },
      communityDm: { getDM: (...a: unknown[]) => getDM(...a) },
      communityFriendship: { isBlocked: (...a: unknown[]) => isBlocked(...a) },
    },
  }
})

import {
  requireServerMember,
  requireServerAdmin,
  requireChannelMember,
  requireDMParticipant,
  requireNotBlocked,
} from "./permissions"

const db = {} as never

describe("requireServerMember", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the member when present", async () => {
    getMember.mockResolvedValue({ id: "m1", role: "member" })
    const res = await requireServerMember(db, "s1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual({ id: "m1", role: "member" })
  })

  it("returns 403 when the user is not a member", async () => {
    getMember.mockResolvedValue(null)
    const res = await requireServerMember(db, "s1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "not a member of this server" })
  })
})

describe("requireServerAdmin", () => {
  beforeEach(() => vi.clearAllMocks())

  it("passes for owner", async () => {
    getMember.mockResolvedValue({ id: "m1", role: "owner" })
    const res = await requireServerAdmin(db, "s1", "u1")
    expect(res.ok).toBe(true)
  })

  it("passes for admin", async () => {
    getMember.mockResolvedValue({ id: "m1", role: "admin" })
    const res = await requireServerAdmin(db, "s1", "u1")
    expect(res.ok).toBe(true)
  })

  it("rejects a plain member", async () => {
    getMember.mockResolvedValue({ id: "m1", role: "member" })
    const res = await requireServerAdmin(db, "s1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "admin permission required" })
  })

  it("rejects when not a member at all", async () => {
    getMember.mockResolvedValue(null)
    const res = await requireServerAdmin(db, "s1", "u1")
    expect(res.ok).toBe(false)
  })
})

describe("requireChannelMember", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the channel when the join hits", async () => {
    getChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    const res = await requireChannelMember(db, "c1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.id).toBe("c1")
  })

  it("returns 403 when the join is empty (non-member or non-existent channel)", async () => {
    getChannelForMember.mockResolvedValue(null)
    const res = await requireChannelMember(db, "c1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "forbidden" })
  })
})

describe("requireDMParticipant", () => {
  beforeEach(() => vi.clearAllMocks())

  it("accepts user1 and returns user2 as otherUserId", async () => {
    getDM.mockResolvedValue({ id: "d1", user1Id: "u1", user2Id: "u2", lastMessageAt: null, createdAt: "2026-06-30" })
    isBlocked.mockResolvedValue(false)
    const res = await requireDMParticipant(db, "d1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.otherUserId).toBe("u2")
  })

  it("accepts user2 and returns user1 as otherUserId", async () => {
    getDM.mockResolvedValue({ id: "d1", user1Id: "u2", user2Id: "u1", lastMessageAt: null, createdAt: "2026-06-30" })
    isBlocked.mockResolvedValue(false)
    const res = await requireDMParticipant(db, "d1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.otherUserId).toBe("u2")
  })

  it("rejects an outsider", async () => {
    getDM.mockResolvedValue({ id: "d1", user1Id: "u2", user2Id: "u3", lastMessageAt: null, createdAt: "2026-06-30" })
    const res = await requireDMParticipant(db, "d1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "forbidden" })
  })

  it("returns 404 when the DM doesn't exist", async () => {
    getDM.mockResolvedValue(null)
    const res = await requireDMParticipant(db, "d1", "u1")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  it("returns 404 when participant ids are null (orphan row)", async () => {
    getDM.mockResolvedValue({ id: "d1", user1Id: null, user2Id: "u1", lastMessageAt: null, createdAt: "2026-06-30" })
    const res = await requireDMParticipant(db, "d1", "u1")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  it("returns 403 'blocked' when the participants are in a blocked relationship", async () => {
    getDM.mockResolvedValue({ id: "d1", user1Id: "u1", user2Id: "u2", lastMessageAt: null, createdAt: "2026-06-30" })
    isBlocked.mockResolvedValue(true)
    const res = await requireDMParticipant(db, "d1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "blocked" })
  })

  it("does not consult isBlocked when the participant check already fails", async () => {
    // Non-participant → short-circuit before the block query. Locking this in
    // keeps the helper from making an unnecessary round-trip for outsiders.
    getDM.mockResolvedValue({ id: "d1", user1Id: "u2", user2Id: "u3", lastMessageAt: null, createdAt: "2026-06-30" })
    const res = await requireDMParticipant(db, "d1", "u1")
    expect(res.ok).toBe(false)
    expect(isBlocked).not.toHaveBeenCalled()
  })

  it("does not consult isBlocked when the DM is missing", async () => {
    getDM.mockResolvedValue(null)
    await requireDMParticipant(db, "d1", "u1")
    expect(isBlocked).not.toHaveBeenCalled()
  })
})

describe("requireNotBlocked", () => {
  beforeEach(() => vi.clearAllMocks())

  it("passes when neither user has blocked the other", async () => {
    isBlocked.mockResolvedValue(false)
    const res = await requireNotBlocked(db, "u1", "u2")
    expect(res.ok).toBe(true)
  })

  it("returns 403 when a block exists in either direction", async () => {
    isBlocked.mockResolvedValue(true)
    const res = await requireNotBlocked(db, "u1", "u2")
    expect(res).toEqual({ ok: false, status: 403, error: "blocked" })
  })
})


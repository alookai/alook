import { describe, it, expect, vi, beforeEach } from "vitest"

const getMember = vi.fn()
const getChannelForMember = vi.fn()
const getChannel = vi.fn()
const resolveChannelAccessContext = vi.fn()
const getDM = vi.fn()
const getDMPeer = vi.fn()
const isBlocked = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => getMember(...a) },
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => getChannelForMember(...a),
        getChannel: (...a: unknown[]) => getChannel(...a),
        resolveChannelAccessContext: (...a: unknown[]) => resolveChannelAccessContext(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => getDM(...a),
        getDMPeer: (...a: unknown[]) => getDMPeer(...a),
      },
      communityFriendship: { isBlocked: (...a: unknown[]) => isBlocked(...a) },
    },
  }
})

import {
  requireServerMember,
  requireServerAdmin,
  requireChannelMember,
  requireChannelAccess,
  requireDMAccess,
  requireNotBlocked,
  requireMessageSurfaceAccess,
} from "./permissions"

// Build a resolveChannelAccessContext return row. `anchor` defaults to the
// channel itself (top-level); pass a distinct anchor for the thread cases.
function ctxRow(over: Partial<{
  channelId: string
  serverId: string
  parentChannelId: string | null
  creatorId: string | null
  role: string
  isPrivate: boolean
  isChannelMember: boolean
}> = {}) {
  const {
    channelId = "c1",
    serverId = "s1",
    parentChannelId = null,
    creatorId = "creator",
    role = "member",
    isPrivate = false,
    isChannelMember = false,
  } = over
  const channel = { id: channelId, serverId, type: "text", parentChannelId, parentMessageId: null, creatorId }
  return {
    channel,
    anchor: parentChannelId ? { id: parentChannelId, serverId, parentChannelId: null, creatorId } : channel,
    role,
    isPrivate,
    isChannelMember,
    // resolveChannelAccessContext now returns the roster-anchor creator flag;
    // the caller in these tests is always "u1".
    isCreator: creatorId === "u1",
  }
}

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

describe("requireChannelAccess", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 403 for a non-server-member (null context)", async () => {
    resolveChannelAccessContext.mockResolvedValue(null)
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "forbidden" })
  })

  it("public channel: any member has access, canManage only for admins", async () => {
    resolveChannelAccessContext.mockResolvedValue(ctxRow({ role: "member", isPrivate: false }))
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.canManage).toBe(false)
  })

  it("public channel: admin gets canManage", async () => {
    resolveChannelAccessContext.mockResolvedValue(ctxRow({ role: "admin", isPrivate: false }))
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.canManage).toBe(true)
  })

  it("private channel: creator has access + canManage", async () => {
    resolveChannelAccessContext.mockResolvedValue(
      ctxRow({ role: "member", isPrivate: true, creatorId: "u1" }),
    )
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.canManage).toBe(true)
  })

  it("private channel: added member has access, not canManage", async () => {
    resolveChannelAccessContext.mockResolvedValue(
      ctxRow({ role: "member", isPrivate: true, creatorId: "other", isChannelMember: true }),
    )
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.canManage).toBe(false)
  })

  it("private channel: unrelated member is forbidden", async () => {
    resolveChannelAccessContext.mockResolvedValue(
      ctxRow({ role: "member", isPrivate: true, creatorId: "other", isChannelMember: false }),
    )
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "forbidden" })
  })

  it("private channel: admin NOT a member/creator is forbidden (no content privilege)", async () => {
    resolveChannelAccessContext.mockResolvedValue(
      ctxRow({ role: "owner", isPrivate: true, creatorId: "other", isChannelMember: false }),
    )
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "forbidden" })
  })

  it("private channel: admin who IS a member has access + canManage", async () => {
    resolveChannelAccessContext.mockResolvedValue(
      ctxRow({ role: "owner", isPrivate: true, creatorId: "other", isChannelMember: true }),
    )
    const res = await requireChannelAccess(db, "c1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.canManage).toBe(true)
  })

  it("thread under a private channel: added member of the parent has access", async () => {
    resolveChannelAccessContext.mockResolvedValue(
      ctxRow({ channelId: "t1", parentChannelId: "c1", role: "member", isPrivate: true, creatorId: "other", isChannelMember: true }),
    )
    const res = await requireChannelAccess(db, "t1", "u1")
    expect(res.ok).toBe(true)
  })

  it("thread under a private channel: unrelated member is forbidden", async () => {
    resolveChannelAccessContext.mockResolvedValue(
      ctxRow({ channelId: "t1", parentChannelId: "c1", role: "member", isPrivate: true, creatorId: "other", isChannelMember: false }),
    )
    const res = await requireChannelAccess(db, "t1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "forbidden" })
  })
})

describe("requireDMAccess", () => {
  beforeEach(() => vi.clearAllMocks())

  it("accepts a participant and returns the peer as otherUserId", async () => {
    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue({ otherUserId: "u2" })
    isBlocked.mockResolvedValue(false)
    const res = await requireDMAccess(db, "d1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.otherUserId).toBe("u2")
  })

  it("rejects an outsider (no peer row) with 404", async () => {
    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue(null)
    const res = await requireDMAccess(db, "d1", "u1")
    expect(res).toEqual({ ok: false, status: 404, error: "dm not found" })
  })

  it("returns 404 when the DM doesn't exist", async () => {
    getDM.mockResolvedValue(null)
    const res = await requireDMAccess(db, "d1", "u1")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  // Existence-mask parity: the no-dm and no-peer 404s must be BYTE-IDENTICAL to
  // each other, not merely both 404. If they diverge (e.g. one grows a distinct
  // error string), a caller can tell "DM exists but you're not in it" apart from
  // "no such DM" and probe DM existence for arbitrary channel ids. The two
  // branches deep-equal here, not each-asserted-404 — divergence must fail the
  // test, whichever branch drifts. (Freezes today's correct behavior as a
  // before-baseline invariant ahead of the channel-type trait refactor, where
  // the 404-on-no-access rule moves into a visibility trait value.)
  it("existence mask: no-dm and no-peer 404s are byte-identical (no existence oracle)", async () => {
    getDM.mockResolvedValue(null)
    const noDm = await requireDMAccess(db, "d1", "u1")

    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue(null)
    const noPeer = await requireDMAccess(db, "d1", "u1")

    expect(noDm).toEqual(noPeer)
    expect(noDm).toEqual({ ok: false, status: 404, error: "dm not found" })
  })

  it("returns 403 'blocked' when the participants are in a blocked relationship", async () => {
    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue({ otherUserId: "u2" })
    isBlocked.mockResolvedValue(true)
    const res = await requireDMAccess(db, "d1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "blocked" })
  })

  it("does not consult isBlocked when the participant check already fails", async () => {
    // Non-participant → short-circuit before the block query. Locking this in
    // keeps the helper from making an unnecessary round-trip for outsiders.
    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue(null)
    const res = await requireDMAccess(db, "d1", "u1")
    expect(res.ok).toBe(false)
    expect(isBlocked).not.toHaveBeenCalled()
  })

  it("does not consult isBlocked when the DM is missing", async () => {
    getDM.mockResolvedValue(null)
    await requireDMAccess(db, "d1", "u1")
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


describe("requireMessageSurfaceAccess — id-in-path trunk dispatch (surface axis not flattened)", () => {
  beforeEach(() => {
    getChannel.mockReset()
    getChannelForMember.mockReset()
    getDM.mockReset()
    getDMPeer.mockReset()
    isBlocked.mockReset()
  })

  it("unknown channel id → single 404 on every surface (existence-masked)", async () => {
    getChannel.mockResolvedValue(null)
    const res = await requireMessageSurfaceAccess(db, "nope", "u1")
    expect(res).toEqual({ ok: false, status: 404, error: "not found" })
  })

  it("DM id → routes to requireDMAccess (block check runs — closes the P0), ok when a participant & not blocked", async () => {
    getChannel.mockResolvedValue({ id: "d1", type: "dm" })
    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue({ otherUserId: "u2" })
    isBlocked.mockResolvedValue(false)
    const res = await requireMessageSurfaceAccess(db, "d1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.surface).toBe("dm")
    // The block check that the plain-channel path never ran — now on the DM arm.
    expect(isBlocked).toHaveBeenCalledWith(db, "u1", "u2")
  })

  it("DM id, blocked participant → 403 (a legit known-participant 403, not existence disclosure)", async () => {
    getChannel.mockResolvedValue({ id: "d1", type: "dm" })
    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue({ otherUserId: "u2" })
    isBlocked.mockResolvedValue(true)
    const res = await requireMessageSurfaceAccess(db, "d1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "blocked" })
  })

  it("DM id, non-participant → 404 (masks DM existence — NOT a channel 403)", async () => {
    getChannel.mockResolvedValue({ id: "d1", type: "dm" })
    getDM.mockResolvedValue({ id: "d1", lastMessageAt: null, createdAt: "2026-06-30" })
    getDMPeer.mockResolvedValue(null)
    const res = await requireMessageSurfaceAccess(db, "d1", "u1")
    expect(res).toEqual({ ok: false, status: 404, error: "dm not found" })
  })

  it("channel id, known but non-member → 403 (the unknown case already 404'd above, so 403 = real non-member)", async () => {
    getChannel.mockResolvedValue({ id: "c1", type: "text" })
    getChannelForMember.mockResolvedValue(null) // known (getChannel found it) but caller not a member
    const res = await requireMessageSurfaceAccess(db, "c1", "u1")
    expect(res).toEqual({ ok: false, status: 403, error: "forbidden" })
  })

  it("channel id, member → ok, surface=channel", async () => {
    getChannel.mockResolvedValue({ id: "c1", type: "text" })
    getChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    const res = await requireMessageSurfaceAccess(db, "c1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.surface).toBe("channel")
  })

  it("thread id (child channel) → channel arm, member gate (thread inherits parent audience)", async () => {
    getChannel.mockResolvedValue({ id: "t1", type: "thread" })
    getChannelForMember.mockResolvedValue({ id: "t1", serverId: "s1" })
    const res = await requireMessageSurfaceAccess(db, "t1", "u1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.surface).toBe("channel")
  })
})

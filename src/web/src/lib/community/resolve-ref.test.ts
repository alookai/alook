import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetUserInternal = vi.fn()
const mockGetUserByNameAndDiscriminator = vi.fn()
const mockAreFriends = vi.fn()
const mockIsBlocked = vi.fn()
const mockCreateOrGetDM = vi.fn()
const mockGetDMBetween = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockResolveChannelByNameForMember = vi.fn()
const mockGetMessageByChannelAndSeq = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()
const mockCreateChannelUnified = vi.fn()

vi.mock("./channel-service", () => ({
  createChannelUnified: (...a: unknown[]) => mockCreateChannelUnified(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUserByNameAndDiscriminator: (...a: unknown[]) => mockGetUserByNameAndDiscriminator(...a),
      },
      communityFriendship: {
        areFriends: (...a: unknown[]) => mockAreFriends(...a),
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
      },
      communityDm: {
        createOrGetDM: (...a: unknown[]) => mockCreateOrGetDM(...a),
        getDMBetween: (...a: unknown[]) => mockGetDMBetween(...a),
      },
      communityServer: {
        resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a),
      },
      communityChannel: {
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        getThreadChannelByParentMessage: (...a: unknown[]) => mockGetThreadChannelByParentMessage(...a),
      },
      communityMessage: {
        getMessageByChannelAndSeq: (...a: unknown[]) => mockGetMessageByChannelAndSeq(...a),
      },
    },
  }
})

import { resolveTargetForMember, resolveErrorResponse } from "./resolve-ref"

const db = {} as never

describe("resolveTargetForMember", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("400 malformed channel ref for a ref not starting with /", async () => {
    const res = await resolveTargetForMember(db, "u_1", "not-a-ref")
    expect(res).toEqual({ error: 400, message: "malformed channel ref" })
  })

  it("400 rejects a ref carrying a pinned #N message seq", async () => {
    const res = await resolveTargetForMember(db, "u_1", "/studio/general#5")
    expect(res).toMatchObject({ error: 400 })
    expect((res as { message: string }).message).toMatch(/must not pin/)
  })

  describe("DM refs (/.dm/<peer#0042>)", () => {
    it("404 DM threads are not supported", async () => {
      const res = await resolveTargetForMember(db, "u_1", "/.dm/peer#0001/#3")
      expect(res).toEqual({ error: 404, message: "DM threads are not supported" })
    })

    it("400 invalid DM handle when the segment has no #0042 tag", async () => {
      const res = await resolveTargetForMember(db, "u_1", "/.dm/peer_1")
      expect(res).toEqual({ error: 400, message: "invalid DM handle, expected name#0042" })
      expect(mockGetUserByNameAndDiscriminator).not.toHaveBeenCalled()
    })

    it("404 user not found when peer is missing or soft-deleted", async () => {
      mockGetUserByNameAndDiscriminator.mockResolvedValue(null)
      const res = await resolveTargetForMember(db, "u_1", "/.dm/peer#0001")
      expect(res).toEqual({ error: 404, message: "user not found" })
      expect(mockGetUserByNameAndDiscriminator).toHaveBeenCalledWith(db, "peer", "0001")
    })

    it("without createDmIfMissing: 404 dm not found when no existing DM row", async () => {
      mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
      mockGetDMBetween.mockResolvedValue(null)
      const res = await resolveTargetForMember(db, "u_1", "/.dm/peer#0001")
      expect(res).toEqual({ error: 404, message: "dm not found" })
      expect(mockCreateOrGetDM).not.toHaveBeenCalled()
    })

    it("without createDmIfMissing: resolves an existing DM without calling guardDmOpen", async () => {
      mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
      mockGetDMBetween.mockResolvedValue({ id: "dm_1" })
      const res = await resolveTargetForMember(db, "u_1", "/.dm/peer#0001")
      expect(res).toEqual({ kind: "dm", dmConversationId: "dm_1", otherUserId: "peer_1" })
      expect(mockIsBlocked).not.toHaveBeenCalled()
    })

    it("with createDmIfMissing: blocked by guardDmOpen surfaces the guard's status/error", async () => {
      mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
      mockGetUserInternal.mockResolvedValue({ id: "peer_1", deletedAt: null })
      mockIsBlocked.mockResolvedValue(true)
      const res = await resolveTargetForMember(db, "u_1", "/.dm/peer#0001", { createDmIfMissing: true })
      expect(res).toEqual({ error: 403, message: "blocked" })
      expect(mockCreateOrGetDM).not.toHaveBeenCalled()
    })

    it("with createDmIfMissing: creates/gets the DM when guard passes", async () => {
      mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
      mockGetUserInternal.mockResolvedValue({ id: "peer_1", deletedAt: null })
      mockIsBlocked.mockResolvedValue(false)
      mockCreateOrGetDM.mockResolvedValue({ id: "dm_new" })
      const res = await resolveTargetForMember(db, "u_1", "/.dm/peer#0001", { createDmIfMissing: true })
      expect(res).toEqual({ kind: "dm", dmConversationId: "dm_new", otherUserId: "peer_1" })
      expect(mockCreateOrGetDM).toHaveBeenCalledWith(db, { userId1: "u_1", userId2: "peer_1" })
    })
  })

  describe("channel refs (/server/channel)", () => {
    it("404 server not found", async () => {
      mockResolveServerByNameForMember.mockResolvedValue([])
      const res = await resolveTargetForMember(db, "u_1", "/studio/general")
      expect(res).toEqual({ error: 404, message: "server not found: studio" })
    })

    it("400 ambiguous server name returns hint list", async () => {
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }, { id: "srv_2" }])
      const res = await resolveTargetForMember(db, "u_1", "/studio/general")
      expect(res).toEqual({
        error: 400,
        message: "ambiguous server name",
        hint: [
          { id: "srv_1", path: "/srv_1/general" },
          { id: "srv_2", path: "/srv_2/general" },
        ],
      })
    })

    it("404 channel not found", async () => {
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
      mockResolveChannelByNameForMember.mockResolvedValue([])
      const res = await resolveTargetForMember(db, "u_1", "/studio/general")
      expect(res).toEqual({ error: 404, message: "channel not found: general" })
    })

    it("resolves a plain channel ref to { kind: channel, channelId }", async () => {
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
      mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
      const res = await resolveTargetForMember(db, "u_1", "/studio/general")
      expect(res).toEqual({ kind: "channel", channelId: "ch_1" })
    })

    it("resolves to the top-level channel when a thread under it shares the same name", async () => {
      // DB partial-unique guarantees the resolver returns at most one row for
      // a name lookup — the top-level channel. Same-named thread stays
      // unreachable via the name path.
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
      mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_top" }])
      const res = await resolveTargetForMember(db, "u_1", "/studio/general")
      expect(res).toEqual({ kind: "channel", channelId: "ch_top" })
      expect(mockResolveChannelByNameForMember).toHaveBeenCalledWith(db, "srv_1", "u_1", "general")
    })

    it("404 channel not found when caller passes a raw top-level channel id (id refs rejected)", async () => {
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
      // Name-only resolver returns [] when the segment is an id — the DB
      // lookup misses because the row's `name` column doesn't match the id.
      mockResolveChannelByNameForMember.mockResolvedValue([])
      const res = await resolveTargetForMember(db, "u_1", "/studio/mFUplbfFL7PIzeiaP3Ysg")
      expect(res).toEqual({ error: 404, message: "channel not found: mFUplbfFL7PIzeiaP3Ysg" })
    })

    it("404 channel not found when caller passes a raw thread id (id refs rejected)", async () => {
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
      mockResolveChannelByNameForMember.mockResolvedValue([])
      const res = await resolveTargetForMember(db, "u_1", "/studio/WyHlYFioUV_V9oRZXlSir")
      expect(res).toEqual({ error: 404, message: "channel not found: WyHlYFioUV_V9oRZXlSir" })
    })
  })

  describe("thread refs (/server/channel/#N)", () => {
    beforeEach(() => {
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
      mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    })

    it("404 when the root message (seq #N) doesn't exist", async () => {
      mockGetMessageByChannelAndSeq.mockResolvedValue(null)
      const res = await resolveTargetForMember(db, "u_1", "/studio/general/#7")
      expect(res).toEqual({ error: 404, message: "no message with seq #7 in this channel" })
    })

    it("resolves to the existing thread channel when one already exists", async () => {
      mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "msg_1" })
      mockGetThreadChannelByParentMessage.mockResolvedValue({ id: "thread_1" })
      const res = await resolveTargetForMember(db, "u_1", "/studio/general/#7")
      expect(res).toEqual({ kind: "channel", channelId: "thread_1" })
      expect(mockCreateChannelUnified).not.toHaveBeenCalled()
    })

    it("404 thread not found when missing and createThreadIfMissing is false", async () => {
      mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "msg_1" })
      mockGetThreadChannelByParentMessage.mockResolvedValue(null)
      const res = await resolveTargetForMember(db, "u_1", "/studio/general/#7")
      expect(res).toEqual({ error: 404, message: "thread not found" })
    })

    it("auto-creates via createChannelUnified (agent path: no seeding) when createThreadIfMissing is true", async () => {
      mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "msg_1" })
      mockGetThreadChannelByParentMessage.mockResolvedValue(null)
      mockCreateChannelUnified.mockResolvedValue({ ok: true, created: true, channel: { id: "thread_new" } })
      const res = await resolveTargetForMember(db, "u_1", "/studio/general/#7", { createThreadIfMissing: true })
      expect(res).toEqual({ kind: "channel", channelId: "thread_new" })
      expect(mockCreateChannelUnified).toHaveBeenCalledWith(
        db,
        { userId: "u_1" },
        { type: "thread", parentMessageId: "msg_1" },
        { seedCreator: false, seedRootAuthor: false },
      )
    })

    it("R18: on a lost create race (service returns created:false), re-uses the winner without erroring", async () => {
      mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "msg_1" })
      mockGetThreadChannelByParentMessage.mockResolvedValue(null)
      // The service absorbs the unique-constraint conflict and returns the
      // existing winner with created:false.
      mockCreateChannelUnified.mockResolvedValue({ ok: true, created: false, channel: { id: "thread_winner" } })
      const res = await resolveTargetForMember(db, "u_1", "/studio/general/#7", { createThreadIfMissing: true })
      expect(res).toEqual({ kind: "channel", channelId: "thread_winner" })
    })

    it("maps a service error branch to a resolver error (409 → 400)", async () => {
      mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "msg_1" })
      mockGetThreadChannelByParentMessage.mockResolvedValue(null)
      mockCreateChannelUnified.mockResolvedValue({ ok: false, status: 400, error: "can't start a thread on a message in a thread or forum post" })
      const res = await resolveTargetForMember(db, "u_1", "/studio/general/#7", { createThreadIfMissing: true })
      expect(res).toMatchObject({ error: 400 })
    })
  })
})

describe("resolveErrorResponse", () => {
  it("maps error+message to a JSON response with matching status, no hint key when absent", async () => {
    const res = resolveErrorResponse({ error: 404, message: "not found" })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not found" })
  })

  it("includes hint when present", async () => {
    const res = resolveErrorResponse({
      error: 400,
      message: "ambiguous",
      hint: [{ id: "a", path: "/a/b" }],
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "ambiguous", hint: [{ id: "a", path: "/a/b" }] })
  })
})

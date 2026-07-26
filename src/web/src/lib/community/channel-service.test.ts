import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockGetCategory = vi.fn()
const mockCreateChannel = vi.fn()
const mockCreateChannelMember = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetChannel = vi.fn()
const mockGetMessage = vi.fn()
const mockGetThreadByParentMessage = vi.fn()
const mockAddThreadParticipants = vi.fn()
const mockGetUserSelf = vi.fn()

const mockFanOutToChannel = vi.fn()
const mockFanOutToServerMembers = vi.fn()
const mockCreateCommunityMessage = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityCategory: { getCategory: (...a: unknown[]) => mockGetCategory(...a) },
      communityChannel: {
        createChannel: (...a: unknown[]) => mockCreateChannel(...a),
        createChannelMember: (...a: unknown[]) => mockCreateChannelMember(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getThreadChannelByParentMessage: (...a: unknown[]) => mockGetThreadByParentMessage(...a),
      },
      communityMessage: { getMessage: (...a: unknown[]) => mockGetMessage(...a) },
      communityThread: { addThreadParticipants: (...a: unknown[]) => mockAddThreadParticipants(...a) },
      user: { getUserSelf: (...a: unknown[]) => mockGetUserSelf(...a) },
    },
  }
})

vi.mock("./fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  fanOutToServerMembers: (...a: unknown[]) => mockFanOutToServerMembers(...a),
  broadcastToUserSafe: vi.fn(async () => {}),
}))
vi.mock("./message-handler", () => ({
  createCommunityMessage: (...a: unknown[]) => mockCreateCommunityMessage(...a),
}))
vi.mock("./audit", () => ({ logAudit: vi.fn() }))

import { createChannelUnified } from "./channel-service"

const db = {} as never
const actor = { userId: "u1" }

beforeEach(() => {
  vi.clearAllMocks()
  mockFanOutToChannel.mockResolvedValue(undefined)
  mockFanOutToServerMembers.mockResolvedValue(undefined)
  mockAddThreadParticipants.mockResolvedValue(undefined)
})

describe("createChannelUnified — text / forum (top-level)", () => {
  beforeEach(() => {
    mockCreateChannel.mockResolvedValue({
      id: "c_new", name: "general", type: "text", categoryId: null, topic: "", position: 0,
      createdAt: "2026-07-12T00:00:00Z",
    })
  })

  it("admin creates an uncategorized text channel; fans out server-wide", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    const r = await createChannelUnified(db, actor, { type: "text", serverId: "s1", name: "General Chat" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.created).toBe(true)
    // slugified
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "General-Chat", type: "text" }),
    )
    expect(mockFanOutToServerMembers).toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("rejects a plain member creating an uncategorized channel (403)", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    const r = await createChannelUnified(db, actor, { type: "text", serverId: "s1", name: "chan" })
    expect(r).toEqual({ ok: false, status: 403, error: "admin permission required" })
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("member CAN create in a private category; seeds creator member row + channel-scoped fanout", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    mockGetCategory.mockResolvedValue({ id: "cat1", serverId: "s1", private: 1 })
    const r = await createChannelUnified(db, actor, { type: "text", serverId: "s1", name: "chan", categoryId: "cat1" })
    expect(r.ok).toBe(true)
    expect(mockCreateChannelMember).toHaveBeenCalledWith(expect.anything(), {
      channelId: "c_new", userId: "u1", addedBy: "u1",
    })
    expect(mockFanOutToChannel).toHaveBeenCalled()
    expect(mockFanOutToServerMembers).not.toHaveBeenCalled()
  })

  it("returns 409 on a unique-constraint conflict", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    mockCreateChannel.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
    )
    const r = await createChannelUnified(db, actor, { type: "text", serverId: "s1", name: "general" })
    expect(r).toEqual({ ok: false, status: 409, error: "a channel with this name already exists" })
  })
})

describe("createChannelUnified — post", () => {
  beforeEach(() => {
    mockGetChannelForMember.mockResolvedValue({ id: "forum1", serverId: "s1", type: "forum" })
    mockCreateChannel.mockResolvedValue({
      id: "post1", name: "my-post", type: "post", parentChannelId: "forum1",
      createdAt: "2026-07-02T00:00:00Z",
    })
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m1", createdAt: "2026-07-02T00:00:00Z" } })
    mockGetUserSelf.mockResolvedValue({ id: "u1", name: "Alice", image: null })
  })

  it("routes the opener via kind:channel with the post's OWN id (not kind:post), enrolls creator, emits ONE child_create", async () => {
    const r = await createChannelUnified(db, actor, {
      type: "post", parentChannelId: "forum1", name: "My Post", content: "hello",
    })
    expect(r.ok).toBe(true)
    // opener routed with kind:"channel" and the post's own id
    const sendArgs = mockCreateCommunityMessage.mock.calls[0]?.[0] as { target: { kind: string; channelId: string } }
    expect(sendArgs.target.kind).toBe("channel")
    expect(sendArgs.target.channelId).toBe("post1")
    // creator enrolled directly
    expect(mockAddThreadParticipants).toHaveBeenCalledWith(expect.anything(), "post1", [
      { userId: "u1", source: "spoke" },
    ])
    // exactly one CHILD_CHANNEL_CREATE to the parent forum
    expect(mockFanOutToChannel).toHaveBeenCalledTimes(1)
    const ev = mockFanOutToChannel.mock.calls[0]?.[1] as { type: string; channel: { type: string } }
    expect(ev.channel.type).toBe("post")
  })

  it("slugifies the name into channel.name", async () => {
    await createChannelUnified(db, actor, { type: "post", parentChannelId: "forum1", name: "My thoughts on this!", content: "x" })
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "My-thoughts-on-this!", type: "post" }),
    )
  })

  it("400 when the parent is not a forum", async () => {
    mockGetChannelForMember.mockResolvedValue({ id: "forum1", serverId: "s1", type: "text" })
    const r = await createChannelUnified(db, actor, { type: "post", parentChannelId: "forum1", name: "x", content: "hi" })
    expect(r).toEqual({ ok: false, status: 400, error: "channel is not a forum" })
  })

  it("400 post is empty when no content and no attachments", async () => {
    const r = await createChannelUnified(db, actor, { type: "post", parentChannelId: "forum1", name: "x", content: "  " })
    expect(r).toEqual({ ok: false, status: 400, error: "post is empty" })
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("pure-attachment post (empty content, object attachments) succeeds", async () => {
    const r = await createChannelUnified(db, actor, {
      type: "post", parentChannelId: "forum1", name: "img", content: "",
      attachments: [{ url: "/api/community/media/x.png", filename: "x.png", contentType: "image/png", size: 10 }],
    })
    expect(r.ok).toBe(true)
    const sendArgs = mockCreateCommunityMessage.mock.calls[0]?.[0] as { body: { attachments?: unknown[] } }
    expect(sendArgs.body.attachments).toHaveLength(1)
  })

  it("card fields present in the response envelope", async () => {
    const r = await createChannelUnified(db, actor, { type: "post", parentChannelId: "forum1", name: "p", content: "hi" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.channel.messageCount).toBe(0)
      expect(r.channel.authorId).toBe("u1")
      expect(r.channel.participants).toEqual([{ id: "u1", name: "Alice", avatar: "A" }])
      expect(r.channel.creator).toEqual({ id: "u1", name: "Alice", avatar: "A" })
    }
  })
})

describe("createChannelUnified — thread (human path, 3 guards)", () => {
  beforeEach(() => {
    mockGetMessage.mockResolvedValue({ id: "msg-p", authorId: "u-author", content: "the parent content", channelId: "c-parent" })
    mockGetChannelForMember.mockResolvedValue({ id: "c-parent", serverId: "s1", parentChannelId: null })
    mockGetThreadByParentMessage.mockResolvedValue(null)
    mockCreateChannel.mockResolvedValue({
      id: "t-new", name: "my thread", serverId: "s1", parentChannelId: "c-parent",
      parentMessageId: "msg-p", type: "thread", creatorId: "u1", createdAt: "2026-07-03T00:00:00Z",
    })
  })

  it("creates the thread, seeds creator (spoke) + root author (added), emits child_create; no message clone", async () => {
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p", name: "my thread" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.created).toBe(true)
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
    const [, tid, rows] = mockAddThreadParticipants.mock.calls[0] as [unknown, string, { userId: string; source: string }[]]
    expect(tid).toBe("t-new")
    expect(rows).toEqual([
      { userId: "u1", source: "spoke" },
      { userId: "u-author", source: "added" },
    ])
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentChannelId: "c-parent", parentMessageId: "msg-p", type: "thread" }),
    )
  })

  it("guard 1 (R10): 400 when rooting on a message in a child channel", async () => {
    mockGetChannelForMember.mockResolvedValue({ id: "post1", serverId: "s1", parentChannelId: "forum1" })
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p", name: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(400)
      expect(r.error).toContain("can't start a thread")
    }
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("guard 2: 409 (created:false) when the message already has a thread", async () => {
    mockGetThreadByParentMessage.mockResolvedValue({ id: "t-existing", createdAt: "2026-07-01T00:00:00Z" })
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p", name: "second" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.created).toBe(false)
      expect(r.channel.id).toBe("t-existing")
    }
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("guard 3: does NOT seed the root author when they lost parent-channel access", async () => {
    mockGetChannelForMember.mockImplementation(async (_db: unknown, _cid: string, userId: string) => {
      if (userId === "u1") return { id: "c-parent", serverId: "s1", parentChannelId: null }
      return null
    })
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p", name: "my thread" })
    expect(r.ok).toBe(true)
    const [, , rows] = mockAddThreadParticipants.mock.calls[0] as [unknown, string, { userId: string; source: string }[]]
    expect(rows).toEqual([{ userId: "u1", source: "spoke" }])
  })

  it("de-dupes when the creator threads their own message (one spoke row)", async () => {
    mockGetMessage.mockResolvedValue({ id: "msg-p", authorId: "u1", content: "mine", channelId: "c-parent" })
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p", name: "my thread" })
    expect(r.ok).toBe(true)
    const [, , rows] = mockAddThreadParticipants.mock.calls[0] as [unknown, string, { userId: string; source: string }[]]
    expect(rows).toEqual([{ userId: "u1", source: "spoke" }])
  })

  it("403 when the caller isn't a member of the parent channel's server", async () => {
    mockGetChannelForMember.mockResolvedValue(null)
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p", name: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("400 name required when name is blank", async () => {
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p", name: "  " })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })
})

describe("createChannelUnified — thread (agent path: seedCreator/seedRootAuthor false)", () => {
  beforeEach(() => {
    mockGetMessage.mockResolvedValue({ id: "msg-p", authorId: "u-author", content: "a very long root message body that should be truncated to forty chars max", channelId: "c-parent" })
    mockGetChannel.mockResolvedValue({ id: "c-parent", serverId: "s1", parentChannelId: null })
    mockGetThreadByParentMessage.mockResolvedValue(null)
    mockCreateChannel.mockResolvedValue({
      id: "t-agent", name: "derived", serverId: "s1", parentChannelId: "c-parent",
      parentMessageId: "msg-p", type: "thread", creatorId: "u1", createdAt: "2026-07-03T00:00:00Z",
    })
  })

  const opts = { seedCreator: false, seedRootAuthor: false }

  it("does NOT seed participants, does NOT emit child_create, does NOT run the member gate", async () => {
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p" }, opts)
    expect(r.ok).toBe(true)
    expect(mockAddThreadParticipants).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("derives the name from the root message (first 40 chars)", async () => {
    await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p" }, opts)
    const passed = mockCreateChannel.mock.calls[0]?.[1] as { name: string }
    expect(passed.name).toBe("a very long root message body that shoul")
    expect(passed.name.length).toBe(40)
  })

  it("falls back to 'Thread' when the root message has no usable text", async () => {
    mockGetMessage.mockResolvedValue({ id: "msg-p", authorId: "u-author", content: "", channelId: "c-parent" })
    await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p" }, opts)
    const passed = mockCreateChannel.mock.calls[0]?.[1] as { name: string }
    expect(passed.name).toBe("Thread")
  })

  it("400 top-level-only when the parent channel is itself a child channel", async () => {
    mockGetChannel.mockResolvedValue({ id: "c-parent", serverId: "s1", parentChannelId: "forum1" })
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p" }, opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  // R18 — concurrent create: unique-constraint conflict re-selects the winner
  // and returns created:false (not a throw).
  it("R18: on a lost create race, re-selects the winner and returns created:false", async () => {
    mockGetThreadByParentMessage
      .mockResolvedValueOnce(null) // initial dedupe miss
      .mockResolvedValueOnce({ id: "t-winner", createdAt: "2026-07-03T00:00:00Z" }) // re-select after conflict
    mockCreateChannel.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
    )
    const r = await createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p" }, opts)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.created).toBe(false)
      expect(r.channel.id).toBe("t-winner")
    }
  })

  it("rethrows a non-unique-constraint error from createChannel", async () => {
    mockCreateChannel.mockRejectedValue(new Error("boom"))
    await expect(
      createChannelUnified(db, actor, { type: "thread", parentMessageId: "msg-p" }, opts),
    ).rejects.toThrow("boom")
  })
})

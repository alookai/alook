import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreateCommunityMessage = vi.fn()
const mockCreateChannel = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockAddThreadParticipants = vi.fn()
const mockFanOutToChannel = vi.fn()
const mockDeleteChannel = vi.fn()

vi.mock("@/lib/community/message-handler", () => ({
  createCommunityMessage: (...a: unknown[]) => mockCreateCommunityMessage(...a),
}))

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: vi.fn(),
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityChannel: {
        ...actual.queries.communityChannel,
        createChannel: (...a: unknown[]) => mockCreateChannel(...a),
        getThreadChannelByParentMessage: (...a: unknown[]) => mockGetThreadChannelByParentMessage(...a),
        deleteChannel: (...a: unknown[]) => mockDeleteChannel(...a),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        hardDeleteMessage: (...a: unknown[]) => mockHardDeleteMessage(...a),
      },
      communityThread: {
        ...actual.queries.communityThread,
        addThreadParticipants: (...a: unknown[]) => mockAddThreadParticipants(...a),
      },
    },
  }
})

import { createMessageWithThread } from "./create-channels"

describe("createMessageWithThread (phase2 forum≡thread — atomic-by-compensation primitive)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("inserts the opener message into the PARENT channel, then opens a fresh thread rooted on it", async () => {
    mockCreateCommunityMessage.mockResolvedValue({
      ok: true,
      row: { id: "msg_1", content: "hello world", channelId: "forum_1" },
      attachments: [],
    })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "hello world" })

    const res = await createMessageWithThread({
      db: {} as any,
      authorId: "u1",
      parentChannelId: "forum_1",
      serverId: "s1",
      body: { content: "hello world" },
    })

    expect(res.ok).toBe(true)
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: "u1",
        target: { kind: "channel", channelId: "forum_1", serverId: "s1" },
      }),
    )
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: "s1",
        parentChannelId: "forum_1",
        parentMessageId: "msg_1",
        type: "thread",
        creatorId: "u1",
      }),
    )
    if (res.ok) {
      expect(res.message.id).toBe("msg_1")
      expect(res.thread.id).toBe("th_1")
    }
  })

  it("fresh-create seeds the author as a SPOKE participant and fires CHILD_CHANNEL_CREATE by default", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "hi", channelId: "forum_1" }, attachments: [] })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "hi" })

    await createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1", body: { content: "hi" },
    })

    expect(mockAddThreadParticipants).toHaveBeenCalledWith(
      expect.anything(), "th_1", [{ userId: "u1", source: "spoke" }],
    )
    expect(mockFanOutToChannel).toHaveBeenCalledTimes(1)
  })

  it("suppressBroadcast passes through to createCommunityMessage; suppressThreadFanout independently silences ONLY the thread's own CHILD_CHANNEL_CREATE — enroll still runs unconditionally", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "hi", channelId: "forum_1" }, attachments: [] })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "hi" })

    await createMessageWithThread({
      db: {} as any,
      authorId: "u1",
      parentChannelId: "forum_1",
      serverId: "s1",
      body: { content: "hi" },
      suppressBroadcast: true,
      suppressThreadFanout: true,
    })

    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ suppressBroadcast: true }),
    )
    // Enroll (structural core) is NOT gated by either suppress switch.
    expect(mockAddThreadParticipants).toHaveBeenCalledTimes(1)
    // But the thread's own broadcast IS silenced.
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("a concurrent-race re-select (not a fresh create) skips seed + fan-out entirely", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "hi", channelId: "forum_1" }, attachments: [] })
    // creatorId !== authorId ("u2") → this actor lost the race, re-selected someone else's row.
    mockCreateChannel.mockRejectedValue(Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT" }))
    mockGetThreadChannelByParentMessage.mockResolvedValue({ id: "th_1", creatorId: "u2", createdAt: "t0", name: "hi" })

    const res = await createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1", body: { content: "hi" },
    })

    expect(res.ok).toBe(true)
    expect(mockAddThreadParticipants).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
    expect(mockHardDeleteMessage).not.toHaveBeenCalled()
  })

  it("returns the message-handler's error verbatim without touching the thread path at all", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: false, status: 400, error: "content or attachments required" })

    const res = await createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1", body: { content: "" },
    })

    expect(res).toEqual({ ok: false, status: 400, error: "content or attachments required" })
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("compensates with hardDeleteMessage when the thread-open throws unrecoverably (no orphan message left behind)", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "hi", channelId: "forum_1" }, attachments: [] })
    mockCreateChannel.mockRejectedValue(new Error("D1 outage"))

    await expect(
      createMessageWithThread({
        db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1", body: { content: "hi" },
      }),
    ).rejects.toThrow("D1 outage")

    expect(mockHardDeleteMessage).toHaveBeenCalledWith(expect.anything(), "msg_1")
  })

  it("when the compensating hardDelete ALSO fails, logs both errors but re-throws the ORIGINAL thread-open error (never masks the real cause, never fails silently)", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "hi", channelId: "forum_1" }, attachments: [] })
    mockCreateChannel.mockRejectedValue(new Error("D1 outage"))
    mockHardDeleteMessage.mockRejectedValue(new Error("rollback also down"))

    await expect(
      createMessageWithThread({
        db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1", body: { content: "hi" },
      }),
    ).rejects.toThrow("D1 outage")

    expect(mockHardDeleteMessage).toHaveBeenCalledWith(expect.anything(), "msg_1")
  })

  it("with replyBody present, sends it as the thread's first reply via the SAME target shape any later reply would use", async () => {
    mockCreateCommunityMessage
      .mockResolvedValueOnce({ ok: true, row: { id: "msg_1", content: "My Post Title", channelId: "forum_1" }, attachments: [] })
      .mockResolvedValueOnce({ ok: true, row: { id: "msg_2", content: "the actual body text", channelId: "th_1" }, attachments: [] })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "My Post Title" })

    const res = await createMessageWithThread({
      db: {} as any,
      authorId: "u1",
      parentChannelId: "forum_1",
      serverId: "s1",
      body: { content: "My Post Title" },
      replyBody: { content: "the actual body text" },
    })

    expect(res.ok).toBe(true)
    // Second createCommunityMessage call is the reply, targeted at the THREAD.
    expect(mockCreateCommunityMessage).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        authorId: "u1",
        target: { kind: "thread", channelId: "th_1", parentChannelId: "forum_1", serverId: "s1" },
        body: { content: "the actual body text" },
      }),
    )
    if (res.ok) expect(res.reply?.id).toBe("msg_2")
  })

  it("without replyBody, reply is null and only ONE createCommunityMessage call happens (the migration M=0 orphan path — opener + empty thread is a normal state)", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "Old Post Title", channelId: "forum_1" }, attachments: [] })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "Old Post Title" })

    const res = await createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1", body: { content: "Old Post Title" },
    })

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.reply).toBeNull()
    expect(mockCreateCommunityMessage).toHaveBeenCalledTimes(1)
  })

  it("when the reply send fails, unwinds the WHOLE structure — deletes the thread (FK-cascades any partial reply) AND hard-deletes the opener, never leaving a half-built post", async () => {
    mockCreateCommunityMessage
      .mockResolvedValueOnce({ ok: true, row: { id: "msg_1", content: "Title", channelId: "forum_1" }, attachments: [] })
      .mockResolvedValueOnce({ ok: false, status: 400, error: "content or attachments required" })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "Title" })

    const res = await createMessageWithThread({
      db: {} as any,
      authorId: "u1",
      parentChannelId: "forum_1",
      serverId: "s1",
      body: { content: "Title" },
      replyBody: { content: "" },
    })

    expect(res).toEqual({ ok: false, status: 400, error: "content or attachments required" })
    expect(mockDeleteChannel).toHaveBeenCalledWith(expect.anything(), "th_1")
    expect(mockHardDeleteMessage).toHaveBeenCalledWith(expect.anything(), "msg_1")
  })

  it("when the reply-failure rollback ALSO fails, logs both errors but still returns the ORIGINAL reply error (never masks the real cause)", async () => {
    mockCreateCommunityMessage
      .mockResolvedValueOnce({ ok: true, row: { id: "msg_1", content: "Title", channelId: "forum_1" }, attachments: [] })
      .mockResolvedValueOnce({ ok: false, status: 500, error: "d1 outage" })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "Title" })
    mockDeleteChannel.mockRejectedValue(new Error("rollback also down"))

    const res = await createMessageWithThread({
      db: {} as any,
      authorId: "u1",
      parentChannelId: "forum_1",
      serverId: "s1",
      body: { content: "Title" },
      replyBody: { content: "body" },
    })

    expect(res).toEqual({ ok: false, status: 500, error: "d1 outage" })
  })
})

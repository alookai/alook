import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreateCommunityMessage = vi.fn()
const mockCreateChannel = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockAddThreadParticipants = vi.fn()
const mockFanOutToChannel = vi.fn()
const mockDeleteChannel = vi.fn()
const mockListMessageAttachments = vi.fn()
const mockRebindPendingAttachmentsToChild = vi.fn()

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
      communityAttachment: {
        ...actual.queries.communityAttachment,
        listMessageAttachments: (...a: unknown[]) => mockListMessageAttachments(...a),
        rebindPendingAttachmentsToChild: (...a: unknown[]) => mockRebindPendingAttachmentsToChild(...a),
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
    // vi.clearAllMocks() only clears call history, NOT a prior test's
    // mockRejectedValue/mockResolvedValue implementation — reset the two
    // compensating-delete mocks to a resolved default every test so a
    // rejection set by one failure-path test can never silently leak into
    // the next; any test exercising a rollback failure overrides explicitly.
    mockDeleteChannel.mockResolvedValue(undefined)
    mockHardDeleteMessage.mockResolvedValue(undefined)
    mockRebindPendingAttachmentsToChild.mockResolvedValue(true)
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

  it("threadName is ALWAYS truncated to MAX_CHANNEL_NAME_LENGTH (100), even when explicitly passed a longer string — the thread's `name` column is a channel-naming field, bounded like any other channel name, regardless of how long a post's title (up to MAX_MESSAGE_CONTENT_LENGTH=4000) happens to be", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "short", channelId: "forum_1" }, attachments: [] })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "x" })
    const longTitle = "x".repeat(4000)

    await createMessageWithThread({
      db: {} as any,
      authorId: "u1",
      parentChannelId: "forum_1",
      serverId: "s1",
      body: { content: "short" },
      threadName: longTitle,
    })

    const [, createChannelArgs] = mockCreateChannel.mock.calls[0]
    expect(createChannelArgs.name.length).toBe(100)
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

  it("same-nonce replay returns the existing thread without rebinding or broadcasting", async () => {
    mockCreateCommunityMessage.mockResolvedValue({
      ok: true,
      row: { id: "msg_1", content: "Title", channelId: "forum_1" },
      attachments: [],
      deduped: true,
    })
    mockGetThreadChannelByParentMessage.mockResolvedValue({
      id: "th_1", creatorId: "u1", createdAt: "t0", name: "Title",
    })
    mockListMessageAttachments.mockResolvedValue([])

    const res = await createMessageWithThread({
      db: {} as any,
      authorId: "u1",
      parentChannelId: "forum_1",
      serverId: "s1",
      body: { content: "Title" },
      pendingAttachmentIdsToRebind: ["att_1"],
      clientNonce: "nonce_1",
    })

    expect(res).toEqual(expect.objectContaining({
      ok: true,
      deduped: true,
      thread: expect.objectContaining({ id: "th_1" }),
    }))
    expect(mockCreateCommunityMessage).toHaveBeenCalledTimes(1)
    expect(mockCreateChannel).not.toHaveBeenCalled()
    expect(mockAddThreadParticipants).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
    expect(mockRebindPendingAttachmentsToChild).not.toHaveBeenCalled()
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

  it("rebinds pending attachments from the forum to the fresh child thread", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "Title", channelId: "forum_1" }, attachments: [] })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "Title" })

    const res = await createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1",
      body: { content: "Title" }, pendingAttachmentIdsToRebind: ["att_1"],
    })

    expect(res.ok).toBe(true)
    expect(mockRebindPendingAttachmentsToChild).toHaveBeenCalledWith(expect.anything(), {
      ids: ["att_1"], uploaderId: "u1", parentTargetId: "forum_1", childTargetId: "th_1",
    })
  })

  it("compensates the fresh opener and thread when attachment rebind is rejected", async () => {
    const broadcast = vi.fn()
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "Title", channelId: "forum_1" }, attachments: [], broadcast })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "Title" })
    mockRebindPendingAttachmentsToChild.mockResolvedValue(false)

    const res = await createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1",
      body: { content: "Title" }, pendingAttachmentIdsToRebind: ["stolen"],
    })

    expect(res).toEqual({ ok: false, status: 400, error: "attachment not found or not attachable to this thread" })
    expect(mockDeleteChannel).toHaveBeenCalledWith(expect.anything(), "th_1")
    expect(mockHardDeleteMessage).toHaveBeenCalledWith(expect.anything(), "msg_1")
    expect(broadcast).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("attempts both compensations and never publishes when rebind throws", async () => {
    const broadcast = vi.fn()
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "Title", channelId: "forum_1" }, attachments: [], broadcast })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "Title" })
    mockRebindPendingAttachmentsToChild.mockRejectedValue(new Error("rebind failed"))
    mockDeleteChannel.mockRejectedValue(new Error("delete thread failed"))

    await expect(createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1",
      body: { content: "Title" }, pendingAttachmentIdsToRebind: ["att_1"],
    })).rejects.toThrow("rebind failed")

    expect(mockDeleteChannel).toHaveBeenCalledWith(expect.anything(), "th_1")
    expect(mockHardDeleteMessage).toHaveBeenCalledWith(expect.anything(), "msg_1")
    expect(broadcast).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("publishes the opener only after structure and participants commit", async () => {
    const broadcast = vi.fn(async () => undefined)
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1", content: "Title", channelId: "forum_1" }, attachments: [], broadcast })
    mockCreateChannel.mockResolvedValue({ id: "th_1", creatorId: "u1", createdAt: "t0", name: "Title" })

    await createMessageWithThread({
      db: {} as any, authorId: "u1", parentChannelId: "forum_1", serverId: "s1", body: { content: "Title" },
    })

    expect(mockAddThreadParticipants.mock.invocationCallOrder[0]).toBeLessThan(mockRebindPendingAttachmentsToChild.mock.invocationCallOrder[0])
    expect(mockRebindPendingAttachmentsToChild.mock.invocationCallOrder[0]).toBeLessThan(broadcast.mock.invocationCallOrder[0])
    expect(broadcast.mock.invocationCallOrder[0]).toBeLessThan(mockFanOutToChannel.mock.invocationCallOrder[0])
  })
})

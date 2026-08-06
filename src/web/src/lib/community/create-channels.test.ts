import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreateCommunityMessage = vi.fn()
const mockCreateChannel = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockAddThreadParticipants = vi.fn()
const mockFanOutToChannel = vi.fn()

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
})

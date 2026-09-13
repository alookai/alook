import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreateCommunityMessage = vi.fn()
const mockCreateChannel = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockAddThreadParticipants = vi.fn()
const mockFanOutToChannel = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockDeleteChannel = vi.fn()
const mockListMessageAttachments = vi.fn()
const mockRebindPendingAttachmentsToChild = vi.fn()
const mockGetMessage = vi.fn()
const mockRequireChannelMember = vi.fn()

vi.mock("@/lib/community/message-handler", () => ({
  createCommunityMessage: (...a: unknown[]) => mockCreateCommunityMessage(...a),
}))

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: vi.fn(),
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))

vi.mock("@/lib/community/permissions", () => ({
  requireServerMember: vi.fn(),
  requireChannelMember: (...a: unknown[]) => mockRequireChannelMember(...a),
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
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
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

import { createMessageWithThread, createThreadForUser } from "./create-channels"

describe("createThreadForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetThreadChannelByParentMessage.mockResolvedValue(null)
    mockAddThreadParticipants.mockResolvedValue(undefined)
    mockFanOutToChannel.mockResolvedValue(undefined)
  })

  it("derives the CLI thread name and commits participants before the canonical child-create frame", async () => {
    const order: string[] = []
    mockGetMessage.mockResolvedValue({
      id: "m1",
      channelId: "parent_1",
      authorId: "source_author",
      content: `  ${"x".repeat(60)}  `,
    })
    mockRequireChannelMember
      .mockResolvedValueOnce({
        ok: true,
        value: { id: "parent_1", serverId: "s1", parentChannelId: null, type: "text" },
      })
      .mockResolvedValueOnce({ ok: true, value: {} })
    mockCreateChannel.mockImplementation(async () => {
      order.push("create")
      return { id: "thread_1", name: "x".repeat(40), createdAt: "t0", creatorId: "cli_author" }
    })
    mockAddThreadParticipants.mockImplementation(async () => {
      order.push("participants")
    })
    mockFanOutToChannel.mockImplementation(async () => {
      order.push("fanout")
    })

    const result = await createThreadForUser({} as never, {
      messageId: "m1",
      actorUserId: "cli_author",
    })

    expect(result).toMatchObject({ ok: true, value: { id: "thread_1" } })
    expect(mockCreateChannel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "x".repeat(40),
      parentChannelId: "parent_1",
      parentMessageId: "m1",
      creatorId: "cli_author",
    }))
    expect(mockCreateChannel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialParticipants: [
      { userId: "cli_author", source: "spoke" },
      { userId: "source_author", source: "added" },
    ] }))
    expect(mockAddThreadParticipants).not.toHaveBeenCalled()
    expect(order).toEqual(["create", "fanout"])
  })

  it("treats a same-actor race re-select as non-fresh and skips duplicate side effects", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      channelId: "parent_1",
      authorId: "same_actor",
      content: "root",
    })
    mockRequireChannelMember.mockResolvedValue({
      ok: true,
      value: { id: "parent_1", serverId: "s1", parentChannelId: null, type: "text" },
    })
    mockCreateChannel.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT" }),
    )
    mockGetThreadChannelByParentMessage
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "thread_winner",
        name: "root",
        createdAt: "t0",
        creatorId: "same_actor",
      })

    const result = await createThreadForUser({} as never, {
      messageId: "m1",
      actorUserId: "same_actor",
    })

    expect(result).toMatchObject({ ok: true, value: { id: "thread_winner" } })
    expect(mockAddThreadParticipants).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })
})

describe("createMessageWithThread — atomic message composition", () => {
  const input = {
    db: {} as never, authorId: "u1", authorKind: "bot" as const,
    parentChannelId: "forum_1", serverId: "s1", body: { content: "Title" },
  }
  const thread = { id: "th_1", name: "Title", creatorId: "u1", createdAt: "t0" }
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateCommunityMessage.mockReset().mockResolvedValue({
      ok: true, row: { id: "msg_1", content: "Title" }, attachments: [],
    })
    mockGetThreadChannelByParentMessage.mockReset().mockResolvedValue(thread)
  })

  it("passes structure, pending attachments and activity to the same message write before broadcasting", async () => {
    const broadcast = vi.fn()
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1" }, attachments: [], broadcast })
    const sent = { statement: "sent" }
    const result = await createMessageWithThread({ ...input, expectedSeq: 8, pendingAttachmentIdsToRebind: ["a"], extraStatements: [sent] })
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(expect.objectContaining({
      expectedSeq: 8, extraStatements: [sent],
      forumThread: { id: expect.any(String), name: "Title", serverId: "s1", pendingAttachmentIds: ["a"] },
    }))
    expect(result).toEqual({ ok: true, message: { id: "msg_1" }, attachments: [], thread })
    expect(broadcast).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
    expect(mockCreateChannel).not.toHaveBeenCalled()
    expect(mockRebindPendingAttachmentsToChild).not.toHaveBeenCalled()
  })

  it("rejects oversized pending attachments before creating a forum opener", async () => {
    const result = await createMessageWithThread({
      ...input,
      pendingAttachmentIdsToRebind: Array.from({ length: 11 }, (_, i) => `attachment-${i}`),
    })
    expect(result).toEqual({ ok: false, status: 400, error: "too many attachments (max 10)" })
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
    expect(mockGetThreadChannelByParentMessage).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("bounds explicit and content-derived thread names", async () => {
    await createMessageWithThread({ ...input, threadName: "x".repeat(4000) })
    expect(mockCreateCommunityMessage.mock.calls[0][0].forumThread.name).toBe("x".repeat(100))
    await createMessageWithThread({ ...input, body: { content: "y".repeat(4000) } })
    expect(mockCreateCommunityMessage.mock.calls[1][0].forumThread.name).toBe("y".repeat(100))
  })

  it("returns complete nonce replay without mutating pending attachments or broadcasting", async () => {
    const attachments = [{ id: "a", thumbnailUrl: "/thumbnail" }]
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1" }, attachments, deduped: true })
    const result = await createMessageWithThread({ ...input, clientNonce: "nonce", pendingAttachmentIdsToRebind: ["a"] })
    expect(result).toEqual({ ok: true, message: { id: "msg_1" }, attachments, thread, deduped: true })
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
    expect(mockRebindPendingAttachmentsToChild).not.toHaveBeenCalled()
    expect(mockAddThreadParticipants).not.toHaveBeenCalled()
  })

  it("passes CAS and attachment rejection through without dispatch", async () => {
    for (const error of [{ ok: false, status: 409, error: "seq_conflict" }, { ok: false, status: 400, error: "attachment not found" }]) {
      mockCreateCommunityMessage.mockResolvedValue(error)
      expect(await createMessageWithThread(input)).toEqual(error)
    }
    expect(mockGetThreadChannelByParentMessage).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("failed atomic write never runs compensating deletes or fanout", async () => {
    mockCreateCommunityMessage.mockRejectedValue(new Error("injected thread write failure"))
    await expect(createMessageWithThread(input)).rejects.toThrow("injected thread write failure")
    expect(mockHardDeleteMessage).not.toHaveBeenCalled()
    expect(mockDeleteChannel).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("rejects a legacy incomplete forum replay instead of acknowledging success", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "msg_1" }, attachments: [], deduped: true })
    mockGetThreadChannelByParentMessage.mockResolvedValue(null)
    await expect(createMessageWithThread(input)).rejects.toThrow("committed forum opener is missing its thread")
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("keeps broadcast suppression separate from structure", async () => {
    await createMessageWithThread({ ...input, suppressBroadcast: true, suppressThreadFanout: true })
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(expect.objectContaining({ suppressBroadcast: true, forumThread: expect.any(Object) }))
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })


})

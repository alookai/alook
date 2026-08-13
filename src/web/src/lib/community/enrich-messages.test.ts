import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listAttachments: vi.fn(),
  listReactions: vi.fn(),
  getReplies: vi.fn(),
  listChildren: vi.fn(),
  getLatestSeq: vi.fn(),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    withD1Retry: (operation: () => unknown) => operation(),
    queries: {
      ...actual.queries,
      communityAttachment: {
        ...actual.queries.communityAttachment,
        listByMessageIds: (...args: unknown[]) => mocks.listAttachments(...args),
      },
      communityReaction: {
        ...actual.queries.communityReaction,
        listReactionsByMessageIds: (...args: unknown[]) => mocks.listReactions(...args),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessagesByIdsInScope: (...args: unknown[]) => mocks.getReplies(...args),
        getLatestMessageSeq: (...args: unknown[]) => mocks.getLatestSeq(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        listChildChannels: (...args: unknown[]) => mocks.listChildren(...args),
      },
    },
  }
})

import { enrichMessages } from "./enrich-messages"

describe("enrichMessages attachment projection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listReactions.mockResolvedValue([])
    mocks.listChildren.mockResolvedValue([])
    mocks.getLatestSeq.mockResolvedValue(9)
  })

  it("projects a canonical thumbnail beside reply enrichment", async () => {
    mocks.listAttachments.mockResolvedValue([{
      id: "att_1",
      messageId: "m1",
      targetId: "c1",
      filename: "photo.png",
      r2Key: "private-original-key",
      thumbnailR2Key: "private-thumbnail-key",
      contentType: "image/png",
      size: 100,
      width: 640,
      height: 480,
    }])
    mocks.getReplies.mockResolvedValue([{
      id: "reply_1",
      authorName: "Bob",
      content: "original",
      channelId: "c1",
    }])

    const result = await enrichMessages(
      {} as never,
      "u1",
      { channelId: "c1" },
      [{
        id: "m1",
        seq: 9,
        authorId: "u1",
        authorName: "Alice",
        authorImage: null,
        content: "reply",
        type: "default",
        mentionType: null,
        replyToId: "reply_1",
        embeds: null,
        createdAt: "2026-08-13T00:00:00.000Z",
        channelId: "c1",
      }],
    )

    expect(result.messages).toEqual([
      expect.objectContaining({
        replyTo: { id: "reply_1", authorName: "Bob", text: "original" },
        attachments: [{
          kind: "image",
          name: "photo.png",
          url: "/api/community/channels/c1/attachments/att_1",
          contentType: "image/png",
          sizeBytes: 100,
          thumbnailUrl: "/api/community/channels/c1/attachments/att_1/thumbnail",
          width: 640,
          height: 480,
        }],
      }),
    ])
  })
})

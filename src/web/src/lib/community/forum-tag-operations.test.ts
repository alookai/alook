import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetMessage = vi.fn()
const mockGetThread = vi.fn()
const mockListTags = vi.fn()
const mockAddTag = vi.fn()
const mockRemoveTag = vi.fn()
const mockReplaceTags = vi.fn()
const mockRequireAccess = vi.fn()
const mockFanOut = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: { getMessage: (...args: unknown[]) => mockGetMessage(...args) },
      communityChannel: { getThreadChannelByParentMessage: (...args: unknown[]) => mockGetThread(...args) },
      communityMessageTag: {
        listTagsForMessage: (...args: unknown[]) => mockListTags(...args),
        addMessageTag: (...args: unknown[]) => mockAddTag(...args),
        removeMessageTag: (...args: unknown[]) => mockRemoveTag(...args),
        replaceMessageTags: (...args: unknown[]) => mockReplaceTags(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({
  requireChannelAccess: (...args: unknown[]) => mockRequireAccess(...args),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...args: unknown[]) => mockFanOut(...args),
}))

import {
  listForumTagsForActor,
  mutateForumTagsForActor,
  replaceForumTagsForActor,
} from "./forum-tag-operations"

describe("forum tag operations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "forum1", authorId: "bot1" })
    mockRequireAccess.mockResolvedValue({
      ok: true,
      value: { channel: { id: "forum1", type: "forum" }, member: { role: "member" } },
    })
    mockGetThread.mockResolvedValue({ id: "thread1", type: "thread" })
    mockAddTag.mockResolvedValue(undefined)
    mockRemoveTag.mockResolvedValue(null)
    mockReplaceTags.mockResolvedValue(undefined)
    mockFanOut.mockResolvedValue(undefined)
  })

  it("rejects malformed tag collections before authorization", async () => {
    await expect(replaceForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      tags: "bug",
    })).resolves.toEqual({ ok: false, status: 400, error: "tags must be an array" })
    await expect(mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: ["bug", 1],
    })).resolves.toEqual({ ok: false, status: 400, error: "tags must contain only strings" })
    await expect(mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: ["x".repeat(65)],
    })).resolves.toEqual({ ok: false, status: 400, error: "tag must be ≤ 30 characters" })
    expect(mockGetMessage).not.toHaveBeenCalled()
  })

  it("enforces target existence, access, forum-opener, and editor permissions", async () => {
    mockGetMessage.mockResolvedValueOnce(null)
    await expect(replaceForumTagsForActor({} as any, {
      messageId: "missing",
      userId: "bot1",
      tags: ["bug"],
    })).resolves.toEqual({ ok: false, status: 404, error: "message not found" })

    mockRequireAccess.mockResolvedValueOnce({ ok: false, status: 401, error: "unauthorized" })
    await expect(mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: ["bug"],
    })).resolves.toEqual({ ok: false, status: 401, error: "unauthorized" })

    mockRequireAccess.mockResolvedValueOnce({
      ok: true,
      value: { channel: { id: "c1", type: "text" }, member: { role: "member" } },
    })
    await expect(mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: ["bug"],
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: "tags are only supported on forum opener messages",
    })

    mockGetThread.mockResolvedValueOnce(null)
    await expect(mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: ["bug"],
    })).resolves.toEqual({ ok: false, status: 400, error: "message is not a forum opener" })

    mockGetMessage.mockResolvedValueOnce({ id: "m1", channelId: "forum1", authorId: "someone-else" })
    await expect(mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: ["bug"],
    })).resolves.toEqual({ ok: false, status: 403, error: "forbidden" })

    mockGetMessage.mockResolvedValueOnce(null)
    await expect(listForumTagsForActor({} as any, {
      messageId: "missing",
      userId: "bot1",
    })).resolves.toEqual({ ok: false, status: 404, error: "message not found" })
  })

  it("uses the existing idempotent add query for bot delta set and fans out the final full set", async () => {
    mockListTags.mockResolvedValueOnce(["existing"]).mockResolvedValueOnce(["bug", "existing"])
    const result = await mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: [" Bug ", "bug"],
    })

    expect(result).toEqual({ ok: true, value: { tags: ["bug"], changed: true } })
    expect(mockAddTag).toHaveBeenCalledTimes(1)
    expect(mockAddTag).toHaveBeenCalledWith({}, { messageId: "m1", tag: "bug" })
    expect(mockReplaceTags).not.toHaveBeenCalled()
    expect(mockFanOut).toHaveBeenCalledWith("forum1", expect.objectContaining({
      channelId: "thread1",
      changes: { tags: ["bug", "existing"] },
    }))
  })

  it("checks the five ordinary-tag limit before adding and keeps archived exempt", async () => {
    mockListTags.mockResolvedValue(["a", "b", "c", "d", "e", "archived"])
    const result = await mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: ["sixth"],
    })
    expect(result).toEqual({ ok: false, status: 400, error: "too many tags (max 5)" })
    expect(mockAddTag).not.toHaveBeenCalled()
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("uses removeMessageTag and returns a no-op without fanout when nothing existed", async () => {
    mockListTags.mockResolvedValue(["existing"])
    const result = await mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "remove",
      tags: ["missing"],
    })
    expect(result).toEqual({ ok: true, value: { tags: ["missing"], changed: false } })
    expect(mockRemoveTag).toHaveBeenCalledWith({}, { messageId: "m1", tag: "missing" })
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("keeps human replace-all but suppresses no-op writes and fanout", async () => {
    mockListTags.mockResolvedValue(["new", "keep"])
    const result = await replaceForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      tags: [" keep ", "NEW"],
    })
    expect(result).toEqual({ ok: true, value: { tags: ["keep", "new"], changed: false } })
    expect(mockReplaceTags).not.toHaveBeenCalled()
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("replaces a changed full set and publishes the final tags", async () => {
    mockListTags.mockResolvedValue(["keep"])
    const result = await replaceForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      tags: ["keep", "new"],
    })

    expect(result).toEqual({ ok: true, value: { tags: ["keep", "new"], changed: true } })
    expect(mockReplaceTags).toHaveBeenCalledWith({}, {
      messageId: "m1",
      tags: ["keep", "new"],
    })
    expect(mockFanOut).toHaveBeenCalledWith("forum1", expect.objectContaining({
      channelId: "thread1",
      changes: { tags: ["keep", "new"] },
    }))
  })

  it("returns after the D1 write without waiting for background fanout", async () => {
    mockListTags.mockResolvedValue(["keep"])
    let releaseFanout!: () => void
    mockFanOut.mockReturnValueOnce(new Promise<void>((resolve) => {
      releaseFanout = resolve
    }))

    const result = await Promise.race([
      replaceForumTagsForActor({} as any, {
        messageId: "m1",
        userId: "bot1",
        tags: ["keep", "new"],
      }),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ])
    releaseFanout()

    expect(result).toEqual({ ok: true, value: { tags: ["keep", "new"], changed: true } })
    expect(mockReplaceTags).toHaveBeenCalledOnce()
    expect(mockFanOut).toHaveBeenCalledOnce()
  })

  it("does not schedule fanout when the authoritative D1 write fails", async () => {
    mockListTags.mockResolvedValue(["keep"])
    mockReplaceTags.mockRejectedValueOnce(new Error("D1 unavailable"))

    await expect(replaceForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      tags: ["keep", "new"],
    })).rejects.toThrow("D1 unavailable")
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("publishes a real removal and lists the caller-visible tags in stable order", async () => {
    mockListTags
      .mockResolvedValueOnce(["keep", "old"])
      .mockResolvedValueOnce(["keep"])
      .mockResolvedValueOnce(["zeta", "alpha"])
    mockRemoveTag.mockResolvedValue({ messageId: "m1", tag: "old" })

    const removed = await mutateForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      action: "remove",
      tags: ["old"],
    })
    expect(removed).toEqual({ ok: true, value: { tags: ["old"], changed: true } })
    expect(mockFanOut).toHaveBeenCalledWith("forum1", expect.objectContaining({
      changes: { tags: ["keep"] },
    }))

    await expect(listForumTagsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
    })).resolves.toEqual({ ok: true, value: ["alpha", "zeta"] })
  })
})

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

import { mutateForumTagsForActor, replaceForumTagsForActor } from "./forum-tag-operations"

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
})

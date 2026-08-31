import { beforeEach, describe, expect, it, vi } from "vitest"

const mockAuthorize = vi.fn()
const mockAdd = vi.fn()
const mockRemove = vi.fn()
const mockList = vi.fn()
const mockActors = vi.fn()
const mockFanOutChannel = vi.fn()
const mockFanOutDm = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityReaction: {
        addReaction: (...args: unknown[]) => mockAdd(...args),
        removeReaction: (...args: unknown[]) => mockRemove(...args),
        listReactionsByMessageIds: (...args: unknown[]) => mockList(...args),
        getReactionDetailsActors: (...args: unknown[]) => mockActors(...args),
      },
    },
  }
})
vi.mock("@/lib/community/reaction-access", () => ({
  authorizeReaction: (...args: unknown[]) => mockAuthorize(...args),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...args: unknown[]) => mockFanOutChannel(...args),
  fanOutToDM: (...args: unknown[]) => mockFanOutDm(...args),
}))

import { listReactionsForActor, removeReactionForActor, setReactionForActor } from "./reaction-operations"

describe("reaction operations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthorize.mockResolvedValue({
      ok: true,
      channelId: "c1",
      isDm: false,
      scope: { kind: "server", serverId: "s1", channelId: "c1" },
    })
    mockAdd.mockResolvedValue({ messageId: "m1", userId: "bot1", emoji: "👍" })
    mockRemove.mockResolvedValue(null)
  })

  it("rejects empty, non-string, and oversized emoji before authorization", async () => {
    await expect(setReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: null,
    })).resolves.toEqual({ ok: false, status: 400, error: "emoji must be a non-empty string" })
    await expect(removeReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "",
    })).resolves.toEqual({ ok: false, status: 400, error: "emoji must be a non-empty string" })
    await expect(setReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "😀".repeat(100),
    })).resolves.toEqual({ ok: false, status: 400, error: "emoji too long" })
    expect(mockAuthorize).not.toHaveBeenCalled()
  })

  it("propagates authorization failures for set, remove, and list", async () => {
    const denied = { ok: false, status: 403, error: "forbidden" }
    mockAuthorize.mockResolvedValue(denied)
    await expect(setReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })).resolves.toEqual(denied)
    await expect(removeReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })).resolves.toEqual(denied)
    await expect(listReactionsForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
    })).resolves.toEqual(denied)
    expect(mockAdd).not.toHaveBeenCalled()
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockList).not.toHaveBeenCalled()
  })

  it("treats a duplicate add as changed:false and emits no fanout", async () => {
    const error = new Error("UNIQUE constraint failed")
    mockAdd.mockRejectedValue(error)
    const result = await setReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })
    expect(result).toEqual({ ok: true, value: { emoji: "👍", changed: false } })
    expect(mockFanOutChannel).not.toHaveBeenCalled()
    expect(mockFanOutDm).not.toHaveBeenCalled()
  })

  it("rethrows a non-unique add failure", async () => {
    mockAdd.mockRejectedValue(new Error("database unavailable"))
    await expect(setReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })).rejects.toThrow("database unavailable")
  })

  it("adds a reaction and fans the canonical event out to a channel", async () => {
    const result = await setReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })
    expect(result).toEqual({
      ok: true,
      value: {
        emoji: "👍",
        changed: true,
        reaction: { messageId: "m1", userId: "bot1", emoji: "👍" },
      },
    })
    expect(mockFanOutChannel).toHaveBeenCalledWith("c1", expect.objectContaining({
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    }))
  })

  it("does not fan out when remove finds no matching reaction", async () => {
    const result = await removeReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })
    expect(result).toEqual({ ok: true, value: { emoji: "👍", changed: false } })
    expect(mockFanOutChannel).not.toHaveBeenCalled()
  })

  it("removes a reaction and fans the canonical event out to a DM", async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      channelId: "dm1",
      isDm: true,
      scope: { kind: "dm", channelId: "dm1" },
    })
    mockRemove.mockResolvedValue({ messageId: "m1", userId: "bot1", emoji: "👍" })
    const result = await removeReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })
    expect(result).toEqual({ ok: true, value: { emoji: "👍", changed: true } })
    expect(mockFanOutDm).toHaveBeenCalledWith("dm1", expect.objectContaining({
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    }))
  })

  it("groups actors per emoji, projects handles, me, unknown users, and stable ordering", async () => {
    mockList.mockResolvedValue([
      { messageId: "m1", userId: "u2", emoji: "👍" },
      { messageId: "m1", userId: "bot1", emoji: "🔥" },
      { messageId: "m1", userId: "missing", emoji: "👍" },
    ])
    mockActors.mockResolvedValue([
      { userId: "u2", profile: { id: "u2", name: "Zed", discriminator: "0002" } },
      { userId: "bot1", profile: { id: "bot1", name: "Ana", discriminator: "0001" } },
      { userId: "missing", profile: null },
    ])
    const result = await listReactionsForActor({} as any, { messageId: "m1", userId: "bot1" })
    expect(result).toEqual({
      ok: true,
      value: [
        { emoji: "👍", actors: ["@Zed#0002", "Unknown user"], me: false },
        { emoji: "🔥", actors: ["@Ana#0001"], me: true },
      ],
    })
  })
})

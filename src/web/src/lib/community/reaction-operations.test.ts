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

  it("does not fan out when remove finds no matching reaction", async () => {
    const result = await removeReactionForActor({} as any, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })
    expect(result).toEqual({ ok: true, value: { emoji: "👍", changed: false } })
    expect(mockFanOutChannel).not.toHaveBeenCalled()
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

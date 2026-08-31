import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetMessage = vi.fn()
const mockGetChannelType = vi.fn()
const mockRequireSurfaceAccess = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessage: (...args: unknown[]) => mockGetMessage(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        getChannelType: (...args: unknown[]) => mockGetChannelType(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...args: unknown[]) => mockRequireSurfaceAccess(...args),
}))

import { authorizeReaction } from "./reaction-access"

describe("authorizeReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "private-forum" })
  })

  it("returns the private-forum non-member gate before revealing emoji capability", async () => {
    mockRequireSurfaceAccess.mockResolvedValue({ ok: false, status: 403, error: "forbidden" })
    mockGetChannelType.mockResolvedValue("forum")

    const result = await authorizeReaction({} as any, "m1", "outsider")

    expect(result).toEqual({ ok: false, status: 403, error: "forbidden" })
    expect(mockRequireSurfaceAccess).toHaveBeenCalledWith({}, "private-forum", "outsider")
    expect(mockGetChannelType).not.toHaveBeenCalled()
  })

  it("returns capability 400 only after an authorized forum access check", async () => {
    mockRequireSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "private-forum", serverId: "s1" } },
    })
    mockGetChannelType.mockResolvedValue("forum")

    const result = await authorizeReaction({} as any, "m1", "member")

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "emoji reactions are not supported on this message surface",
    })
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { WS_EVENTS } from "@alook/shared"
import { communityWsEventFixtures } from "../../shared/test/community-ws-events.fixtures"
import { canDeliverCommunityContent, communityContentAccessKinds } from "./community-content-access"

const { readable, messageScope } = vi.hoisted(() => ({ readable: vi.fn(), messageScope: vi.fn() }))
vi.mock("@alook/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@alook/shared")>(),
  queries: { communityChannel: { listReadableChannelsForUser: readable, getReadableMessageChannelId: messageScope } },
}))
beforeEach(() => {
  vi.clearAllMocks()
  readable.mockResolvedValue([{ id: "channel-1", serverId: "server-1", parentChannelId: "parent-1" }])
  messageScope.mockResolvedValue("channel-1")
})

describe("community target content access", () => {
  it("fails closed for an event outside the declared contract", async () => {
    expect(await canDeliverCommunityContent({} as never, "user-1", [{ type: "community:future" } as never])).toBe(false)
  })
  it("classifies the entire current event contract", () => {
    expect(Object.keys(communityContentAccessKinds).sort()).toEqual(Object.values(WS_EVENTS).sort())
  })
  it.each(Object.values(communityWsEventFixtures))("enforces the declared gate for $type", async (event) => {
    if (communityContentAccessKinds[event.type] === "control") {
      expect(await canDeliverCommunityContent({} as never, "user-1", [event])).toBe(true)
      expect(readable).not.toHaveBeenCalled()
    } else {
      readable.mockResolvedValue([])
      messageScope.mockResolvedValue(null)
      expect(await canDeliverCommunityContent({} as never, "user-1", [event])).toBe(false)
    }
  })
  it("never lets a control child bypass mixed content access", async () => {
    readable.mockResolvedValue([])
    expect(await canDeliverCommunityContent({} as never, "user-1", [
      communityWsEventFixtures["community:channel.member_add"],
      communityWsEventFixtures["community:message.create"],
    ])).toBe(false)
  })
  it("validates current scope and server identity", async () => {
    const event = communityWsEventFixtures["community:message.create"]
    expect(await canDeliverCommunityContent({} as never, "user-1", [event])).toBe(true)
    expect(await canDeliverCommunityContent({} as never, "user-1", [{ ...event, serverId: "wrong" }])).toBe(false)
    expect(await canDeliverCommunityContent({} as never, "user-1", [{ ...event, parentChannelId: "wrong" }])).toBe(false)
  })
  it("validates child-parent relationships and notification targets", async () => {
    const event = { type: "community:channel.child_update" as const, channelId: "child", parentChannelId: "parent", changes: {} }
    readable.mockResolvedValue([{ id: "parent", serverId: "server" }, { id: "child", serverId: "server", parentChannelId: "parent" }])
    expect(await canDeliverCommunityContent({} as never, "user-1", [event])).toBe(true)
    readable.mockResolvedValue([{ id: "parent" }, { id: "child", parentChannelId: "wrong" }])
    expect(await canDeliverCommunityContent({} as never, "user-1", [event])).toBe(false)
    expect(await canDeliverCommunityContent({} as never, "user-1", [{ type: "community:unread.bump", userId: "other", channelId: "child" }])).toBe(false)
  })
  it("resolves legacy attention scope and propagates transient lookup failure", async () => {
    const event = { type: "community:mention.create" as const, userId: "user-1", messageId: "message-1", authorName: "Author" }
    expect(await canDeliverCommunityContent({} as never, "user-1", [event])).toBe(true)
    expect(messageScope).toHaveBeenCalledWith({}, "user-1", "message-1")
    readable.mockRejectedValue(new Error("D1 unavailable"))
    await expect(canDeliverCommunityContent({} as never, "user-1", [event])).rejects.toThrow("D1 unavailable")
  })
})

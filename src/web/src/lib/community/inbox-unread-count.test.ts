import { describe, expect, it } from "vitest"
import { inboxUnreadCount } from "./inbox-unread-count"
import type { Mention, UnreadDm, UnreadServer } from "./models/inbox"

describe("inboxUnreadCount", () => {
  it("deduplicates mentions and pending arrivals without counting grouping parents", () => {
    const servers = [{ serverId: "s", serverName: "S", channels: [
      { channelId: "parent", hasDirectUnread: false, children: [{ channelId: "thread" }] },
      { channelId: "direct", children: [] },
    ] }] as UnreadServer[]
    const mentions = [{ id: "m1", channelId: "thread" }, { id: "m2", channelId: "thread" }, { id: "m3", channelId: "mention-only" }] as Mention[]
    expect(inboxUnreadCount({ servers, dms: [], mentions, pendingChannelIds: ["direct", "pending", "pending"], friendRequestCount: 2 })).toBe(6)
  })

  it("counts DMs, legacy mentions and clears when projected feeds clear", () => {
    expect(inboxUnreadCount({ servers: [], dms: [{ channelId: "dm" }] as UnreadDm[], mentions: [{ id: "legacy" }] as Mention[], friendRequestCount: 1 })).toBe(3)
    expect(inboxUnreadCount({ servers: [], dms: [], mentions: [], friendRequestCount: 0 })).toBe(0)
  })
})

import { expect, it } from "vitest"
import { dmSummaryFromInbox } from "./dm-cache"

it("projects a provisional Inbox peer without claiming canonical presence", () => {
  expect(dmSummaryFromInbox({ channelId: "dm-new", otherUserId: "peer", otherUserName: "New peer", otherUserDiscriminator: "2222", otherUserAvatar: "N", lastMessageAt: "2026-08-24T05:00:00.000Z" })).toEqual({ id: "dm-new", userId: "peer", name: "New peer", discriminator: "2222", avatar: "N", status: "offline", preview: "", activityAt: "2026-08-24T05:00:00.000Z", unread: false })
})

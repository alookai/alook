import { describe, expect, it } from "vitest"
import type { InboxRowTarget } from "./inbox-read-reservation"
import {
  isInboxTargetReserved,
  reservedUnreadExclusion,
  selectUnreadPresentation,
} from "./unread-presentation"

describe("unread presentation", () => {
  it("keeps one diagnostic decision snapshot for account, reservation, active, and mute policy", () => {
    expect({
      unread: selectUnreadPresentation({ accountUnread: true }),
      active: selectUnreadPresentation({ accountUnread: true, active: true }),
      muted: selectUnreadPresentation({ accountUnread: true, muted: true }),
      reserved: selectUnreadPresentation({ accountUnread: true, reserved: true }),
    }).toMatchInlineSnapshot(`
      {
        "active": {
          "accountUnread": true,
          "active": true,
          "effectiveUnread": true,
          "emphasize": false,
          "muted": false,
          "reserved": false,
          "showDot": false,
          "state": "active",
        },
        "muted": {
          "accountUnread": true,
          "active": false,
          "effectiveUnread": true,
          "emphasize": false,
          "muted": true,
          "reserved": false,
          "showDot": false,
          "state": "muted",
        },
        "reserved": {
          "accountUnread": true,
          "active": false,
          "effectiveUnread": false,
          "emphasize": false,
          "muted": false,
          "reserved": true,
          "showDot": false,
          "state": "reserved",
        },
        "unread": {
          "accountUnread": true,
          "active": false,
          "effectiveUnread": true,
          "emphasize": true,
          "muted": false,
          "reserved": false,
          "showDot": true,
          "state": "unread",
        },
      }
    `)
  })

  it("maps only unread Inbox targets into their account domains", () => {
    const channel = {
      kind: "channel-direct",
      identity: "channel",
      fingerprint: "channel-v1",
      confirmationChannelId: "channel-1",
      serverId: "server-1",
      channelId: "channel-1",
    } satisfies InboxRowTarget
    const thread = {
      kind: "thread",
      identity: "thread",
      fingerprint: "thread-v1",
      confirmationChannelId: "thread-1",
      serverId: "server-1",
      parentChannelId: "forum-1",
      childChannelId: "thread-1",
    } satisfies InboxRowTarget
    const dm = {
      kind: "dm",
      identity: "dm",
      fingerprint: "dm-v1",
      confirmationChannelId: "dm-1",
      channelId: "dm-1",
    } satisfies InboxRowTarget
    const mention = {
      kind: "mention",
      identity: "mention",
      fingerprint: "mention-v1",
      confirmationChannelId: "channel-1",
      mentionId: "mention-1",
    } satisfies InboxRowTarget

    expect(reservedUnreadExclusion(channel, "channels")).toEqual({
      channelId: "channel-1",
    })
    expect(reservedUnreadExclusion(thread, "channels")).toEqual({
      channelId: "thread-1",
    })
    expect(reservedUnreadExclusion(dm, "dms")).toEqual({ channelId: "dm-1" })
    expect(reservedUnreadExclusion(channel, "dms")).toBeNull()
    expect(reservedUnreadExclusion(dm, "channels")).toBeNull()
    expect(reservedUnreadExclusion(mention, "channels")).toBeNull()
  })

  it("requires exact identity and fingerprint for row reservation", () => {
    const target = {
      kind: "dm",
      identity: "dm-1",
      fingerprint: "v1",
      confirmationChannelId: "dm-1",
      channelId: "dm-1",
    } satisfies InboxRowTarget
    expect(isInboxTargetReserved(target, target)).toBe(true)
    expect(isInboxTargetReserved(target, { ...target, fingerprint: "v2" })).toBe(false)
    expect(isInboxTargetReserved(target, { ...target, identity: "dm-2" })).toBe(false)
    expect(isInboxTargetReserved(target, null)).toBe(false)
  })
})

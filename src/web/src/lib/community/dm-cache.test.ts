import { describe, expect, it } from "vitest"
import { dmSummaryFromInbox, upsertDmSummary } from "./dm-cache"
import type { DM } from "./models/people"

const cached: DM = {
  id: "dm-old",
  userId: "u-old",
  name: "Old peer",
  discriminator: "1111",
  avatar: "O",
  status: "offline",
  preview: "old preview",
  unread: true,
}

describe("DM cache projector", () => {
  it("projects a complete provisional summary from an Inbox row", () => {
    expect(dmSummaryFromInbox({
      channelId: "dm-new",
      otherUserId: "u-new",
      otherUserName: "New peer",
      otherUserDiscriminator: "2222",
      otherUserAvatar: "N",
      lastMessageAt: "2026-08-24T05:00:00.000Z",
    })).toEqual({
      id: "dm-new",
      userId: "u-new",
      name: "New peer",
      discriminator: "2222",
      avatar: "N",
      status: "offline",
      preview: "",
      unread: false,
    })
  })

  it("prepends a missing summary while preserving unrelated rows", () => {
    const incoming = { ...cached, id: "dm-new", userId: "u-new", unread: false }
    expect(upsertDmSummary({ conversations: [cached] }, incoming)).toEqual({
      conversations: [incoming, cached],
    })
  })

  it("creates the cache when no canonical list has loaded", () => {
    expect(upsertDmSummary(undefined, cached)).toEqual({ conversations: [cached] })
  })

  it("updates an existing identity without degrading canonical-only fields", () => {
    const canonical = { ...cached, status: "online" as const }
    const unrelated = { ...cached, id: "dm-unrelated", userId: "u-unrelated" }
    const incoming = {
      ...cached,
      name: "Updated peer",
      status: "offline" as const,
      preview: "",
      unread: false,
    }
    const result = upsertDmSummary({ conversations: [canonical, unrelated] }, incoming)
    expect(result.conversations).toHaveLength(2)
    expect(result.conversations[0]).toEqual({
      ...canonical,
      name: "Updated peer",
      unread: false,
    })
    expect(result.conversations[1]).toBe(unrelated)
  })
})

import { describe, expect, it } from "vitest"
import {
  buildCommunityMessagesUrl,
  isMessageResourceQueryKey,
  messageCursorPage,
  messagePagesQueryKey,
  messageResourceQueryKey,
  messageRowsQueryKey,
  type MessageAccessScope,
} from "./message-pagination"

const channelScope: MessageAccessScope = {
  accountId: "viewer-a",
  kind: "server-channel",
  serverId: "server-a",
  channelId: "channel-a",
}

const tailOlder = {
  base: { mode: "tail" },
  direction: "older",
  order: ["seq", "asc", "id", "asc"],
} as const

describe("message pagination namespaces", () => {
  it("keeps access, tag, and sequence identity in the resource prefix", () => {
    const newest = messageResourceQueryKey(channelScope, null, tailOlder)
    const tagged = messageResourceQueryKey(channelScope, " bug ", tailOlder)
    const anchored = messageResourceQueryKey(channelScope, null, {
      base: { mode: "anchor", anchor: "message-a" },
      direction: "older",
      order: ["seq", "asc", "id", "asc"],
    })
    const dm = messageResourceQueryKey({
      accountId: "viewer-a",
      kind: "dm",
      serverId: null,
      channelId: "channel-a",
    }, null, tailOlder)

    expect(new Set([newest, tagged, anchored, dm].map(JSON.stringify)).size).toBe(4)
    expect(tagged).toContain("bug")
  })

  it("keeps row and page namespaces as siblings so row writes cannot corrupt pages", () => {
    const resource = messageResourceQueryKey(channelScope, null, tailOlder)
    const rows = messageRowsQueryKey(channelScope, null, tailOlder)
    const pages = messagePagesQueryKey(channelScope, null, tailOlder)

    expect(rows.slice(0, 4)).toEqual(resource.slice(0, 4))
    expect(pages.slice(0, 4)).toEqual(resource.slice(0, 4))
    expect(rows[4]).toBe("rows")
    expect(pages[4]).toBe("pages")
    expect(rows.slice(5)).toEqual(resource.slice(4))
    expect(pages.slice(5)).toEqual(resource.slice(4))
    expect(isMessageResourceQueryKey(rows, {
      accountId: "viewer-a",
      channelId: "channel-a",
    })).toBe(true)
    expect(isMessageResourceQueryKey(pages, {
      accountId: "viewer-a",
      channelId: "channel-a",
    })).toBe(true)
    expect(isMessageResourceQueryKey(rows)).toBe(true)
  })

  it("never places demand or opaque continuation cursors in sequence identity", () => {
    const resource = messageResourceQueryKey(channelScope, null, tailOlder)
    expect(JSON.stringify(resource)).not.toContain("offset")
    expect(JSON.stringify(resource)).not.toContain("limit")
    expect(JSON.stringify(resource)).not.toContain("backend-cursor")
    const rows = messageRowsQueryKey(channelScope, null, tailOlder)
    expect(rows.slice(5)).toEqual(resource.slice(4))
    expect(JSON.stringify(rows)).not.toContain("offset")
    expect(JSON.stringify(rows)).not.toContain("limit")
    expect(JSON.stringify(rows)).not.toContain("backend-cursor")
  })
})

describe("message endpoint mapping", () => {
  it.each([
    [{ mode: "newest" } as const, null, "/api/community/channels/a%2Fb/messages"],
    [{ mode: "older", cursor: "old" } as const, null, "/api/community/channels/a%2Fb/messages?cursor=old"],
    [{ mode: "newer", cursor: "new" } as const, null, "/api/community/channels/a%2Fb/messages?since=new"],
    [{ mode: "since", since: "40" } as const, null, "/api/community/channels/a%2Fb/messages?since=40"],
    [{ mode: "anchor", anchor: "m 1" } as const, "bug", "/api/community/channels/a%2Fb/messages?tag=bug&anchor=m+1"],
  ])("maps %o to the existing API contract", (page, tag, expected) => {
    expect(buildCommunityMessagesUrl("a/b", page, tag)).toBe(expected)
  })

  it("maps continuation metadata without treating an empty page as exhaustion", () => {
    expect(messageCursorPage({
      messages: [],
      hasMoreOlder: true,
      olderCursor: "older-2",
    }, "older")).toEqual({ rows: [], nextCursor: "older-2" })
    expect(messageCursorPage({ messages: [], hasMoreNewer: false }, "newer"))
      .toEqual({ rows: [], nextCursor: null })
    expect(() => messageCursorPage({ messages: [], hasMoreNewer: true }, "newer"))
      .toThrow("without a cursor")
  })
})

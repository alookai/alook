import { describe, expect, it } from "vitest"
import { communityKeys } from "./query-keys"

/**
 * These tests exist so that segment order and prefix nesting of the query-key
 * factory cannot silently drift. If someone reorders `[..., "channel", id,
 * "messages"]` to `[..., id, "channel", "messages"]`, TanStack Query's
 * invalidateQueries-by-prefix behaviour breaks — every consumer that
 * invalidates `communityKeys.server(id)` expecting members/presence to
 * refresh underneath would quietly stop working.
 */

describe("communityKeys", () => {
  it("roots every key under ['community']", () => {
    expect(communityKeys.all).toEqual(["community"])

    // Sample enough branches to catch a mis-rooted key.
    expect(communityKeys.servers()[0]).toBe("community")
    expect(communityKeys.inbox()[0]).toBe("community")
    expect(communityKeys.friends()[0]).toBe("community")
    expect(communityKeys.machines()[0]).toBe("community")
    expect(communityKeys.channelMessages("c1")[0]).toBe("community")
    expect(communityKeys.message("m1")[0]).toBe("community")
  })

  it("nests server-scoped keys under communityKeys.server(id)", () => {
    const server = communityKeys.server("s1")
    expect(server).toEqual(["community", "servers", "s1"])

    expect(communityKeys.members("s1")).toEqual([...server, "members"])
    expect(communityKeys.presence("s1")).toEqual([...server, "presence"])
    expect(communityKeys.auditLog("s1")).toEqual([...server, "audit-log"])
    expect(communityKeys.invites("s1")).toEqual([...server, "invites"])
  })

  it("nests channel-scoped keys under a stable channel prefix", () => {
    const messagesRoot = communityKeys.channelMessages("c1")
    expect(messagesRoot).toEqual(["community", "channel", "c1", "messages"])

    // Cursor-page keys extend the root so invalidateQueries on the root
    // clears every page.
    expect(communityKeys.channelMessagesPage("c1", "cur-1")).toEqual([
      ...messagesRoot,
      "cur-1",
    ])
    expect(communityKeys.channelMessagesPage("c1")).toEqual([
      ...messagesRoot,
      null,
    ])

    expect(communityKeys.pins("c1")).toEqual([
      "community",
      "channel",
      "c1",
      "pins",
    ])
    expect(communityKeys.threads("c1")).toEqual([
      "community",
      "channel",
      "c1",
      "threads",
    ])
    expect(communityKeys.forumPosts("c1")).toEqual([
      "community",
      "channel",
      "c1",
      "posts",
    ])
  })

  it("nests DM-scoped keys under a stable DM prefix", () => {
    const dmRoot = communityKeys.dmMessages("d1")
    expect(dmRoot).toEqual(["community", "dm", "d1", "messages"])

    expect(communityKeys.dmMessagesPage("d1", "cur-1")).toEqual([
      ...dmRoot,
      "cur-1",
    ])
    expect(communityKeys.dmMessagesPage("d1")).toEqual([...dmRoot, null])
  })

  it("nests inbox feeds under a shared inbox() prefix", () => {
    const inbox = communityKeys.inbox()
    expect(inbox).toEqual(["community", "inbox"])
    expect(communityKeys.inboxUnreads()).toEqual([...inbox, "unreads"])
    expect(communityKeys.inboxForYou()).toEqual([...inbox, "foryou"])
    expect(communityKeys.inboxMentions()).toEqual([...inbox, "mentions"])
  })

  it("keys top-level social/machine feeds directly under all", () => {
    expect(communityKeys.friends()).toEqual(["community", "friends"])
    expect(communityKeys.dms()).toEqual(["community", "dms"])
    expect(communityKeys.folders()).toEqual(["community", "folders"])
    expect(communityKeys.machines()).toEqual(["community", "machines"])
    expect(communityKeys.notificationSettings()).toEqual([
      "community",
      "notification-settings",
    ])
    expect(communityKeys.profile("u1")).toEqual([
      "community",
      "profile",
      "u1",
    ])
    expect(communityKeys.message("m1")).toEqual([
      "community",
      "message",
      "m1",
    ])
  })

  it("returns a distinct new tuple each call (no shared mutable arrays)", () => {
    const a = communityKeys.channelMessages("c1")
    const b = communityKeys.channelMessages("c1")
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it("returns readonly-typed tuples the compiler can narrow", () => {
    const key = communityKeys.channelMessages("c1")
    // The literal-tuple type should be preserved (not widened to `string[]`).
    // If someone drops `as const`, this narrows to `string` and this test
    // is a signal — but the real guard is the compiler, so we just assert
    // a concrete value here.
    const head: "community" = key[0]
    expect(head).toBe("community")
  })
})

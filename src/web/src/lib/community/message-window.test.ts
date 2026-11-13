import { messageResourceFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { InfiniteQueryObserver } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { messagePageForReading, messagePageNeighbors, messageWindowIdentity, messageWindowOptions } from "./message-window"

const load = vi.hoisted(() => vi.fn())
vi.mock("./account-cache-lifecycle", async (original) => ({
  ...await original<typeof import("./account-cache-lifecycle")>(),
  apiFetchCommunity: (...args: unknown[]) => load(...args),
}))
beforeEach(() => { load.mockReset() })

describe("native message window identity", () => {
  it("keeps initial mode, anchor and tag distinct under the common invalidation prefix", async () => {
    const { client } = await createCommunityQueryOwner()
    const specs = [
      messageWindowOptions(client, "c1", { mode: "newest" }),
      messageWindowOptions(client, "c1", { mode: "anchor", anchor: "m1" }),
      messageWindowOptions(client, "c1", { mode: "anchor", anchor: "m2" }),
      messageWindowOptions(client, "c1", { mode: "anchor", anchor: "m1" }, "tag"),
      messageWindowOptions(client, "c1", { mode: "since", since: "cursor" }),
    ]
    for (const options of specs) client.setQueryData(options.queryKey, { pages: [], pageParams: [] })
    await client.invalidateQueries({ queryKey: communityKeys.channelMessages("c1"), refetchType: "none" })
    expect(client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages("c1") })).toHaveLength(5)
    for (const options of specs) {
      expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true)
      expect(messageWindowIdentity(options.queryKey)?.channelId).toBe("c1")
    }
    expect(messageWindowIdentity([...specs[1].queryKey, "reconcile"])).toBeUndefined()
    expect(messageWindowIdentity([...communityKeys.channelMessages("c1"), "tag", "old"])).toBeUndefined()
    expect(messageWindowIdentity(["foreign", "channel", "c1", "messages"])).toBeUndefined()
    expect(messageWindowIdentity([...communityKeys.channelMessages("c1"), "window", { mode: "anchor", anchor: "m1", tag: null, extra: true }])).toBeUndefined()
  })

  it("uses native bidirectional pages and stores only references while the canonical owner holds bodies", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const row = (id: string, seq: number) => messageResourceFixture({ id, channelId: "c1", seq, createdAt: `2026-10-01T00:00:0${seq}.000Z`, content: `Body ${seq}` })
    load.mockResolvedValueOnce({ profiles: [profileResourceFixture()], messages: [row("m2", 2)], olderCursor: "older", newerCursor: "newer", hasMoreOlder: true, hasMoreNewer: true, latestSeq: 3 })
      .mockResolvedValueOnce({ profiles: [profileResourceFixture()], messages: [row("m1", 1)], hasMoreOlder: false, hasMoreNewer: true, newerCursor: "m2", latestSeq: 3 })
      .mockResolvedValueOnce({ profiles: [profileResourceFixture()], messages: [row("m3", 3)], hasMoreOlder: true, hasMoreNewer: false, olderCursor: "m2", latestSeq: 3 })
    const options = messageWindowOptions(client, "c1", { mode: "anchor", anchor: "m2" }, "tag")
    await client.infiniteQuery({ ...options, select: undefined })
    const initial = client.getQueryData(options.queryKey)!
    const reading = messagePageForReading(initial, "m2")!
    expect(messagePageNeighbors(initial, reading)).toEqual({ older: true, newer: true })
    const observer = new InfiniteQueryObserver(client, { ...options, enabled: false })
    const unsubscribe = observer.subscribe(() => {})
    await observer.fetchNextPage()
    expect(messagePageForReading(client.getQueryData(options.queryKey)!, "m2")).toBe(reading)
    expect(messagePageNeighbors(client.getQueryData(options.queryKey)!, reading)).toEqual({ older: false, newer: true })
    await observer.fetchPreviousPage()
    const data = client.getQueryData(options.queryKey)!
    expect(data.pageParams).toEqual([{ mode: "newer", cursor: "newer" }, { mode: "anchor", anchor: "m2" }, { mode: "older", cursor: "older" }])
    expect(data.pages.map((page) => page.messages)).toEqual([[{ id: "m3", seq: 3 }], [{ id: "m2", seq: 2 }], [{ id: "m1", seq: 1 }]])
    const middle = messagePageForReading(data, "m2")!
    expect(messagePageNeighbors(data, middle)).toEqual({ older: false, newer: false })
    expect(messagePageForReading(data, "m1")).not.toBe(middle)
    expect(messagePageNeighbors(data, messagePageForReading(data, "m1")!)).toEqual({ older: false, newer: false })
    expect(messagePageNeighbors(data, messagePageForReading(data, "m3")!)).toEqual({ older: false, newer: false })
    expect(messagePageForReading(data, "reply-target-only")).toBeUndefined()
    expect(load.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/c1/messages?tag=tag&anchor=m2",
      "/api/community/channels/c1/messages?tag=tag&cursor=older",
      "/api/community/channels/c1/messages?tag=tag&since=newer",
    ])
    expect(registry.collections.messages.get("m2")?.content).toBe("Body 2")
    expect(JSON.stringify(data)).not.toContain("Body")
    unsubscribe()
    observer.destroy()
  })

  it("publishes full reply targets without inserting them into the selected window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const target = messageResourceFixture({ id: "older", seq: 1, content: "**Full** `file_name.ts`", attachments: [{ id: "file", name: "photo.png", url: "/file", thumbnailUrl: null, contentType: "image/png", sizeBytes: 50, width: 1, height: 1 }] })
    const reply = messageResourceFixture({ id: "reply", seq: 100, replyToId: target.id, replyTo: { id: target.id, authorId: target.authorId, authorName: "Viewer" } })
    load.mockResolvedValueOnce({ profiles: [profileResourceFixture()], messages: [reply], relatedMessages: [target], latestSeq: 100, hasMoreOlder: true, hasMoreNewer: false })
    const options = messageWindowOptions(client, "c1", { mode: "newest" })
    await client.infiniteQuery({ ...options, select: undefined })
    const data = client.getQueryData(options.queryKey)!
    expect(data.pages[0].messages).toEqual([{ id: "reply", seq: 100 }])
    expect(data.pages[0]).not.toHaveProperty("relatedMessages")
    expect(registry.collections.messages.get("older")).toMatchObject({ content: target.content, attachments: target.attachments })
    expect(load).toHaveBeenCalledOnce()
  })
})

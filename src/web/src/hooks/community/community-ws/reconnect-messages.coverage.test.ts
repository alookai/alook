import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryObserver } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture } from "@/test/conversation-entry-fixtures"
import { conversationEntryOptions, publishConversationEntry } from "@/lib/community/conversation-entry"
import { captureCommunityLiveSnapshotToken, ingestMessages } from "@/lib/community-db/sync"
import { messageWindowPage, type MessagesPage } from "@/lib/community/models/message"
import type { MessageWindowData } from "@/lib/community/message-window"
import { prefetchCommunityLatestMessage, prefetchCommunityMessage } from "../use-message"
import { reconcileConversationLanding, reconcileFocusedMessageQueries, reconcileWindow } from "./reconnect-messages"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })

function row(seq: number) {
  return { ...fixture().messages[0], id: `m${seq}`, seq,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(),
    authorName: "Peer", authorAvatar: "", authorAvatarVersion: 0,
    content: `Body ${seq}`, resourceComplete: true as const, embeds: [], reactions: [],
  }
}
function page(messages: ReturnType<typeof row>[], latestSeq: number): MessagesPage {
  return { messages, latestSeq, hasMoreOlder: true, hasMoreNewer: false, olderCursor: "older" }
}
function suffix(cursor: number) { return `since=${encodeURIComponent(`${row(cursor).createdAt}|m${cursor}`)}` }

async function setup(sequences = [98, 99, 100], tag: string | null = null) {
  const owner = await createCommunityQueryOwner()
  const target = { channelId: "c1", serverId: "s1", tag }
  const messages = sequences.map(row)
  const last = messages.at(-1)!
  const packet = { ...fixture(), messages,
    channel: { ...fixture().channel, messageCount: messages.length, createdAt: messages[0].createdAt, lastMessageAt: last.createdAt },
    readState: { channelId: "c1", lastReadMessageId: last.id, lastReadAt: last.createdAt, lastReadSeq: last.seq },
    selection: { reason: "tail" as const, anchorMessageId: null },
    page: { ...fixture().page, latestSeq: last.seq, hasMoreOlder: true, hasMoreNewer: false },
  }
  const options = conversationEntryOptions(owner.client, target)
  const resource = publishConversationEntry(owner.client, target, packet, { token: captureCommunityLiveSnapshotToken(owner.client, "c1") })
  owner.client.setQueryData(options.queryKey, resource)
  const key = resource.windowKey
  const observer = new QueryObserver(owner.client, { queryKey: key, queryFn: vi.fn(), staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  const read = () => owner.client.getQueryData<MessageWindowData>(key)!
  const ids = () => read().pages.flatMap(part => part.messages.map(message => message.id))
  const repairOwner = { query: owner.client.getQueryCache().find({ queryKey: options.queryKey, exact: true })!, signal: new AbortController().signal }
  return { ...owner, target, key, resource, read, ids, unsubscribe, repairOwner }
}

describe("complete canonical coverage at the existing repair owner", () => {
  it.each([false, true])("merges a matching complete landing without fetching its last message again (watermark ahead=%s)", async watermarkAhead => {
    const h = await setup()
    if (watermarkAhead) h.client.setQueryData<MessageWindowData>(h.key, current => current && ({ ...current, pages: current.pages.map(part => ({ ...part, latestSeq: 101 })) }))
    const params = h.read().pageParams
    const fresh = { ...fixture(), messages: [{ ...row(100), content: "edited" }, row(101)],
      selection: { reason: "tail" as const, anchorMessageId: null }, page: { ...fixture().page, latestSeq: 101 },
    }
    publishConversationEntry(h.client, h.target, fresh, { token: captureCommunityLiveSnapshotToken(h.client, "c1") })
    load.mockResolvedValue(page([row(101)], 101))
    try {
      await reconcileConversationLanding(h.client, { kind: "channel", scopeId: "c1", serverId: "s1" }, h.key,
        page(fresh.messages, 101), { mode: "newest" }, h.repairOwner)
      expect(load).not.toHaveBeenCalled()
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101"])
      expect(h.registry.collections.messages.get("m100")?.content).toBe("edited")
      expect(h.read().pageParams).toEqual(params)
    } finally { h.unsubscribe() }
  })

  it.each(["exact-ID", "latest"] as const)("reuses a real %s prefetch without giving prefetch a window writer", async hint => {
    const h = await setup()
    load.mockResolvedValueOnce(hint === "exact-ID" ? row(101) : page([row(101)], 101))
    if (hint === "exact-ID") await prefetchCommunityMessage(h.client, "m101", { channelId: "c1", serverId: "s1" })
    else await prefetchCommunityLatestMessage(h.client, "c1")
    expect(h.registry.collections.messages.get("m101")?.resourceComplete).toBe(true)
    expect(h.ids()).toEqual(["m98", "m99", "m100"])
    load.mockReset().mockResolvedValue(page([{ ...row(100), content: "corrected" }], 101))
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages"])
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101"])
      expect(h.registry.collections.messages.get("m100")?.content).toBe("corrected")
    } finally { h.unsubscribe() }
  })

  it("publishes the available complete prefix before the remaining delta settles", async () => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [row(101), row(103)])
    let release!: (value: MessagesPage) => void
    load.mockResolvedValueOnce(page([row(100)], 103))
      .mockImplementationOnce(() => new Promise<MessagesPage>(resolve => { release = resolve }))
    const pending = reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101"])
      expect(h.read().pages[0].hasMoreNewer).toBe(true)
      expect(h.read().pages[0].newerCursor).toBe(`${row(101).createdAt}|m101`)
      release(page([row(102)], 103))
      await pending
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101", "m102", "m103"])
      expect(h.read().pages[0].hasMoreNewer).toBe(false)
    } finally {
      release?.(page([row(102)], 103))
      await pending
      h.unsubscribe()
    }
  })

  it("retains current-window correction of a deleted reply target even when creations are cached", async () => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [{ ...row(100), replyTo: { id: "gone", authorName: "Peer", text: "old reply" } }, row(101)])
    load.mockResolvedValueOnce(page([{ ...row(100), replyTo: { id: "gone", authorName: "Deleted user", text: "", deleted: true } }], 101))
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages"])
      expect(h.registry.collections.messages.get("m100")?.replyTo).toEqual({ id: "gone", authorName: "Deleted user", text: "", deleted: true })
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101"])
    } finally { h.unsubscribe() }
  })

  it("reads only beyond a proven canonical prefix while filling a hole before a higher cached seq", async () => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [row(101), row(103)])
    load.mockResolvedValueOnce(page([row(100)], 103)).mockResolvedValueOnce(page([row(102), row(103)], 103))
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages", `/api/community/channels/c1/messages?${suffix(101)}`])
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101", "m102", "m103"])
    } finally { h.unsubscribe() }
  })

  it("reuses a higher cached full resource only after the delta fills the intervening hole", async () => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [row(101), row(103)])
    load.mockResolvedValueOnce(page([row(100)], 100)).mockResolvedValueOnce(page([row(102)], 102))
    try {
      await reconcileWindow(h.client, { kind: "channel", scopeId: "c1", serverId: "s1" }, h.key, 103)
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages", `/api/community/channels/c1/messages?${suffix(101)}`])
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101", "m102", "m103"])
      expect(h.read().pages[0].hasMoreNewer).toBe(false)
    } finally { h.unsubscribe() }
  })

  it("closes a resumable network page when complete cached rows prove its whole remainder", async () => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [row(101), row(103), row(104)])
    load.mockResolvedValueOnce(page([row(100)], 104)).mockResolvedValueOnce({
      ...page([row(102)], 104), hasMoreNewer: true, newerCursor: `${row(102).createdAt}|m102`,
    })
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load).toHaveBeenCalledTimes(2)
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101", "m102", "m103", "m104"])
      expect(h.read().pages[0].hasMoreNewer).toBe(false)
      expect(h.read().pages[0].newerCursor).toBeUndefined()
    } finally { h.unsubscribe() }
  })

  it("accepts the resource contract's zero-seq boundary without rereading its complete successor", async () => {
    const h = await setup([0])
    ingestMessages(h.registry, "c1", [row(1)])
    load.mockResolvedValue(page([row(0)], 1))
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages"])
      expect(h.ids()).toEqual(["m0", "m1"])
    } finally { h.unsubscribe() }
  })

  it("does not turn a repair target into coverage while another sequence is still missing", async () => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [row(101), row(104)])
    load.mockResolvedValueOnce(page([row(100)], 100)).mockResolvedValueOnce(page([row(102)], 102))
    try {
      await expect(reconcileWindow(h.client, { kind: "channel", scopeId: "c1", serverId: "s1" }, h.key, 104)).rejects.toThrow("Messages have not caught up yet")
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101", "m102"])
      expect(h.read().pages[0].latestSeq).toBe(102)
    } finally { h.unsubscribe() }
  })

  it("starts before an actual loaded-window hole rather than using its maximum seq", async () => {
    const h = await setup([98, 100])
    ingestMessages(h.registry, "c1", [row(102)])
    load.mockResolvedValueOnce(page([row(100)], 102)).mockResolvedValueOnce(page([row(99), row(100), row(101), row(102)], 102))
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages", `/api/community/channels/c1/messages?${suffix(98)}`])
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101", "m102"])
    } finally { h.unsubscribe() }
  })

  it.each(["missing", "partial", "other-channel", "duplicate-seq", "cursor-order", "invalid-time", "cursor-separator"] as const)("does not let %s evidence or a maximum seq hide a missing resource", async kind => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [row(103)])
    if (kind === "partial") ingestMessages(h.registry, "c1", [{ id: "m101", seq: 101, createdAt: row(101).createdAt, content: "partial" }])
    if (kind === "other-channel") ingestMessages(h.registry, "c2", [{ ...row(101), channelId: "c2" }])
    if (kind === "duplicate-seq") ingestMessages(h.registry, "c1", [row(101), { ...row(101), id: "other101" }])
    if (kind === "cursor-order") ingestMessages(h.registry, "c1", [{ ...row(101), createdAt: row(99).createdAt }])
    if (kind === "invalid-time") ingestMessages(h.registry, "c1", [{ ...row(101), createdAt: "not-a-time" }])
    if (kind === "cursor-separator") ingestMessages(h.registry, "c1", [{ ...row(101), id: "m|101" }])
    load.mockResolvedValueOnce(page([row(100)], 103)).mockResolvedValueOnce(page([row(101), row(102), row(103)], 103))
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages", `/api/community/channels/c1/messages?${suffix(100)}`])
      expect(h.ids()).toEqual(["m98", "m99", "m100", "m101", "m102", "m103"])
    } finally { h.unsubscribe() }
  })

  it("keeps tag-filtered seq gaps under the original transport contract", async () => {
    const h = await setup([98, 100], "bug")
    ingestMessages(h.registry, "c1", [row(101), row(102)])
    load.mockResolvedValueOnce(page([row(100)], 102)).mockResolvedValueOnce(page([row(102)], 102))
    try {
      await reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1")
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?tag=bug", `/api/community/channels/c1/messages?tag=bug&${suffix(100)}`])
      expect(h.ids()).toEqual(["m98", "m100", "m102"])
    } finally { h.unsubscribe() }
  })

  it("does not publish cached or returned additions into a replacement window", async () => {
    const h = await setup()
    ingestMessages(h.registry, "c1", [row(101)])
    let release!: (value: MessagesPage) => void
    load.mockImplementationOnce(() => new Promise<MessagesPage>(resolve => { release = resolve }))
    const pending = reconcileFocusedMessageQueries(h.client, "channel", "c1", "s1").catch(error => error)
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    h.client.removeQueries({ queryKey: h.key, exact: true })
    const replacement = { pages: [messageWindowPage(page([row(500)], 500))], pageParams: [{ mode: "newest" as const }] }
    h.client.setQueryData(h.key, replacement)
    release(page([row(100)], 101))
    await pending
    expect(h.client.getQueryData(h.key)).toBe(replacement)
    h.unsubscribe()
  })
})

import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createElement, type PropsWithChildren } from "react"
import { CancelledError, type InfiniteData } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { CONVERSATION_READ_TIMEOUT_MS, ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { communityKeys } from "@/lib/query-keys"
import type { Msg } from "@/lib/community/models/message"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()

})

afterEach(() => vi.useRealTimers())

// Load *after* the mock is set up so the queryFn resolves the mocked import.
async function loadHook() {
  return await import("./use-messages")
}

// The queryFn dispatches on `pageParam.mode` — one URL per mode. Legacy
// pre-A2 tests passed a raw cursor string; the new signature takes a
// discriminated pageParam so the type-narrowing per branch is explicit.

describe("channelMessagesQueryFn — url per mode", () => {
  it("newest → no query params", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    const { client } = await createCommunityQueryOwner()
    await channelMessagesQueryFn("ch_1")({ client, signal: new AbortController().signal, pageParam: { mode: "newest" } })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/channels/ch_1/messages", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
  })

  it("older → ?cursor=<c>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    const { client } = await createCommunityQueryOwner()
    await channelMessagesQueryFn("ch_1")({
      client,
      signal: new AbortController().signal,
      pageParam: { mode: "older", cursor: "2026-07-03T00:00:00.000Z|abc" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?cursor=2026-07-03T00%3A00%3A00.000Z%7Cabc",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })

  it("newer → ?since=<c>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMoreNewer: false, latestSeq: 0 })
    const { client } = await createCommunityQueryOwner()
    await channelMessagesQueryFn("ch_1")({
      client,
      signal: new AbortController().signal,
      pageParam: { mode: "newer", cursor: "cur_new" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?since=cur_new",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })

  it("anchor → ?anchor=<id>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMoreOlder: false, hasMoreNewer: false, latestSeq: 0 })
    const { client } = await createCommunityQueryOwner()
    await channelMessagesQueryFn("ch_1")({
      client,
      signal: new AbortController().signal,
      pageParam: { mode: "anchor", anchor: "m_42" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?anchor=m_42",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })

  it("since → ?since=<c>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMoreNewer: false, latestSeq: 0 })
    const { client } = await createCommunityQueryOwner()
    await channelMessagesQueryFn("ch_1")({
      client,
      signal: new AbortController().signal,
      pageParam: { mode: "since", since: "cur_since" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?since=cur_since",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })
})

describe("channelMessagesQueryFn — queryClient integration", () => {
  it.each(["account", "access"] as const)(
    "rejects a signal-free cold result after the active %s epoch changes",
    async (epoch) => {
      const { channelMessagesQueryFn } = await loadHook()
      const { client: queryClient, runtime } = await createCommunityQueryOwner("viewer-a")
      let resolveTransport!: (value: { messages: Msg[]; hasMore: boolean }) => void
      apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveTransport = resolve }))
      const request = channelMessagesQueryFn("ch_1", null, { queryClient })({
        pageParam: { mode: "newest" },
        signal: undefined,
      })

      const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" })
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
      if (epoch === "account") {
        runtime.ws.actions.activateProfileAccount("viewer-b")
      } else {
        runtime.ws.actions.revokeChannelAccess("server-1", "ch_1")
      }
      resolveTransport({ messages: [], hasMore: false })

      await rejection
    },
  )

  it("validates the transport receipt before returning a cache-safe page", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    const onSurfaceReceipt = vi.fn()
    apiFetchMock.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
      surfaceReceipt: { channelId: "ch_1", surfaceKind: "channel" },
    })

    const { client } = await createCommunityQueryOwner()
    const page = await channelMessagesQueryFn("ch_1", null, { onSurfaceReceipt })({
      client,
      pageParam: { mode: "newest" },
    })

    expect(onSurfaceReceipt).toHaveBeenCalledWith({
      channelId: "ch_1",
      surfaceKind: "channel",
    })
    expect(page).not.toHaveProperty("surfaceReceipt")
  })

  it("passes TanStack's AbortSignal to apiFetch", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    const controller = new AbortController()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })

    const { client } = await createCommunityQueryOwner()
    await channelMessagesQueryFn("ch_abort")({
      client,
      pageParam: { mode: "newest" },
      signal: controller.signal,
    })

    controller.abort()
    expect(apiFetchMock.mock.calls.at(-1)?.[1].signal.aborted).toBe(true)
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_abort/messages",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })

  it("populates queryClient at communityKeys.channelMessages(channelId)", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [{ id: "m_1" }], hasMore: false })
    const { client: qc } = await createCommunityQueryOwner()
    const key = communityKeys.channelMessages("ch_1")
    await qc.infiniteQuery({
      queryKey: key,
      queryFn: channelMessagesQueryFn("ch_1"),
      initialPageParam: { mode: "newest" } as const,
    })
    expect(qc.getQueryData(key)).toBeDefined()
  })

  // Foundation invariant: invalidating `channelMessages(channelId)` marks
  // every `channelMessagesPage(channelId, …)` variant as invalidated too.
  it("prefix invalidation via channelMessages(id) marks channelMessagesPage(id, cursor) invalidated", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false })
    const { client: qc } = await createCommunityQueryOwner()
    const cursorKey = communityKeys.channelMessagesPage("ch_1", "cur|abc")
    await qc.query({ queryKey: cursorKey, queryFn: () => apiFetchMock() })
    expect(qc.getQueryData(cursorKey)).toBeDefined()

    await qc.invalidateQueries({ queryKey: communityKeys.channelMessages("ch_1") })
    expect(qc.getQueryState(cursorKey)?.isInvalidated).toBe(true)
  })
})

describe("dmMessagesQueryFn", () => {
  it("strips the authoritative receipt before QueryClient storage", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
      surfaceReceipt: { channelId: "dm_1", surfaceKind: "dm" },
    })
    const { client: qc } = await createCommunityQueryOwner()
    const key = communityKeys.dmMessages("dm_1")

    await qc.infiniteQuery({
      queryKey: key,
      queryFn: dmMessagesQueryFn("dm_1"),
      initialPageParam: { mode: "newest" } as const,
    })

    const data = qc.getQueryData<InfiniteData<Record<string, unknown>>>(key)
    expect(data?.pages[0]).not.toHaveProperty("surfaceReceipt")
  })

  it("passes TanStack's AbortSignal to apiFetch", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    const controller = new AbortController()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })

    const { client } = await createCommunityQueryOwner()
    await dmMessagesQueryFn("dm_abort")({
      client,
      pageParam: { mode: "newest" },
      signal: controller.signal,
    })

    controller.abort()
    expect(apiFetchMock.mock.calls.at(-1)?.[1].signal.aborted).toBe(true)
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/dm_abort/messages",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })

  it("newest → no query params", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    const { client } = await createCommunityQueryOwner()
    await dmMessagesQueryFn("dm_1")({ client, signal: new AbortController().signal, pageParam: { mode: "newest" } })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/channels/dm_1/messages", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
  })

  it("older cursor → ?cursor", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    const { client } = await createCommunityQueryOwner()
    await dmMessagesQueryFn("dm_1")({
      client,
      signal: new AbortController().signal,
      pageParam: { mode: "older", cursor: "cur_1" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/dm_1/messages?cursor=cur_1",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })

  it("fetchNextPage (older) produces a new page under the same infinite key", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock
      .mockResolvedValueOnce({ messages: [{ id: "m_1" }], hasMore: true, cursor: "cur_1", latestSeq: 1 })
      .mockResolvedValueOnce({ messages: [{ id: "m_2" }], hasMore: false, latestSeq: 1 })
    const { client: qc } = await createCommunityQueryOwner()
    const key = communityKeys.dmMessages("dm_1")
    await qc.infiniteQuery({
      queryKey: key,
      queryFn: dmMessagesQueryFn("dm_1"),
      initialPageParam: { mode: "newest" } as const,
      getNextPageParam: (last: { hasMore?: boolean; cursor?: string }) =>
        last.hasMore && last.cursor ? { mode: "older" as const, cursor: last.cursor } : undefined,
      pages: 2,
    })
    const data = qc.getQueryData<InfiniteData<{ messages: unknown[] }>>(key)
    expect(data?.pages).toHaveLength(2)
  })
})

describe("message hooks — canonical receipt forwarding", () => {
  it("records transport receipts for mounted Channel and DM queries", async () => {
    const { useDmMessages, useMessages } = await loadHook()
    const { client: queryClient } = await createCommunityQueryOwner()
    apiFetchMock.mockImplementation(async (url: string) => ({
      messages: [],
      hasMore: false,
      latestSeq: 0,
      surfaceReceipt: url.includes("ch_receipt")
        ? { channelId: "ch_receipt", surfaceKind: "channel" }
        : { channelId: "dm_receipt", surfaceKind: "dm" },
    }))

    function useReceiptQueries() {
      useMessages("ch_receipt", {
        serverId: "server",
        lastReadMessageId: null,
      })
      useDmMessages("dm_receipt", { lastReadMessageId: null })
    }
    function QueryWrapper({ children }: PropsWithChildren) {
      return createElement(QueryClientProvider, { client: queryClient }, children)
    }
    renderHook(useReceiptQueries, { wrapper: QueryWrapper })
    await waitFor(() => {
      expect(queryClient.getQueryState(communityKeys.channelMessages("ch_receipt"))?.status)
        .toBe("success")
      expect(queryClient.getQueryState(communityKeys.dmMessages("dm_receipt"))?.status)
        .toBe("success")
    })
  })
})

describe("messageMatchesTag", () => {
  it("keeps untagged live rows out of tagged forum variants", async () => {
    const { messageMatchesTag } = await loadHook()
    const untagged = { id: "m1", type: "chat", thread: { tags: [] } } as Msg
    const tagged = { id: "m2", type: "chat", thread: { tags: ["bug"] } } as Msg

    expect(messageMatchesTag(untagged, null)).toBe(true)
    expect(messageMatchesTag(untagged, "bug")).toBe(false)
    expect(messageMatchesTag(tagged, "bug")).toBe(true)
  })
})

// ── mergeMessagesPages reducer ──────────────────────────────────────────
//
// Pages may arrive out of order — anchor first, then interleaved
// older/newer fetches. The reducer sorts across ALL pages by
// (createdAt, id) and dedupes by id so the visible message list is
// always in chronological ASC regardless of fetch sequence.

describe("mergeMessagesPages", () => {
  it("sorts across pages by (createdAt, id) ASC", async () => {
    const { mergeMessagesPages } = await loadHook()
    const pages = [
      {
        messages: [
          { id: "m_3", createdAt: "2026-07-01T00:00:03.000Z" },
          { id: "m_4", createdAt: "2026-07-01T00:00:04.000Z" },
        ],
        hasMoreOlder: false,
        hasMoreNewer: false,
      },
      {
        messages: [
          { id: "m_1", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_2", createdAt: "2026-07-01T00:00:02.000Z" },
        ],
        hasMore: false,
      },
    ]
    const merged = mergeMessagesPages(pages)
    expect(merged.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3", "m_4"])
  })

  it("dedupes by id (keeps first occurrence in sorted order)", async () => {
    const { mergeMessagesPages } = await loadHook()
    const pages = [
      {
        messages: [
          { id: "m_1", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_2", createdAt: "2026-07-01T00:00:02.000Z" },
        ],
      },
      {
        messages: [
          { id: "m_2", createdAt: "2026-07-01T00:00:02.000Z" },
          { id: "m_3", createdAt: "2026-07-01T00:00:03.000Z" },
        ],
      },
    ]
    const merged = mergeMessagesPages(pages)
    expect(merged.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"])
  })

  it("stable sort — equal createdAt tiebreaks on id", async () => {
    const { mergeMessagesPages } = await loadHook()
    const pages = [
      {
        messages: [
          { id: "m_b", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_a", createdAt: "2026-07-01T00:00:01.000Z" },
        ],
      },
    ]
    const merged = mergeMessagesPages(pages)
    expect(merged.map((m) => m.id)).toEqual(["m_a", "m_b"])
  })

  it("handles empty pages array", async () => {
    const { mergeMessagesPages } = await loadHook()
    expect(mergeMessagesPages([])).toEqual([])
  })
})


describe("bounded messages publication", () => {
  it.each(["cold", "known", "late-lineage"] as const)("rejects a %s child response after parent retirement without publishing body, window or navigation", async (lineage) => {
    const { channelMessagesQueryFn } = await loadHook()
    const { retireCommunityChannelReading, assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken } = await import("@/lib/community-db/sync")
    const { client, registry, runtime } = await createCommunityQueryOwner()
    runtime.ws.actions.rememberChannelAccess(null, "sibling-dm")
    const sibling = captureCommunityLiveSnapshotToken(client, "sibling-dm")
    if (lineage === "known") runtime.ws.actions.rememberChannelAccess("server", "child", "parent")
    let resolve!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const receipt = vi.fn(), key = communityKeys.channelMessages("child")
    const request = client.infiniteQuery({ queryKey: key, queryFn: channelMessagesQueryFn("child", null, { onSurfaceReceipt: receipt }), initialPageParam: { mode: "newest" }, getNextPageParam: () => undefined, retry: false })
    const rejected = lineage === "known" ? expect(request).rejects.toBeInstanceOf(CancelledError) : expect(request).rejects.toMatchObject({ name: "AbortError" })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    retireCommunityChannelReading(registry, "parent", { reason: "read-denied", serverId: "server" })
    if (lineage === "late-lineage") runtime.ws.actions.observeChannelScope("server", "child", "parent")
    resolve({ messages: [{ id: "late-child-message", type: "chat", seq: 1, authorId: "late-author", authorName: "Late", content: "private" }], hasMore: false, latestSeq: 1, surfaceReceipt: { channelId: "child", surfaceKind: "thread" } })
    await rejected
    expect(registry.collections.messages.has("late-child-message")).toBe(false)
    expect(registry.collections.profiles.has("late-author")).toBe(false)
    expect(client.getQueryData(key)).toBeUndefined()
    expect(receipt).not.toHaveBeenCalled()
    expect(() => assertCommunityLiveSnapshotTokenCurrent(client, sibling, undefined)).not.toThrow()
    apiFetchMock.mockResolvedValueOnce({ messages: [{ id: "fresh-child-message", type: "chat", seq: 2, authorId: "fresh-author", authorName: "Fresh", content: "fresh" }], hasMore: false, latestSeq: 2 })
    await client.infiniteQuery({ queryKey: key, queryFn: channelMessagesQueryFn("child"), initialPageParam: { mode: "newest" }, getNextPageParam: () => undefined, retry: false })
    expect(registry.collections.messages.has("fresh-child-message")).toBe(true)
    expect(client.getQueryData(key)).toBeDefined()
  })

  it("publishes an already-qualified sibling DM response across an unrelated parent retirement", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    const { retireCommunityChannelReading } = await import("@/lib/community-db/sync")
    const { client, registry, runtime } = await createCommunityQueryOwner()
    runtime.ws.actions.rememberChannelAccess(null, "sibling-dm")
    let resolve!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const request = channelMessagesQueryFn("sibling-dm")({ client, pageParam: { mode: "newest" } })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    retireCommunityChannelReading(registry, "parent", { reason: "read-denied", serverId: "server" })
    resolve({ messages: [{ id: "dm-message", type: "chat", seq: 1, authorId: "peer", authorName: "Peer", content: "current" }], hasMore: false, latestSeq: 1 })
    await expect(request).resolves.toMatchObject({ messages: [{ id: "dm-message" }] })
    expect(registry.collections.messages.has("dm-message")).toBe(true)
    expect(registry.collections.profiles.has("peer")).toBe(true)
  })

  it("does not publish a late message, profile or navigation receipt after deadline failure", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    const { client } = await createCommunityQueryOwner()
    let resolve!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const receipt = vi.fn()
    vi.useFakeTimers()
    const request = channelMessagesQueryFn("ch_deadline", null, { queryClient: client, onSurfaceReceipt: receipt })({ client, signal: new AbortController().signal, pageParam: { mode: "newest" } })
    const rejected = expect(request).rejects.toBeInstanceOf(ConversationReadTimeoutError)
    await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS) })
    await rejected
    expect(apiFetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => {
      resolve({ messages: [{ id: "late_message", type: "chat", seq: 1, authorId: "late_author", authorName: "Late", content: "late" }], hasMore: false, latestSeq: 1, surfaceReceipt: { channelId: "ch_deadline", surfaceKind: "channel" } })
      await vi.advanceTimersByTimeAsync(0)
    })
    const registry = getCommunityDbRegistry(client)!
    expect(registry.collections.messages.get("late_message")).toBeUndefined()
    expect(registry.collections.profiles.get("late_author")).toBeUndefined()
    expect(receipt).not.toHaveBeenCalled()
  })
})

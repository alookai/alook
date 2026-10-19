import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider, onlineManager } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import type { MessageWindowData } from "@/lib/community/message-window"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useMessages, useDmMessages } from "./use-messages"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset(); return () => { onlineManager.setOnline(true) } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: React.PropsWithChildren) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
  return { ...owner, wrapper }
}

describe("entry-owned message activation", () => {
  it.each(["text", "thread", "dm"] as const)("uses one qualified %s entry and reuses its actual window on return", async type => {
    const { wrapper } = await setup()
    const packet = type === "dm" ? dmConversationEntryFixture() : fixture()
    packet.channel.type = type
    packet.surfaceReceipt.surfaceKind = type === "text" ? "channel" : type
    if (type === "thread") { packet.channel.parentChannelId = "parent"; packet.channel.parentMessageId = "opener" }
    load.mockResolvedValue(packet)
    const useSurface = type === "dm" ? () => useDmMessages("c1") : () => useMessages("c1", { serverId: "s1" })
    const first = renderHook(useSurface, { wrapper })
    await waitFor(() => expect(first.result.current.initialPositionKnown).toBe(true))
    expect(first.result.current.messages?.map(row => row.id)).toEqual(["m1"])
    expect(load).toHaveBeenCalledOnce()
    first.unmount()
    const returned = renderHook(useSurface, { wrapper })
    await waitFor(() => expect(returned.result.current.messages?.map(row => row.id)).toEqual(["m1"]))
    expect(load).toHaveBeenCalledOnce()
    returned.unmount()
  })

  it("revalidates a stale landing once without replaying its three cached pages", async () => {
    const { wrapper, client } = await setup()
    load.mockResolvedValue(fixture())
    const first = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(first.result.current.initialPositionKnown).toBe(true))
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
    const cached = client.getQueryData<MessageWindowData>(key)!
    const pages = [cached.pages[0], { ...cached.pages[0], messages: [], olderCursor: "old-2" }, { ...cached.pages[0], messages: [], hasMoreOlder: false }]
    await act(async () => client.setQueryData(key, { pages, pageParams: [{ mode: "anchor", anchor: "m1" }, { mode: "older", cursor: "old-1" }, { mode: "older", cursor: "old-2" }] }))
    first.unmount()
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000)
    try {
      const returned = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(returned.result.current.isFetching).toBe(false))
      expect(load.mock.calls.every(([url]) => String(url).includes("entry=1"))).toBe(true)
      expect(client.getQueryData<MessageWindowData>(key)?.pages).toEqual(pages)
      expect(returned.result.current.messages.map(row => row.id)).toEqual(["m1"])
      returned.unmount()
    } finally { clock.mockRestore() }
  })

  it("feeds a new landing tail into the existing gap repair without reloading the anchor page", async () => {
    const { wrapper, client } = await setup()
    const packet = fixture()
    load.mockResolvedValueOnce(packet)
    const first = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(first.result.current.initialPositionKnown).toBe(true))
    first.unmount()
    const m2 = { ...packet.messages[0], id: "m2", seq: 2, content: "Missed message", createdAt: "2026-10-01T00:00:02.000Z" }
    const m3 = { ...m2, id: "m3", seq: 3, content: "New landing", createdAt: "2026-10-01T00:00:03.000Z" }
    load.mockImplementation((url: string) => url.includes("entry=1")
      ? Promise.resolve({ ...packet, messages: [packet.messages[0], m3], page: { ...packet.page, latestSeq: 3 } })
      : Promise.resolve({ messages: [m2, m3], latestSeq: 3, hasMoreNewer: false, hasMoreOlder: true }))
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000)
    try {
      const returned = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
      await waitFor(() => expect(returned.result.current.messages.map(row => row.id)).toEqual(["m1", "m2", "m3"]))
      const urls = load.mock.calls.map(([url]) => String(url))
      expect(urls).toHaveLength(3)
      expect(urls.filter(url => url.includes("entry=1"))).toHaveLength(2)
      expect(urls[2]).toContain("since=")
      expect(urls.filter(url => url.includes("anchor="))).toHaveLength(0)
      expect(client.getQueryData<MessageWindowData>(communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" }))?.pages).toHaveLength(1)
      returned.unmount()
    } finally { clock.mockRestore() }
  })

  it("freezes a confirmed never-visited pointer through a later canonical advance", async () => {
    const { wrapper, registry } = await setup()
    const packet = fixture()
    packet.readState = { channelId: "c1", lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
    packet.selection = { reason: "tail", anchorMessageId: null }
    load.mockResolvedValue(packet)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(hook.result.current.initialPositionKnown).toBe(true))
    await act(async () => { ingestReadStateSnapshot(registry, { revision: 5, readStates: [{ channelId: "c1", lastReadMessageId: "m1", lastReadAt: "now", lastReadSeq: 1 }] }) })
    expect(hook.result.current.readSnapshot?.lastReadMessageId).toBeNull()
    expect(hook.result.current.readSnapshot?.lastReadSeq).toBe(0)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("does not invent a never-visited pointer after timeout", async () => {
    const { wrapper } = await setup()
    load.mockRejectedValue(new ConversationReadTimeoutError())
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(hook.result.current.initialLoadError).toBeInstanceOf(ConversationReadTimeoutError))
    expect(hook.result.current.readSnapshot).toBeNull()
    expect(hook.result.current.initialPositionKnown).toBe(false)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("runs a bounded first read even while the native online manager is offline", async () => {
    const { wrapper } = await setup()
    onlineManager.setOnline(false)
    load.mockResolvedValue(fixture())
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(hook.result.current.initialPositionKnown).toBe(true))
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("uses the native abort signal when the last consumer unmounts", async () => {
    const { wrapper } = await setup()
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    const signal: AbortSignal = load.mock.calls[0][1].signal
    hook.unmount()
    expect(signal.aborted).toBe(true)
    request.resolve(fixture())
  })
})

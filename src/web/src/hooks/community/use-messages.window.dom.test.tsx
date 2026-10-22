import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, conversationEntryTarget as target } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useMessages } from "./use-messages"
import type { MessagesPage } from "@/lib/community/models/message"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async (original) => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function page(id: string, seq: number, more = false): MessagesPage {
  const row = fixture().messages[0]
  return { messages: [{ ...row, resourceComplete: true, id, seq, content: id }], latestSeq: seq, hasMoreOlder: more, hasMoreNewer: false, olderCursor: more ? "older" : undefined }
}
async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
  return { ...owner, wrapper }
}
const options = { serverId: target.serverId, viewerUserId: "viewer" }

describe("native conversation windows", () => {
  it("bounds missing canonical rows with the existing conversation read deadline", async () => {
    const { wrapper, registry } = await setup()
    load.mockResolvedValue(fixture())
    const hook = renderHook(() => useMessages("c1", options), { wrapper })
    await waitFor(() => expect(hook.result.current.positionDataState).toBe("ready"))
    vi.useFakeTimers()
    try {
      await act(async () => registry.collections.messages.utils.writeDelete("m1"))
      await act(async () => vi.advanceTimersByTimeAsync(14999))
      expect(hook.result.current.positionDataState).toBe("pending")
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(hook.result.current.positionDataState).toBe("error")
      expect(hook.result.current.initialLoadError).toBeTruthy()
      expect(hook.result.current.readSnapshot?.lastReadMessageId).toBe("m1")
    } finally { hook.unmount(); vi.useRealTimers() }
  })
  it("renders the cold entry window without a second GET and keeps only references in Query", async () => {
    const { wrapper, client } = await setup()
    load.mockResolvedValue(fixture())
    const hook = renderHook(() => useMessages("c1", options), { wrapper })
    await waitFor(() => expect(hook.result.current.messages.map((message) => message.content)).toEqual(["Body"]))
    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.readSnapshot?.lastReadMessageId).toBe("m1")
    expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1"])
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
    expect(JSON.stringify(client.getQueryData(key))).not.toContain("Body")
    hook.unmount()
  })

  it("waits for native background refetch before fulfilling an older-page intent", async () => {
    const { wrapper } = await setup()
    const refresh = deferred<MessagesPage>()
    load.mockImplementation((url: string) => {
      const search = new URL(url, "https://example.test").searchParams
      if (search.has("entry")) return Promise.resolve(fixture())
      if (search.has("anchor")) return refresh.promise
      if (search.get("cursor") === "older") return Promise.resolve(page("m0", 0))
      throw new Error("Unexpected message window")
    })
    const hook = renderHook(() => useMessages("c1", options), { wrapper })
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1))
    let refetch!: Promise<unknown>
    await act(async () => { refetch = hook.result.current.refetch({ cancelRefetch: false }); await Promise.resolve() })
    await act(async () => hook.result.current.fetchOlder())
    expect(load.mock.calls.some(([url]) => new URL(url, "https://example.test").searchParams.has("cursor"))).toBe(false)
    await act(async () => { refresh.resolve(page("m1", 1, true)); await refetch })
    await waitFor(() => expect(hook.result.current.messages.map((message) => message.id)).toEqual(["m0", "m1"]))
    expect(hook.result.current.data?.pageParams).toEqual([{ mode: "anchor", anchor: "m1" }, { mode: "older", cursor: "older" }])
    hook.unmount()
  })

  it("returns an older-page failure and accepts a later request on the same window", async () => {
    const { wrapper } = await setup()
    load.mockResolvedValue(fixture())
    const hook = renderHook(() => useMessages("c1", options), { wrapper })
    await waitFor(() => expect(hook.result.current.positionDataState).toBe("ready"))
    const original = hook.result.current.data
    load.mockRejectedValue(new ConversationReadTimeoutError())
    const failed = hook.result.current.fetchOlder()
    expect(failed.accepted).toBe(true)
    if (!failed.accepted) throw new Error("Older request was rejected")
    await act(async () => expect(await failed.completed).toEqual({ status: "error" }))
    expect(hook.result.current.data).toBe(original)
    expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1"])
    load.mockResolvedValue(page("m0", 0))
    const retried = hook.result.current.fetchOlder()
    expect(retried.accepted).toBe(true)
    if (!retried.accepted) throw new Error("Older retry was rejected")
    await act(async () => expect((await retried.completed).status).toBe("success"))
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["m0", "m1"]))
    hook.unmount()
  })

  it.each(["success", "error"] as const)("returns a real newer cursor request's %s receipt", async status => {
    const { wrapper } = await setup()
    const packet = fixture()
    packet.page.hasMoreNewer = true
    packet.page.newerCursor = "newer"
    load.mockResolvedValue(packet)
    const hook = renderHook(() => useMessages("c1", options), { wrapper })
    await waitFor(() => expect(hook.result.current.positionDataState).toBe("ready"))
    const original = hook.result.current.data
    load.mockImplementation(() => status === "success" ? Promise.resolve(page("m2", 2)) : Promise.reject(new ConversationReadTimeoutError()))
    let accepted!: ReturnType<typeof hook.result.current.fetchNewer>
    await act(async () => { accepted = hook.result.current.fetchNewer() })
    const pending = accepted
    expect(pending.accepted).toBe(true)
    if (!pending.accepted) throw new Error("Newer request was rejected")
    await act(async () => expect((await pending.completed).status).toBe(status))
    expect(load.mock.calls.at(-1)?.[0]).toBe("/api/community/channels/c1/messages?since=newer")
    if (status === "success") {
      await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1", "m2"]))
      expect(hook.result.current.data?.pageParams).toEqual([{ mode: "newer", cursor: "newer" }, { mode: "anchor", anchor: "m1" }])
      expect(hook.result.current.hasMoreNewer).toBe(false)
    } else {
      expect(hook.result.current.data).toBe(original)
      expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1"])
    }
    hook.unmount()
  })

  it("keeps the old window during Jump, preserves it on failure, and switches only after a successful tail read", async () => {
    const { wrapper, client } = await setup()
    const first = deferred<MessagesPage>()
    const second = deferred<MessagesPage>()
    let attempts = 0
    load.mockImplementation((url: string) => new URL(url, "https://example.test").searchParams.has("entry")
      ? Promise.resolve(fixture()) : ++attempts === 1 ? first.promise : second.promise)
    const hook = renderHook(() => useMessages("c1", options), { wrapper })
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1))
    const anchorKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
    const original = client.getQueryData(anchorKey)
    await act(async () => hook.result.current.jumpToPresent())
    expect(hook.result.current.isFetchingNewer).toBe(true)
    expect(hook.result.current.messages[0].id).toBe("m1")
    await act(async () => first.reject(new ConversationReadTimeoutError()))
    await waitFor(() => expect(hook.result.current.isFetchingNewer).toBe(false))
    expect(hook.result.current.messages[0].id).toBe("m1")
    expect(hook.result.current.presentVersion).toBe(0)
    expect(client.getQueryData(anchorKey)).toBe(original)
    await act(async () => hook.result.current.jumpToPresent())
    await act(async () => second.resolve(page("m3", 3)))
    await waitFor(() => expect(hook.result.current.messages.map((message) => message.id)).toEqual(["m3"]))
    expect(hook.result.current.presentVersion).toBeGreaterThan(0)
    expect(hook.result.current.readSnapshot?.lastReadMessageId).toBe("m1")
    expect(client.getQueryData(anchorKey)).toBe(original)
    hook.unmount()
  })

  it("drops a queued pagination intent when the original target loses permission", async () => {
    const { wrapper, registry } = await setup()
    const refresh = deferred<MessagesPage>()
    load.mockImplementation((url: string) => new URL(url, "https://example.test").searchParams.has("entry") ? Promise.resolve(fixture()) : refresh.promise)
    const hook = renderHook(() => useMessages("c1", options), { wrapper })
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1))
    await act(async () => { void hook.result.current.refetch({ cancelRefetch: false }); await Promise.resolve() })
    await act(async () => hook.result.current.fetchOlder())
    await act(async () => { registry.runtime.ws.actions.revokeChannelAccess("s1", "c1"); refresh.resolve(page("m1", 1, true)) })
    await waitFor(() => expect(hook.result.current.messages).toEqual([]))
    expect(load.mock.calls.some(([url]) => new URL(url, "https://example.test").searchParams.has("cursor"))).toBe(false)
    hook.unmount()
  })
})

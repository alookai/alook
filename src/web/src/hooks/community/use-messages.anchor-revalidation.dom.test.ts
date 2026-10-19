import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { communityKeys } from "@/lib/query-keys"
import { retireCommunityChannelReading } from "@/lib/community-db/sync"
import { useMessages } from "./use-messages"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })
function packet(anchor: string) {
  const value = conversationEntryFixture()
  return { ...value, selection: { reason: "explicit_anchor" as const, anchorMessageId: anchor },
    messages: [{ ...value.messages[0], id: anchor, content: anchor }] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
  return { ...owner, wrapper }
}
const target = (anchor: string) => ({ channelId: "c1", serverId: "s1", anchorMessageId: anchor })

describe("anchor windows keep native identity and history", () => {
  it("shares one pending entry between two consumers and aborts only when both leave", async () => {
    const { wrapper } = await setup()
    const request = deferred<ReturnType<typeof packet>>()
    load.mockReturnValue(request.promise)
    const first = renderHook(() => useMessages("c1", target("a")), { wrapper })
    const second = renderHook(() => useMessages("c1", target("a")), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    const signal = load.mock.calls[0][1].signal as AbortSignal
    first.unmount()
    expect(signal.aborted).toBe(false)
    await act(async () => request.resolve(packet("a")))
    await waitFor(() => expect(second.result.current.messages.map(row => row.id)).toEqual(["a"]))
    second.unmount()
  })

  it("keeps simultaneous anchor identities on independent requests and windows", async () => {
    const { wrapper, client } = await setup()
    const a = deferred<ReturnType<typeof packet>>(), b = deferred<ReturnType<typeof packet>>()
    load.mockImplementation((url: string) => new URL(url, "https://example.test").searchParams.get("anchor") === "a" ? a.promise : b.promise)
    const first = renderHook(() => useMessages("c1", target("a")), { wrapper })
    const second = renderHook(() => useMessages("c1", target("b")), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await act(async () => { b.resolve(packet("b")); a.resolve(packet("a")) })
    await waitFor(() => expect(first.result.current.messages.map(row => row.id)).toEqual(["a"]))
    expect(second.result.current.messages.map(row => row.id)).toEqual(["b"])
    expect(client.getQueryData(communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "a" }))).not.toBe(client.getQueryData(communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "b" })))
    first.unmount(); second.unmount()
  })

  it("keeps three loaded history pages intact when another explicit anchor opens", async () => {
    const { wrapper, client } = await setup()
    await seedConversationEntry(client, packet("a"), target("a"))
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "a" })
    client.setQueryData(key, { pages: ["a", "older-1", "older-2"].map(id => ({ messages: [{ id }], latestSeq: 8, hasMoreNewer: false, hasMoreOlder: false })),
      pageParams: [{ mode: "anchor", anchor: "a" }, { mode: "older", cursor: "one" }, { mode: "older", cursor: "two" }] })
    const history = client.getQueryData(key)
    load.mockResolvedValue(packet("b"))
    const hook = renderHook(() => useMessages("c1", target("b")), { wrapper })
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["b"]))
    expect(client.getQueryData(key)).toBe(history)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("reuses a qualified settled window on return without rewriting its page parameters", async () => {
    const { wrapper, client } = await setup()
    load.mockResolvedValue(packet("a"))
    const first = renderHook(() => useMessages("c1", target("a")), { wrapper })
    await waitFor(() => expect(first.result.current.initialPositionKnown).toBe(true))
    first.unmount()
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "a" })
    const before = client.getQueryData(key)
    const returned = renderHook(() => useMessages("c1", target("a")), { wrapper })
    expect(returned.result.current.messages.map(row => row.id)).toEqual(["a"])
    expect(client.getQueryData(key)).toBe(before)
    expect(load).toHaveBeenCalledOnce()
    returned.unmount()
  })

  it.each(["resolves", "rejects"] as const)("does not restore evicted content when an old anchor request %s", async outcome => {
    const { wrapper, registry, client } = await setup()
    const request = deferred<ReturnType<typeof packet>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(() => useMessages("c1", target("a")), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => {
      retireCommunityChannelReading(registry, "c1", { reason: "read-denied", serverId: "s1" })
      hook.unmount()
      if (outcome === "resolves") request.resolve(packet("a"))
      else request.reject(new Error("old request"))
    })
    expect(registry.collections.messages.has("a")).toBe(false)
    expect(client.getQueryData(communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "a" }))).toBeUndefined()
  })
})

import { createElement, type PropsWithChildren, Suspense, useLayoutEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { communityKeys } from "@/lib/query-keys"
import { useMessages, useDmMessages } from "./use-messages"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function packet(kind: "channel" | "dm", anchor = "m1", channelId = "c1") {
  const value = kind === "channel" ? conversationEntryFixture() : dmConversationEntryFixture()
  return { ...value, channelId, channel: { ...value.channel, id: channelId },
    access: { ...value.access, channelId }, readState: { ...value.readState, channelId },
    surfaceReceipt: { ...value.surfaceReceipt, channelId }, selection: { reason: "explicit_anchor" as const, anchorMessageId: anchor },
    messages: [{ ...value.messages[0], id: anchor, channelId, content: anchor }], page: { ...value.page, hasMoreNewer: true } }
}
function page(id: string) {
  return { messages: [{ ...conversationEntryFixture().messages[0], id, content: id, seq: 8 }], latestSeq: 8, hasMoreOlder: false, hasMoreNewer: false }
}
async function setup(kind: "channel" | "dm", anchor = "m1", channelId = "c1") {
  const owner = await createCommunityQueryOwner()
  const serverId = kind === "channel" ? "s1" : null
  const seed = (anchor: string, channelId = "c1") => seedConversationEntry(owner.client, packet(kind, anchor, channelId), { channelId, serverId, anchorMessageId: anchor })
  await seed(anchor, channelId)
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
  const useSurface = kind === "channel" ? (anchor: string, channelId = "c1") => useMessages(channelId, { serverId: "s1", anchorMessageId: anchor }) : (anchor: string, channelId = "c1") => useDmMessages(channelId, { anchorMessageId: anchor })
  return { ...owner, wrapper, seed, useSurface }
}

describe("Jump to present preserves native history", () => {
  it.each(["channel", "dm"] as const)("joins repeated pending clicks and commits one successful %s tail", async kind => {
    const { wrapper, useSurface, client } = await setup(kind)
    const request = deferred<ReturnType<typeof page>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(() => useSurface("m1"), { wrapper })
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1"]))
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
    const history = client.getQueryData(key)
    await act(async () => { hook.result.current.jumpToPresent(); hook.result.current.jumpToPresent() })
    expect(load).toHaveBeenCalledOnce()
    expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1"])
    expect(hook.result.current.isFetchingNewer).toBe(true)
    await act(async () => request.resolve(page("newest")))
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["newest"]))
    expect(hook.result.current.presentVersion).toBe(1)
    expect(client.getQueryData(key)).toBe(history)
    expect(hook.result.current.readSnapshot?.lastReadMessageId).toBe("m1")
    hook.unmount()
  })

  it("retains the anchored window after failure and allows a fresh attempt", async () => {
    const { wrapper, useSurface } = await setup("channel")
    load.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page("newest"))
    const hook = renderHook(() => useSurface("m1"), { wrapper })
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    await act(async () => hook.result.current.jumpToPresent())
    await waitFor(() => expect(hook.result.current.isFetchingNewer).toBe(false))
    expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1"])
    expect(hook.result.current.presentVersion).toBe(0)
    await act(async () => hook.result.current.jumpToPresent())
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["newest"]))
    expect(load).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

  it("resets a present selection when the explicit anchor changes", async () => {
    const { wrapper, useSurface, seed } = await setup("channel")
    await seed("other")
    load.mockResolvedValue(page("newest"))
    const hook = renderHook(({ anchor }) => useSurface(anchor), { wrapper, initialProps: { anchor: "m1" } })
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    await act(async () => hook.result.current.jumpToPresent())
    await waitFor(() => expect(hook.result.current.presentVersion).toBe(1))
    hook.rerender({ anchor: "other" })
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["other"]))
    expect(hook.result.current.presentVersion).toBe(0)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("drops the old override across A to B to A and rejects the old target completion", async () => {
    const { wrapper, useSurface, seed } = await setup("channel")
    await seed("b1", "c2")
    const request = deferred<ReturnType<typeof page>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(({ id, anchor }) => useSurface(anchor, id), { wrapper, initialProps: { id: "c1", anchor: "m1" } })
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    await act(async () => hook.result.current.jumpToPresent())
    hook.rerender({ id: "c2", anchor: "b1" })
    await act(async () => request.resolve(page("old-completion")))
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["b1"]))
    expect(hook.result.current.presentVersion).toBe(0)
    hook.rerender({ id: "c1", anchor: "m1" })
    await waitFor(() => expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1"]))
    expect(hook.result.current.presentVersion).toBe(0)
    hook.unmount()
  })

  it.each(["channel", "dm"] as const)("does not let an uncommitted %s target steal the committed window", async kind => {
    const { wrapper: Wrapper, useSurface, seed } = await setup(kind)
    await seed("b1", "c2")
    const commits: string[][] = []
    const blocker = new Promise<never>(() => {})
    function Capture({ id, anchor, suspend }: { id: string; anchor: string; suspend: boolean }) {
      const value = useSurface(anchor, id)
      const signature = value.messages.map(row => row.id).join(",")
      useLayoutEffect(() => { commits.push(signature ? signature.split(",") : []) }, [signature])
      if (suspend) throw blocker
      return null
    }
    const tree = (id: string, anchor: string, suspend: boolean) => createElement(Wrapper, null, createElement(Suspense, { fallback: null }, createElement(Capture, { id, anchor, suspend })))
    const view = render(tree("c1", "m1", false))
    await waitFor(() => expect(commits.at(-1)).toEqual(["m1"]))
    view.rerender(tree("c2", "b1", true))
    expect(commits.at(-1)).toEqual(["m1"])
    view.rerender(tree("c1", "m1", false))
    expect(commits.at(-1)).toEqual(["m1"])
    expect(load).not.toHaveBeenCalled()
    view.unmount()
  })
})

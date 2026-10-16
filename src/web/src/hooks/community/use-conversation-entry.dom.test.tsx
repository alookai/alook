import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, dmConversationEntryFixture, conversationEntryTarget as target } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { conversationEntryOptions, publishConversationEntry } from "@/lib/community/conversation-entry"
import { communityKeys } from "@/lib/query-keys"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { useConversationEntry } from "./use-conversation-entry"
import { useChannelMetadata } from "./use-channel-metadata"
import { useDmMessages } from "./use-messages"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async (original) => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
  const publish = (value = fixture()) => {
    const options = conversationEntryOptions(owner.client, target)
    const resource = publishConversationEntry(owner.client, target, value, { token: captureCommunityLiveSnapshotToken(owner.client, target.channelId) })
    owner.client.setQueryData(options.queryKey, resource)
    return resource
  }
  return { ...owner, wrapper, publish }
}

describe("conversation entry selection", () => {
  it("shares one returned-DM read between metadata and the subsequently mounted body", async () => {
    const { wrapper: Owner, registry, client } = await setup()
    const dmTarget = { channelId: "c1", serverId: null }
    const old = dmConversationEntryFixture()
    const oldResource = publishConversationEntry(client, dmTarget, old, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    client.setQueryData(conversationEntryOptions(client, dmTarget).queryKey, oldResource)
    ingestReadStateSnapshot(registry, { revision: 6, readStates: [{ channelId: "c1", lastReadMessageId: "m2", lastReadSeq: 2, lastReadAt: "later" }] })
    const next = dmConversationEntryFixture()
    next.readState = { ...next.readState, lastReadMessageId: "m2", lastReadSeq: 2 }
    next.readStateRevision = 6
    next.selection = { reason: "read_pointer", anchorMessageId: "m2" }
    next.messages = [{ ...next.messages[0], id: "m2", seq: 2 }]
    load.mockResolvedValue(next)
    const navigation = { entryIntent: { href: "/c/me/c1" } }
    let body!: ReturnType<typeof useDmMessages>
    function Body() { body = useDmMessages("c1"); return null }
    function Route() {
      const metadata = useChannelMetadata(null, "c1")
      return metadata.canRead ? createElement(Body) : null
    }
    const view = render(createElement(Owner, null, createElement(CommunityRouteContext, { value: { navigation } as never }, createElement(Route))))
    await waitFor(() => expect(body?.messages.map(message => message.id)).toContain("m2"))
    expect(load).toHaveBeenCalledOnce()
    view.unmount()
  })

  it("resolves a cold main window and freezes NEW from the single entry GET", async () => {
    const { wrapper } = await setup()
    const transport = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(transport.promise)
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.isPending).toBe(true)
    expect(hook.result.current.snapshot).toBeNull()
    await act(async () => transport.resolve(fixture()))
    await waitFor(() => expect(hook.result.current.window).not.toBeNull())
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    expect(hook.result.current.canRead).toBe(true)
    expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1"])
    hook.unmount()
  })

  it("renders a warm covered window without GET and freezes the current document pointer", async () => {
    const { wrapper, publish, registry } = await setup()
    const value = fixture()
    value.messages.push({ ...value.messages[0], id: "m2", seq: 2, content: "Second" })
    value.page.latestSeq = 2
    publish(value)
    ingestReadStateSnapshot(registry, { revision: 5, readStates: [{ channelId: "c1", lastReadMessageId: "m2", lastReadAt: "at", lastReadSeq: 2 }] })
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    expect(hook.result.current.window).not.toBeNull()
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2")
    expect(hook.result.current.isPending).toBe(false)
    expect(load).not.toHaveBeenCalled()
    await act(async () => { ingestReadStateSnapshot(registry, { revision: 6, readStates: [{ channelId: "c1", lastReadMessageId: "m3", lastReadAt: "later", lastReadSeq: 3 }] }) })
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2")
    expect(load).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("keeps its selected window and NEW during a background timeout", async () => {
    const { wrapper, publish } = await setup()
    publish()
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    const window = hook.result.current.window
    const transport = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(transport.promise)
    let refreshing!: Promise<unknown>
    await act(async () => { refreshing = hook.result.current.refetch({ cancelRefetch: false }); await Promise.resolve() })
    expect(hook.result.current.window).toBe(window)
    expect(hook.result.current.isPending).toBe(false)
    await act(async () => { transport.reject(new ConversationReadTimeoutError()); await refreshing })
    expect(hook.result.current.window).toBe(window)
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    expect(hook.result.current.canRead).toBe(true)
    expect(hook.result.current.isPending).toBe(false)
    hook.unmount()
  })

  it("does not freeze an unqualified disk pointer", async () => {
    const { wrapper, client } = await setup()
    client.setQueryData(communityKeys.communityDbCollection("viewer", "readStates"), [{ channelId: "c1", lastReadMessageId: "old-disk-pointer", lastReadAt: "old", lastReadSeq: 100, observedRevision: 1 }])
    const transport = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(transport.promise)
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    expect(hook.result.current.snapshot).toBeNull()
    await act(async () => transport.resolve(fixture()))
    await waitFor(() => expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1"))
    hook.unmount()
  })

  it("loads one new entry when a newer current pointer is outside all cached windows", async () => {
    const { wrapper, publish, registry } = await setup()
    publish()
    ingestReadStateSnapshot(registry, { revision: 5, readStates: [{ channelId: "c1", lastReadMessageId: "m2", lastReadAt: "second", lastReadSeq: 2 }] })
    const transport = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(transport.promise)
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.window).toBeNull()
    const next = fixture()
    next.readState = { channelId: "c1", lastReadMessageId: "m2", lastReadAt: "second", lastReadSeq: 2 }
    next.readStateRevision = 5
    next.selection = { reason: "read_pointer", anchorMessageId: "m2" }
    next.messages = [{ ...next.messages[0], id: "m2", seq: 2, content: "Second" }]
    await act(async () => transport.resolve(next))
    await waitFor(() => expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2"))
    expect(hook.result.current.window?.initial).toEqual({ mode: "anchor", anchor: "m2" })
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("takes the current covered pointer for a new same-channel navigation while retaining the native resource", async () => {
    const { wrapper: Owner, publish, registry } = await setup()
    const packet = fixture()
    packet.messages.push({ ...packet.messages[0], id: "m2", seq: 2 })
    packet.page.latestSeq = 2
    publish(packet)
    const navigation: { entryIntent: { href: string } | null } = { entryIntent: null }
    const wrapper = ({ children }: PropsWithChildren) => createElement(Owner, null, createElement(CommunityRouteContext, { value: { navigation } as never }, children))
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    await act(async () => { ingestReadStateSnapshot(registry, { revision: 5, readStates: [{ channelId: "c1", lastReadMessageId: "m2", lastReadAt: "later", lastReadSeq: 2 }] }) })
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    navigation.entryIntent = { href: "/c/channels/s1/c1" }
    hook.rerender()
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2")
    expect(load).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("withdraws a selected window immediately on target revocation", async () => {
    const { wrapper, publish, registry } = await setup()
    publish()
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    expect(hook.result.current.canRead).toBe(true)
    await act(async () => { registry.runtime.ws.actions.revokeChannelAccess("s1", "c1") })
    expect(hook.result.current.canRead).toBe(false)
    expect(hook.result.current.window).toBeNull()
    expect(hook.result.current.denied).toBe(true)
    expect(load).not.toHaveBeenCalled()
    hook.unmount()
  })
  it("withdraws a completed proof and exactly refetches after its real registry registration retires", async () => {
    const { wrapper, publish, registry, client } = await setup()
    const original = publish()
    const hook = renderHook(() => useConversationEntry({ ...target }), { wrapper })
    expect(hook.result.current.canRead).toBe(true)
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const unregister = registerCommunityDbRegistry(registry)
    let dispose!: () => void
    await act(async () => {
      unregister()
      dispose = registerCommunityDbRegistry(registry)
      hook.rerender()
    })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationEntryOptions(client, target).queryKey, exact: true })
    expect(hook.result.current.canRead).toBe(false)
    expect(hook.result.current.resource).toBeUndefined()
    await act(async () => request.resolve(fixture()))
    await waitFor(() => expect(hook.result.current.canRead).toBe(true))
    expect(hook.result.current.resource?.proof.ownerGeneration).toBe(registry.runtime.lifecycle.get().generation)
    expect(hook.result.current.resource?.proof.ownerGeneration).toBeGreaterThan(original.proof.ownerGeneration)
    invalidate.mockRestore()
    hook.unmount()
    dispose()
  })

})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, dmConversationEntryFixture, conversationEntryTarget as target } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, ingestMessages, ingestReadStateSnapshot, publishAccountAttentionSnapshot } from "@/lib/community-db/sync"
import { conversationEntryOptions, currentConversationReadState, publishConversationEntry } from "@/lib/community/conversation-entry"
import { communityKeys } from "@/lib/query-keys"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { ConversationActivityContext } from "@/contexts/community/conversation-activity"
import { useConversationEntry } from "./use-conversation-entry"
import { useChannelMetadata } from "./use-channel-metadata"
import { useDmMessages, useMessages } from "./use-messages"
import { resolveMessageReadProjection } from "@/lib/community/message-read-projection"
import { useMessageListController } from "@/components/community/messages/message-list-controller"
import { VirtualRows } from "@/components/community/messages/virtual-cursor-list"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize } from "@/test/message-scroll-fixture"
import type { FlatItem } from "@/lib/community/message-list-items"
import { renderMessageListRow } from "@/components/community/messages/message-list-row"
import { confirmReadSurface, disposeReadCoordinator, getReadCoordinator, registerReadSurface, releaseReadSurface, submitReadIntentGeneration } from "./read-coordinator"
import { disposeAccountReadStateReconciliation } from "./community-ws/read-state-reconciliation"
import { getAccountUnreadProjection } from "./account-unread-projection"

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
  it("retains a parent's window and NEW through background and semantic resume, while a fresh entry reselects", async () => {
    const { wrapper: Owner, publish, registry } = await setup()
    const value = fixture()
    value.messages.push({ ...value.messages[0], id: "m2", seq: 2, content: "Second" })
    value.page.latestSeq = 2
    publish(value)
    let active = true
    const navigation = { entryIntent: { href: "/c/channels/s1/c1" } as { href: string; resume?: boolean } }
    function Wrapper({ children }: PropsWithChildren) {
      return createElement(Owner, null, createElement(CommunityRouteContext, { value: { navigation } as never },
        createElement(ConversationActivityContext, { value: active }, children)))
    }
    const hook = renderHook(() => useConversationEntry(target), { wrapper: Wrapper })
    const original = hook.result.current.window
    expect(original).not.toBeNull()
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    active = false
    navigation.entryIntent = { href: "/c/channels/s1/child" }
    hook.rerender()
    await act(async () => ingestReadStateSnapshot(registry, { revision: 5, readStates: [
      { channelId: "c1", lastReadMessageId: "m2", lastReadSeq: 2, lastReadAt: "later" },
    ] }))
    expect(hook.result.current.window).toBe(original)
    active = true
    navigation.entryIntent = { href: "/c/channels/s1/c1", resume: true }
    hook.rerender()
    expect(hook.result.current.window).toBe(original)
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    navigation.entryIntent = { href: "/c/channels/s1/c1" }
    hook.rerender()
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2")
    expect(load).not.toHaveBeenCalled()
  })

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
  it("verifies a newly selected revoked target but does not retry a later access withdrawal", async () => {
    const { wrapper, registry } = await setup()
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(({ selected }) => useConversationEntry(selected), {
      wrapper, initialProps: { selected: null as typeof target | null },
    })
    await act(async () => registry.runtime.ws.actions.revokeChannelAccess("s1", "c1"))
    hook.rerender({ selected: target })
    expect(hook.result.current.denied).toBe(false)
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => request.resolve(fixture()))
    await waitFor(() => expect(hook.result.current.canRead).toBe(true))
    await act(async () => registry.runtime.ws.actions.revokeChannelAccess("s1", "c1"))
    expect(hook.result.current.canRead).toBe(false)
    expect(hook.result.current.denied).toBe(true)
    expect(load).toHaveBeenCalledOnce()
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

describe("conversation entry return during accepted reading", () => {
  beforeEach(installMessageScrollFixture)
  afterEach(restoreMessageScrollFixture)

  async function readingOwner() {
    const owner = await setup()
    const value = fixture()
    value.messages = Array.from({ length: 42 }, (_, index) => ({
      ...value.messages[0], id: `m${index + 1}`, seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
    }))
    value.channel.messageCount = 42
    value.channel.lastMessageAt = value.messages[41].createdAt
    value.readState = { channelId: "c1", lastReadMessageId: "m30", lastReadSeq: 30, lastReadAt: value.messages[29].createdAt }
    value.selection = { reason: "read_pointer", anchorMessageId: "m30" }
    value.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }
    owner.publish(value)
    const put = deferred<{ changed: boolean; revision: number; targetSeq: number }>()
    const canonical = deferred<{ revision: number; readStates: typeof value.readState[] }>()
    load.mockImplementation((url: string) => {
      if (url === "/api/community/channels/c1/read") return put.promise
      if (url === "/api/community/users/me/read-state") return canonical.promise
      if (url === "/api/community/users/me/attention") return Promise.resolve({ scopes: [], items: [], limit: 100, truncated: false })
      throw new Error(`Unexpected reading transport ${url}`)
    })
    const coordinator = getReadCoordinator(owner.client, "viewer")
    const lease = registerReadSurface(owner.client, "viewer", { kind: "timeline", channelId: "c1" }, 30)
    const read42 = { ...value.readState, lastReadMessageId: "m42", lastReadSeq: 42, lastReadAt: value.messages[41].createdAt }
    const finish = async () => {
      disposeReadCoordinator(owner.client)
      disposeAccountReadStateReconciliation(owner.client)
      await act(async () => {
        put.resolve({ changed: true, revision: 5, targetSeq: 42 })
        canonical.resolve({ revision: 5, readStates: [read42] })
      })
    }
    return { ...owner, put, canonical, coordinator, lease, read42, finish,
      scope: () => coordinator.state.get().scopes.get("timeline:c1")!,
    }
  }

  function mountReadingEntry(owner: Awaited<ReturnType<typeof readingOwner>>, scrollToMessageId?: string) {
    let latest!: {
      feed: ReturnType<typeof useMessages>
      controller: ReturnType<typeof useMessageListController>
      newDividerBefore: string | undefined
    }
    function EntryList() {
      const feed = useMessages("c1", { serverId: "s1", viewerUserId: "viewer" })
      const projection = resolveMessageReadProjection({ messages: feed.messages,
        lastReadMessageId: feed.readSnapshot?.lastReadMessageId ?? null,
        viewerUserId: "viewer", anchorReconciled: feed.anchorReconciled,
      })
      const props = { channel: "Channel", messages: feed.messages,
        loading: feed.isLoading, initialLoadError: feed.initialLoadError,
        newDividerBefore: projection.newDividerBefore, scrollToMessageId,
        initialScrollReady: feed.initialPositionKnown,
        positionDataState: feed.positionDataState, positionEntry: feed.positionEntry, messageWindow: feed.messageWindow,
        hasMore: feed.hasMoreOlder, hasMoreNewer: feed.hasMoreNewer,
        historyStartKnown: feed.historyStartKnown,
        initialPositionMessageId: feed.initialPositionMessageId,
        isFetching: feed.isFetching, isFetchingOlder: feed.isFetchingOlder, isFetchingNewer: feed.isFetchingNewer,
        presentVersion: feed.presentVersion, variant: "channel" as const, hoverCapable: false,
        onOpenThread: () => undefined,
      }
      const controller = useMessageListController(props)
      latest = { feed, controller, newDividerBefore: projection.newDividerBefore }
      return createElement("div", { "data-slot": "community-conversation-surface" },
        createElement("div", { ref: controller.scrollRef, "data-testid": "community-message-scroller" },
          createElement("div", { "data-message-list-content": "", "data-read-position-ready": String(controller.readPositionReady) },
            createElement(VirtualRows<FlatItem>, {
              items: controller.items, virtualizer: controller.virtualizer, reactLayout: true,
              onLayoutCommit: controller.onRowsLayoutCommit,
              renderItem: (item, index) => item.kind === "leading" ? renderMessageListRow(item, props, controller, index) : createElement("div", {
                "data-message-row-key": item.key, "data-fixture-kind": item.kind,
                "data-fixture-date": String(item.kind === "divider" && !!item.dateLabel),
                "data-message-divider-for": item.kind === "divider" ? item.messageId : undefined,
              }, item.kind === "message" ? createElement("div", { "data-msg-id": item.m.id }) :
                item.kind === "divider" && item.newDivider ? createElement("div", { "data-new-divider": "" }) : null),
            }))),
        createElement("div", { "data-slot": "community-conversation-footer" }))
    }
    const view = render(createElement(EntryList), { wrapper: owner.wrapper })
    const root = view.getByTestId("community-message-scroller")
    resize()
    const visible = (id: string) => {
      const row = root.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
      if (!row) return false
      const rect = row.getBoundingClientRect(), viewport = root.getBoundingClientRect()
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom
    }
    return { view, root, visible, get latest() { return latest } }
  }

  it.each([30, 42])("reveals cached reading at %s through a slow real entry without granting reads or following late NEW", async readSeq => {
    const owner = await readingOwner()
    const held = deferred<ReturnType<typeof fixture>>()
    const fresh = fixture()
    fresh.messages = Array.from({ length: 45 }, (_, index) => ({ ...fresh.messages[0],
      id: `m${index + 1}`, seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
    }))
    const readState = { channelId: "c1", lastReadMessageId: `m${readSeq}`, lastReadSeq: readSeq, lastReadAt: fresh.messages[readSeq - 1].createdAt }
    fresh.readState = readState
    fresh.readStateRevision = 5
    fresh.selection = { reason: "read_pointer", anchorMessageId: `m${readSeq}` }
    fresh.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 45 }
    await act(async () => {
      ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [readState] })
      publishAccountAttentionSnapshot(owner.client, {
        snapshot: { scopes: [{ scopeId: "c1", channelId: "c1", serverId: "s1",
          ordinaryUnread: true, lastUnreadSeq: 45, lastAttentionSeq: null, attentionCount: 0 }], items: [], limit: 100, truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } },
        proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined },
      })
    })
    const oldLoad = load.getMockImplementation()!
    load.mockImplementation((url: string, options: unknown) => url.includes("/messages") ? held.promise : oldLoad(url, options))
    const view = mountReadingEntry(owner)
    try {
      await act(async () => vi.advanceTimersByTimeAsync(0))
      resize()
      expect(view.latest.feed.readSnapshotFetching).toBe(true)
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.controller.initialPosition.contentVisible).toBe(true)
      expect(view.latest.controller.readPositionReady).toBe(false)
      expect(view.latest.controller.paginationEnabled).toBe(false)
      const anchor = [...view.root.querySelectorAll<HTMLElement>("[data-msg-id]")]
        .find(row => row.getBoundingClientRect().bottom > 0)!
      const before = anchor.getBoundingClientRect().top
      const id = anchor.dataset.msgId!
      await act(async () => vi.advanceTimersByTimeAsync(6500))
      resize()
      expect(view.latest.controller.initialPosition.contentVisible).toBe(true)
      expect(load.mock.calls.some(([url, options]) => url === "/api/community/channels/c1/read" && options?.method === "PUT")).toBe(false)
      await act(async () => held.resolve(fresh))
      await act(async () => vi.advanceTimersByTimeAsync(0))
      resize()
      expect(view.root.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!.getBoundingClientRect().top).toBeCloseTo(before, 0)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(readSeq)
      expect(view.latest.newDividerBefore).toBe(`m${readSeq + 1}`)
      expect(view.latest.controller.initialPosition.contentVisible).toBe(true)
    } finally {
      view.view.unmount()
      held.resolve(fresh)
      releaseReadSurface(owner.lease)
      await owner.finish()
    }
  })

  it.each(["before PUT confirmation", "after PUT before canonical publication", "after ACK and failed canonical readback"] as const)(
    "keeps accepted local reading in the returned viewport %s without confirming the entry snapshot", async boundary => {
      const owner = await readingOwner()
      const first = mountReadingEntry(owner)
      let returned: ReturnType<typeof mountReadingEntry> | undefined
      try {
        expect(first.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
        act(() => first.latest.controller.pillOnClick())
        resize()
        expect(first.latest.controller.readPositionReady).toBe(true)
        expect(first.visible("m42")).toBe(true)
        const generation = submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })
        expect(generation).not.toBeNull()
        expect(owner.scope().accepted?.intent).toEqual({ kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })
        getAccountUnreadProjection(owner.client, "viewer").recordOptimisticRead("c1", 42, generation!)
        expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m31", seq: 31 })).toBeNull()
        first.view.unmount()
        releaseReadSurface(owner.lease)
        await act(async () => vi.advanceTimersByTimeAsync(0))
        expect(load).toHaveBeenCalledWith("/api/community/channels/c1/read", expect.objectContaining({
          method: "PUT", body: JSON.stringify({ lastReadMessageId: "m42" }),
        }))
        expect(owner.scope().inFlight?.phase).toBe("mutation")
        if (boundary !== "before PUT confirmation") {
          await act(async () => owner.put.resolve({ changed: true, revision: 5, targetSeq: 42 }))
          expect(load.mock.calls.some(([url]) => url === "/api/community/users/me/read-state")).toBe(true)
          expect(owner.scope().inFlight?.phase).toBe("reconciling")
          expect(owner.scope().confirmedSeq).toBe(42)
          if (boundary === "after ACK and failed canonical readback") {
            await act(async () => owner.canonical.reject(new Error("canonical readback unavailable")))
            expect(owner.scope().inFlight).toBeNull()
            expect(owner.scope().accepted).toBeNull()
            expect(owner.scope().dirty).toBeNull()
          }
        } else {
          expect(owner.scope().confirmedSeq).toBe(30)
          expect(load.mock.calls.some(([url]) => url === "/api/community/users/me/read-state")).toBe(false)
        }
        expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(30)
        returned = mountReadingEntry(owner)
        expect(returned.latest.feed.messages).toHaveLength(42)
        expect(returned.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
        expect(returned.latest.newDividerBefore).toBe("m31")
        expect(returned.latest.controller.readPositionReady).toBe(true)
        expect(returned.visible("m42")).toBe(true)
        const offset = returned.root.scrollTop, captured = returned.latest.feed.readSnapshot
        await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 6, readStates: [owner.read42] }))
        resize()
        expect(returned.latest.feed.readSnapshot).toBe(captured)
        expect(returned.root.scrollTop).toBe(offset)
      } finally {
        first.view.unmount()
        returned?.view.unmount()
        await owner.finish()
      }
    },
  )

  it("reads a qualified covering window when the accepted target survives only as a canonical entity", async () => {
    const owner = await readingOwner()
    const originalKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m30" })
    const originalWindow = owner.client.getQueryData<import("@/lib/community/message-window").MessageWindowData>(originalKey)!
    const entryRead = deferred<ReturnType<typeof fixture>>()
    const originalLoad = load.getMockImplementation()!
    let view: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      owner.client.setQueryData(originalKey, { ...originalWindow, pages: originalWindow.pages.map(page => ({ ...page,
        messages: page.messages.filter(message => message.id !== "m42"), hasMoreNewer: true,
      })) })
      const retainedWindow = owner.client.getQueryData(originalKey)
      expect(owner.registry.collections.messages.get("m42")?.seq).toBe(42)
      load.mockImplementation((url: string, options: unknown) => url.includes("/messages?entry=1") ? entryRead.promise : originalLoad(url, options))
      view = mountReadingEntry(owner)
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(load.mock.calls.some(([url]) => url === "/api/community/channels/c1/messages?entry=1&anchor=m42")).toBe(true)
      const fresh = fixture()
      fresh.messages = Array.from({ length: 23 }, (_, index) => ({ ...fresh.messages[0], id: `m${index + 20}`, seq: index + 20,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 20)).toISOString(),
      }))
      fresh.readState = { channelId: "c1", lastReadMessageId: "m30", lastReadSeq: 30, lastReadAt: fresh.messages.find(message => message.id === "m30")!.createdAt }
      fresh.selection = { reason: "explicit_anchor", anchorMessageId: "m42" }
      fresh.page = { ...fresh.page, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 42 }
      await act(async () => entryRead.resolve(fresh))
      expect(view.latest.feed.error).toBeNull()
      resize()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.initialPositionMessageId).toBe("m42")
      expect(view.visible("m42")).toBe(true)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
      expect(owner.client.getQueryData(originalKey)).toBe(retainedWindow)
      expect(view.latest.feed.historyStartKnown).toBe(false)
    } finally { view?.view.unmount(); releaseReadSurface(owner.lease); await owner.finish() }
  })

  function evictOrdinaryEntryWithAlternateCoverage(owner: Awaited<ReturnType<typeof readingOwner>>) {
    const alternateTarget = { ...target, anchorMessageId: "m42" }
    const alternate = fixture()
    alternate.messages = [{ ...alternate.messages[0], id: "m42", seq: 42, createdAt: owner.read42.lastReadAt! }]
    alternate.channel.messageCount = 42
    alternate.readState = { channelId: "c1", lastReadMessageId: "m30", lastReadSeq: 30, lastReadAt: "2026-10-01T00:00:30.000Z" }
    alternate.selection = { reason: "explicit_anchor", anchorMessageId: "m42" }
    alternate.page = { ...alternate.page, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 42 }
    const alternateResource = publishConversationEntry(owner.client, alternateTarget, alternate,
      { token: captureCommunityLiveSnapshotToken(owner.client, "c1") })
    const alternateKey = conversationEntryOptions(owner.client, alternateTarget).queryKey
    owner.client.setQueryData(alternateKey, alternateResource)
    const retainedWindow = owner.client.getQueryData(alternateResource.windowKey)
    expect(retainedWindow).toBeDefined()
    const ordinaryKey = conversationEntryOptions(owner.client, target).queryKey
    owner.client.removeQueries({ queryKey: ordinaryKey, exact: true })
    owner.client.removeQueries({ queryKey: communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m30" }), exact: true })
    return { alternate, alternateResource, alternateKey, retainedWindow, ordinaryKey }
  }

  it.each([true, false])("uses alternate entry coverage after ordinary entry eviction only with qualification: %s", async qualified => {
    const owner = await readingOwner()
    const { alternate, alternateResource, alternateKey, retainedWindow, ordinaryKey } = evictOrdinaryEntryWithAlternateCoverage(owner)
    if (!qualified) owner.client.removeQueries({ queryKey: alternateKey, exact: true })
    expect(owner.client.getQueryData(ordinaryKey)).toBeUndefined()
    expect(owner.client.getQueryData(alternateKey)).toBe(qualified ? alternateResource : undefined)
    expect(owner.registry.collections.messages.get("m42")?.seq).toBe(42)
    const response = qualified ? fixture() : alternate
    if (qualified) {
      response.messages = [{ ...response.messages[0], id: "m30", seq: 30, createdAt: alternate.readState.lastReadAt! }]
      response.channel.messageCount = 42
      response.readState = alternate.readState
      response.selection = { reason: "read_pointer", anchorMessageId: "m30" }
      response.page = { ...response.page, hasMoreOlder: true, hasMoreNewer: true, latestSeq: 42 }
    }
    const entryRead = deferred<ReturnType<typeof fixture>>()
    const originalLoad = load.getMockImplementation()!
    const expectedRequest = `/api/community/channels/c1/messages?entry=1${qualified ? "" : "&anchor=m42"}`
    load.mockImplementation((url: string, options: unknown) => {
      if (!url.includes("/messages?entry=1")) return originalLoad(url, options)
      if (url !== expectedRequest) throw new Error(`Unexpected entry coverage request ${url}`)
      return entryRead.promise
    })
    let view: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      view = mountReadingEntry(owner)
      expect(view.latest.feed.initialPositionKnown).toBe(qualified)
      if (qualified) {
        expect(view.latest.feed.initialPositionMessageId).toBe("m42")
        expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
        expect(view.latest.controller.readPositionReady).toBe(true)
        expect(view.visible("m42")).toBe(true)
        expect(view.latest.feed.readSnapshotFetching).toBe(false)
      }
      const capturedSnapshot = view.latest.feed.readSnapshot, capturedOffset = view.root.scrollTop
      expect(load.mock.calls.filter(([url]) => url.includes("/messages?entry=1")).map(([url]) => url)).toEqual([expectedRequest])
      await act(async () => entryRead.resolve(response))
      resize()
      expect(view.latest.feed.error).toBeNull()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.initialPositionMessageId).toBe("m42")
      expect(view.latest.feed.messages.map(message => message.id)).toEqual(["m42"])
      expect(view.visible("m42")).toBe(true)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
      expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(30)
      expect(owner.client.getQueryData(alternateResource.windowKey)).toBe(retainedWindow)
      expect(view.latest.feed.historyStartKnown).toBe(false)
      expect(load.mock.calls.filter(([url]) => url.includes("/messages?entry=1")).map(([url]) => url)).toEqual([expectedRequest])
      if (qualified) {
        expect(view.latest.feed.readSnapshot).toBe(capturedSnapshot)
        expect(view.root.scrollTop).toBe(capturedOffset)
        await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [owner.read42] }))
        resize()
        expect(view.latest.feed.readSnapshot).toBe(capturedSnapshot)
        expect(view.root.scrollTop).toBe(capturedOffset)
        expect(view.visible("m42")).toBe(true)
      }
    } finally {
      view?.view.unmount()
      entryRead.resolve(response)
      releaseReadSurface(owner.lease)
      await owner.finish()
    }
  })

  it.each([42, 100])("uses the higher canonical target %i with qualified cached coverage or its actual read", async seq => {
    const owner = await readingOwner()
    const { alternate, alternateResource, retainedWindow } = evictOrdinaryEntryWithAlternateCoverage(owner)
    const read = { channelId: "c1", lastReadMessageId: `m${seq}`, lastReadSeq: seq,
      lastReadAt: seq === 42 ? owner.read42.lastReadAt : "2026-10-01T00:01:40.000Z" }
    const response = { ...alternate, readState: read, readStateRevision: 5,
      selection: { reason: "read_pointer" as const, anchorMessageId: read.lastReadMessageId },
      messages: [{ ...alternate.messages[0], id: read.lastReadMessageId, seq, createdAt: read.lastReadAt! }],
      page: { ...alternate.page, latestSeq: seq } }
    const entryRead = deferred<ReturnType<typeof fixture>>()
    const originalLoad = load.getMockImplementation()!
    const expectedRequest = "/api/community/channels/c1/messages?entry=1"
    load.mockImplementation((url: string, options: unknown) => {
      if (!url.includes("/messages?entry=1")) return originalLoad(url, options)
      if (url !== expectedRequest) throw new Error(`Unexpected canonical entry request ${url}`)
      return entryRead.promise
    })
    let view: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [read] }))
      view = mountReadingEntry(owner)
      expect(view.latest.feed.initialPositionKnown).toBe(seq === 42)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      if (seq === 42) {
        expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(42)
        expect(view.visible("m42")).toBe(true)
        expect(view.latest.controller.readPositionReady).toBe(true)
      } else {
        expect(view.latest.feed.readSnapshot).toBeNull()
        expect(view.latest.controller.readPositionReady).toBe(false)
      }
      expect(load.mock.calls.filter(([url]) => url.includes("/messages?entry=1")).map(([url]) => url)).toEqual([expectedRequest])
      await act(async () => entryRead.resolve(response))
      resize()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(seq)
      expect(view.visible(read.lastReadMessageId)).toBe(true)
      expect(owner.client.getQueryData(alternateResource.windowKey)).toBe(retainedWindow)
      expect(load.mock.calls.filter(([url]) => url.includes("/messages?entry=1")).map(([url]) => url)).toEqual([expectedRequest])
    } finally {
      view?.view.unmount()
      entryRead.resolve(response)
      releaseReadSurface(owner.lease)
      await owner.finish()
    }
  })

  it("keeps canonical NEW when no reading was accepted, then leaves that active entry frozen after canonical publication", async () => {
    const owner = await readingOwner()
    const first = mountReadingEntry(owner)
    let returned: ReturnType<typeof mountReadingEntry> | undefined
    try {
      act(() => first.latest.controller.pillOnClick())
      resize()
      expect(first.visible("m42")).toBe(true)
      expect(owner.scope().accepted).toBeNull()
      first.view.unmount()
      releaseReadSurface(owner.lease)
      await act(async () => vi.advanceTimersByTimeAsync(0))
      returned = mountReadingEntry(owner)
      expect(returned.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
      expect(returned.latest.newDividerBefore).toBe("m31")
      expect(returned.visible("m31")).toBe(true)
      expect(returned.visible("m42")).toBe(false)
      expect(load).not.toHaveBeenCalled()
      const captured = returned.latest.feed.readSnapshot, offset = returned.root.scrollTop
      await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [owner.read42] }))
      resize()
      expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(42)
      expect(returned.latest.feed.readSnapshot).toBe(captured)
      expect(returned.latest.newDividerBefore).toBe("m31")
      expect(returned.root.scrollTop).toBe(offset)
    } finally {
      first.view.unmount()
      returned?.view.unmount()
      await owner.finish()
    }
  })

  it.each(["covering response", "canonical publication before the covering response"] as const)("takes higher progress from %s through its own qualified window", async boundary => {
    const owner = await readingOwner()
    const previousKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m30" })
    const previous = owner.client.getQueryData<import("@/lib/community/message-window").MessageWindowData>(previousKey)!
    const localRead = deferred<ReturnType<typeof fixture>>(), canonicalRead = deferred<ReturnType<typeof fixture>>()
    let view: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      owner.client.setQueryData(previousKey, { ...previous, pages: previous.pages.map(page => ({ ...page, messages: page.messages.filter(message => message.id !== "m42"), hasMoreNewer: true })) })
      const oldLoad = load.getMockImplementation()!
      load.mockImplementation((url: string, options: unknown) => url === "/api/community/channels/c1/messages?entry=1&anchor=m42" ? localRead.promise
        : url === "/api/community/channels/c1/messages?entry=1" ? canonicalRead.promise : oldLoad(url, options))
      view = mountReadingEntry(owner)
      const higher = { channelId: "c1", lastReadMessageId: "m100", lastReadSeq: 100, lastReadAt: "2026-10-01T00:01:40.000Z" }
      const aroundLocal = fixture()
      aroundLocal.messages = [{ ...aroundLocal.messages[0], id: "m42", seq: 42 }]
      aroundLocal.readState = boundary === "covering response" ? higher : { ...aroundLocal.readState, lastReadMessageId: "m30", lastReadSeq: 30 }
      aroundLocal.readStateRevision = boundary === "covering response" ? 5 : 4
      aroundLocal.selection = { reason: "explicit_anchor", anchorMessageId: "m42" }
      aroundLocal.page = { ...aroundLocal.page, hasMoreOlder: true, hasMoreNewer: true, latestSeq: 100 }
      await act(async () => {
        if (boundary !== "covering response") ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [higher] })
        localRead.resolve(aroundLocal)
      })
      resize()
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(load.mock.calls.some(([url]) => url === "/api/community/channels/c1/messages?entry=1")).toBe(true)
      const aroundCanonical = fixture()
      aroundCanonical.messages = [{ ...aroundCanonical.messages[0], id: "m100", seq: 100, createdAt: higher.lastReadAt }]
      aroundCanonical.readState = higher
      aroundCanonical.readStateRevision = 5
      aroundCanonical.selection = { reason: "read_pointer", anchorMessageId: "m100" }
      aroundCanonical.page = { ...aroundCanonical.page, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 100 }
      await act(async () => canonicalRead.resolve(aroundCanonical))
      resize()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(100)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.visible("m100")).toBe(true)
    } finally { view?.view.unmount(); releaseReadSurface(owner.lease); await owner.finish() }
  })

  it("allows an explicit older viewport target without lowering accepted or confirmed reading", async () => {
    const owner = await readingOwner()
    let entry: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      confirmReadSurface(owner.lease, 29)
      expect(owner.scope().confirmedSeq).toBe(30)
      entry = mountReadingEntry(owner, "m12")
      expect(entry.visible("m12")).toBe(true)
      expect(owner.scope().dirty?.intent.seq).toBe(42)
      confirmReadSurface(owner.lease, 42)
      confirmReadSurface(owner.lease, 31)
      expect(owner.scope().confirmedSeq).toBe(42)
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m31", seq: 31 })).toBeNull()
      expect(entry.visible("m12")).toBe(true)
    } finally {
      entry?.view.unmount()
      releaseReadSurface(owner.lease)
      await owner.finish()
    }
  })

  it("uses higher canonical reading for a fresh entry instead of an older local target", async () => {
    const owner = await readingOwner()
    let view: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m31", seq: 31 })).not.toBeNull()
      await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [owner.read42] }))
      view = mountReadingEntry(owner)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(42)
      expect(view.latest.newDividerBefore).toBeUndefined()
      expect(view.visible("m42")).toBe(true)
      expect(load).not.toHaveBeenCalled()
    } finally { view?.view.unmount(); releaseReadSurface(owner.lease); await owner.finish() }
  })

  it.each(["seq=12", "msg=m12"])("leaves explicit route %s ahead of the local landing", async search => {
    const owner = await readingOwner(), Owner = owner.wrapper
    const navigation = { entryIntent: { href: `/c/channels/s1/c1?${search}` } }
    function Wrapper({ children }: PropsWithChildren) {
      return createElement(Owner, null, createElement(CommunityRouteContext, { value: { navigation } as never }, children))
    }
    const view = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper: Wrapper })
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      navigation.entryIntent = { href: `/c/channels/s1/c1?${search}` }
      view.rerender()
      expect(view.result.current.initialPositionMessageId).toBeNull()
      expect(view.result.current.readSnapshot?.lastReadSeq).toBe(30)
      expect(owner.scope().dirty?.intent.seq).toBe(42)
      expect(load).not.toHaveBeenCalled()
    } finally { view.unmount(); releaseReadSurface(owner.lease); await owner.finish() }
  })

  it("does not claim the beginning from a live row before the selected history window is known", async () => {
    const owner = await readingOwner()
    const entryRead = deferred<ReturnType<typeof fixture>>()
    const previousKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m30" })
    const previousWindow = owner.client.getQueryData(previousKey)
    expect(previousWindow).toBeDefined()
    const fresh = fixture()
    fresh.messages = Array.from({ length: 22 }, (_, index) => ({
      ...fresh.messages[0], id: `m${index + 59}`, seq: index + 59,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 59)).toISOString(),
    }))
    const read60 = { channelId: "c1", lastReadMessageId: "m60", lastReadSeq: 60, lastReadAt: fresh.messages[1].createdAt }
    fresh.readState = read60
    fresh.readStateRevision = 5
    fresh.selection = { reason: "read_pointer", anchorMessageId: "m60" }
    fresh.channel.messageCount = 80
    fresh.channel.lastMessageAt = fresh.messages.at(-1)!.createdAt
    fresh.page = { olderCursor: "older", newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 }
    await act(async () => {
      ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [read60] })
      ingestMessages(owner.registry, "c1", [{ ...fresh.messages.at(-1)!, resourceComplete: true }])
      owner.runtime.messageStream.actions.dispatch({ kind: "channel", id: "c1", serverId: "s1" }, {
        type: "wsMessage", message: fresh.messages.at(-1)!,
      })
    })
    load.mockImplementation((url: string) => {
      if (url === "/api/community/channels/c1/messages?entry=1") return entryRead.promise
      throw new Error(`Unexpected history transport ${url}`)
    })
    const view = mountReadingEntry(owner)
    try {
      expect(view.latest.feed.messages.map(message => message.id)).toEqual(["m80"])
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(owner.client.getQueryData(previousKey)).toBe(previousWindow)
      expect(view.latest.feed.readSnapshot).toBeNull()
      expect(view.latest.feed.isLoading).toBe(true)
      expect(view.latest.controller.initialPosition.contentVisible).toBe(false)
      expect(view.latest.controller.initialPosition.showSkeleton).toBe(true)
      expect(view.latest.controller.readPositionReady).toBe(false)
      expect(view.latest.feed.hasMoreOlder).toBe(false)
      expect.soft(view.root.textContent).not.toContain("Beginning of the channel")
      await act(async () => entryRead.resolve(fresh))
      resize()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.hasMoreOlder).toBe(true)
      expect(owner.client.getQueryData(previousKey)).toBe(previousWindow)
      expect(view.latest.feed.messages.map(message => message.id)).toEqual(fresh.messages.map(message => message.id))
      expect(view.root.textContent).not.toContain("Beginning of the channel")
    } finally {
      view.view.unmount()
      entryRead.resolve(fresh)
      releaseReadSurface(owner.lease)
      await owner.finish()
    }
  })
})


describe("native entry freshness with authoritative newer attention", () => {
  it.each([["channel", false, false], ["channel", true, false], ["dm", false, false], ["dm", true, false], ["channel", true, true], ["dm", true, true]] as const)("keeps cached %s content while respecting newer=%s, explicit anchor=%s", async (kind, newer, explicitAnchor) => {
    const { client, registry, wrapper } = await setup()
    const packet = kind === "dm" ? dmConversationEntryFixture() : fixture()
    const selectedTarget = { channelId: packet.channelId, serverId: packet.channel.serverId, ...(explicitAnchor ? { anchorMessageId: "m1" } : {}) }
    if (explicitAnchor) packet.selection = { reason: "explicit_anchor", anchorMessageId: "m1" }
    load.mockResolvedValueOnce(packet)
    const original = await client.query(conversationEntryOptions(client, selectedTarget))
    expect(client.getQueryCache().find({ queryKey: original.windowKey, exact: true })?.isActive()).toBe(false)
    load.mockClear()
    publishAccountAttentionSnapshot(client, {
      snapshot: { scopes: [{ scopeId: packet.channelId, channelId: packet.channelId, serverId: packet.channel.serverId,
        ordinaryUnread: newer, lastUnreadSeq: newer ? 2 : 1, lastAttentionSeq: null, attentionCount: 0 }], items: [], limit: 100, truncated: false,
        included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } },
      proof: { token: captureCommunityLiveSnapshotToken(client), signal: undefined },
    })
    const held = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useConversationEntry(selectedTarget), { wrapper })
    const selected = hook.result.current.window
    expect(selected).not.toBeNull()
    expect(hook.result.current.isPending).toBe(false)
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(original.windowKey)?.pages[0].messages.map(row => row.id)).toEqual(["m1"])
    if (!newer || explicitAnchor) {
      await act(async () => { await Promise.resolve() })
      expect(load).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(load).toHaveBeenCalledOnce())
      expect(load.mock.calls[0][0]).toBe("/api/community/channels/c1/messages?entry=1")
      expect(hook.result.current.window).toBe(selected)
      const fresh = { ...packet, channel: { ...packet.channel, messageCount: 2 }, messages: [...packet.messages, { ...packet.messages[0], id: "m2", seq: 2, content: "New message" }], page: { ...packet.page, latestSeq: 2 } }
      await act(async () => { held.resolve(fresh) })
      await waitFor(() => expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(original.windowKey)?.pages.flatMap(page => page.messages.map(row => row.id))).toContain("m2"))
      expect(hook.result.current.window).toBe(selected)
      expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
      expect(load.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true)
    }
    expect(registry.collections.readStates.get(packet.channelId)?.lastReadSeq).toBe(1)
    hook.unmount()
  })

  it.each(["cancel", "replacement", "account", "access"] as const)("retires an entry-owned repair before a message observer exists on %s", async (reason) => {
    const { client, registry } = await setup()
    const options = conversationEntryOptions(client, target)
    load.mockResolvedValueOnce(fixture())
    const original = await client.query(options)
    const window = client.getQueryCache().find({ queryKey: original.windowKey, exact: true })!
    expect(window.isActive()).toBe(false)
    const before = client.getQueryData(original.windowKey)
    const newer = fixture()
    newer.page.latestSeq = 2
    newer.page.hasMoreNewer = true
    newer.page.newerCursor = "next"
    const held = deferred<unknown>()
    let signal: AbortSignal | undefined
    load.mockImplementation((url: string, request: { signal: AbortSignal }) => {
      if (url.includes("entry=1")) return Promise.resolve(newer)
      signal = request.signal
      return held.promise
    })
    const result = client.query({ ...options, staleTime: 0 }).catch((error: unknown) => error)
    await waitFor(() => expect(signal).toBeDefined())
    expect(window.isActive()).toBe(false)
    await act(async () => {
      if (reason === "cancel") await client.cancelQueries({ queryKey: options.queryKey, exact: true })
      else if (reason === "replacement") client.removeQueries({ queryKey: options.queryKey, exact: true })
      else if (reason === "account") registry.runtime.ws.actions.activateProfileAccount("other")
      else registry.runtime.ws.actions.revokeChannelAccess("s1", "c1")
    })
    if (reason === "cancel" || reason === "replacement") expect(signal?.aborted).toBe(true)
    await act(async () => {
      held.resolve({ messages: [{ ...newer.messages[0], id: "m2", seq: 2 }], latestSeq: 2, hasMoreNewer: false })
      await result
    })
    expect(client.getQueryData(original.windowKey)).toBe(before)
    expect(registry.collections.messages.has("m2")).toBe(false)
  })
})

import "fake-indexeddb/auto"
import { MessageList } from "@/components/community/messages/message-list"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { createCommunityRestorePersister, createIdbPersister, clearPersistedCache, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "@/lib/query-persister"
import { discardCommunityRestoreReplacements, restoreCommunityCollections, publishCommunityForumFeed } from "@/lib/community-db/sync"
import { channelResourceFixture, messageResourceFixture, forumFeedScenarioFixture } from "@/test/community-resource-fixtures"
import { forumFeedWindow, normalizeThreadResources } from "@/lib/community/forum-feed-window"
import { CommunityChannelResourceSchema, CommunityResourceProfileSchema } from "@alook/shared"
import { conversationEntryFromChannel, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { resourceBundleFixture, fullResourceBundleFixture, serverResourceFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type PropsWithChildren } from "react"
import { dehydrate, IsRestoringProvider, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, dmConversationEntryFixture, forumConversationEntryFixture, conversationEntryTarget as target } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, publishCommunityResourceBundle, publishCommunityMessages, ingestMessages, ingestReadStateSnapshot, publishAccountAttentionSnapshot } from "@/lib/community-db/sync"
import { conversationEntryOptions, currentConversationReadState, publishConversationEntry } from "@/lib/community/conversation-entry"
import { communityKeys } from "@/lib/query-keys"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { ConversationActivityContext } from "@/contexts/view-activity"
import { reconcileWindow } from "@/lib/community/message-reconcile"
import { useConversationEntry } from "./use-conversation-entry"
import { useChannelMetadata } from "./use-channel-metadata"
import { useDmMessages, useMessages } from "./use-messages"
import { useForumFeed } from "./use-forum-feed"
import { useMessageListController } from "@/components/community/messages/message-list-controller"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize } from "@/test/message-scroll-fixture"
import { renderMessageListRow } from "@/components/community/messages/message-list-row"
import { confirmReadSurface, disposeReadCoordinator, getReadCoordinator, registerReadSurface, releaseReadSurface, submitReadIntentGeneration } from "./read-coordinator"
import { disposeAccountReadStateReconciliation } from "./community-ws/read-state-reconciliation"
import { PERSIST_BUSTER, readCommunityRestoredCollections } from "@/lib/query-persister"
import { restoreConversationDisplayWindows } from "@/lib/community/restored-conversation-window"
import { writeCommunityCollectionChanges } from "@/lib/community-db/write"

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
  const publish = async (value = fixture()) => {
    const options = conversationEntryOptions(owner.client, target)
    const resource = await publishConversationEntry(owner.client, target, value, { token: captureCommunityLiveSnapshotToken(owner.client, target.channelId) })
    owner.client.setQueryData(options.queryKey, resource)
    return resource
  }
  return { ...owner, wrapper, publish }
}

describe("conversation entry selection", () => {
  it.each(["row", "clock only"] as const)("keeps a restored display stable with a %s read snapshot while entry is held", async pointer => {
    const { client, registry, wrapper, publish } = await setup()
    const packet = fixture()
    await publish(packet)
    if (pointer === "clock only") {
      await writeCommunityCollectionChanges(registry, "readStates", [], ["c1"])
      await writeCommunityCollectionChanges(registry, "readStateClock", [{ id: "account", revision: 4 }])
      expect(currentConversationReadState(client, "c1")).toMatchObject({ lastReadSeq: 0, observedRevision: 4 })
    }
    const restored = readCommunityRestoredCollections({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) }, "viewer")
    client.removeQueries({ queryKey: communityKeys.channelMessages("c1") })
    client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    restoreConversationDisplayWindows(registry, restored)
    const held = deferred<typeof packet>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["m1"])
    expect(hook.result.current.initialPositionKnown).toBe(false)
    expect(hook.result.current.readSnapshotFetching).toBe(true)
    if (pointer === "clock only") packet.newBoundary = { afterSeq: 0, target: { id: "m1", seq: 1, channelId: "c1", authorId: "peer" } }
    await act(async () => held.resolve(packet))
    await waitFor(() => expect(hook.result.current.initialPositionKnown).toBe(true))
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["m1"])
    expect(hook.result.current.readSnapshotFetching).toBe(false)
    expect(load.mock.calls.filter(([url]) => String(url).includes("entry=1"))).toHaveLength(1)
  })

  it.each([
    { kind: "text", useSurface: function useText() { return useMessages("c1", { serverId: "s1" }) } },
    { kind: "dm", useSurface: function useDm() { return useDmMessages("c1") } },
  ])("keeps a qualified local $kind window readable before this document confirms its account", async ({ kind, useSurface }) => {
    const { registry, client, wrapper } = await setup()
    const value = kind === "dm" ? dmConversationEntryFixture() : fixture()
    const destination = { channelId: "c1", serverId: value.channel.serverId }
    const resource = await publishConversationEntry(client, destination, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    client.setQueryData(conversationEntryOptions(client, destination).queryKey, resource)
    registry.bindAuthentication(() => undefined, async () => {})
    const local = renderHook(useSurface, { wrapper })
    await waitFor(() => expect(local.result.current.messages.map(message => message.id)).toEqual(["m1"]))
    expect(local.result.current.navigationBlocked).toBe(false)
    expect(client.getQueryData(resource.windowKey)).toBeDefined()
    expect(() => registry.assertOnlineAccount()).toThrow(expect.objectContaining({ name: "AbortError" }))
    await expect(client.query({ ...conversationEntryOptions(client, destination), staleTime: 0, retry: false })).rejects.toMatchObject({ name: "AbortError" })
    expect(local.result.current.messages.map(message => message.id)).toEqual(["m1"])
  })

  it("waits for a refreshing warm null boundary and preserves the captured cutoff across ACK", async () => {
    const owner = await setup()
    const old = fixture()
    const resource = await owner.publish(old)
    owner.client.setQueryData(conversationEntryOptions(owner.client, target).queryKey, resource, { updatedAt: Date.now() - 6000 })
    const held = deferred<typeof old>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper: owner.wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["m1"])
    expect(hook.result.current.newBoundary).toBeUndefined()
    expect(new URL(load.mock.calls[0][0], "https://test.invalid").searchParams.get("newAfterSeq")).toBe("1")
    const fresh = fixture()
    fresh.messages = [...fresh.messages, { ...fresh.messages[0], id: "m2", seq: 2 }]
    fresh.page = { ...fresh.page, latestSeq: 2 }
    fresh.readState = { ...fresh.readState, lastReadMessageId: "m2", lastReadSeq: 2 }
    fresh.readStateRevision = 5
    fresh.newBoundary = { afterSeq: 1, target: { id: "m2", seq: 2, channelId: "c1", authorId: "peer" } }
    await act(async () => held.resolve(fresh))
    await waitFor(() => expect(hook.result.current.newBoundary?.target?.id).toBe("m2"))
    await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 6, readStates: [{ ...fresh.readState, lastReadSeq: 3, lastReadMessageId: "m3", lastReadAt: "2026-10-01T00:00:03.000Z" }] }))
    expect(hook.result.current.newBoundary).toEqual(fresh.newBoundary)
    expect(load.mock.calls.filter(([url]) => String(url).includes("entry=1"))).toHaveLength(1)
    hook.unmount()
    owner.client.clear()
  })

  it("offers entry Retry after warm New metadata fails while leaving the current messages readable", async () => {
    const owner = await setup()
    const packet = fixture()
    const resource = await owner.publish(packet)
    owner.client.setQueryData(conversationEntryOptions(owner.client, target).queryKey, resource, { updatedAt: Date.now() - 6000 })
    load.mockRejectedValueOnce(new ConversationReadTimeoutError()).mockResolvedValue(packet)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper: owner.wrapper })
    await waitFor(() => expect(hook.result.current.targetLoadError).toBeInstanceOf(ConversationReadTimeoutError))
    expect(hook.result.current.initialDisplayReady).toBe(true)
    expect(hook.result.current.newBoundary).toBeUndefined()
    act(() => hook.result.current.retryInitialLoad())
    await waitFor(() => expect(hook.result.current.newBoundary).toEqual({ afterSeq: 1, target: null }))
    expect(hook.result.current.targetLoadError).toBeNull()
    expect(load.mock.calls.filter(([url]) => String(url).includes("entry=1"))).toHaveLength(2)
    hook.unmount()
    owner.client.clear()
  })

  it("keeps takeover on its original entry and retires that selection on a fresh navigation", async () => {
    const { client, wrapper: Owner, publish, registry } = await setup()
    const old = fixture()
    const original = await publish(old)
    const fresh = fixture()
    fresh.messages = [{ ...fresh.messages[0], id: "m2", seq: 2, createdAt: "2026-10-01T00:00:02.000Z" }]
    fresh.readState = { ...fresh.readState, lastReadMessageId: "m2", lastReadSeq: 2, lastReadAt: fresh.messages[0].createdAt }
    fresh.readStateRevision = 5
    fresh.selection = { reason: "tail", anchorMessageId: null }
    fresh.newBoundary = { afterSeq: 2, target: null }
    fresh.page.latestSeq = 2
    ingestReadStateSnapshot(registry, { revision: 5, readStates: [{ ...fresh.readState, lastReadAt: fresh.messages[0].createdAt }] })
    client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    const held = deferred<typeof fresh>()
    load.mockImplementation((url: string) => url.includes("entry=1") ? held.promise
      : Promise.resolve({ ...old.page, messages: old.messages, profiles: old.profiles }))
    const navigation = { entryIntent: { href: "/c/channels/s1/c1" } }
    function Wrapper({ children }: PropsWithChildren) {
      return createElement(Owner, null, createElement(CommunityRouteContext, { value: { navigation } as never }, children))
    }
    const hook = renderHook(() => useConversationEntry(target), { wrapper: Wrapper })
    const retained = hook.result.current.window
    const oldTakeover = hook.result.current.retainWindow
    act(() => { oldTakeover(); oldTakeover() })
    await act(async () => held.resolve(fresh))
    await waitFor(() => expect(hook.result.current.targetCovered).toBe(true))
    expect(hook.result.current.window).toBe(retained)
    expect(hook.result.current.window?.key).toEqual(original.windowKey)
    navigation.entryIntent = { href: "/c/channels/s1/c1" }
    hook.rerender()
    expect(hook.result.current.window?.initial).toEqual({ mode: "newest" })
    act(oldTakeover)
    expect(hook.result.current.window?.initial).toEqual({ mode: "newest" })
    await act(async () => registry.runtime.ws.actions.revokeChannelAccess("s1", "c1"))
    act(() => hook.result.current.retainWindow())
    expect(hook.result.current.window).toBeNull()
    expect(hook.result.current.canRead).toBe(false)
    hook.unmount()
  })

  it("ignores actual reconnect helper cache keys when the original entry hook consumes a complete warm window", async () => {
    const { client, wrapper, publish } = await setup()
    const value = fixture()
    const resource = await publish(value)
    const observer = new QueryObserver(client, { queryKey: resource.windowKey, queryFn: async () => client.getQueryData(resource.windowKey), staleTime: Infinity })
    const stop = observer.subscribe(() => undefined)
    const repairPage = { profiles: value.profiles, messages: value.messages, ...value.page }
    const held = deferred<typeof repairPage>()
    load.mockReturnValue(held.promise)
    const repair = reconcileWindow(client, { kind: "channel", scopeId: "c1", serverId: "s1" }, resource.windowKey, 1)
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(client.getQueryData([...resource.windowKey, "reconcile-target"])).toBe(1)
    const reads = load.mock.calls.length
    const hook = renderHook(() => ({ entry: useConversationEntry(target), surface: useMessages("c1", { serverId: "s1" }) }), { wrapper })
    await waitFor(() => expect(hook.result.current.surface.messages.map(message => message.id)).toEqual(["m1"]))
    expect(hook.result.current.surface.navigationBlocked).toBe(false)
    expect(hook.result.current.entry.window).not.toBeNull()
    expect(load).toHaveBeenCalledTimes(reads)
    await act(async () => { held.resolve(repairPage); await repair })
    expect(client.getQueryData([...resource.windowKey, "reconcile"])).toEqual({ latestSeq: 1 })
    expect(hook.result.current.surface.navigationBlocked).toBe(false)
    expect(load).toHaveBeenCalledTimes(reads)
    hook.unmount()
    stop()
  })

  it("keeps a complete current window usable when an unselected old anchor has no author", async () => {
    const { client, wrapper, registry, publish } = await setup()
    const value = fixture()
    value.selection = { reason: "tail", anchorMessageId: null }
    const current = await publish(value)
    const old = { ...value.messages[0], id: "old-message", authorId: "old-author", seq: 0 }
    await publishCommunityMessages(client, { channelId: "c1", messages: [old], profiles: [profileResourceFixture({ id: "old-author", name: "Old Author" })], proof: { token: captureCommunityLiveSnapshotToken(client, "c1") } })
    const oldKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: old.id })
    const oldWindow = { pages: [{ ...value.page, messages: [{ id: old.id, seq: old.seq }] }], pageParams: [{ mode: "anchor", anchor: old.id }] }
    client.setQueryData(oldKey, oldWindow)
    registry.collections.profiles.utils.writeDelete("old-author")
    load.mockReturnValue(new Promise(() => {}))
    const hook = renderHook(() => ({ metadata: useChannelMetadata("s1", "c1"), surface: useMessages("c1", { serverId: "s1" }) }), { wrapper })
    await waitFor(() => expect(hook.result.current.metadata.windowReady).toBe(true))
    expect(hook.result.current.surface.navigationBlocked).toBe(false)
    expect(hook.result.current.surface.messages.map(message => message.id)).toEqual(["m1"])
    expect(client.getQueryData(oldKey)).toBe(oldWindow)
    expect(client.getQueryData(current.windowKey)).toBeDefined()
    expect(registry.collections.messages.get(old.id)).toMatchObject({ authorId: "old-author" })
    expect(registry.collections.profiles.has("old-author")).toBe(false)
    expect(load).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("repairs the current missing author even when an unselected old anchor has no body", async () => {
    const { client, wrapper, registry, publish } = await setup()
    const value = fixture()
    value.selection = { reason: "tail", anchorMessageId: null }
    await publish(value)
    const oldKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "missing-old-body" })
    const oldWindow = { pages: [{ ...value.page, messages: [{ id: "missing-old-body", seq: 0 }] }], pageParams: [{ mode: "anchor", anchor: "missing-old-body" }] }
    client.setQueryData(oldKey, oldWindow)
    const held = deferred<typeof value>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => ({ metadata: useChannelMetadata("s1", "c1"), surface: useMessages("c1", { serverId: "s1" }) }), { wrapper })
    await waitFor(() => expect(hook.result.current.metadata.windowReady).toBe(true))
    expect(load).not.toHaveBeenCalled()
    await act(async () => { registry.collections.profiles.utils.writeDelete("peer") })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.metadata.windowReady).toBe(false)
    expect(hook.result.current.surface.navigationBlocked).toBe(true)
    await act(async () => held.resolve(value))
    await waitFor(() => expect(hook.result.current.metadata.windowReady).toBe(true))
    expect(hook.result.current.surface.navigationBlocked).toBe(false)
    expect(client.getQueryData(oldKey)).toBe(oldWindow)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it.each(["messages-shape", "missing-author", "forum-shape"])("rereads an incomplete cached dependency through ordinary entry ($0)", async defect => {
    const { client, wrapper, registry, publish } = await setup()
    const value = defect === "forum-shape" ? forumConversationEntryFixture() : fixture()
    const destination = { channelId: "c1", serverId: value.channel.serverId }
    const resource = defect === "forum-shape" ? await publishConversationEntry(client, destination, value, { token: captureCommunityLiveSnapshotToken(client, "c1") }) : await publish(value)
    client.setQueryData(conversationEntryOptions(client, destination).queryKey, resource)
    if (defect === "messages-shape") client.setQueryData(resource.windowKey, { pages: [{ messages: 42 }], pageParams: [{ mode: "newest" }] })
    if (defect === "forum-shape") client.setQueryData(communityKeys.forumFeed("c1", null), { pages: [{ threads: 42 }], pageParams: [null] })
    if (defect === "missing-author") registry.collections.profiles.utils.writeDelete(value.messages[0].authorId)
    const held = deferred<typeof value>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useChannelMetadata(destination.serverId, "c1"), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.canRead).toBe(true)
    expect(hook.result.current.windowReady).toBe(false)
    await act(async () => held.resolve(value))
    await waitFor(() => expect(hook.result.current.windowReady).toBe(true))
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it.each([
    { kind: "text", useSurface: function useText() { return useMessages("c1", { serverId: "s1" }) } },
    { kind: "dm", useSurface: function useDm() { return useDmMessages("c1") } },
  ])("keeps current $kind permission separate from a missing owned entry window", async ({ kind, useSurface }) => {
    const { client, wrapper } = await setup()
    const value = kind === "dm" ? dmConversationEntryFixture() : fixture()
    await publishCommunityResourceBundle(client, fullResourceBundleFixture(value.viewerId,
      value.channel.serverId ? [serverResourceFixture({ id: value.channel.serverId, ownerId: value.viewerId })] : [],
      [value.channel], [], value.peer ? [value.peer] : []), { token: captureCommunityLiveSnapshotToken(client) })
    const held = deferred<typeof value>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => ({ metadata: useChannelMetadata(value.channel.serverId, "c1"),
      messages: useSurface() }), { wrapper })
    await waitFor(() => expect(hook.result.current.metadata.canRead).toBe(true))
    expect(hook.result.current.metadata.data?.id).toBe("c1")
    expect(hook.result.current.metadata.windowReady).toBe(false)
    expect(hook.result.current.messages.navigationBlocked).toBe(true)
    expect(hook.result.current.messages.messages).toEqual([])
    expect(load).toHaveBeenCalledOnce()
    await act(async () => held.resolve(value))
    await waitFor(() => expect(hook.result.current.metadata.windowReady).toBe(true))
    await waitFor(() => expect(hook.result.current.messages.navigationBlocked).toBe(false))
    await waitFor(() => expect(hook.result.current.messages.messages[0]?.id).toBe("m1"))
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("offers the existing retry after a scope-only entry window fails, while retaining identity", async () => {
    const { client, wrapper } = await setup()
    const value = dmConversationEntryFixture()
    await publishCommunityResourceBundle(client, fullResourceBundleFixture(value.viewerId, [], [value.channel], [], [value.peer!]),
      { token: captureCommunityLiveSnapshotToken(client) })
    load.mockRejectedValue(new ConversationReadTimeoutError())
    const hook = renderHook(() => ({ metadata: useChannelMetadata(null, "c1"), messages: useDmMessages("c1") }), { wrapper })
    await waitFor(() => expect(hook.result.current.metadata.status).toBe("retryable-error"))
    expect(hook.result.current.metadata.canRead).toBe(true)
    expect(hook.result.current.metadata.data?.id).toBe("c1")
    expect(hook.result.current.metadata.windowReady).toBe(false)
    expect(hook.result.current.messages.navigationBlocked).toBe(true)
    load.mockResolvedValue(value)
    await act(async () => { await hook.result.current.metadata.retry() })
    await waitFor(() => expect(hook.result.current.metadata.windowReady).toBe(true))
    expect(hook.result.current.metadata.status).toBe("readable")
    expect(load).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

  it.each([
    { kind: "text", useSurface: function useText() { return useMessages("c1", { serverId: "s1" }) } },
    { kind: "dm", useSurface: function useDm() { return useDmMessages("c1") } },
    { kind: "forum", useSurface: function useForum() { return useForumFeed("s1", "c1") } },
    { kind: "thread", useSurface: function useThread() { return useMessages("c1", { serverId: "s1" }) } },
  ] as const)("presents the qualified $kind cache while the missing entry is actually pending", async ({ kind, useSurface }) => {
    const { client, wrapper } = await setup()
    const value = kind === "dm" ? dmConversationEntryFixture() : kind === "forum" ? forumConversationEntryFixture() : fixture()
    if (kind === "thread") {
      value.channel = { ...value.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
      value.parent = { ...fixture().channel, id: "parent", type: "text" }
      value.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    }
    const destination = { channelId: "c1", serverId: value.channel.serverId }
    const resource = await publishConversationEntry(client, destination, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    client.setQueryData(conversationEntryOptions(client, destination).queryKey, resource)
    client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    const held = deferred<typeof value>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => {
      const metadata = useChannelMetadata(destination.serverId, "c1")
      const surface = useSurface()
      return { metadata, surface }
    }, { wrapper })
    await waitFor(() => expect(load.mock.calls.some(([url]) => String(url).startsWith("/api/community/channels/c1/messages?entry=1&"))).toBe(true))
    expect(hook.result.current.metadata.canRead).toBe(true)
    expect(hook.result.current.metadata.windowReady).toBe(true)
    expect(hook.result.current.metadata.data?.id).toBe("c1")
    expect(hook.result.current.metadata.isFetching).toBe(true)
    if ("messages" in hook.result.current.surface) {
      await waitFor(() => expect(hook.result.current.surface).toMatchObject({ isLoading: false, messages: [expect.objectContaining({ id: "m1", content: "Body" })] }))
    } else await waitFor(() => {
      const surface = hook.result.current.surface
      expect("posts" in surface ? surface.posts.map(post => post.id) : []).toEqual(["t1"])
    })
    hook.unmount()
  })

  it("does not block a valid cached empty window on missing entry data", async () => {
    const { client, wrapper, publish } = await setup()
    const value = fixture()
    value.messages = []
    value.newBoundary = { afterSeq: 0, target: null }
    value.readState = { ...value.readState, lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
    value.selection = { reason: "tail", anchorMessageId: null }
    value.page = { ...value.page, olderCursor: null, hasMoreOlder: false, latestSeq: 0 }
    await publish(value)
    client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    load.mockReturnValue(new Promise(() => {}))
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    expect(hook.result.current.messages).toEqual([])
    expect(hook.result.current.initialPositionKnown).toBe(true)
    expect(hook.result.current.positionDataState).toBe("empty")
    expect(hook.result.current.navigationBlocked).toBe(false)
    expect(hook.result.current.isFetching).toBe(true)
    hook.unmount()
  })

  it("keeps the current qualified cache while another server retires old entry proofs", async () => {
    const { wrapper, publish, registry } = await setup()
    await publish()
    const held = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(hook.result.current.messages.map(message => message.id)).toEqual(["m1"]))
    await act(async () => registry.runtime.ws.actions.revokeServerAccess("unrelated"))
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.entryCanRead).toBe(true)
    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.messages[0]?.content).toBe("Body")
    expect(hook.result.current.initialPositionKnown).toBe(true)
    expect(hook.result.current.readSnapshot?.lastReadMessageId).toBe("m1")
    hook.unmount()
  })

  it("retains a parent's window and NEW through background and semantic resume, while a fresh entry reselects", async () => {
    const { wrapper: Owner, publish, registry } = await setup()
    const value = fixture()
    value.messages.push({ ...value.messages[0], id: "m2", seq: 2, content: "Second" })
    value.page.latestSeq = 2
    value.newBoundary = { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } }
    await publish(value)
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
    load.mockResolvedValue({ ...value, readState: { ...value.readState, lastReadMessageId: "m2", lastReadSeq: 2 }, readStateRevision: 5,
      newBoundary: { afterSeq: 2, target: null } })
    navigation.entryIntent = { href: "/c/channels/s1/c1" }
    hook.rerender()
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2")
    expect(load).toHaveBeenCalledOnce()
  })

  it("shares one returned-DM read between metadata and the subsequently mounted body", async () => {
    const { wrapper: Owner, registry, client } = await setup()
    const dmTarget = { channelId: "c1", serverId: null }
    const old = dmConversationEntryFixture()
    const oldResource = await publishConversationEntry(client, dmTarget, old, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    client.setQueryData(conversationEntryOptions(client, dmTarget).queryKey, oldResource)
    ingestReadStateSnapshot(registry, { revision: 6, readStates: [{ channelId: "c1", lastReadMessageId: "m2", lastReadSeq: 2, lastReadAt: "later" }] })
    const next = dmConversationEntryFixture()
    next.readState = { ...next.readState, lastReadMessageId: "m2", lastReadSeq: 2 }
    next.readStateRevision = 6
    next.selection = { reason: "tail", anchorMessageId: null }
    next.newBoundary = { afterSeq: 2, target: null }
    next.page.latestSeq = 2
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

  it("joins the held cold child entry when sidebar scope publishes before the body", async () => {
    const owner = await setup()
    const value = fixture()
    value.channel = { ...value.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
    value.parent = { ...fixture().channel, id: "parent", type: "forum" }
    value.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    const held = deferred<typeof value>()
    load.mockReturnValue(held.promise)
    let body: ReturnType<typeof useMessages> | undefined
    function Body() { body = useMessages("c1", { serverId: "s1" }); return null }
    function Route() {
      const metadata = useChannelMetadata("s1", "c1")
      return metadata.canRead ? createElement(Body) : null
    }
    const view = render(createElement(Route), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(load).toHaveBeenCalledOnce())
      expect(body).toBeUndefined()
      await act(async () => publishCommunityResourceBundle(owner.client,
        fullResourceBundleFixture("viewer", [serverResourceFixture({ id: "s1", ownerId: "viewer" })], [value.parent!, value.channel]),
        { token: captureCommunityLiveSnapshotToken(owner.client) }))
      await waitFor(() => expect(body?.entryCanRead).toBe(true))
      expect(body?.navigationBlocked).toBe(true)
      expect(body?.messages).toEqual([])
      expect(load).toHaveBeenCalledOnce()
      await act(async () => held.resolve(value))
      await waitFor(() => expect(body?.messages.map(message => message.id)).toEqual(["m1"]))
      expect(body?.navigationBlocked).toBe(false)
      expect(load).toHaveBeenCalledOnce()
    } finally { view.unmount(); owner.client.clear() }
  })

  it("captures a fresh DM cutoff after confirmed reading while metadata stays mounted", async () => {
    const owner = await setup()
    const old = dmConversationEntryFixture()
    old.messages.push({ ...old.messages[0], id: "m2", seq: 2 })
    old.page.latestSeq = 2
    old.newBoundary = { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } }
    load.mockResolvedValue(old)
    let showBody = true
    let body: ReturnType<typeof useDmMessages> | undefined
    const navigation = { entryIntent: { href: "/c/me/c1" } }
    function Body() { body = useDmMessages("c1"); return null }
    function Route() { useChannelMetadata(null, "c1"); return showBody ? createElement(Body) : null }
    const tree = () => createElement(CommunityRouteContext, { value: { navigation } as never }, createElement(Route))
    const view = render(tree(), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(body?.newBoundary?.target?.id).toBe("m2"))
      showBody = false
      navigation.entryIntent = { href: "/c/me" }
      view.rerender(tree())
      const readState = { ...old.readState, lastReadMessageId: "m2", lastReadSeq: 2, lastReadAt: old.messages[1].createdAt }
      await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [readState] }))
      const fresh = { ...old, readState, readStateRevision: 5, newBoundary: { afterSeq: 2, target: null } }
      load.mockResolvedValue(fresh)
      showBody = true
      navigation.entryIntent = { href: "/c/me/c1" }
      view.rerender(tree())
      await waitFor(() => expect(body?.newBoundary).toEqual(fresh.newBoundary))
      expect(body?.readSnapshot?.lastReadSeq).toBe(2)
      expect(load.mock.calls.filter(([url]) => String(url).includes("entry=1"))).toHaveLength(2)
    } finally { view.unmount(); owner.client.clear() }
  })

  it("shares the restored cutoff when metadata initializes before restored scope", async () => {
    const owner = await setup()
    let restoring = true
    const held = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(held.promise)
    let body: ReturnType<typeof useMessages> | undefined
    function Body() { body = useMessages("c1", { serverId: "s1" }); return null }
    function Route() {
      const metadata = useChannelMetadata("s1", "c1")
      return metadata.canRead ? createElement(Body) : null
    }
    const tree = () => createElement(IsRestoringProvider, { value: restoring }, createElement(Route))
    const view = render(tree(), { wrapper: owner.wrapper })
    try {
      expect(load).not.toHaveBeenCalled()
      const value = fixture()
      const restored = await owner.publish(value)
      owner.client.setQueryData(conversationEntryOptions(owner.client, target).queryKey, restored, { updatedAt: Date.now() - 6000 })
      view.rerender(tree())
      await waitFor(() => expect(body?.entryCanRead).toBe(true))
      expect(load).not.toHaveBeenCalled()
      restoring = false
      view.rerender(tree())
      await waitFor(() => expect(load, JSON.stringify(load.mock.calls.map(([url]) => url))).toHaveBeenCalledOnce())
      await act(async () => held.resolve(value))
      await waitFor(() => expect(body?.isFetching).toBe(false))
      expect(load).toHaveBeenCalledOnce()
      expect(body?.newBoundary).toEqual(value.newBoundary)
    } finally { view.unmount(); owner.client.clear() }
  })

  it("does not freeze a previous New target into a fresh DM while its metadata refresh is held", async () => {
    const owner = await setup()
    const old = dmConversationEntryFixture()
    old.messages.push({ ...old.messages[0], id: "m2", seq: 2 })
    old.page.latestSeq = 2
    old.newBoundary = { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } }
    load.mockResolvedValue(old)
    let showBody = true
    let body: ReturnType<typeof useDmMessages> | undefined
    const navigation = { entryIntent: { href: "/c/me/c1" } }
    function Body() { body = useDmMessages("c1"); return null }
    function Route() { useChannelMetadata(null, "c1"); return showBody ? createElement(Body) : null }
    const tree = () => createElement(CommunityRouteContext, { value: { navigation } as never }, createElement(Route))
    const view = render(tree(), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(body?.newBoundary?.target?.id).toBe("m2"))
      showBody = false
      navigation.entryIntent = { href: "/c/me" }
      view.rerender(tree())
      const fresh = { ...old, readState: { ...old.readState, lastReadMessageId: "m2", lastReadSeq: 2 },
        readStateRevision: 5, newBoundary: { afterSeq: 2, target: null } }
      const held = deferred<typeof fresh>()
      load.mockReturnValue(held.promise)
      let refresh!: Promise<void>
      act(() => { refresh = owner.client.invalidateQueries({ queryKey: communityKeys.conversationEntries("c1") }) })
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      showBody = true
      navigation.entryIntent = { href: "/c/me/c1" }
      view.rerender(tree())
      expect(body?.messages.map(message => message.id)).toEqual(["m1", "m2"])
      await act(async () => { held.resolve(fresh); await refresh })
      await waitFor(() => expect(body?.isFetching).toBe(false))
      expect(body?.newBoundary).toEqual(fresh.newBoundary)
      expect(load.mock.calls.filter(([url]) => String(url).includes("entry=1"))).toHaveLength(2)
    } finally { view.unmount(); owner.client.clear() }
  })

  it("shares one cold entry when metadata mounts the body after its real publication", async () => {
    const owner = await setup()
    load.mockResolvedValue(fixture())
    let body: ReturnType<typeof useMessages> | undefined
    function Body() { body = useMessages("c1", { serverId: "s1" }); return null }
    function Route() {
      const metadata = useChannelMetadata("s1", "c1")
      return metadata.canRead ? createElement(Body) : null
    }
    const view = render(createElement(Route), { wrapper: owner.wrapper })
    await waitFor(() => expect(body?.messages.map(message => message.id)).toEqual(["m1"]))
    expect(load).toHaveBeenCalledOnce()
    expect(body?.newBoundary).toEqual({ afterSeq: 1, target: null })
    view.unmount()
    owner.client.clear()
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
    expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1&window=tail"])
    hook.unmount()
  })

  it("renders a warm covered window without GET and freezes the current document pointer", async () => {
    const { wrapper, publish, registry } = await setup()
    const value = fixture()
    value.messages.push({ ...value.messages[0], id: "m2", seq: 2, content: "Second" })
    value.page.latestSeq = 2
    value.newBoundary = { afterSeq: 2, target: null }
    await publish(value)
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
    await publish()
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
    await publish()
    ingestReadStateSnapshot(registry, { revision: 5, readStates: [{ channelId: "c1", lastReadMessageId: "m2", lastReadAt: "second", lastReadSeq: 2 }] })
    const transport = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(transport.promise)
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.window).not.toBeNull()
    expect(hook.result.current.targetCovered).toBe(false)
    const next = fixture()
    next.readState = { channelId: "c1", lastReadMessageId: "m2", lastReadAt: "second", lastReadSeq: 2 }
    next.readStateRevision = 5
    next.selection = { reason: "tail", anchorMessageId: null }
    next.newBoundary = { afterSeq: 2, target: null }
    next.page.latestSeq = 2
    next.messages = [{ ...next.messages[0], id: "m2", seq: 2, content: "Second" }]
    await act(async () => transport.resolve(next))
    await waitFor(() => expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2"))
    expect(hook.result.current.window?.initial).toEqual({ mode: "newest" })
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("takes the current covered pointer for a new same-channel navigation while retaining the native resource", async () => {
    const { wrapper: Owner, publish, registry } = await setup()
    const packet = fixture()
    packet.messages.push({ ...packet.messages[0], id: "m2", seq: 2 })
    packet.page.latestSeq = 2
    await publish(packet)
    const navigation: { entryIntent: { href: string } | null } = { entryIntent: null }
    const wrapper = ({ children }: PropsWithChildren) => createElement(Owner, null, createElement(CommunityRouteContext, { value: { navigation } as never }, children))
    const hook = renderHook(() => useConversationEntry(target), { wrapper })
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    await act(async () => { ingestReadStateSnapshot(registry, { revision: 5, readStates: [{ channelId: "c1", lastReadMessageId: "m2", lastReadAt: "later", lastReadSeq: 2 }] }) })
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m1")
    load.mockResolvedValue({ ...packet, readState: { ...packet.readState, lastReadMessageId: "m2", lastReadSeq: 2 }, readStateRevision: 5,
      newBoundary: { afterSeq: 2, target: null } })
    navigation.entryIntent = { href: "/c/channels/s1/c1" }
    hook.rerender()
    expect(hook.result.current.snapshot?.lastReadMessageId).toBe("m2")
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("withdraws a selected window immediately on target revocation", async () => {
    const { wrapper, publish, registry } = await setup()
    await publish()
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

  it("retires the old entry proof and refetches while qualifying the current canonical scope after registry registration changes", async () => {
    const { wrapper, publish, registry, client } = await setup()
    const original = await publish()
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationEntryOptions(client, { ...target, newAfterSeq: 1 }).queryKey, exact: true })
    expect(hook.result.current.canRead).toBe(true)
    expect(hook.result.current.scope?.proof.ownerGeneration).toBeGreaterThan(original.proof.ownerGeneration)
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
    value.selection = { reason: "tail", anchorMessageId: null }
    value.newBoundary = { afterSeq: 30, target: { id: "m31", channelId: "c1", seq: 31, authorId: "peer" } }
    value.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }
    await owner.publish(value)
    const historyTarget = { ...target, anchorMessageId: "m30" }
    const history = await publishConversationEntry(owner.client, historyTarget,
      { ...value, selection: { reason: "explicit_anchor", anchorMessageId: "m30" } },
      { token: captureCommunityLiveSnapshotToken(owner.client, "c1") })
    owner.client.setQueryData(conversationEntryOptions(owner.client, historyTarget).queryKey, history)
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
      const newDividerBefore = feed.newBoundary?.target?.id
      const props = { channel: "Channel", messages: feed.messages,
        loading: feed.isLoading, initialLoadError: feed.initialLoadError,
        newBoundary: feed.newBoundary, latestSeq: feed.latestSeq, retiredNewTargetId: feed.retiredNewTargetId,
        onLoadNewTarget: feed.loadNewTarget, onReadNewBoundary: feed.readNewBoundary, scrollToMessageId,
        initialScrollReady: feed.initialDisplayReady,
        onUserTakeover: feed.onUserTakeover,
        positionDataState: feed.positionDataState, positionEntry: feed.positionEntry, messageWindow: feed.messageWindow,
        hasMore: feed.hasMoreOlder, hasMoreNewer: feed.hasMoreNewer,
        historyStartKnown: feed.historyStartKnown,
        initialPositionMessageId: feed.initialPositionMessageId,
        isFetching: feed.isFetching, isFetchingOlder: feed.isFetchingOlder, isFetchingNewer: feed.isFetchingNewer,
        presentVersion: feed.presentVersion, variant: "channel" as const, hoverCapable: false,
        onOpenThread: () => undefined,
      }
      const controller = useMessageListController(props)
      latest = { feed, controller, newDividerBefore }
      return createElement("div", { "data-slot": "community-conversation-surface" },
        createElement("div", { ref: controller.scrollRef, "data-testid": "community-message-scroller" },
          createElement("div", { "data-message-list-content": "", className: "flex min-h-full flex-col", "data-read-position-ready": String(controller.readPositionReady) },
            createElement("div", { "data-message-rows": "", className: "mt-auto flex w-full flex-col", style: { paddingBottom: controller.tailPaddingEnd } },
              controller.items.map((item, index) => createElement("div", { key: item.key, "data-index": index, className: "w-full" },
                item.kind === "leading" ? renderMessageListRow(item, props, controller) : createElement("div", {
                  "data-message-row-key": item.key, "data-fixture-kind": item.kind,
                  "data-fixture-date": String(item.kind === "divider" && !!item.dateLabel),
                  "data-message-divider-for": item.kind === "divider" ? item.messageId : undefined,
                }, item.kind === "message" ? createElement("div", { "data-msg-id": item.m.id }) :
                  item.kind === "divider" && item.newDivider ? createElement("div", { "data-new-divider": "" }) : null),
              )),
            ))),
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

  it.each([30, 42])("preserves an admitted reader through canonical read %s and slow refresh without granting early reads or replacing its New cutoff", async readSeq => {
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
    fresh.selection = { reason: "tail", anchorMessageId: null }
    fresh.newBoundary = { afterSeq: 30, target: { id: "m31", channelId: "c1", seq: 31, authorId: "peer" } }
    fresh.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 45 }
    const oldLoad = load.getMockImplementation()!
    load.mockImplementation((url: string, options: unknown) => url.includes("/messages") ? held.promise : oldLoad(url, options))
    const view = mountReadingEntry(owner)
    try {
    expect(view.latest.controller.initialPosition.contentVisible).toBe(true)
    act(() => { view.root.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000 })); view.root.scrollTo({ top: 1800 }) })
    resize()
    await act(async () => {
      ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [readState] })
      await publishAccountAttentionSnapshot(owner.client, {
        snapshot: { resources: resourceBundleFixture(), scopes: [{ scopeId: "c1", channelId: "c1", serverId: "s1",
          ordinaryUnread: true, lastUnreadSeq: 45, lastAttentionSeq: null, attentionCount: 0 }], items: [], limit: 100, truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } },
        proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined },
      })
    })
    await act(async () => { void owner.client.invalidateQueries({ queryKey: communityKeys.conversationEntries("c1") }); await vi.advanceTimersByTimeAsync(0) })
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
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
      expect(view.latest.newDividerBefore).toBe("m31")
      expect(view.latest.controller.initialPosition.contentVisible).toBe(true)
    } finally {
      view.view.unmount()
      held.resolve(fresh)
      releaseReadSurface(owner.lease)
      await owner.finish()
    }
  })

  it.each(["before PUT confirmation", "after ACK before canonical readback", "after ACK and failed canonical readback"] as const)(
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
        expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(boundary === "before PUT confirmation" ? 30 : 42)
        returned = mountReadingEntry(owner)
        expect(returned.latest.feed.messages).toHaveLength(42)
        expect(returned.latest.feed.readSnapshot?.lastReadSeq).toBe(boundary === "before PUT confirmation" ? 30 : 42)
        expect(returned.latest.newDividerBefore).toBe(boundary === "before PUT confirmation" ? "m31" : undefined)
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
    const phases: unknown[] = [], writes: unknown[] = [], optionsTimeline: unknown[] = []
    let phase = "mount-pending"
    const capture = () => {
      if (!view) return
      const { feed, controller } = view.latest
      const root = view.root
      const body = root.querySelector<HTMLElement>('[data-msg-id="m42"]')?.getBoundingClientRect()
      phases.push({ phase, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
        readReady: controller.readPositionReady, contentVisible: controller.initialPosition.contentVisible,
        positionDataState: feed.positionDataState, initialDisplayReady: feed.initialDisplayReady,
        initialPositionKnown: feed.initialPositionKnown, initialTarget: feed.initialPositionMessageId,
        first: feed.messages[0]?.id, last: feed.messages.at(-1)?.id, hasMoreOlder: feed.hasMoreOlder, hasMoreNewer: feed.hasMoreNewer,
        visibleTail: view.visible("m42"), tailRect: body ? { top: body.top, bottom: body.bottom, height: body.height } : null })
    }
    try {
      const originalScrollTo = HTMLElement.prototype.scrollTo
      vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function(this: HTMLElement, ...args: [options?: ScrollToOptions] | [x: number, y: number]) {
        const before = this.scrollTop
        Reflect.apply(originalScrollTo, this, args)
        writes.push({ phase, before, requested: typeof args[0] === "number" ? args[1] : args[0]?.top, after: this.scrollTop,
          nativeStack: new Error().stack?.split("\n").filter(line => /resizeItem|applyScrollAdjustment|_scrollToOffset|setOptions/.test(line)) })
      })
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      owner.client.setQueryData(originalKey, { ...originalWindow, pages: originalWindow.pages.map(page => ({ ...page,
        messages: page.messages.filter(message => message.id !== "m42"), hasMoreNewer: true,
      })) })
      owner.client.removeQueries({ queryKey: communityKeys.channelMessagesWindow("c1", { mode: "newest" }), exact: true })
      const retainedWindow = owner.client.getQueryData(originalKey)
      expect(owner.registry.collections.messages.get("m42")?.seq).toBe(42)
      load.mockImplementation((url: string, options: unknown) => url.includes("/messages?entry=1") ? entryRead.promise : originalLoad(url, options))
      view = mountReadingEntry(owner)
      capture()
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.latest.controller.readPositionReady).toBe(false)
      expect(view.latest.controller.paginationEnabled).toBe(false)
      expect(load.mock.calls.some(([url]) => url === "/api/community/channels/c1/messages?entry=1&window=tail&newAfterSeq=30")).toBe(true)
      const fresh = fixture()
      fresh.messages = Array.from({ length: 23 }, (_, index) => ({ ...fresh.messages[0], id: `m${index + 20}`, seq: index + 20,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 20)).toISOString(),
      }))
      fresh.readState = { channelId: "c1", lastReadMessageId: "m30", lastReadSeq: 30, lastReadAt: fresh.messages.find(message => message.id === "m30")!.createdAt }
      fresh.selection = { reason: "tail", anchorMessageId: null }
      fresh.newBoundary = { afterSeq: 30, target: { id: "m31", channelId: "c1", seq: 31, authorId: "peer" } }
      fresh.page = { ...fresh.page, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 42 }
      phase = "entry-response"
      await act(async () => entryRead.resolve(fresh))
      capture()
      expect(view.latest.feed.error).toBeNull()
      phase = "response-resize-and-frames"
      resize()
      capture()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.visible("m42")).toBe(true)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
      expect(owner.client.getQueryData(originalKey)).toBe(retainedWindow)
      expect(view.latest.feed.historyStartKnown).toBe(false)
    } finally {
      console.info("accepted-canonical-target327", JSON.stringify({ phases, writes, optionsTimeline }))
      view?.view.unmount(); releaseReadSurface(owner.lease); await owner.finish()
    }
  })

  async function evictOrdinaryEntryWithAlternateCoverage(owner: Awaited<ReturnType<typeof readingOwner>>) {
    const alternateTarget = { ...target, anchorMessageId: "m42" }
    const alternate = fixture()
    alternate.messages = [{ ...alternate.messages[0], id: "m42", seq: 42, createdAt: owner.read42.lastReadAt! }]
    alternate.channel.messageCount = 42
    alternate.readState = { channelId: "c1", lastReadMessageId: "m30", lastReadSeq: 30, lastReadAt: "2026-10-01T00:00:30.000Z" }
    alternate.selection = { reason: "explicit_anchor", anchorMessageId: "m42" }
    alternate.page = { ...alternate.page, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 42 }
    const alternateResource = await publishConversationEntry(owner.client, alternateTarget, alternate,
      { token: captureCommunityLiveSnapshotToken(owner.client, "c1") })
    const alternateKey = conversationEntryOptions(owner.client, alternateTarget).queryKey
    owner.client.setQueryData(alternateKey, alternateResource)
    const retainedWindow = owner.client.getQueryData(alternateResource.windowKey)
    expect(retainedWindow).toBeDefined()
    const ordinaryKey = conversationEntryOptions(owner.client, target).queryKey
    owner.client.removeQueries({ queryKey: ordinaryKey, exact: true })
    owner.client.removeQueries({ queryKey: communityKeys.channelMessagesWindow("c1", { mode: "newest" }), exact: true })
    return { alternate, alternateResource, alternateKey, retainedWindow, ordinaryKey }
  }

  it.each([true, false])("uses qualified canonical coverage after ordinary entry eviction with alternate entry retained=%s", async qualified => {
    const owner = await readingOwner()
    const { alternate, alternateResource, alternateKey, retainedWindow, ordinaryKey } = await evictOrdinaryEntryWithAlternateCoverage(owner)
    if (!qualified) owner.client.removeQueries({ queryKey: alternateKey, exact: true })
    expect(owner.client.getQueryData(ordinaryKey)).toBeUndefined()
    expect(owner.client.getQueryData(alternateKey)).toBe(qualified ? alternateResource : undefined)
    expect(owner.registry.collections.messages.get("m42")?.seq).toBe(42)
    const response = { ...alternate, selection: { reason: "tail" as const, anchorMessageId: null },
      newBoundary: { afterSeq: 30, target: { id: "m31", channelId: "c1", seq: 31, authorId: "peer" } } }
    const entryRead = deferred<ReturnType<typeof fixture>>()
    const originalLoad = load.getMockImplementation()!
    const expectedRequest = "/api/community/channels/c1/messages?entry=1&window=tail&newAfterSeq=30"
    load.mockImplementation((url: string, options: unknown) => {
      if (!url.includes("/messages?entry=1")) return originalLoad(url, options)
      if (url !== expectedRequest) throw new Error(`Unexpected entry coverage request ${url}`)
      return entryRead.promise
    })
    let view: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      view = mountReadingEntry(owner)
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.latest.controller.readPositionReady).toBe(false)
      const retainedAnchor = owner.client.getQueryData(alternateResource.windowKey)
      expect(load.mock.calls.filter(([url]) => url.includes("/messages?entry=1")).map(([url]) => url)).toEqual([expectedRequest])
      await act(async () => entryRead.resolve(response))
      resize()
      expect(view.latest.feed.error).toBeNull()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.latest.feed.messages.map(message => message.id)).toEqual(["m42"])
      expect(view.visible("m42")).toBe(true)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(30)
      expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(30)
      expect(owner.client.getQueryData(alternateResource.windowKey)).toBe(retainedWindow)
      expect(view.latest.feed.historyStartKnown).toBe(false)
      expect(load.mock.calls.filter(([url]) => url.includes("/messages?entry=1")).map(([url]) => url)).toEqual([expectedRequest])
      expect(owner.client.getQueryData(alternateResource.windowKey)).toBe(retainedAnchor)
      if (qualified) {
        const capturedSnapshot = view.latest.feed.readSnapshot, capturedOffset = view.root.scrollTop
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
    const { alternate, alternateResource, retainedWindow } = await evictOrdinaryEntryWithAlternateCoverage(owner)
    const read = { channelId: "c1", lastReadMessageId: `m${seq}`, lastReadSeq: seq,
      lastReadAt: seq === 42 ? owner.read42.lastReadAt : "2026-10-01T00:01:40.000Z" }
    const response = { ...alternate, readState: read, readStateRevision: 5,
      selection: { reason: "tail" as const, anchorMessageId: null }, newBoundary: { afterSeq: seq, target: null },
      messages: [{ ...alternate.messages[0], id: read.lastReadMessageId, seq, createdAt: read.lastReadAt! }],
      page: { ...alternate.page, latestSeq: seq } }
    const entryRead = deferred<ReturnType<typeof fixture>>()
    const originalLoad = load.getMockImplementation()!
    const expectedRequest = `/api/community/channels/c1/messages?entry=1&window=tail&newAfterSeq=${seq}`
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
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.latest.controller.readPositionReady).toBe(false)
      expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(seq)
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
      expect(returned.visible("m31")).toBe(false)
      expect(returned.visible("m42")).toBe(true)
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

  it.each(["covering response", "canonical publication before the covering response"] as const)("takes higher progress from %s through its own qualified latest window", async boundary => {
    const owner = await readingOwner()
    const previousKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m30" })
    const previous = owner.client.getQueryData(previousKey)
    const pending = deferred<ReturnType<typeof fixture>>()
    let view: ReturnType<typeof mountReadingEntry> | undefined
    try {
      expect(submitReadIntentGeneration(owner.lease, { kind: "timeline", channelId: "c1", messageId: "m42", seq: 42 })).not.toBeNull()
      owner.client.removeQueries({ queryKey: communityKeys.channelMessagesWindow("c1", { mode: "newest" }), exact: true })
      load.mockReturnValue(pending.promise)
      view = mountReadingEntry(owner)
      const higher = { channelId: "c1", lastReadMessageId: "m100", lastReadSeq: 100, lastReadAt: "2026-10-01T00:01:40.000Z" }
      const response = fixture()
      response.messages = [{ ...response.messages[0], id: "m100", seq: 100, createdAt: higher.lastReadAt }]
      response.readState = boundary === "covering response" ? higher : { ...response.readState, lastReadMessageId: "m30", lastReadSeq: 30 }
      response.readStateRevision = boundary === "covering response" ? 5 : 4
      response.newBoundary = { afterSeq: 30, target: { id: "m31", channelId: "c1", seq: 31, authorId: "peer" } }
      response.page = { ...response.page, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 100 }
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1&window=tail&newAfterSeq=30"])
      await act(async () => {
        if (boundary !== "covering response") ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [higher] })
        pending.resolve(response)
      })
      resize()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(100)
      expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(100)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.visible("m100")).toBe(true)
      expect(view.latest.newDividerBefore).toBe("m31")
      expect(owner.client.getQueryData(previousKey)).toBe(previous)
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
      const current = fixture()
      current.messages = [{ ...current.messages[0], id: "m42", seq: 42 }]
      current.readState = owner.read42
      current.readStateRevision = 5
      current.page.latestSeq = 42
      current.newBoundary = { afterSeq: 42, target: null }
      load.mockResolvedValue(current)
      view = mountReadingEntry(owner)
      expect(view.latest.feed.initialPositionMessageId).toBeNull()
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(42)
      await act(async () => {})
      resize()
      expect(view.latest.newDividerBefore).toBeUndefined()
      expect(view.visible("m42")).toBe(true)
      expect(load).toHaveBeenCalledOnce()
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

  it("preserves the actual cached reader and history boundary while a newer tail reconciles", async () => {
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
    fresh.selection = { reason: "tail", anchorMessageId: null }
    fresh.newBoundary = { afterSeq: 60, target: { id: "m61", channelId: "c1", seq: 61, authorId: "peer" } }
    fresh.channel.messageCount = 80
    fresh.channel.lastMessageAt = fresh.messages.at(-1)!.createdAt
    fresh.page = { olderCursor: "older", newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 }
    await act(async () => {
      ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [read60] })
      ingestMessages(owner.registry, "c1", [fresh.messages.at(-1)!])
      owner.runtime.messageStream.actions.dispatch({ kind: "channel", id: "c1", serverId: "s1" }, {
        type: "wsMessage", message: fresh.messages.at(-1)!,
      })
    })
    load.mockImplementation((url: string) => {
      if (url.includes("/messages?entry=1")) return entryRead.promise
      if (url.includes("/messages?since=")) return Promise.resolve({ ...fresh.page, hasMoreOlder: false, olderCursor: null,
        messages: Array.from({ length: 38 }, (_, index) => ({ ...fresh.messages[0], id: `m${index + 43}`, seq: index + 43 })), profiles: fresh.profiles })
      throw new Error(`Unexpected history transport ${url}`)
    })
    const view = mountReadingEntry(owner)
    try {
      act(() => {
        view.root.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000, bubbles: true }))
        view.root.scrollTo({ top: 1000 })
      })
      resize()
      const viewport = view.root.getBoundingClientRect()
      const reader = [...view.root.querySelectorAll<HTMLElement>("[data-msg-id]")].find(row => row.getBoundingClientRect().bottom > viewport.top + 1)!
      const readerOffset = reader.getBoundingClientRect().top - viewport.top
      expect(view.latest.feed.messages.map(message => message.id)).toEqual([...Array.from({ length: 42 }, (_, index) => `m${index + 1}`), "m80"])
      expect(view.latest.feed.initialPositionKnown).toBe(false)
      expect(owner.client.getQueryData(previousKey)).toBe(previousWindow)
      expect(view.latest.feed.readSnapshot?.lastReadSeq).toBe(60)
      expect(view.latest.feed.isLoading).toBe(false)
      expect(view.latest.feed.initialDisplayReady).toBe(true)
      expect(view.latest.controller.initialPosition.contentVisible).toBe(true)
      expect(view.latest.controller.initialPosition.showSkeleton).toBe(false)
      expect(view.latest.controller.readPositionReady).toBe(false)
      expect(view.latest.feed.hasMoreOlder).toBe(false)
      expect(view.latest.feed.historyStartKnown).toBe(true)
      expect(view.latest.controller.items.some(item => item.kind === "leading")).toBe(true)
      await act(async () => entryRead.resolve(fresh))
      resize()
      expect(view.latest.feed.initialPositionKnown).toBe(true)
      expect(view.latest.feed.hasMoreOlder).toBe(false)
      expect(view.latest.feed.historyStartKnown).toBe(true)
      expect(owner.client.getQueryData(previousKey)).toBe(previousWindow)
      expect(view.latest.feed.messages.map(message => message.id)).toEqual(Array.from({ length: 80 }, (_, index) => `m${index + 1}`))
      expect(Math.abs(reader.getBoundingClientRect().top - view.root.getBoundingClientRect().top - readerOffset)).toBeLessThanOrEqual(1)
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
    await publishAccountAttentionSnapshot(client, {
      snapshot: { resources: resourceBundleFixture(), scopes: [{ scopeId: packet.channelId, channelId: packet.channelId, serverId: packet.channel.serverId,
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
      expect(load.mock.calls[0][0]).toBe("/api/community/channels/c1/messages?entry=1&window=tail&newAfterSeq=1")
      expect(hook.result.current.window).toBe(selected)
      const fresh = { ...packet, channel: { ...packet.channel, messageCount: 2 }, messages: [...packet.messages, { ...packet.messages[0], id: "m2", seq: 2, content: "New message" }], page: { ...packet.page, latestSeq: 2 },
        newBoundary: { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } } }
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
      if (reason === "cancel") await client.cancelQueries({ queryKey: [...original.windowKey, "reconcile"], exact: true })
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

describe("first body frame after actual disk save and a fresh owner", () => {
  it.each(["preview-only", "single", "empty", "complete"] as const)("keeps %s membership through a held entry, failure and reconciliation", async kind => {
    const account = `body-frame-${crypto.randomUUID()}`
    const source = await createCommunityQueryOwner(account)
    const forum = channelResourceFixture({ id: "forum", serverId: "s1", type: "forum", creatorId: account })
    const post = channelResourceFixture({ id: "post", serverId: "s1", type: "thread", parentChannelId: "forum", parentMessageId: "title", creatorId: account })
    const title = messageResourceFixture({ id: "title", channelId: "forum", authorId: "peer", content: "Saved title" })
    const body = messageResourceFixture({ id: "preview-body", channelId: "post", authorId: "peer", content: "Saved preview body" })
    await publishCommunityResourceBundle(source.client, fullResourceBundleFixture(account,
      [serverResourceFixture({ id: "s1", ownerId: account })], [forum, post], [title, body], [profileResourceFixture({ id: account }), profileResourceFixture({ id: "peer" })]), { token: captureCommunityLiveSnapshotToken(source.client) })
    const forumKey = communityKeys.forumFeed("forum", null)
    const page = normalizeThreadResources("forum", forumFeedScenarioFixture("forum", { serverId: "s1", parentType: "forum", hasMore: false,
      threads: [{ id: "post", creatorId: account, parentMessageId: "title" }], included: { parentMessages: [title], firstMessages: [body] } }))
    await publishCommunityForumFeed(source.client, "forum", page, { token: captureCommunityLiveSnapshotToken(source.client) })
    source.client.setQueryData(forumKey, { pages: [forumFeedWindow(page)], pageParams: [null] })
    const packet = conversationEntryFromChannel(CommunityChannelResourceSchema.strip().parse(source.registry.collections.channels.get("post")), account)
    packet.profiles = [...source.registry.collections.profiles.values()].map(row => CommunityResourceProfileSchema.strip().parse(row))
    const count = kind === "empty" ? 0 : kind === "single" ? 1 : 3
    packet.messages = Array.from({ length: count }, (_, i) => messageResourceFixture({ id: `actual-${i + 1}`, channelId: "post", authorId: "peer", seq: i + 2, content: `Actual body ${i + 1}` }))
    packet.page.latestSeq = count ? count + 1 : 0
    packet.channel.messageCount = count
    if (kind !== "preview-only") await seedConversationEntry(source.client, packet)
    const writer = createIdbPersister(account), reader = createIdbPersister(account)
    let view: ReturnType<typeof render> | undefined
    let installed = false
    try {
      await writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
      writer.stopPersisting()
      await source.registry.cleanup()
      source.client.clear()
      const next = await createCommunityQueryOwner(account)
      const restore = createCommunityRestorePersister(reader, account)
      await persistQueryClientRestore({ queryClient: next.client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
      const input = restore.takeCollections()
      await restoreCommunityCollections(next.registry, input)
      next.registry.captureRestoredCollections(input)
      next.registry.runtime.ws.actions.activateProfileAccount(account)
      discardCommunityRestoreReplacements(next.registry)
      restoreConversationDisplayWindows(next.registry, input)
      expect(next.registry.collections.messages.get("preview-body")?.content).toBe("Saved preview body")
      expect(next.client.getQueryData(forumKey)).toBeDefined()
      expect(next.registry).not.toBe(source.registry)
      const held = deferred<typeof packet>()
      load.mockImplementation((_url, options?: { signal?: AbortSignal }) => { options?.signal?.addEventListener("abort", () => held.reject(new DOMException("Aborted", "AbortError")), { once: true }); return held.promise })
      let feed!: ReturnType<typeof useMessages>
      function Body() {
        feed = useMessages("post", { serverId: "s1" })
        return <MessageList channel="Post" variant="channel" messages={feed.messages} loading={feed.isLoading}
          initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError} initialScrollReady={feed.initialDisplayReady}
          preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
          positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
          messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage} latestSeq={feed.latestSeq}
          hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer} historyStartKnown={feed.historyStartKnown} onUserTakeover={feed.onUserTakeover}
          onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
      }
      installMessageScrollFixture(); installed = true
      view = render(<QueryClientProvider client={next.client}><CommunityDbProvider registry={next.registry}><Body /></CommunityDbProvider></QueryClientProvider>)
      resize()
      expect(load).toHaveBeenCalled()
      const expected = kind === "preview-only" ? [] : packet.messages.map(row => row.id)
      expect(feed.messages.map(row => row.id)).toEqual(expected)
      expect(view.container.querySelector('[data-msg-id="preview-body"]')).toBeNull()
      if (kind === "preview-only") expect(view.container.querySelector("[data-message-list-skeleton]")).toBeVisible()
      else {
        expect(view.container.querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
        expect(view.getByTestId("community-message-scroller")).toHaveAttribute("aria-busy", "false")
      }
      for (const id of expected) expect(view.container.querySelector(`[data-msg-id="${id}"]`)).not.toBeNull()
      expect(feed.readSnapshotFetching).toBe(true)
      expect(feed.initialPositionKnown).toBe(false)
      await act(async () => { held.reject(new Error("Entry unavailable")); await vi.advanceTimersByTimeAsync(2000) })
      resize()
      expect(feed.messages.map(row => row.id)).toEqual(expected)
      expect(view.container.querySelector('[data-msg-id="preview-body"]')).toBeNull()
      if (kind === "preview-only") expect(view.getByRole("button", { name: "Retry" })).toBeVisible()
      else expect(view.getByTestId("community-message-scroller")).toHaveAttribute("aria-busy", "false")
      load.mockImplementation(() => Promise.resolve(packet))
      await act(async () => { feed.retryInitialLoad(); await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(feed.messages.map(row => row.id)).toEqual(packet.messages.map(row => row.id))
      expect(view.getByTestId("community-message-scroller")).toHaveAttribute("aria-busy", "false")
      for (const id of packet.messages.map(row => row.id)) expect(view.container.querySelector(`[data-msg-id="${id}"]`)).not.toBeNull()
      if (kind === "empty") {
        await act(async () => { await vi.waitFor(() => expect(feed.historyStartKnown).toBe(true)) })
        resize()
        expect(view.getByRole("heading", { name: /^Post$/ })).toBeVisible()
      }
    } finally {
      view?.unmount()
      if (installed) restoreMessageScrollFixture()
      writer.stopPersisting(); reader.stopPersisting()
      await clearPersistedCache(account)
    }
  })
})

describe("cache-first New boundary and jump", () => {
  it("derives entry newBoundary immediately from continuous cache and contiguous WS rows while entry=1 is held, then retires on server deletion", async () => {
    const owner = await setup()
    const base = fixture()
    base.messages = [
      { ...base.messages[0], id: "m1", seq: 1, authorId: "viewer", createdAt: "2026-10-01T00:00:01.000Z" },
      { ...base.messages[0], id: "m2", seq: 2, authorId: "peer", createdAt: "2026-10-01T00:00:02.000Z" },
    ]
    base.profiles = [...base.profiles, profileResourceFixture({ id: "viewer", name: "Viewer" })]
    base.readState = { channelId: "c1", lastReadMessageId: "m1", lastReadSeq: 1, lastReadAt: base.messages[0].createdAt }
    base.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 2 }
    base.newBoundary = { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } }
    await owner.publish(base)
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })

    const held = deferred<typeof base>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" }), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(load).toHaveBeenCalledOnce())
      expect(hook.result.current.messages.map(message => message.id)).toEqual(["m1", "m2"])
      expect(hook.result.current.newBoundary).toEqual({
        afterSeq: 1,
        target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" },
      })
      expect(hook.result.current.retiredNewTargetId).toBeUndefined()

      const deletedOnServer = {
        ...base,
        messages: [base.messages[0]],
        newBoundary: { afterSeq: 1, target: null },
      }
      await act(async () => held.resolve(deletedOnServer))
      await waitFor(() => expect(hook.result.current.retiredNewTargetId).toBe("m2"))
    } finally {
      hook.unmount()
      owner.client.clear()
    }
  })

  it("keeps cross-page unread falling back to server entry=1 when afterSeq precedes the cached newest window", async () => {
    const owner = await setup()
    const base = fixture()
    base.messages = Array.from({ length: 10 }, (_, index) => ({
      ...base.messages[0],
      id: `m${index + 51}`,
      seq: index + 51,
      authorId: "peer",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 51)).toISOString(),
    }))
    base.readState = { channelId: "c1", lastReadMessageId: "m5", lastReadSeq: 5, lastReadAt: "2026-10-01T00:00:05.000Z" }
    base.page = { olderCursor: `${base.messages[0].createdAt}|m51`, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 60 }
    base.newBoundary = { afterSeq: 5, target: { id: "m9", channelId: "c1", seq: 9, authorId: "peer" } }
    await owner.publish(base)
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })

    const held = deferred<typeof base>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" }), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(load).toHaveBeenCalledOnce())
      expect(hook.result.current.newBoundary).toBeUndefined()
      await act(async () => held.resolve(base))
      await waitFor(() => expect(hook.result.current.newBoundary).toEqual(base.newBoundary))
    } finally {
      hook.unmount()
      owner.client.clear()
    }
  })

  it("computes readNewBoundary locally with 0 requests when continuous and falls back on gaps without forced staleTime=0", async () => {
    const owner = await setup()
    const base = fixture()
    base.messages = [
      { ...base.messages[0], id: "m1", seq: 1, authorId: "viewer", createdAt: "2026-10-01T00:00:01.000Z" },
      { ...base.messages[0], id: "m2", seq: 2, authorId: "peer", createdAt: "2026-10-01T00:00:02.000Z" },
    ]
    base.profiles = [...base.profiles, profileResourceFixture({ id: "viewer", name: "Viewer" })]
    base.readState = { channelId: "c1", lastReadMessageId: "m2", lastReadSeq: 2, lastReadAt: base.messages[1].createdAt }
    base.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 2 }
    base.newBoundary = { afterSeq: 2, target: null }
    await owner.publish(base)

    const hook = renderHook(() => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" }), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(hook.result.current.positionDataState).toBe("ready"))
      const live3 = { ...base.messages[0], id: "m3", seq: 3, authorId: "peer", createdAt: "2026-10-01T00:00:03.000Z" }
      await act(async () => {
        ingestMessages(owner.registry, "c1", [live3])
        owner.runtime.messageStream.actions.dispatch({ kind: "channel", id: "c1", serverId: "s1" }, { type: "wsMessage", message: live3 })
      })
      const localResult = await hook.result.current.readNewBoundary(2)
      expect(localResult).toEqual({
        boundary: { afterSeq: 2, target: { id: "m3", channelId: "c1", seq: 3, authorId: "peer" } },
        latestSeq: 3,
      })
      expect(load).not.toHaveBeenCalled()

      await act(async () => owner.runtime.ws.actions.setConnectionStatus("reconnecting"))
      const serverFallback = {
        ...base,
        messages: [...base.messages, live3],
        page: { ...base.page, latestSeq: 3 },
        newBoundary: { afterSeq: 2, target: { id: "m3", channelId: "c1", seq: 3, authorId: "peer" } },
      }
      load.mockResolvedValue(serverFallback)
      const fallbackFirst = await hook.result.current.readNewBoundary(2)
      expect(fallbackFirst).toEqual({ boundary: serverFallback.newBoundary, latestSeq: 3 })
      expect(load).toHaveBeenCalledOnce()

      const fallbackReused = await hook.result.current.readNewBoundary(2)
      expect(fallbackReused).toEqual({ boundary: serverFallback.newBoundary, latestSeq: 3 })
      expect(load).toHaveBeenCalledOnce()

      const nullBoundaryEntry = {
        ...base,
        messages: [...base.messages, live3],
        page: { ...base.page, latestSeq: 3 },
        newBoundary: { afterSeq: 3, target: null },
      }
      load.mockResolvedValueOnce(nullBoundaryEntry)
      const nullResult = await hook.result.current.readNewBoundary(3)
      expect(nullResult).toEqual({ boundary: nullBoundaryEntry.newBoundary, latestSeq: 3 })
      expect(load).toHaveBeenCalledTimes(2)

      const live4 = { ...base.messages[0], id: "m4", seq: 4, authorId: "peer", createdAt: "2026-10-01T00:00:04.000Z" }
      await act(async () => {
        ingestMessages(owner.registry, "c1", [live4])
        owner.runtime.messageStream.actions.dispatch({ kind: "channel", id: "c1", serverId: "s1" }, { type: "wsMessage", message: live4 })
      })
      const refreshedEntry = {
        ...base,
        messages: [...base.messages, live3, live4],
        page: { ...base.page, latestSeq: 4 },
        newBoundary: { afterSeq: 3, target: { id: "m4", channelId: "c1", seq: 4, authorId: "peer" } },
      }
      load.mockResolvedValueOnce(refreshedEntry)
      const staleRefreshed = await hook.result.current.readNewBoundary(3)
      expect(staleRefreshed).toEqual({ boundary: refreshedEntry.newBoundary, latestSeq: 4 })
      expect(load).toHaveBeenCalledTimes(3)
    } finally {
      hook.unmount()
      owner.client.clear()
    }
  })

  it("switches loadNewTarget directly to another qualified cached window with 0 requests and falls back on miss or unqualified cache", async () => {
    const owner = await setup()
    const newest = fixture()
    newest.messages = [
      { ...newest.messages[0], id: "m50", seq: 50, authorId: "peer", createdAt: "2026-10-01T00:00:50.000Z" },
    ]
    newest.readState = { channelId: "c1", lastReadMessageId: "m5", lastReadSeq: 5, lastReadAt: "2026-10-01T00:00:05.000Z" }
    newest.page = { olderCursor: "old50", newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 50 }
    newest.newBoundary = { afterSeq: 5, target: { id: "m10", channelId: "c1", seq: 10, authorId: "peer" } }
    await owner.publish(newest)

    const anchorTarget = { ...target, anchorMessageId: "m10" }
    const anchorPacket = {
      ...newest,
      selection: { reason: "explicit_anchor" as const, anchorMessageId: "m10" },
      messages: [{ ...newest.messages[0], id: "m10", seq: 10, authorId: "peer", createdAt: "2026-10-01T00:00:10.000Z" }],
      page: { olderCursor: "old10", newerCursor: "new10", hasMoreOlder: true, hasMoreNewer: true, latestSeq: 50 },
    }
    await publishConversationEntry(owner.client, anchorTarget, anchorPacket, { token: captureCommunityLiveSnapshotToken(owner.client, "c1") })

    const brokenKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m20" })
    owner.client.setQueryData(brokenKey, {
      pages: [{ messages: [{ id: "m20", seq: 20 }], hasMoreOlder: true, hasMoreNewer: true, latestSeq: 50 }],
      pageParams: [{ mode: "anchor", anchor: "m20" }],
    })

    const hook = renderHook(() => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" }), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(hook.result.current.positionDataState).toBe("ready"))
      expect(hook.result.current.messages.map(message => message.id)).toEqual(["m50"])

      let hitRequest!: ReturnType<typeof hook.result.current.loadNewTarget>
      act(() => { hitRequest = hook.result.current.loadNewTarget("m10") })
      expect(hitRequest.accepted).toBe(true)
      if (!hitRequest.accepted) throw new Error("Expected cached loadNewTarget to be accepted")
      expect((await hitRequest.completed).status).toBe("success")
      await waitFor(() => expect(hook.result.current.messages.map(message => message.id)).toEqual(["m10"]))
      expect(load).not.toHaveBeenCalled()

      const m20 = { ...newest.messages[0], id: "m20", seq: 20, authorId: "peer", createdAt: "2026-10-01T00:00:20.000Z" }
      load.mockResolvedValue({
        messages: [m20],
        profiles: newest.profiles,
        hasMoreOlder: true,
        hasMoreNewer: true,
        olderCursor: "old20",
        newerCursor: "new20",
        latestSeq: 50,
      })
      let missRequest!: ReturnType<typeof hook.result.current.loadNewTarget>
      act(() => { missRequest = hook.result.current.loadNewTarget("m20") })
      expect(missRequest.accepted).toBe(true)
      if (!missRequest.accepted) throw new Error("Expected unqualified cached loadNewTarget to refetch")
      expect((await missRequest.completed).status).toBe("success")
      await waitFor(() => expect(hook.result.current.messages.map(message => message.id)).toEqual(["m20"]))
      expect(load).toHaveBeenCalledOnce()
      expect(load.mock.calls[0][0]).toBe("/api/community/channels/c1/messages?anchor=m20")

      let backToNewest!: ReturnType<typeof hook.result.current.loadNewTarget>
      act(() => { backToNewest = hook.result.current.loadNewTarget("m50") })
      expect(backToNewest.accepted).toBe(true)
      if (!backToNewest.accepted) throw new Error("Expected cached newest switch to be accepted")
      expect((await backToNewest.completed).status).toBe("success")
      await waitFor(() => expect(hook.result.current.messages.map(message => message.id)).toEqual(["m50"]))
      expect(load).toHaveBeenCalledOnce()
    } finally {
      hook.unmount()
      owner.client.clear()
    }
  })

  it("derives provisional newBoundary on warm re-entry when input.newAfterSeq is null and retires it on cross-device read advance", async () => {
    const owner = await setup()
    const old = dmConversationEntryFixture()
    old.messages = [
      { ...old.messages[0], id: "m1", seq: 1, authorId: "viewer", createdAt: "2026-10-01T00:00:01.000Z" },
      { ...old.messages[0], id: "m2", seq: 2, authorId: "peer", createdAt: "2026-10-01T00:00:02.000Z" },
    ]
    old.profiles = [...old.profiles, profileResourceFixture({ id: "viewer", name: "Viewer" })]
    old.readState = { channelId: "c1", lastReadMessageId: "m1", lastReadSeq: 1, lastReadAt: old.messages[0].createdAt }
    old.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 2 }
    old.newBoundary = { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } }
    load.mockResolvedValue(old)

    let showBody = true
    let body: ReturnType<typeof useDmMessages> | undefined
    const navigation = { entryIntent: { href: "/c/me/c1" } }
    function Body() { body = useDmMessages("c1", { viewerUserId: "viewer" }); return null }
    function Route() { useChannelMetadata(null, "c1"); return showBody ? createElement(Body) : null }
    const tree = () => createElement(CommunityRouteContext, { value: { navigation } as never }, createElement(Route))
    const view = render(tree(), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(body?.newBoundary?.target?.id).toBe("m2"))
      showBody = false
      navigation.entryIntent = { href: "/c/me" }
      view.rerender(tree())

      const fresh = {
        ...old,
        readState: { ...old.readState, lastReadMessageId: "m2", lastReadSeq: 2, lastReadAt: old.messages[1].createdAt },
        readStateRevision: 5,
        newBoundary: { afterSeq: 2, target: null },
      }
      const held = deferred<typeof fresh>()
      load.mockReturnValue(held.promise)
      let refresh!: Promise<void>
      act(() => { refresh = owner.client.invalidateQueries({ queryKey: communityKeys.conversationEntries("c1") }) })
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      expect(new URL(load.mock.calls[1][0], "https://test.invalid").searchParams.has("newAfterSeq")).toBe(false)

      showBody = true
      navigation.entryIntent = { href: "/c/me/c1" }
      view.rerender(tree())
      expect(body?.messages.map(message => message.id)).toEqual(["m1", "m2"])
      expect(body?.newBoundary).toEqual({
        afterSeq: 1,
        target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" },
      })
      expect(body?.retiredNewTargetId).toBeUndefined()

      await act(async () => { held.resolve(fresh); await refresh })
      await waitFor(() => expect(body?.isFetching).toBe(false))
      expect(body?.newBoundary).toEqual({ afterSeq: 2, target: null })
      expect(body?.retiredNewTargetId).toBe("m2")
    } finally {
      view.unmount()
      owner.client.clear()
    }
  })

  it("keeps readSnapshotFetching false while entry=1 is held when contiguous WS liveIds cover knownConversationLatestSeq, and pending on real gap", async () => {
    const owner = await setup()
    const base = fixture()
    base.messages = Array.from({ length: 16 }, (_, index) => ({
      ...base.messages[0],
      id: `m${index + 1}`,
      seq: index + 1,
      authorId: "viewer",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
    }))
    base.profiles = [...base.profiles, profileResourceFixture({ id: "viewer", name: "Viewer" })]
    base.readState = { channelId: "c1", lastReadMessageId: "m16", lastReadSeq: 16, lastReadAt: base.messages[15].createdAt }
    base.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 16 }
    base.newBoundary = { afterSeq: 16, target: null }
    await owner.publish(base)

    const liveBatch = Array.from({ length: 12 }, (_, index) => ({
      ...base.messages[0],
      id: `m${index + 17}`,
      seq: index + 17,
      authorId: "peer",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 17)).toISOString(),
    }))
    await act(async () => {
      ingestMessages(owner.registry, "c1", liveBatch)
      for (const message of liveBatch) {
        owner.runtime.messageStream.actions.dispatch({ kind: "channel", id: "c1", serverId: "s1" }, { type: "wsMessage", message })
      }
      await publishAccountAttentionSnapshot(owner.client, {
        snapshot: {
          resources: resourceBundleFixture(),
          scopes: [{ scopeId: "c1", channelId: "c1", serverId: "s1", ordinaryUnread: true,
            lastUnreadSeq: 28, lastAttentionSeq: null, attentionCount: 0 }],
          items: [], limit: 100, truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
        },
        proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined },
      })
    })
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })

    const held = deferred<typeof base>()
    load.mockReturnValue(held.promise)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" }), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(load).toHaveBeenCalledOnce())
      expect(hook.result.current.isFetching).toBe(true)
      expect(hook.result.current.messages).toHaveLength(28)
      expect(hook.result.current.latestSeq).toBe(28)
      expect(hook.result.current.readSnapshotFetching).toBe(false)
      expect(hook.result.current.positionDataState).toBe("ready")
      expect(hook.result.current.newBoundary).toEqual({
        afterSeq: 16,
        target: { id: "m17", channelId: "c1", seq: 17, authorId: "peer" },
      })

      await act(async () => {
        await publishAccountAttentionSnapshot(owner.client, {
          snapshot: {
            resources: resourceBundleFixture(),
            scopes: [{ scopeId: "c1", channelId: "c1", serverId: "s1", ordinaryUnread: true,
              lastUnreadSeq: 30, lastAttentionSeq: null, attentionCount: 0 }],
            items: [], limit: 100, truncated: false,
            included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
          },
          proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined },
        })
      })
      hook.rerender()
      expect(hook.result.current.latestSeq).toBe(28)
      expect(hook.result.current.readSnapshotFetching).toBe(true)
      expect(hook.result.current.positionDataState).toBe("pending")

      await act(async () => {
        await publishAccountAttentionSnapshot(owner.client, {
          snapshot: {
            resources: resourceBundleFixture(),
            scopes: [{ scopeId: "c1", channelId: "c1", serverId: "s1", ordinaryUnread: true,
              lastUnreadSeq: 28, lastAttentionSeq: null, attentionCount: 0 }],
            items: [], limit: 100, truncated: false,
            included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
          },
          proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined },
        })
      })
      hook.rerender()
      expect(hook.result.current.readSnapshotFetching).toBe(false)
      expect(hook.result.current.positionDataState).toBe("ready")

      await act(async () => {
        const gapped = {
          ...base.messages[0],
          id: "m30",
          seq: 30,
          authorId: "peer",
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 30)).toISOString(),
        }
        ingestMessages(owner.registry, "c1", [gapped])
        owner.runtime.messageStream.actions.dispatch({ kind: "channel", id: "c1", serverId: "s1" }, { type: "wsMessage", message: gapped })
      })
      await waitFor(() => expect(hook.result.current.readSnapshotFetching).toBe(true))
      expect(hook.result.current.positionDataState).toBe("pending")
    } finally {
      hook.unmount()
      owner.client.clear()
    }
  })

  it("covers warm DM re-entry with input.newAfterSeq === null when read pointer and unread message are in contiguous WS liveIds", async () => {
    const owner = await setup()
    const base = dmConversationEntryFixture()
    base.messages = Array.from({ length: 16 }, (_, index) => ({
      ...base.messages[0],
      id: `m${index + 1}`,
      seq: index + 1,
      authorId: "peer",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
    }))
    base.profiles = [...base.profiles, profileResourceFixture({ id: "viewer", name: "Viewer" })]
    base.readState = { channelId: "c1", lastReadMessageId: "m16", lastReadSeq: 16, lastReadAt: base.messages[15].createdAt }
    base.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 16 }
    base.newBoundary = { afterSeq: 16, target: null }
    load.mockResolvedValue(base)

    let showBody = true
    let body: ReturnType<typeof useDmMessages> | undefined
    const navigation = { entryIntent: { href: "/c/me/c1" } }
    function Body() { body = useDmMessages("c1", { viewerUserId: "viewer" }); return null }
    function Route() { useChannelMetadata(null, "c1"); return showBody ? createElement(Body) : null }
    const tree = () => createElement(CommunityRouteContext, { value: { navigation } as never }, createElement(Route))
    const view = render(tree(), { wrapper: owner.wrapper })
    try {
      await waitFor(() => expect(body?.messages).toHaveLength(16))
      const livePeer = [
        { ...base.messages[0], id: "m17", seq: 17, authorId: "peer", createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 17)).toISOString() },
        { ...base.messages[0], id: "m18", seq: 18, authorId: "peer", createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 18)).toISOString() },
      ]
      await act(async () => {
        ingestMessages(owner.registry, "c1", livePeer)
        for (const message of livePeer) {
          owner.runtime.messageStream.actions.dispatch({ kind: "dm", id: "c1" }, { type: "wsMessage", message })
        }
        ingestReadStateSnapshot(owner.registry, {
          revision: 5,
          readStates: [{ channelId: "c1", lastReadMessageId: "m17", lastReadSeq: 17, lastReadAt: livePeer[0].createdAt }],
        })
      })
      showBody = false
      navigation.entryIntent = { href: "/c/me" }
      view.rerender(tree())

      const confirmed = {
        ...base,
        messages: [...base.messages, ...livePeer],
        readState: { channelId: "c1", lastReadMessageId: "m17", lastReadSeq: 17, lastReadAt: livePeer[0].createdAt },
        readStateRevision: 5,
        page: { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 18 },
        newBoundary: { afterSeq: 17, target: { id: "m18", channelId: "c1", seq: 18, authorId: "peer" } },
      }
      const held = deferred<typeof confirmed>()
      load.mockReturnValue(held.promise)
      let refresh!: Promise<void>
      act(() => { refresh = owner.client.invalidateQueries({ queryKey: communityKeys.conversationEntries("c1") }) })
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      expect(new URL(load.mock.calls[1][0], "https://test.invalid").searchParams.has("newAfterSeq")).toBe(false)

      showBody = true
      navigation.entryIntent = { href: "/c/me/c1" }
      view.rerender(tree())
      expect(body?.isFetching).toBe(true)
      expect(body?.latestSeq).toBe(18)
      expect(body?.readSnapshotFetching).toBe(false)
      expect(body?.positionDataState).toBe("ready")
      expect(body?.newBoundary).toEqual({
        afterSeq: 17,
        target: { id: "m18", channelId: "c1", seq: 18, authorId: "peer" },
      })

      await act(async () => { held.resolve(confirmed); await refresh })
      await waitFor(() => expect(body?.isFetching).toBe(false))
      expect(body?.newBoundary?.target?.id).toBe("m18")
      expect(body?.retiredNewTargetId).toBeUndefined()
    } finally {
      view.unmount()
      owner.client.clear()
    }
  })
})

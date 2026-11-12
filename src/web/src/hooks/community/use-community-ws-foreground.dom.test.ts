import { messageReadPageFixture } from "@/test/community-resource-fixtures"
import { messageResourceFixture, currentCommunityEventFixture } from "@/test/community-resource-fixtures"
import { getCapturedRuntime } from "./community-ws/test-harness"
import { act } from "@/test/react-dom-harness"
import { conversationEntryFixture, conversationEntryTarget } from "@/test/conversation-entry-fixtures"
import { conversationEntryOptions, publishConversationEntry } from "@/lib/community/conversation-entry"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useMessages } from "./use-messages"
import { canonicalRegistry } from "./community-ws/test-harness"
import { reconcileCommunityWsReconnect } from "./community-ws/reconnect"
import { communityWsReconnectPolicies } from "./community-ws/registry"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryObserver } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { messageWindowPage } from "@/lib/community/models/message"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  capturedOnMessage,
  capturedOnReconnect,
  capturedQueryClient,
  capturedUseUserWsOptions,
  cleanupCommunityWsHarness,
  flushEffects,
  getCommunityApiFetchMock,
  messageCreate,
  mountHook,
  mountCanonicalHook,
  resetCommunityWsHarness,
  resetHookMemoization,
  unmountHook,
  seedCanonicalMessages,
} from "./community-ws/test-harness"

const subscriptions: Array<() => void> = []
const message = (channelId: string, id: string, seq = 1) => messageResourceFixture({
  channelId,
  id, seq, type: "chat" as const, content: id, authorId: "author",
  createdAt: `2026-08-15T00:00:0${seq}.000Z`,
})
const page = (channelId: string, id: string) => (messageReadPageFixture({ messages: [message(channelId, id)], latestSeq: 1, hasMore: false }))

function seed(id: string, kind: "channel" | "dm" = "channel") {
  const key = kind === "channel" ? communityKeys.channelMessages(id) : communityKeys.dmMessages(id)
  seedCanonicalMessages(id, [message(id, `old-${id}`)])
  capturedQueryClient.setQueryData(key, { pages: [messageWindowPage(page(id, `old-${id}`))], pageParams: [{ mode: "newest" }] })
  const observer = new QueryObserver(capturedQueryClient, {
    queryKey: key,
    queryFn: async () => ({ pages: [messageWindowPage(page(id, `query-${id}`))], pageParams: [{ mode: "newest" }] }),
    staleTime: Infinity,
  })
  subscriptions.push(observer.subscribe(() => undefined))
  return key
}

async function mountWarmEntryRecovery(recover: (fresh: ReturnType<typeof conversationEntryFixture>) => Promise<ReturnType<typeof conversationEntryFixture>>) {
  const packet = conversationEntryFixture()
  packet.viewerId = "u_me"
  packet.channel.creatorId = "u_me"
  const target = conversationEntryTarget
  await act(async () => {
    const resource = await publishConversationEntry(capturedQueryClient, target, packet, {
      token: captureCommunityLiveSnapshotToken(capturedQueryClient, target.channelId),
    })
    capturedQueryClient.setQueryData(conversationEntryOptions(capturedQueryClient, target).queryKey, resource, { updatedAt: Date.now() - 6000 })
    getCapturedRuntime().ui.actions.subscribe({ channelId: target.channelId })
  })
  const fresh = { ...packet, messages: [...packet.messages, { ...packet.messages[0], id: "m2", seq: 2, content: "Foreground body" }],
    page: { ...packet.page, latestSeq: 2 },
    newBoundary: { afterSeq: 1, target: { id: "m2", seq: 2, channelId: target.channelId, authorId: "peer" } },
  }
  const entries: Array<{ path: string; signal: AbortSignal | undefined }> = []
  getCommunityApiFetchMock().mockImplementation(async (path, options) => {
    if (String(path).includes("entry=1")) {
      entries.push({ path: String(path), signal: (options as { signal?: AbortSignal } | undefined)?.signal })
      if (entries.length === 1) throw new ConversationReadTimeoutError()
      return recover(fresh)
    }
    if (path === "/api/community/channels/c1/messages") {
      return messageReadPageFixture({ ...fresh.page, messages: fresh.messages, profiles: fresh.profiles })
    }
    throw new Error(`unexpected entry recovery request: ${String(path)}`)
  })
  const feed = await mountCanonicalHook(() => useMessages(target.channelId, { serverId: target.serverId }))
  await vi.waitFor(() => expect(feed.result.current.targetLoadError).toBeInstanceOf(ConversationReadTimeoutError))
  await mountHook({ viewerUserId: "u_me" })
  flushEffects()
  const entryQuery = capturedQueryClient.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries(target.channelId), type: "active" })[0]!
  return { feed, fresh, entries, entryQuery }
}

beforeEach(resetCommunityWsHarness)
afterEach(async () => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
  await cleanupCommunityWsHarness()
})

describe("community foreground message reconciliation", () => {
  it("recovers entry metadata and public New admission after a warm timeout and foreground window publication", async () => {
    const packet = conversationEntryFixture()
    packet.viewerId = "u_me"
    packet.channel.creatorId = "u_me"
    const client = capturedQueryClient
    const target = conversationEntryTarget
    const resource = await publishConversationEntry(client, target, packet, {
      token: captureCommunityLiveSnapshotToken(client, target.channelId),
    })
    client.setQueryData(conversationEntryOptions(client, target).queryKey, resource, { updatedAt: Date.now() - 6000 })
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: target.channelId }) })
    let rejectEntry!: (error: Error) => void
    const entryTransport = new Promise<never>((_, reject) => { rejectEntry = reject })
    const fresh = { ...packet, messages: [...packet.messages, { ...packet.messages[0], id: "m2", seq: 2, content: "Foreground body" }],
      page: { ...packet.page, latestSeq: 2 },
      newBoundary: { afterSeq: 1, target: { id: "m2", seq: 2, channelId: target.channelId, authorId: "peer" } },
    }
    const requests: Array<Record<string, unknown>> = []
    let entryRequests = 0
    getCommunityApiFetchMock().mockImplementation(async (path, options) => {
      const request = { order: requests.length + 1, path: String(path),
        observation: (options as { observation?: unknown } | undefined)?.observation,
        account: (options as { authenticationAccount?: string } | undefined)?.authenticationAccount,
        result: "pending" }
      requests.push(request)
      if (String(path).includes("entry=1")) {
        entryRequests += 1
        if (entryRequests === 1) {
          try { return await entryTransport } finally { request.result = "ConversationReadTimeoutError" }
        }
        request.result = "authoritative-entry"
        return fresh
      }
      if (path === "/api/community/channels/c1/messages") {
        request.result = "message-window"
        return messageReadPageFixture({ ...fresh.page, messages: fresh.messages, profiles: fresh.profiles })
      }
      throw new Error(`unexpected combined recovery request: ${String(path)}`)
    })
    const feed = await mountCanonicalHook(() => useMessages(target.channelId, { serverId: target.serverId }))
    const samples: Array<Record<string, unknown>> = []
    const sample = (phase: string) => {
      const current = feed.result.current
      const value = { phase, account: getCapturedRuntime().ws.get().profileViewerId,
        ids: current.messages.map(row => row.id), windowIds: current.messageWindow?.pages.flatMap(page => page.messages.map(row => row.id)),
        originalWindow: current.messageWindow === originalWindow,
        displayReady: current.initialDisplayReady, positionKnown: current.initialPositionKnown,
        positionDataState: current.positionDataState, targetPositionDataState: current.targetPositionDataState,
        targetError: current.targetLoadError?.name ?? null, initialError: current.initialLoadError?.name ?? null,
        entryCanRead: current.entryCanRead, readSnapshotFetching: current.readSnapshotFetching,
        readSnapshot: current.readSnapshot, boundary: current.newBoundary ?? "unqualified",
      }
      samples.push(value)
      return value
    }
    const originalWindow = feed.result.current.messageWindow
    try {
      await vi.waitFor(() => expect(entryRequests).toBe(1))
      const refreshing = sample("warm-entry-refresh-held")
      expect(refreshing.ids).toEqual(["m1"])
      expect(refreshing.displayReady).toBe(true)
      await mountHook({ viewerUserId: "u_me" })
      flushEffects()
      await act(async () => { rejectEntry(new ConversationReadTimeoutError()) })
      await vi.waitFor(() => expect(feed.result.current.targetLoadError).toBeInstanceOf(ConversationReadTimeoutError))
      const failed = sample("entry-timeout-body-retained")
      expect(failed.ids).toEqual(["m1"])
      expect(failed.originalWindow).toBe(true)
      expect(failed.displayReady).toBe(true)
      expect(failed.boundary).toBe("unqualified")
      await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
      await vi.waitFor(() => expect(feed.result.current.messages.map(row => row.id)).toEqual(["m1", "m2"]))
      const foreground = sample("foreground-window-published")
      let newRead!: Awaited<ReturnType<typeof feed.result.current.readNewBoundary>>
      await act(async () => { newRead = await feed.result.current.readNewBoundary(1) })
      const newLoad = feed.result.current.loadNewTarget("m2")
      sample("after-public-new-read-and-load")
      console.info("entry-foreground317-public " + JSON.stringify({ newRead: newRead ?? null, newLoadAccepted: newLoad.accepted }))
      expect(foreground.windowIds).toEqual(["m1", "m2"])
      expect(foreground.entryCanRead).toBe(true)
      expect(feed.result.current.targetLoadError).toBeNull()
      expect(newRead).toEqual({ boundary: fresh.newBoundary, latestSeq: 2 })
      expect(newLoad.accepted).toBe(true)
    } finally {
      console.info("entry-foreground317-observations " + JSON.stringify({ requests, samples }))
    }
  })

  it("keeps cached display and the real entry error when foreground authority recovery also times out", async () => {
    const { feed, entries } = await mountWarmEntryRecovery(async () => { throw new ConversationReadTimeoutError() })
    const snapshot = feed.result.current.readSnapshot
    await act(async () => { await expect(capturedUseUserWsOptions!.onForeground!()).rejects.toThrow("focused messages failed") })
    await vi.waitFor(() => expect(feed.result.current.messages.map(row => row.id)).toEqual(["m1", "m2"]))
    expect(feed.result.current.initialDisplayReady).toBe(true)
    expect(feed.result.current.readSnapshot).toEqual(snapshot)
    expect(feed.result.current.positionDataState).toBe("ready")
    expect(feed.result.current.targetLoadError).toBeInstanceOf(ConversationReadTimeoutError)
    expect(feed.result.current.newBoundary).toBeUndefined()
    expect(await feed.result.current.readNewBoundary(1)).toBeUndefined()
    expect(feed.result.current.loadNewTarget("m2").accepted).toBe(false)
    expect(entries).toHaveLength(2)
    expect(entries[1]!.path).toBe(entries[0]!.path)
  })

  it("shares the held entry authority with foreground and reconnect without changing its cutoff or cancelling it", async () => {
    let release!: (value: ReturnType<typeof conversationEntryFixture>) => void
    const held = new Promise<ReturnType<typeof conversationEntryFixture>>(resolve => { release = resolve })
    const { feed, fresh, entries, entryQuery } = await mountWarmEntryRecovery(() => held)
    const snapshot = feed.result.current.readSnapshot
    let foreground!: void | Promise<void>, duplicate!: void | Promise<void>, reconnect!: Promise<unknown>
    act(() => { foreground = capturedUseUserWsOptions!.onForeground!() })
    await vi.waitFor(() => expect(entries).toHaveLength(2))
    act(() => {
      duplicate = capturedUseUserWsOptions!.onForeground!()
      reconnect = reconcileCommunityWsReconnect(capturedQueryClient, 0, {
        excludePolicies: communityWsReconnectPolicies.filter(policy => policy !== "focused-messages"),
      })
    })
    expect(entries).toHaveLength(2)
    expect(entries[1]!.path).toBe(entries[0]!.path)
    expect(entries[1]!.signal?.aborted).toBe(false)
    expect(capturedQueryClient.getQueryCache().get(entryQuery.queryHash)).toBe(entryQuery)
    expect(feed.result.current.messages.some(row => row.id === "m1")).toBe(true)
    expect(feed.result.current.readSnapshot).toEqual(snapshot)
    await act(async () => { release(fresh); await Promise.all([foreground, duplicate, reconnect]) })
    await vi.waitFor(() => expect(feed.result.current.targetLoadError).toBeNull())
    expect(feed.result.current.newBoundary).toEqual(fresh.newBoundary)
    expect(feed.result.current.readSnapshot).toEqual(snapshot)
    expect(entries).toHaveLength(2)
    expect(capturedQueryClient.getQueryCache().get(entryQuery.queryHash)).toBe(entryQuery)
  })

  it.each(["account", "access"] as const)("rejects a held foreground entry after %s retirement", async reason => {
    let release!: (value: ReturnType<typeof conversationEntryFixture>) => void
    const held = new Promise<ReturnType<typeof conversationEntryFixture>>(resolve => { release = resolve })
    const { feed, fresh, entries, entryQuery } = await mountWarmEntryRecovery(() => held)
    let foreground!: void | Promise<void>
    act(() => { foreground = capturedUseUserWsOptions!.onForeground!() })
    const settled = Promise.allSettled([foreground])
    await vi.waitFor(() => expect(entries).toHaveLength(2))
    await act(async () => {
      if (reason === "account") getCapturedRuntime().ws.actions.activateProfileAccount("other")
      else getCapturedRuntime().ws.actions.revokeChannelAccess("s1", "c1")
    })
    const late = { ...fresh, messages: [...fresh.messages, { ...fresh.messages[0], id: "retired-entry-only", seq: 3 }],
      page: { ...fresh.page, latestSeq: 3 },
      newBoundary: { afterSeq: 1, target: { id: "retired-entry-only", channelId: "c1", seq: 3, authorId: "peer" } },
    }
    await act(async () => { release(late); await settled })
    expect(canonicalRegistry!.collections.messages.has("retired-entry-only")).toBe(false)
    expect(feed.result.current.messages.some(row => row.id === "retired-entry-only")).toBe(false)
    expect(feed.result.current.newBoundary?.target?.id).not.toBe("retired-entry-only")
    const entryCalls = entries.length
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    expect(entries).toHaveLength(entryCalls)
    expect(capturedQueryClient.getQueryCache().get(entryQuery.queryHash)?.state.data).not.toMatchObject({ newBoundaryAtEntry: late.newBoundary })
  })

  it("leaves a recovered fresh entry alone on the next foreground", async () => {
    const { feed, entries } = await mountWarmEntryRecovery(async fresh => fresh)
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    await vi.waitFor(() => expect(feed.result.current.targetLoadError).toBeNull())
    expect(entries).toHaveLength(2)
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    expect(entries).toHaveLength(2)
    expect(feed.result.current.messages.map(row => row.id)).toEqual(["m1", "m2"])
  })

  it("does not revive the failed entry after its last consumer leaves", async () => {
    const { feed, entries } = await mountWarmEntryRecovery(async fresh => fresh)
    act(() => feed.unmount())
    getCommunityApiFetchMock().mockClear()
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    expect(entries).toHaveLength(1)
    expect(getCommunityApiFetchMock()).not.toHaveBeenCalled()
  })

  it.each(["split", "dm"] as const)("starts only focused %s messages while transport access is disconnected", async (layout) => {
    const store = getCapturedRuntime().ui.get()
    const secondary = Symbol("parent")
    if (layout === "split") {
      await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "primary" }) })
      await act(async () => { getCapturedRuntime().ui.actions.claimSecondaryChannel(secondary, "parent") })
      seed("primary")
      seed("parent")
    } else {
      await act(async () => { getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm" }) })
      seed("dm", "dm")
    }
    seed("unrelated")
    await mountHook()
    flushEffects()
    await act(async () => { getCapturedRuntime().ws.actions.markAccessDisconnected() })
    getCommunityApiFetchMock().mockImplementation(async (path) => page(String(path).split("/")[4]!, String(path)))
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    const paths = getCommunityApiFetchMock().mock.calls.map(([path]) => path)
    expect(paths).toEqual(layout === "split" ? [
      "/api/community/channels/primary/messages",
      "/api/community/channels/parent/messages",
    ] : ["/api/community/channels/dm/messages"])
    expect(invalidate).not.toHaveBeenCalled()
    if (layout === "split") {
      await act(async () => { getCapturedRuntime().ui.actions.releaseSecondaryChannel(secondary) })
      getCommunityApiFetchMock().mockClear()
      await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
      expect(getCommunityApiFetchMock().mock.calls.map(([path]) => path)).toEqual([
        "/api/community/channels/primary/messages",
      ])
    }
  })

  it("shares a held foreground window with reconnect and a later gap frame without duplicate cancellation", async () => {
    await act(async () => { getCapturedRuntime().ui.actions.setCurrentServerId("server") })
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "focused" }) })
    const key = seed("focused")
    await mountHook()
    flushEffects()
    let release!: (value: unknown) => void
    getCommunityApiFetchMock().mockImplementation(async (path) => {
      if (path === "/api/community/channels/focused/messages") {
        if (release) throw new Error(`unexpected duplicate snapshot: ${JSON.stringify(getCommunityApiFetchMock().mock.calls.map(([url]) => url))}`)
        return new Promise((resolve) => { release = resolve })
      }
      if (String(path).includes("/messages?since=")) return messageReadPageFixture({
        messages: [message("focused", "missed", 2), message("focused", "live", 3)], latestSeq: 3, hasMoreNewer: false,
      })
      if (path === "/api/community/users/me/read-state") return { revision: 0, readStates: [] }
      throw new Error(`unexpected fetch: ${String(path)}`)
    })
    const cancel = vi.spyOn(capturedQueryClient, "cancelQueries")
    let foreground!: void | Promise<void>; act(() => { foreground = capturedUseUserWsOptions!.onForeground!() })
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    let duplicate!: void | Promise<void>, reconnect!: void | Promise<void>
    act(() => { duplicate = capturedUseUserWsOptions!.onForeground!(); reconnect = capturedOnReconnect!({ reconnectDurationMs: 1_000 }) })
    expect(capturedQueryClient.getQueryState([...key, "reconcile"])?.fetchStatus).toBe("fetching")
    const event = messageCreate("focused", "live")
    event.message.seq = 3
    await act(async () => { capturedOnMessage!(currentCommunityEventFixture(event)) })
    await Promise.resolve()
    expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => path === "/api/community/channels/focused/messages")).toHaveLength(1)
    expect(cancel.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(key))).toHaveLength(1)
    await act(async () => { release(page("focused", "snapshot-before-gap")) })
    await act(async () => { await Promise.all([foreground, duplicate, reconnect]) })
    expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => String(path).includes("/channels/focused/messages"))).toHaveLength(2)
    expect(cancel.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(key))).toHaveLength(1)
  })

  it("reconciles a new target independently and never applies the previous target response to it", async () => {
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "a" }) })
    seed("a")
    const currentKey = seed("b")
    await mountHook()
    flushEffects()
    let releaseOld!: (value: unknown) => void
    getCommunityApiFetchMock().mockImplementation(async (path) => {
      if (path === "/api/community/channels/a/messages") return new Promise((resolve) => { releaseOld = resolve })
      if (path === "/api/community/channels/b/messages") return page("b", "current-b")
      throw new Error(`unexpected fetch: ${String(path)}`)
    })
    let old!: void | Promise<void>; act(() => { old = capturedUseUserWsOptions!.onForeground!() })
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"))
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "b" }) })
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    await act(async () => { releaseOld(page("a", "late-a")) })
    await act(async () => { await old })
    expect(capturedQueryClient.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(currentKey)?.pages.flatMap((entry) => entry.messages.map((row) => row.id))).toEqual(["old-b", "current-b"])
  })

  it("does not let an old account callback start work after the same hook renders another account", async () => {
    await act(async () => { getCapturedRuntime().ws.actions.activateProfileAccount("a") })
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "account-target" }) })
    seed("account-target")
    await mountHook({ viewerUserId: "a" })
    flushEffects()
    const old = capturedUseUserWsOptions!.onForeground!
    await act(async () => { getCapturedRuntime().ws.actions.activateProfileAccount("b") })
    await old()
    expect(getCommunityApiFetchMock()).not.toHaveBeenCalled()
    resetHookMemoization()
    await mountHook({ viewerUserId: "b" })
    await old()
    expect(getCommunityApiFetchMock()).not.toHaveBeenCalled()
    getCommunityApiFetchMock().mockResolvedValue(page("account-target", "current-account"))
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    expect(getCommunityApiFetchMock()).toHaveBeenCalledOnce()
  })

  it("does not let a disposed owner start work from an old foreground callback", async () => {
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "disposed" }) })
    seed("disposed")
    await mountHook()
    flushEffects()
    const old = capturedUseUserWsOptions!.onForeground!
    const authenticate = capturedUseUserWsOptions!.onAuthenticated!
    const reconnect = capturedOnReconnect!
    unmountHook()
    await Promise.all([old(), authenticate(), reconnect({ reconnectDurationMs: 1_000 })])
    expect(getCommunityApiFetchMock()).not.toHaveBeenCalled()
  })
})

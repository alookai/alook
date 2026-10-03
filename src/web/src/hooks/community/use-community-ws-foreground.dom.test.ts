import { getCapturedRuntime } from "./community-ws/test-harness"
import { act } from "@/test/react-dom-harness"
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
  resetCommunityWsHarness,
  resetHookMemoization,
  unmountHook,
  seedCanonicalMessages,
} from "./community-ws/test-harness"

const subscriptions: Array<() => void> = []
const message = (id: string, seq = 1) => ({
  id, seq, type: "chat" as const, content: id, authorId: "author",
  createdAt: `2026-08-15T00:00:0${seq}.000Z`,
})
const page = (id: string) => ({ messages: [message(id)], latestSeq: 1, hasMore: false })

function seed(id: string, kind: "channel" | "dm" = "channel") {
  const key = kind === "channel" ? communityKeys.channelMessages(id) : communityKeys.dmMessages(id)
  seedCanonicalMessages(id, [message(`old-${id}`)])
  capturedQueryClient.setQueryData(key, { pages: [messageWindowPage(page(`old-${id}`))], pageParams: [{ mode: "newest" }] })
  const observer = new QueryObserver(capturedQueryClient, {
    queryKey: key,
    queryFn: async () => ({ pages: [messageWindowPage(page(`query-${id}`))], pageParams: [{ mode: "newest" }] }),
    staleTime: Infinity,
  })
  subscriptions.push(observer.subscribe(() => undefined))
  return key
}

beforeEach(resetCommunityWsHarness)
afterEach(async () => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
  await cleanupCommunityWsHarness()
})

describe("community foreground message reconciliation", () => {
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
    getCommunityApiFetchMock().mockImplementation(async (path) => page(String(path)))
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
      if (String(path).includes("/messages?since=")) return {
        messages: [message("missed", 2), message("live", 3)], latestSeq: 3, hasMoreNewer: false,
      }
      if (path === "/api/community/users/me/read-state") return { revision: 0, readStates: [] }
      throw new Error(`unexpected fetch: ${String(path)}`)
    })
    const cancel = vi.spyOn(capturedQueryClient, "cancelQueries")
    const reads = vi.spyOn(capturedQueryClient, "fetchQuery")
    let foreground!: void | Promise<void>; act(() => { foreground = capturedUseUserWsOptions!.onForeground!() })
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    let duplicate!: void | Promise<void>, reconnect!: void | Promise<void>
    act(() => { duplicate = capturedUseUserWsOptions!.onForeground!(); reconnect = capturedOnReconnect!({ reconnectDurationMs: 1_000 }) })
    await vi.waitFor(() => expect(reads.mock.calls.filter(([options]) => options.queryKey.at(-1) === "reconcile")).toHaveLength(3))
    const event = messageCreate("focused", "live")
    event.message.seq = 3
    await act(async () => { capturedOnMessage!(event) })
    await Promise.resolve()
    expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => path === "/api/community/channels/focused/messages")).toHaveLength(1)
    expect(cancel.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(key))).toHaveLength(1)
    await act(async () => { release(page("snapshot-before-gap")) })
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
      if (path === "/api/community/channels/b/messages") return page("current-b")
      throw new Error(`unexpected fetch: ${String(path)}`)
    })
    let old!: void | Promise<void>; act(() => { old = capturedUseUserWsOptions!.onForeground!() })
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"))
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "b" }) })
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    await act(async () => { releaseOld(page("late-a")) })
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
    getCommunityApiFetchMock().mockResolvedValue(page("current-account"))
    await act(async () => { await capturedUseUserWsOptions!.onForeground!() })
    expect(getCommunityApiFetchMock()).toHaveBeenCalledOnce()
  })

  it("does not let a disposed owner start work from an old foreground callback", async () => {
    await act(async () => { getCapturedRuntime().ui.actions.subscribe({ channelId: "disposed" }) })
    seed("disposed")
    await mountHook()
    flushEffects()
    const old = capturedUseUserWsOptions!.onForeground!
    unmountHook()
    await old()
    expect(getCommunityApiFetchMock()).not.toHaveBeenCalled()
  })
})

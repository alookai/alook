import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  capturedOnReconnect,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"

const telemetry = vi.hoisted(() => ({
  complete: vi.fn(),
  failure: vi.fn(),
}))

vi.mock("@/lib/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analytics")>("@/lib/analytics")
  return {
    ...actual,
    trackCommunityWsReconcileComplete: telemetry.complete,
    trackCommunityWsReconcileFailure: telemetry.failure,
  }
})

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — resyncs machines on WS reconnect", () => {
  it("invalidates communityKeys.machines() when the captured onReconnect fires", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("machines")
      }),
    ).toBe(true)
    expect(spy).toHaveBeenCalledWith({
      queryKey: [...communityKeys.all, "bot"],
      exact: false,
      refetchType: "active",
    })
  })

  it("reconciles the focused channel's messages + inbox on reconnect, but NOT the read-state snapshot", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    // Focused channel messages use the bounded catch-up path instead of a
    // TanStack invalidation that would refetch every cached infinite page.
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "channel" &&
          k[2] === "ch_focus" &&
          k[3] === "messages",
      ),
    ).toBe(false)
    expect(
      invalidatedKeys.some(
        (k) => JSON.stringify(k) === JSON.stringify(communityKeys.channelMembers("ch_focus")),
      ),
    ).toBe(true)
    expect(
      invalidatedKeys.some(
        (k) => JSON.stringify(k) === JSON.stringify(communityKeys.channelAddableMembers("ch_focus")),
      ),
    ).toBe(true)
    // Read-state snapshot MUST NOT be invalidated: the snapshot hook latches
    // its first value (gcTime: 0, frozen ref) so a refetch can't move the
    // "New" divider — it only flips `isFetching` back to true, which the
    // channel page reads as loading and flashes a second skeleton mid-mount
    // (the "skeleton → content → skeleton → top hero" refresh bug). See
    // `handleReconnect`'s comment in use-community-ws.ts.
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "channel" &&
          k[2] === "ch_focus" &&
          k[3] === "read-state-snapshot",
      ),
    ).toBe(false)
    // Inbox
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k[0] === "community" && k[1] === "inbox",
      ),
    ).toBe(true)
  })

  it("invalidates the focused thread opener's single-message query on reconnect", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "thread",
      parentChannelId: "ch_parent",
      parentMessageId: "m_opener",
    })
    capturedQueryClient.setQueryData(communityKeys.message("m_opener"), { id: "m_opener" })
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    expect(spy).toHaveBeenCalledWith({
      queryKey: communityKeys.message("m_opener"),
      exact: true,
      refetchType: "active",
    })
  })

  it("re-seeds the rail list + open server's detail on reconnect (inbox-dot-ws-driven ②)", async () => {
    // Sidebar dots + rail mention badges are now driven by the live
    // `unread.bump` patch, with no switch-refetch backing them. A bump dropped
    // during the socket gap would leave them stale, so reconnect must re-seed
    // both — else the cross-server dot fix silently rots after any disconnect.
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), { id: "srv_open" })
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    // handleReconnect reads currentServerId via getState() at call time.
    expect(capturedOnReconnect).not.toBeNull()
    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    // Rail LIST = communityKeys.servers() = ["community","servers"] (length 2).
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k.length === 2 && k[0] === "community" && k[1] === "servers",
      ),
    ).toBe(true)
    // Open server's DETAIL = communityKeys.server(id) = ["community","servers",id].
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "servers" &&
          k[2] === "srv_open",
      ),
    ).toBe(true)
    expect(
      invalidatedKeys.some(
        (k) => JSON.stringify(k) === JSON.stringify(communityKeys.members("srv_open")),
      ),
    ).toBe(true)
  })

  it("drops every inactive retained/meta/hint access result before reconnect validation", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    capturedQueryClient.setQueryData(
      communityKeys.forumSidebarRetained("srv_open", "post-a"),
      { id: "post-a" },
    )
    capturedQueryClient.setQueryData(
      communityKeys.forumSidebarRetained("srv_open", "post-b"),
      null,
    )
    capturedQueryClient.setQueryData(
      communityKeys.channelMeta("srv_open", "post-a"),
      { id: "post-a", verifiedEpoch: 0 },
    )
    capturedQueryClient.setQueryData(
      communityKeys.forumOpenerHint("srv_open", "opener-a"),
      { id: "opener-a", content: "private title" },
    )

    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    expect(capturedQueryClient.getQueriesData({
      queryKey: communityKeys.forumSidebarRetainedRoot("srv_open"),
    })).toEqual([])
    expect(capturedQueryClient.getQueriesData({
      queryKey: communityKeys.channelMetaRoot("srv_open"),
    })).toEqual([])
    expect(capturedQueryClient.getQueriesData({
      queryKey: communityKeys.forumOpenerHintRoot("srv_open"),
    })).toEqual([])
  })

  it("reconciles the focused DM's messages on reconnect, but NOT its read-state snapshot", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "dm" &&
          k[2] === "dm_focus" &&
          k[3] === "messages",
      ),
    ).toBe(false)
    // Read-state snapshot MUST NOT be invalidated — same rationale as the
    // channel case (mirrors `useChannelReadStateSnapshot`'s freeze contract).
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "dm" &&
          k[2] === "dm_focus" &&
          k[3] === "read-state-snapshot",
      ),
    ).toBe(false)
  })

  it("only invalidates the focused scope — no channel invalidation when only a DM is focused", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    // No channel-scoped message invalidation should have fired.
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k[1] === "channel" && k[3] === "messages",
      ),
    ).toBe(false)
  })

  it("reconciles every recognized cached server snapshot and ignores sentinel or unknown tuples", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.server("srv_a"), { id: "srv_a" })
    capturedQueryClient.setQueryData(communityKeys.members("srv_b"), { pages: [] })
    capturedQueryClient.setQueryData(communityKeys.server("__none__"), { id: "__none__" })
    capturedQueryClient.setQueryData(["community", "servers", "srv_ghost", "unknown-family"], {})
    capturedQueryClient.setQueryData(["community", "servers", "srv_ghost", "members", "unexpected"], {})
    const invalidDerivedTuples = [
      [...communityKeys.forumSidebarRetained("srv_a", "child"), "unexpected"],
      [...communityKeys.channelMeta("srv_a", "child"), "unexpected"],
      [...communityKeys.forumOpenerHint("srv_a", "opener"), "unexpected"],
      [...communityKeys.forumSidebarUnreadFallbacks("srv_a"), "unexpected"],
    ] as const
    for (const queryKey of invalidDerivedTuples) {
      capturedQueryClient.setQueryData(queryKey, { sentinel: true })
    }
    for (const serverId of ["srv_a", "srv_b"]) {
      capturedQueryClient.setQueryData(communityKeys.forumSidebarRetained(serverId, "child"), {})
      capturedQueryClient.setQueryData(communityKeys.channelMeta(serverId, "child"), {})
      capturedQueryClient.setQueryData(communityKeys.forumOpenerHint(serverId, "opener"), {})
      capturedQueryClient.setQueryData(communityKeys.forumSidebarUnreadFallbacks(serverId), {})
    }
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    await capturedOnReconnect!({ reconnectDurationMs: 250 })

    const calls = spy.mock.calls.map(([filters]) => filters)
    for (const serverId of ["srv_a", "srv_b"]) {
      for (const queryKey of [
        communityKeys.server(serverId),
        communityKeys.members(serverId),
        communityKeys.presence(serverId),
        communityKeys.invites(serverId),
        communityKeys.forumSidebarThreads(serverId),
      ]) {
        expect(calls).toContainEqual({ queryKey, exact: true, refetchType: "active" })
      }
      expect(capturedQueryClient.getQueryState(
        communityKeys.forumSidebarRetained(serverId, "child"),
      )).toBeUndefined()
      expect(capturedQueryClient.getQueryState(
        communityKeys.channelMeta(serverId, "child"),
      )).toBeUndefined()
      expect(capturedQueryClient.getQueryState(
        communityKeys.forumOpenerHint(serverId, "opener"),
      )).toBeUndefined()
      expect(capturedQueryClient.getQueryState(
        communityKeys.forumSidebarUnreadFallbacks(serverId),
      )).toBeUndefined()
    }
    expect(calls.some(({ queryKey }) => queryKey?.includes("__none__"))).toBe(false)
    expect(calls.some(({ queryKey }) => queryKey?.includes("srv_ghost"))).toBe(false)
    for (const queryKey of invalidDerivedTuples) {
      expect(capturedQueryClient.getQueryData(queryKey)).toEqual({ sentinel: true })
    }
    expect(calls.filter(({ queryKey, exact }) => (
      exact === true && JSON.stringify(queryKey) === JSON.stringify(communityKeys.servers())
    ))).toHaveLength(1)
  })

  it("isolates one cached-server rejection while completing every other policy", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    capturedQueryClient.setQueryData(communityKeys.server("srv_a"), { id: "srv_a" })
    capturedQueryClient.setQueryData(communityKeys.server("srv_b"), { id: "srv_b" })
    const original = capturedQueryClient.invalidateQueries.bind(capturedQueryClient)
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries").mockImplementation((filters, options) => {
      if (JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.members("srv_a"))) {
        return Promise.reject(new Error("private backend detail"))
      }
      return original(filters, options)
    })

    const summary = await reconcileCommunityWsReconnect(capturedQueryClient, 900)

    expect(summary).toMatchObject({
      policyCount: 13,
      successCount: 12,
      failureCount: 1,
      reconnectDurationMs: 900,
    })
    expect(spy).toHaveBeenCalledWith({
      queryKey: communityKeys.server("srv_b"),
      exact: true,
      refetchType: "active",
    })
    expect(telemetry.failure).toHaveBeenCalledTimes(1)
    expect(telemetry.failure).toHaveBeenCalledWith({
      policy: "all-cached-servers",
      reason: "async-rejection",
    })
    expect(JSON.stringify(telemetry.failure.mock.calls)).not.toContain("private backend detail")
    expect(telemetry.complete).toHaveBeenCalledTimes(1)
    expect(telemetry.complete).toHaveBeenCalledWith(summary)
  })

  it("isolates a synchronous policy throw and reports only the stable policy key", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const originalResetPresence = useCommunityWsStore.getState().resetPresence
    useCommunityWsStore.setState({
      resetPresence: () => { throw new Error("private sync detail") },
    })

    const summary = await reconcileCommunityWsReconnect(capturedQueryClient, 10)
    useCommunityWsStore.setState({ resetPresence: originalResetPresence })

    expect(summary).toMatchObject({ policyCount: 13, successCount: 12, failureCount: 1 })
    expect(telemetry.failure).toHaveBeenCalledWith({
      policy: "presence-overlay",
      reason: "sync-throw",
    })
    expect(JSON.stringify(telemetry.failure.mock.calls)).not.toContain("private sync detail")
  })

  it("resets presence and status overlays before authoritative invalidation starts", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const originalResetPresence = useCommunityWsStore.getState().resetPresence
    const originalResetUserStatuses = useCommunityWsStore.getState().resetUserStatuses
    const order: string[] = []
    useCommunityWsStore.setState({
      resetPresence: () => { order.push("presence-reset") },
      resetUserStatuses: () => { order.push("status-reset") },
    })
    const originalInvalidate = capturedQueryClient.invalidateQueries.bind(capturedQueryClient)
    vi.spyOn(capturedQueryClient, "invalidateQueries").mockImplementation((filters, options) => {
      const key = JSON.stringify(filters.queryKey)
      if (
        key === JSON.stringify(communityKeys.friends())
        || key === JSON.stringify(communityKeys.servers())
      ) order.push("authoritative-invalidate")
      return originalInvalidate(filters, options)
    })

    await reconcileCommunityWsReconnect(capturedQueryClient)
    useCommunityWsStore.setState({
      resetPresence: originalResetPresence,
      resetUserStatuses: originalResetUserStatuses,
    })

    expect(order.slice(0, 2)).toEqual(["presence-reset", "status-reset"])
    expect(order.indexOf("authoritative-invalidate")).toBeGreaterThan(1)
  })

  it("refetches an active focused addable-members picker after a socket gap", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_picker" })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    const queryKey = communityKeys.channelAddableMembers("ch_picker")
    let version = 1
    let fetchCount = 0
    const queryFn = async () => {
      fetchCount += 1
      return { version }
    }
    await queryClient.fetchQuery({ queryKey, queryFn })
    const observer = new QueryObserver(queryClient, { queryKey, queryFn, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => undefined)
    version = 2

    await reconcileCommunityWsReconnect(queryClient)

    expect(queryClient.getQueryData(queryKey)).toEqual({ version: 2 })
    expect(fetchCount).toBe(2)
    unsubscribe()
    queryClient.clear()
  })

  it("refetches only active server A and makes inactive forever-fresh server B fetch on mount", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    const versions = { srv_a: 1, srv_b: 1 }
    const fetches = new Map<string, number>()
    const keys = (serverId: "srv_a" | "srv_b") => [
      communityKeys.server(serverId),
      communityKeys.members(serverId),
      communityKeys.presence(serverId),
      communityKeys.invites(serverId),
      communityKeys.forumSidebarThreads(serverId),
    ] as const
    const queryFn = (serverId: "srv_a" | "srv_b", queryKey: readonly unknown[]) => async () => {
      const name = JSON.stringify(queryKey)
      fetches.set(name, (fetches.get(name) ?? 0) + 1)
      return { serverId, version: versions[serverId], key: queryKey.at(-1) }
    }
    for (const serverId of ["srv_a", "srv_b"] as const) {
      for (const queryKey of keys(serverId)) {
        await queryClient.fetchQuery({ queryKey, queryFn: queryFn(serverId, queryKey) })
      }
    }
    queryClient.setQueryData(communityKeys.forumSidebarRetained("srv_b", "private-child"), { stale: true })
    queryClient.setQueryData(communityKeys.channelMeta("srv_b", "private-child"), { stale: true })
    queryClient.setQueryData(communityKeys.forumOpenerHint("srv_b", "private-opener"), { stale: true })
    queryClient.setQueryData(communityKeys.forumSidebarUnreadFallbacks("srv_b"), { stale: true })
    const unsubscribes = keys("srv_a").map((queryKey) => {
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: queryFn("srv_a", queryKey),
        staleTime: Infinity,
      })
      return observer.subscribe(() => undefined)
    })
    versions.srv_a = 2
    versions.srv_b = 2

    await reconcileCommunityWsReconnect(queryClient, 50)

    for (const queryKey of keys("srv_a")) {
      expect(queryClient.getQueryData(queryKey)).toMatchObject({ version: 2 })
      expect(fetches.get(JSON.stringify(queryKey))).toBe(2)
    }
    for (const queryKey of keys("srv_b")) {
      expect(queryClient.getQueryData(queryKey)).toMatchObject({ version: 1 })
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
      await queryClient.fetchQuery({ queryKey, queryFn: queryFn("srv_b", queryKey) })
      expect(queryClient.getQueryData(queryKey)).toMatchObject({ version: 2 })
      expect(fetches.get(JSON.stringify(queryKey))).toBe(2)
    }
    expect(queryClient.getQueriesData({
      queryKey: communityKeys.forumSidebarRetainedRoot("srv_b"),
    })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: communityKeys.channelMetaRoot("srv_b") })).toEqual([])
    expect(queryClient.getQueriesData({ queryKey: communityKeys.forumOpenerHintRoot("srv_b") })).toEqual([])
    expect(queryClient.getQueryState(communityKeys.forumSidebarUnreadFallbacks("srv_b"))).toBeUndefined()
    unsubscribes.forEach((unsubscribe) => unsubscribe())
    queryClient.clear()
  })
})

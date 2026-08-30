import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  capturedOnMessage,
  capturedOnReconnect,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  flushEffects,
  getCommunityApiFetchMock,
  messageCreate,
  mountHook,
  resetHookMemoization,
  resetCommunityWsHarness,
  unmountHook,
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

async function flushMicrotasks(iterations = 12) {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve()
}

describe("useCommunityWs — resyncs machines on WS reconnect", () => {
  it("re-reads the authoritative self identity after a reconnect gap", async () => {
    const apiFetch = getCommunityApiFetchMock()
    apiFetch.mockImplementation(async (url: unknown) => {
      if (url === "/api/community/users/me/read-state") {
        return { revision: 0, readStates: [] }
      }
      if (url === "/api/community/users/self/profile") {
        return {
          id: "self",
          name: "Self",
          discriminator: "0001",
          image: "/api/community/users/self/avatar?v=7",
          avatar: "/api/community/users/self/avatar?v=7",
          avatarVersion: 7,
          aboutMe: "",
          bannerColor: null,
          mutualServers: 0,
          statusEmoji: null,
          statusText: null,
          kind: "human",
        }
      }
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })
    await mountHook({ viewerUserId: "self" })
    flushEffects()

    await capturedOnReconnect!({ reconnectDurationMs: 1_000 })

    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/self/profile")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(useCommunityWsStore.getState().profilesByUserId.get("self")).toMatchObject({
      avatar: "/api/community/users/self/avatar?v=7",
      avatarVersion: 7,
    })
  })

  it("invalidates cached identity surfaces after a reconnect gap", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    capturedQueryClient.setQueryData(communityKeys.bots(), { bots: [] })

    await reconcileCommunityWsReconnect(capturedQueryClient)

    expect(capturedQueryClient.getQueryState(communityKeys.bots())?.isInvalidated).toBe(true)
  })

  it("keeps the authenticated viewer online while resetting stale peer presence", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const profiles = useCommunityWsStore.getState()
    profiles.patchProfiles(profiles.beginProfileSnapshot(), [
      { id: "self", presence: "online" },
      { id: "peer", presence: "online" },
    ])

    await reconcileCommunityWsReconnect(capturedQueryClient, 0, {
      viewerUserId: "self",
    })

    expect(useCommunityWsStore.getState().profilesByUserId.get("self")?.presence)
      .toBe("online")
    expect(useCommunityWsStore.getState().profilesByUserId.get("peer")?.presence)
      .toBe("offline")
  })

  it("reports identity reconciliation failure when an active identity invalidation rejects", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    capturedQueryClient.setQueryData(communityKeys.bots(), { bots: [] })
    const originalInvalidate = capturedQueryClient.invalidateQueries.bind(capturedQueryClient)
    vi.spyOn(capturedQueryClient, "invalidateQueries").mockImplementation((filters, options) => {
      if (filters.predicate) return Promise.reject(new Error("identity cache unavailable"))
      return originalInvalidate(filters, options)
    })

    const summary = await reconcileCommunityWsReconnect(capturedQueryClient)

    expect(summary.failureCount).toBeGreaterThan(0)
    expect(telemetry.failure).toHaveBeenCalledWith(
      expect.objectContaining({ policy: "identity-surfaces" }),
    )
  })

  it("reactivates the Inbox owner after a Strict Effects cleanup/setup replay", async () => {
    vi.useFakeTimers()
    await mountHook()
    flushEffects()
    unmountHook()

    resetHookMemoization()
    await mountHook()
    flushEffects()
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")

    capturedOnMessage?.(messageCreate("ch_effect_replay"))
    await vi.advanceTimersByTimeAsync(500)

    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.dms() })
  })

  it("does not re-arm the Inbox owner when reconnect repair settles after unmount", async () => {
    vi.useFakeTimers()
    await mountHook()
    flushEffects()
    let releaseRepair!: () => void
    const repairGate = new Promise<void>((resolve) => {
      releaseRepair = resolve
    })
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")
      .mockReturnValue(repairGate)

    const reconnect = capturedOnReconnect!({ reconnectDurationMs: 0 })
    await flushMicrotasks()
    expect(invalidate).toHaveBeenCalled()
    unmountHook()
    const callsAtUnmount = invalidate.mock.calls.length

    releaseRepair()
    await reconnect
    await vi.advanceTimersByTimeAsync(500)

    const lateKeys = invalidate.mock.calls.slice(callsAtUnmount).map(
      (call) => JSON.stringify(call[0]?.queryKey),
    )
    expect(lateKeys).not.toContain(JSON.stringify(communityKeys.inbox()))
    expect(lateKeys).not.toContain(JSON.stringify(communityKeys.dms()))
  })

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
    vi.useFakeTimers()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    await capturedOnReconnect!({ reconnectDurationMs: 0 })

    let invalidatedKeys = spy.mock.calls.map(
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
    // Reconnect owns focused repair first; only after it completes does it
    // schedule the single account owner generation.
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k[0] === "community" && k[1] === "inbox",
      ),
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k[0] === "community" && k[1] === "inbox",
      ),
    ).toBe(true)
  })

  it("reconciles both visible split panes and drops the hidden parent after owner cleanup", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    const store = useCommunityStore.getState()
    const owner = Symbol("split")
    store.subscribe({ channelId: "thread_focus" })
    store.claimSecondaryChannel(owner, "parent_focus")
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    await capturedOnReconnect!({ reconnectDurationMs: 0 })
    const firstKeys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey))
    for (const channelId of ["thread_focus", "parent_focus"]) {
      expect(firstKeys).toContain(JSON.stringify(communityKeys.channelMembers(channelId)))
      expect(firstKeys).toContain(JSON.stringify(communityKeys.channelAddableMembers(channelId)))
      expect(firstKeys).toContain(JSON.stringify(communityKeys.pins(channelId)))
      expect(firstKeys).toContain(JSON.stringify(communityKeys.threads(channelId)))
      expect(firstKeys).toContain(JSON.stringify(communityKeys.threadParticipants(channelId)))
    }

    store.releaseSecondaryChannel(owner)
    spy.mockClear()
    await capturedOnReconnect!({ reconnectDurationMs: 0 })
    const hiddenParentKeys = spy.mock.calls
      .map((call) => JSON.stringify(call[0]?.queryKey))
      .filter((key) => key.includes("parent_focus"))
    expect(hiddenParentKeys).toEqual([])
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

  it("keeps inactive retained/meta/hint data painted while marking it stale", async () => {
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

    expect(capturedQueryClient.getQueryData(
      communityKeys.forumSidebarRetained("srv_open", "post-a"),
    )).toEqual({ id: "post-a" })
    expect(capturedQueryClient.getQueryData(
      communityKeys.channelMeta("srv_open", "post-a"),
    )).toEqual({ id: "post-a", verifiedEpoch: 0 })
    expect(capturedQueryClient.getQueryData(
      communityKeys.forumOpenerHint("srv_open", "opener-a"),
    )).toEqual({ id: "opener-a", content: "private title" })
    expect(capturedQueryClient.getQueryState(
      communityKeys.channelMeta("srv_open", "post-a"),
    )?.isInvalidated).toBe(true)
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
      for (const queryKey of [
        communityKeys.forumSidebarRetained(serverId, "child"),
        communityKeys.channelMeta(serverId, "child"),
        communityKeys.forumOpenerHint(serverId, "opener"),
        communityKeys.forumSidebarUnreadFallbacks(serverId),
      ]) {
        expect(capturedQueryClient.getQueryData(queryKey)).toEqual({})
        expect(capturedQueryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
      }
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
      policyCount: 15,
      successCount: 14,
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

  it("isolates a policy rejection and reports only the stable policy key", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const originalPatchProfiles = useCommunityWsStore.getState().patchProfiles
    let patchCallCount = 0
    useCommunityWsStore.setState({
      patchProfiles: (...args) => {
        patchCallCount += 1
        if (patchCallCount === 1) throw new Error("private sync detail")
        return originalPatchProfiles(...args)
      },
    })

    const summary = await reconcileCommunityWsReconnect(capturedQueryClient, 10)
    useCommunityWsStore.setState({ patchProfiles: originalPatchProfiles })

    expect(summary).toMatchObject({ policyCount: 15, successCount: 14, failureCount: 1 })
    expect(telemetry.failure).toHaveBeenCalledWith({
      policy: "presence-overlay",
      reason: "async-rejection",
    })
    expect(JSON.stringify(telemetry.failure.mock.calls)).not.toContain("private sync detail")
  })

  it("can exclude only Inbox/DM repair while completing every other reconnect policy", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    const summary = await reconcileCommunityWsReconnect(capturedQueryClient, 0, {
      excludePolicies: ["inbox-dms"],
    })

    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters.queryKey))
    expect(keys).not.toContain(JSON.stringify(communityKeys.inbox()))
    expect(keys).not.toContain(JSON.stringify(communityKeys.dms()))
    expect(keys).toContain(JSON.stringify(communityKeys.friends()))
    expect(keys).toContain(JSON.stringify(communityKeys.servers()))
    expect(summary).toMatchObject({ policyCount: 14, successCount: 14, failureCount: 0 })
  })

  it("resets presence and status overlays before authoritative invalidation starts", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const store = useCommunityWsStore.getState()
    store.patchProfiles(store.beginProfileSnapshot(), [{
      id: "peer",
      presence: "online",
      status: { statusEmoji: "🌱", statusText: "Growing" },
    }])
    const originalPatchProfiles = useCommunityWsStore.getState().patchProfiles
    const order: string[] = []
    useCommunityWsStore.setState({
      patchProfiles: (_snapshot, patches) => {
        if (patches.some((patch) => patch.presence !== undefined)) order.push("presence-reset")
        if (patches.some((patch) => patch.status !== undefined)) order.push("status-reset")
        return true
      },
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
      patchProfiles: originalPatchProfiles,
    })

    expect(order.slice(0, 2)).toEqual(["presence-reset", "status-reset"])
    expect(order.indexOf("authoritative-invalidate")).toBeGreaterThan(1)
  })

  it("waits for focused route reconciliation before starting background domains", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_priority" })
    let releaseMembers!: () => void
    let releaseAddable!: () => void
    const members = new Promise<void>((resolve) => { releaseMembers = resolve })
    const addable = new Promise<void>((resolve) => { releaseAddable = resolve })
    const started: string[] = []
    const originalInvalidate = capturedQueryClient.invalidateQueries.bind(capturedQueryClient)
    vi.spyOn(capturedQueryClient, "invalidateQueries").mockImplementation((filters, options) => {
      const key = JSON.stringify(filters.queryKey)
      started.push(key)
      if (key === JSON.stringify(communityKeys.channelMembers("ch_priority"))) return members
      if (key === JSON.stringify(communityKeys.channelAddableMembers("ch_priority"))) return addable
      return originalInvalidate(filters, options)
    })

    const work = reconcileCommunityWsReconnect(capturedQueryClient)
    await flushMicrotasks()
    expect(started).toContain(JSON.stringify(communityKeys.channelMembers("ch_priority")))
    expect(started).not.toContain(JSON.stringify(communityKeys.inbox()))

    releaseMembers()
    releaseAddable()
    await work
    expect(started).toContain(JSON.stringify(communityKeys.inbox()))
  })

  it("limits background reconciliation to three policies at a time", async () => {
    const { reconcileCommunityWsReconnect } = await import("./reconnect")
    const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>()
    const started: string[] = []
    vi.spyOn(capturedQueryClient, "invalidateQueries").mockImplementation((filters) => {
      if (filters.predicate) return Promise.resolve()
      const key = JSON.stringify(filters.queryKey)
      started.push(key)
      let resolve!: () => void
      const promise = new Promise<void>((done) => { resolve = done })
      gates.set(key, { promise, resolve })
      return promise
    })

    const work = reconcileCommunityWsReconnect(capturedQueryClient)
    await flushMicrotasks()
    expect(started).toEqual(expect.arrayContaining([
      JSON.stringify(communityKeys.inbox()),
      JSON.stringify(communityKeys.dms()),
      JSON.stringify(communityKeys.friends()),
      JSON.stringify(communityKeys.servers()),
    ]))
    expect(started).not.toContain(JSON.stringify(communityKeys.machines()))
    expect(started).not.toContain(JSON.stringify([...communityKeys.all, "bot"]))

    gates.get(JSON.stringify(communityKeys.friends()))!.resolve()
    await vi.waitFor(() => {
      expect(started).toContain(JSON.stringify(communityKeys.machines()))
    })
    expect(started).not.toContain(JSON.stringify([...communityKeys.all, "bot"]))

    gates.get(JSON.stringify(communityKeys.machines()))!.resolve()
    await vi.waitFor(() => {
      expect(started).toContain(JSON.stringify([...communityKeys.all, "bot"]))
    })

    for (const gate of gates.values()) gate.resolve()
    await work
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
    for (const queryKey of [
      communityKeys.forumSidebarRetained("srv_b", "private-child"),
      communityKeys.channelMeta("srv_b", "private-child"),
      communityKeys.forumOpenerHint("srv_b", "private-opener"),
      communityKeys.forumSidebarUnreadFallbacks("srv_b"),
    ]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
    }
    unsubscribes.forEach((unsubscribe) => unsubscribe())
    queryClient.clear()
  })
})

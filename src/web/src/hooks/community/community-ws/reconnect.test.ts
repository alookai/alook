import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import {
  capturedOnReconnect,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — resyncs machines on WS reconnect", () => {
  it("invalidates communityKeys.machines() when the captured onReconnect fires", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("machines")
      }),
    ).toBe(true)
    expect(spy).toHaveBeenCalledWith({
      queryKey: [...communityKeys.all, "bot"],
      exact: false,
    })
  })

  it("invalidates the focused channel's messages + inbox on reconnect, but NOT the read-state snapshot", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    // Focused channel messages — a legitimate top-up refetch that keeps data.
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "channel" &&
          k[2] === "ch_focus" &&
          k[3] === "messages",
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

  it("re-seeds the rail list + open server's detail on reconnect (inbox-dot-ws-driven ②)", async () => {
    // Sidebar dots + rail mention badges are now driven by the live
    // `unread.bump` patch, with no switch-refetch backing them. A bump dropped
    // during the socket gap would leave them stale, so reconnect must re-seed
    // both — else the cross-server dot fix silently rots after any disconnect.
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    // handleReconnect reads currentServerId via getState() at call time.
    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

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

    capturedOnReconnect!()

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

  it("invalidates the focused DM's messages on reconnect, but NOT its read-state snapshot", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

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
    ).toBe(true)
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
    capturedOnReconnect!()

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
})

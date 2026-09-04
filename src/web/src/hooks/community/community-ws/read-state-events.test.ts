import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

import { dispatchCommunityWsEvent } from "./registry"
import type { CommunityWsDispatchContext } from "./handler-context"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { notificationSettingsQueryFn } from "@/hooks/community/use-notification-settings"
import { disposeAccountReadStateReconciliation } from "./read-state-reconciliation"

function context(
  queryClient: QueryClient,
  scheduleInboxInvalidate = vi.fn(),
): CommunityWsDispatchContext {
  return {
    deliveryMode: "single",
    queryClient,
    communityStore: {} as CommunityWsDispatchContext["communityStore"],
    wsStore: {} as CommunityWsDispatchContext["wsStore"],
    sub: {},
    viewerUserIdRef: { current: "u1" },
    matchesFocus: () => false,
    scheduleInboxInvalidate,
  }
}

describe("same-account read-state WS events", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    apiFetch.mockReset()
  })

  afterEach(() => {
    disposeAccountReadStateReconciliation(queryClient)
    queryClient.clear()
  })

  it("pulls and projects the authoritative replacement for an exact-next hint", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("dm1"), {
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })

    apiFetch.mockResolvedValue({
      revision: 3,
      readStates: [{
        channelId: "dm1",
        lastReadMessageId: "m4",
        lastReadAt: "2026-08-24T00:00:04.000Z",
        lastReadSeq: 4,
      }],
    })
    dispatchCommunityWsEvent({
      type: "community:read_state.advanced",
      revision: 3,
      inboxChanged: true,
    }, context(queryClient))

    await vi.waitFor(() => expect(queryClient.getQueryData(
      communityKeys.dmReadStateSnapshot("dm1"),
    )).toMatchObject({
      lastReadMessageId: "m4",
      lastReadSeq: 4,
    }))
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("repairs a revision gap from the authoritative snapshot", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [],
    })
    apiFetch.mockResolvedValue({
      revision: 5,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m8",
        lastReadAt: "2026-08-24T00:00:08.000Z",
        lastReadSeq: 8,
      }],
    })

    dispatchCommunityWsEvent({
      type: "community:read_state.advanced",
      revision: 5,
      inboxChanged: true,
    }, context(queryClient))

    await vi.waitFor(() => expect(queryClient.getQueryData(
      communityKeys.accountReadStateSnapshot(),
    )).toMatchObject({ revision: 5 }))
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("pulls one full read-all replacement and ignores its stale replay", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 7,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), { lastReadSeq: 0 })

    apiFetch.mockResolvedValue({
      revision: 8,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m8",
        lastReadAt: "2026-08-24T00:00:08.000Z",
        lastReadSeq: 8,
      }],
    })

    const event = {
      type: "community:inbox.changed",
      revision: 8,
      inboxChanged: true,
      reason: "read_all",
    } as const
    dispatchCommunityWsEvent(event, context(queryClient))
    await vi.waitFor(() => expect(queryClient.getQueryData(
      communityKeys.channelReadStateSnapshot("c1"),
    )).toMatchObject({
      lastReadSeq: 8,
    }))
    expect(apiFetch).toHaveBeenCalledTimes(1)

    dispatchCommunityWsEvent(event, context(queryClient))
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("absorbs an authoritative repair failure after receiving a newer hint", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [],
    })
    apiFetch.mockRejectedValue(new Error("temporary snapshot failure"))

    dispatchCommunityWsEvent({
      type: "community:read_state.advanced",
      revision: 3,
      inboxChanged: true,
    }, context(queryClient))

    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(queryClient.getQueryState(
      communityKeys.accountReadStateSnapshot(),
    )?.fetchStatus).toBe("idle"))
    expect(queryClient.getQueryData(communityKeys.accountReadStateSnapshot()))
      .toMatchObject({ revision: 2 })
  })

  it("schedules the owner immediately while the snapshot repairs only non-Inbox surfaces", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [],
    })
    let resolveSnapshot!: (value: unknown) => void
    apiFetch.mockReturnValue(new Promise((resolve) => { resolveSnapshot = resolve }))
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const scheduleInboxInvalidate = vi.fn()

    dispatchCommunityWsEvent({
      type: "community:inbox.changed",
      revision: 3,
      inboxChanged: true,
      reason: "read_all",
    }, context(queryClient, scheduleInboxInvalidate))

    expect(scheduleInboxInvalidate).toHaveBeenCalledOnce()
    expect(scheduleInboxInvalidate).toHaveBeenCalledWith({ inbox: true, dms: true })
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({
      queryKey: communityKeys.inbox(),
    }), expect.anything())
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({
      queryKey: communityKeys.dms(),
    }), expect.anything())

    resolveSnapshot({ revision: 3, readStates: [] })
    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: communityKeys.servers() }),
        expect.anything(),
      )
    })
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({
      queryKey: communityKeys.inbox(),
    }), expect.anything())
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({
      queryKey: communityKeys.dms(),
    }), expect.anything())
  })

  it.each([
    ["nothing", "all", [], true],
    ["all", "nothing", [{ serverId: "s1", channelId: null, level: "nothing" }], false],
  ] as const)("reconciles a peer tab from %s to %s policy", async (
    initial,
    _next,
    settings,
    expected,
  ) => {
    const sourceClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const peerClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const source = getAccountUnreadProjection(sourceClient, "u1")
    const peer = getAccountUnreadProjection(peerClient, "u1")
    source.setNotificationPolicy({ server: { s1: expected ? "all" : "nothing" } })
    peer.setNotificationPolicy({ server: { s1: initial } })
    source.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    peer.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    peerClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 1,
      readStates: [],
    })
    apiFetch.mockImplementation(async (path: string) => (
      path === "/api/community/users/me/notifications"
        ? settings
        : { revision: 2, readStates: [] }
    ))

    dispatchCommunityWsEvent({
      type: "community:inbox.changed",
      revision: 2,
      inboxChanged: true,
      reason: "notification_policy",
    }, context(peerClient))

    await vi.waitFor(() => expect(
      peer.projectUnread("servers", "c1", false),
    ).toBe(expected))
    expect(peer.projectUnread("servers", "c1", false)).toBe(
      source.projectUnread("servers", "c1", false),
    )
  })

  it("cancels an older in-flight policy fetch and keeps an old unread snapshot positive-only", async () => {
    const projection = getAccountUnreadProjection(queryClient, "u1")
    projection.setNotificationPolicy({ server: { s1: "nothing" } })
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const stalePolicySnapshot = projection.beginSnapshot("servers", "channels")
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 1,
      readStates: [],
    })
    let resolveOldPolicy!: (value: unknown) => void
    let policyCalls = 0
    apiFetch.mockImplementation((path: string) => {
      if (path !== "/api/community/users/me/notifications") {
        return Promise.resolve({ revision: 2, readStates: [] })
      }
      policyCalls += 1
      if (policyCalls === 1) {
        return new Promise((resolve) => { resolveOldPolicy = resolve })
      }
      return Promise.resolve([])
    })
    const oldRequest = queryClient.fetchQuery({
      queryKey: communityKeys.notificationSettings(),
      queryFn: notificationSettingsQueryFn,
    }).catch(() => undefined)
    await vi.waitFor(() => expect(policyCalls).toBe(1))

    dispatchCommunityWsEvent({
      type: "community:inbox.changed",
      revision: 2,
      inboxChanged: true,
      reason: "notification_policy",
    }, context(queryClient))
    await vi.waitFor(() => expect(policyCalls).toBe(2))
    resolveOldPolicy([{ serverId: "s1", channelId: null, level: "nothing" }])
    await oldRequest
    await vi.waitFor(() => expect(projection.getPolicyGeneration()).toBeGreaterThan(1))
    expect(queryClient.getQueryData(communityKeys.notificationSettings())).toMatchObject({
      raw: [],
      server: {},
      channel: {},
    })

    projection.absorbSnapshot(stalePolicySnapshot, [], { truncated: false })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

import { dispatchCommunityWsEvent } from "./registry"
import type { CommunityWsDispatchContext } from "./handler-context"

function context(queryClient: QueryClient): CommunityWsDispatchContext {
  return {
    deliveryMode: "single",
    queryClient,
    communityStore: {} as CommunityWsDispatchContext["communityStore"],
    wsStore: {} as CommunityWsDispatchContext["wsStore"],
    sub: {},
    viewerUserIdRef: { current: "u1" },
    matchesFocus: () => false,
    scheduleInboxInvalidate: vi.fn(),
  }
}

describe("same-account read-state WS events", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    apiFetch.mockReset()
  })

  it("projects an exact next read revision into cached read-state", () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("dm1"), {
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })

    dispatchCommunityWsEvent({
      type: "community:read_state.advanced",
      revision: 3,
      readStates: [{
        channelId: "dm1",
        lastReadMessageId: "m4",
        lastReadAt: "2026-08-24T00:00:04.000Z",
        lastReadSeq: 4,
      }],
      inboxChanged: true,
    }, context(queryClient))

    expect(queryClient.getQueryData(communityKeys.dmReadStateSnapshot("dm1"))).toMatchObject({
      lastReadMessageId: "m4",
      lastReadSeq: 4,
    })
    expect(apiFetch).not.toHaveBeenCalled()
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
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m5",
        lastReadAt: "2026-08-24T00:00:05.000Z",
        lastReadSeq: 5,
      }],
      inboxChanged: true,
    }, context(queryClient))

    await vi.waitFor(() => expect(queryClient.getQueryData(
      communityKeys.accountReadStateSnapshot(),
    )).toMatchObject({ revision: 5 }))
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("applies a complete read-all envelope and ignores its stale replay", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 7,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), { lastReadSeq: 0 })

    const event = {
      type: "community:inbox.changed",
      revision: 8,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m8",
        lastReadAt: "2026-08-24T00:00:08.000Z",
        lastReadSeq: 8,
      }],
      inboxChanged: true,
      reason: "read_all",
    } as const
    dispatchCommunityWsEvent(event, context(queryClient))
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadSeq: 8,
    })
    expect(apiFetch).not.toHaveBeenCalled()

    dispatchCommunityWsEvent(event, context(queryClient))
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

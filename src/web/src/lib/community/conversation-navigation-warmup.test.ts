import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { getConversationNavigationProof } from "./conversation-navigation-proof"
import { startConversationNavigationWarmup } from "./conversation-navigation-warmup"

const mocks = vi.hoisted(() => ({
  requests: [] as Array<{
    channelId: string
    receipt: (value: { channelId: string; surfaceKind: "channel" }) => void
    resolve: (value: { messages: never[]; hasMore: boolean }) => void
    reject: (error: unknown) => void
  }>,
  removeScope: vi.fn(),
  apiFetch: vi.fn(async () => ({ lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 })),
}))

vi.mock("@/hooks/community/use-messages", () => ({
  channelMessagesQueryFn: (
    channelId: string,
    _tag: null,
    options: { onSurfaceReceipt: (value: { channelId: string; surfaceKind: "channel" }) => void },
  ) => () => new Promise((resolve, reject) => {
    mocks.requests.push({ channelId, receipt: options.onSurfaceReceipt, resolve, reject })
  }),
  dmMessagesQueryFn: vi.fn(),
}))
vi.mock("@/hooks/community/use-servers", () => ({
  serverQueryFn: () => async () => ({ id: "server" }),
}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}))
vi.mock("@/stores/community/message-stream", () => ({
  useMessageStreamStore: { getState: () => ({ removeScope: mocks.removeScope }) },
}))

const target = (channelId: string) => ({
  href: `/c/channels/s1/${channelId}`,
  viewerId: "viewer",
  channelId,
  serverId: "s1",
  scopeKind: "channel" as const,
})

describe("conversation navigation warmup", () => {
  beforeEach(() => {
    mocks.requests.length = 0
    mocks.removeScope.mockReset()
    mocks.apiFetch.mockClear()
  })

  it("starts canonical work in parallel and prevents superseded A from seeding", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, target("a"), 4)
    startConversationNavigationWarmup(queryClient, target("b"), 4)
    expect(mocks.requests.map((request) => request.channelId)).toEqual(["a", "b"])
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)

    mocks.requests[0]!.receipt({ channelId: "a", surfaceKind: "channel" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    mocks.requests[1]!.receipt({ channelId: "b", surfaceKind: "channel" })
    mocks.requests[1]!.resolve({ messages: [], hasMore: false })
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(communityKeys.channelMessages("b"))).toBeDefined()
    })

    expect(queryClient.getQueryData(communityKeys.channelMessages("a"))).toBeUndefined()
    expect(getConversationNavigationProof(queryClient)).toMatchObject({
      status: "proven",
      target: { channelId: "b" },
    })
  })

  it("clears target caches and overlays on definitive denial", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.channelMessages("denied"), { stale: true })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("denied"), { stale: true })
    queryClient.setQueryData(communityKeys.channelMeta("s1", "denied"), { stale: true })
    startConversationNavigationWarmup(queryClient, target("denied"), 9)
    mocks.requests[0]!.reject(new ApiError("not found", 404))
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
    })

    expect(queryClient.getQueryData(communityKeys.channelMessages("denied"))).toBeUndefined()
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("denied"))).toBeUndefined()
    expect(queryClient.getQueryData(communityKeys.channelMeta("s1", "denied"))).toBeUndefined()
    expect(mocks.removeScope).toHaveBeenCalledWith({
      kind: "channel",
      id: "denied",
      serverId: "s1",
    })
    expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
  })
})

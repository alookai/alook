import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import {
  getConversationNavigationProof,
  recoverConversationNavigationProof,
} from "./conversation-navigation-proof"
import { startConversationNavigationWarmup } from "./conversation-navigation-warmup"

type SurfaceKind = "channel" | "thread" | "forum" | "dm"
type Page = { messages: never[]; hasMore: boolean }

const mocks = vi.hoisted(() => ({
  requests: [] as Array<{
    channelId: string
    kind: "channel" | "dm"
    pageParam: unknown
    signal: AbortSignal | undefined
    receipt: (value: { channelId: string; surfaceKind: SurfaceKind }) => void
    resolve: (value: Page) => void
    reject: (error: unknown) => void
  }>,
  reads: [] as Array<{
    url: string
    signal: AbortSignal | undefined
    resolve: (value: { lastReadMessageId: string | null; lastReadAt: string | null; lastReadSeq: number }) => void
    reject: (error: unknown) => void
  }>,
  servers: [] as Array<{
    serverId: string
    signal: AbortSignal | undefined
    resolve: (value: { id: string }) => void
    reject: (error: unknown) => void
  }>,
  removeScope: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock("@/hooks/community/use-messages", () => ({
  channelMessagesQueryFn: (
    channelId: string,
    _tag: null,
    options: { onSurfaceReceipt: (value: { channelId: string; surfaceKind: SurfaceKind }) => void },
  ) => ({ pageParam, signal }: { pageParam: unknown; signal?: AbortSignal }) => new Promise((resolve, reject) => {
    mocks.requests.push({
      channelId,
      kind: "channel",
      pageParam,
      signal,
      receipt: options.onSurfaceReceipt,
      resolve: resolve as (value: Page) => void,
      reject,
    })
  }),
  dmMessagesQueryFn: (
    channelId: string,
    options: { onSurfaceReceipt: (value: { channelId: string; surfaceKind: SurfaceKind }) => void },
  ) => ({ pageParam, signal }: { pageParam: unknown; signal?: AbortSignal }) => new Promise((resolve, reject) => {
    mocks.requests.push({
      channelId,
      kind: "dm",
      pageParam,
      signal,
      receipt: options.onSurfaceReceipt,
      resolve: resolve as (value: Page) => void,
      reject,
    })
  }),
}))
vi.mock("@/hooks/community/use-servers", () => ({
  serverQueryFn: (_queryClient: unknown, serverId: string, signal?: AbortSignal) => () => (
    new Promise((resolve, reject) => {
      mocks.servers.push({
        serverId,
        signal,
        resolve: resolve as (value: { id: string }) => void,
        reject,
      })
    })
  ),
}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (url: string, options?: { signal?: AbortSignal }) => {
    mocks.apiFetch(url, options)
    return new Promise((resolve, reject) => {
      mocks.reads.push({
        url,
        signal: options?.signal,
        resolve: resolve as (value: {
          lastReadMessageId: string | null
          lastReadAt: string | null
          lastReadSeq: number
        }) => void,
        reject,
      })
    })
  },
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
    mocks.reads.length = 0
    mocks.servers.length = 0
    mocks.removeScope.mockReset()
    mocks.apiFetch.mockReset()
  })

  it("starts canonical work in parallel and prevents superseded A from seeding", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, target("a"), 4)
    startConversationNavigationWarmup(queryClient, target("b"), 4)
    expect(mocks.requests.map((request) => request.channelId)).toEqual(["a", "b"])
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    expect(mocks.servers).toHaveLength(2)
    expect(mocks.requests[0]!.signal?.aborted).toBe(true)
    expect(mocks.reads[0]!.signal?.aborted).toBe(true)
    expect(mocks.servers[0]!.signal?.aborted).toBe(true)

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
    expect(mocks.reads[0]!.signal?.aborted).toBe(true)
    expect(mocks.servers[0]!.signal?.aborted).toBe(true)

    mocks.reads[0]!.resolve({ lastReadMessageId: "late", lastReadAt: null, lastReadSeq: 1 })
    mocks.servers[0]!.resolve({ id: "late" })
    await Promise.resolve()
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("denied"))).toBeUndefined()
    expect(queryClient.getQueryData(communityKeys.server("s1"))).toBeUndefined()
  })

  it("clears DM caches and overlay without starting server detail on denial", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const dmTarget = {
      href: "/c/me/d1",
      viewerId: "viewer",
      channelId: "d1",
      scopeKind: "dm" as const,
      expectedSurfaceKind: "dm" as const,
    }
    queryClient.setQueryData(communityKeys.dmMessages("d1"), { stale: true })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("d1"), { stale: true })
    queryClient.setQueryData(communityKeys.dmRouteVerification("d1"), "present")
    startConversationNavigationWarmup(queryClient, dmTarget, 2)
    expect(mocks.requests[0]).toMatchObject({ kind: "dm", pageParam: { mode: "newest" } })
    expect(mocks.servers).toHaveLength(0)
    mocks.requests[0]!.reject(new ApiError("forbidden", 403))
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
    })

    expect(queryClient.getQueryData(communityKeys.dmMessages("d1"))).toBeUndefined()
    expect(queryClient.getQueryData(communityKeys.dmReadStateSnapshot("d1"))).toBeUndefined()
    expect(queryClient.getQueryData(communityKeys.dmRouteVerification("d1"))).toBeUndefined()
    expect(mocks.removeScope).toHaveBeenCalledWith({ kind: "dm", id: "d1" })
    expect(mocks.reads[0]!.signal?.aborted).toBe(true)
    mocks.reads[0]!.resolve({ lastReadMessageId: "late", lastReadAt: null, lastReadSeq: 8 })
    await Promise.resolve()
    expect(queryClient.getQueryData(communityKeys.dmReadStateSnapshot("d1"))).toBeUndefined()
  })

  it("commits a successful DM receipt", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, {
      href: "/c/me/d2",
      viewerId: "viewer",
      channelId: "d2",
      scopeKind: "dm",
      expectedSurfaceKind: "dm",
    }, 3)
    mocks.requests[0]!.receipt({ channelId: "d2", surfaceKind: "dm" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")
    })
  })

  it("restarts canonical messages after transient failure without exposing stale cache", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = communityKeys.channelMessages("retry")
    queryClient.setQueryData(key, { pages: [{ messages: [{ id: "stale" }] }], pageParams: [] })
    const epoch = startConversationNavigationWarmup(queryClient, target("retry"), 5)
    mocks.requests[0]!.reject(new Error("network"))
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("failed")
    })
    expect(queryClient.getQueryData(key)).toBeDefined()

    expect(recoverConversationNavigationProof(queryClient, epoch, 5)).toBe(true)
    expect(mocks.requests).toHaveLength(2)
    mocks.requests[1]!.receipt({ channelId: "retry", surfaceKind: "channel" })
    mocks.requests[1]!.resolve({ messages: [], hasMore: false })
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)).toMatchObject({
        accessEpoch: 5,
        recoveryAttempt: 1,
        status: "proven",
      })
    })
  })

  it("restarts response-to-commit access drift and accepts only the new proof", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const firstEpoch = startConversationNavigationWarmup(queryClient, target("epoch"), 7)
    mocks.requests[0]!.receipt({ channelId: "epoch", surfaceKind: "channel" })
    expect(getConversationNavigationProof(queryClient)?.status).toBe("verified")

    expect(recoverConversationNavigationProof(queryClient, firstEpoch, 8)).toBe(true)
    expect(mocks.requests[0]!.signal?.aborted).toBe(true)
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    mocks.requests[1]!.receipt({ channelId: "epoch", surfaceKind: "forum" })
    mocks.requests[1]!.resolve({ messages: [], hasMore: false })
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)).toMatchObject({
        accessEpoch: 8,
        recoveryAttempt: 0,
        status: "forum",
      })
    })
  })

  it("uses the exact anchor and seeds current read and server results", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, {
      ...target("anchor"),
      anchorMessageId: "m1",
    }, 3)
    expect(mocks.requests[0]!.pageParam).toEqual({ mode: "anchor", anchor: "m1" })
    mocks.requests[0]!.receipt({ channelId: "anchor", surfaceKind: "thread" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    mocks.reads[0]!.resolve({ lastReadMessageId: "m0", lastReadAt: null, lastReadSeq: 4 })
    mocks.servers[0]!.resolve({ id: "s1" })
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("anchor"))).toMatchObject({
        lastReadSeq: 4,
      })
      expect(queryClient.getQueryData(communityKeys.server("s1"))).toEqual({ id: "s1" })
    })
  })

  it("ignores auxiliary failures while canonical proof succeeds", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, target("aux"), 4)
    mocks.reads[0]!.reject(new Error("read transient"))
    mocks.servers[0]!.reject(new Error("detail transient"))
    mocks.requests[0]!.receipt({ channelId: "aux", surfaceKind: "channel" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")
    })
  })
})

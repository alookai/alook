import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { serverDetailResourceKey } from "@/lib/community-db/server-detail-resource"
import {
  getCompletedConversationNavigationEntryEpoch,
  getConversationNavigationProof,
  recoverConversationNavigationProof,
} from "./conversation-navigation-proof"
import { startConversationNavigationWarmup } from "./conversation-navigation-warmup"

type SurfaceKind = "channel" | "thread" | "forum" | "dm"
type Page = { messages: Array<{ id: string }>; hasMore: boolean }

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
    resolve: (value: { serverId: string; categories: []; channels: [] }) => void
    reject: (error: unknown) => void
  }>,
  removeScope: vi.fn(),
  apiFetch: vi.fn(),
  holdPublication: false,
  publicationResolvers: [] as Array<() => void>,
  deleteMessages: vi.fn(),
  purgeMessageScope: vi.fn(async () => undefined),
  purgeChannel: vi.fn(),
  registryAvailable: true,
}))

vi.mock("@/lib/community-db/collections", () => ({
  getCommunityDbRegistry: () => mocks.registryAvailable ? ({
    scopeId: "viewer",
    collections: {
      messages: {
        values: () => [][Symbol.iterator](),
        utils: { writeDelete: mocks.deleteMessages },
      },
    },
    preloadMessageWindow: (
      demand: {
        scope: { channelId: string; kind: "server-channel" | "dm" }
        sequence: { base: { mode: "tail" } | { mode: "anchor"; anchor: string } }
      },
      _limit: number,
      signal?: AbortSignal,
    ) => {
      let receipt: { channelId: string; surfaceKind: SurfaceKind } | undefined
      const pageParam = demand.sequence.base.mode === "anchor"
        ? { mode: "anchor", anchor: demand.sequence.base.anchor }
        : { mode: "newest" }
      const transport = new Promise<Page>((resolve, reject) => {
        const onAbort = () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        }
        if (signal?.aborted) onAbort()
        else signal?.addEventListener("abort", onAbort, { once: true })
        mocks.requests.push({
          channelId: demand.scope.channelId,
          kind: demand.scope.kind === "dm" ? "dm" : "channel",
          pageParam,
          signal,
          receipt: (value) => { receipt = value },
          resolve,
          reject,
        })
      })
      return transport.then(async (page) => {
        if (mocks.holdPublication) {
          await new Promise<void>((resolve) => mocks.publicationResolvers.push(resolve))
        }
        return {
          publication: {
            hasMore: page.hasMore,
            rows: page.messages,
            ...(receipt ? { surfaceReceipt: receipt } : {}),
          },
          release: vi.fn(async () => undefined),
        }
      })
    },
    purgeMessageScope: mocks.purgeMessageScope,
  }) : null,
}))
vi.mock("@/lib/community-db/sync", () => ({
  purgeCommunityChannel: mocks.purgeChannel,
}))
vi.mock("@/lib/community-db/server-detail-resource", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community-db/server-detail-resource")>(),
  createServerDetailResourceQueryFn: () => (
    { queryKey, signal }: { queryKey: readonly unknown[]; signal?: AbortSignal },
  ) => (
    new Promise((resolve, reject) => {
      mocks.servers.push({
        serverId: String(queryKey.at(-1)),
        signal,
        resolve: resolve as (
          value: { serverId: string; categories: []; channels: [] },
        ) => void,
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
    mocks.holdPublication = false
    mocks.publicationResolvers.length = 0
    mocks.deleteMessages.mockReset()
    mocks.purgeMessageScope.mockClear()
    mocks.purgeChannel.mockReset()
    mocks.registryAvailable = true
  })

  it("fails canonical warmup when no community registry owns the query client", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mocks.registryAvailable = false

    startConversationNavigationWarmup(queryClient, target("missing-registry"), 1)

    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("failed")
    })
    expect(mocks.requests).toHaveLength(0)
  })

  it("starts canonical work in parallel and prevents superseded A from seeding", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, target("a"), 4)
    startConversationNavigationWarmup(queryClient, target("b"), 4)
    expect(mocks.requests.map((request) => request.channelId)).toEqual(["a", "b"])
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    expect(mocks.servers).toHaveLength(1)
    expect(mocks.requests[0]!.signal).toBe(mocks.reads[0]!.signal)
    expect(mocks.requests[1]!.signal).toBe(mocks.reads[1]!.signal)
    expect(mocks.requests[0]!.signal).not.toBe(mocks.servers[0]!.signal)
    expect(mocks.requests[0]!.signal?.aborted).toBe(true)
    expect(mocks.reads[0]!.signal?.aborted).toBe(true)
    expect(mocks.servers[0]!.signal?.aborted).toBe(false)

    mocks.requests[0]!.receipt({ channelId: "a", surfaceKind: "channel" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    mocks.requests[1]!.receipt({ channelId: "b", surfaceKind: "channel" })
    mocks.requests[1]!.resolve({ messages: [], hasMore: false })
    mocks.servers[0]!.resolve({ serverId: "s1", categories: [], channels: [] })
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)).toMatchObject({
        status: "proven",
        target: { channelId: "b" },
      })
    })
  })

  it("keeps completed ownership behind target collection publication", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mocks.holdPublication = true
    startConversationNavigationWarmup(queryClient, target("handoff"), 4)

    mocks.requests[0]!.receipt({ channelId: "handoff", surfaceKind: "channel" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    await vi.waitFor(() => {
      expect(mocks.publicationResolvers).toHaveLength(1)
    })
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")

    mocks.publicationResolvers[0]!()
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")
    })
  })

  it("does not seed the removed legacy infinite-query cache", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, target("hidden-handoff"), 4)

    mocks.requests[0]!.receipt({ channelId: "hidden-handoff", surfaceKind: "channel" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")
    })
    expect(queryClient.getQueryData(communityKeys.channelMessages("hidden-handoff"))).toBeUndefined()
  })

  it("covers only anchors present in a complete newest canonical window", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const epoch = startConversationNavigationWarmup(queryClient, target("covered"), 4)

    mocks.requests[0]!.receipt({ channelId: "covered", surfaceKind: "forum" })
    mocks.requests[0]!.resolve({
      messages: [{ id: "in-window" }],
      hasMore: false,
    })
    await vi.waitFor(() => {
      expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
        viewerId: "viewer",
        channelId: "covered",
        scopeKind: "channel",
        anchorMessageId: "in-window",
      }, 4)).toBe(epoch)
    })
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "covered",
      scopeKind: "channel",
      anchorMessageId: "not-in-window",
    }, 4)).toBeNull()
  })

  it("does not cover an anchor from an incomplete newest window", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    startConversationNavigationWarmup(queryClient, target("incomplete"), 4)

    mocks.requests[0]!.receipt({ channelId: "incomplete", surfaceKind: "forum" })
    mocks.requests[0]!.resolve({
      messages: [{ id: "present-but-incomplete" }],
      hasMore: true,
    })
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("forum")
    })
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "incomplete",
      scopeKind: "channel",
      anchorMessageId: "present-but-incomplete",
    }, 4)).toBeNull()
  })

  it("clears target caches and overlays on definitive denial", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("denied"), { stale: true })
    queryClient.setQueryData(communityKeys.channelMeta("s1", "denied"), { stale: true })
    startConversationNavigationWarmup(queryClient, target("denied"), 9)
    mocks.requests[0]!.reject(new ApiError("not found", 404))
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
    })

    expect(mocks.purgeMessageScope).toHaveBeenCalledWith("denied")
    expect(mocks.purgeChannel).toHaveBeenCalled()
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("denied"))).toBeUndefined()
    expect(queryClient.getQueryData(communityKeys.channelMeta("s1", "denied"))).toBeUndefined()
    expect(mocks.removeScope).toHaveBeenCalledWith({
      kind: "channel",
      id: "denied",
      serverId: "s1",
    })
    expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
    expect(mocks.reads[0]!.signal?.aborted).toBe(true)
    expect(mocks.servers[0]!.signal?.aborted).toBe(false)

    mocks.reads[0]!.resolve({ lastReadMessageId: "late", lastReadAt: null, lastReadSeq: 1 })
    mocks.servers[0]!.resolve({ serverId: "s1", categories: [], channels: [] })
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(serverDetailResourceKey("viewer", "s1"))).toBeDefined()
    })
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("denied"))).toBeUndefined()
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
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("d1"), { stale: true })
    queryClient.setQueryData(communityKeys.dmRouteVerification("d1"), "present")
    startConversationNavigationWarmup(queryClient, dmTarget, 2)
    expect(mocks.requests[0]).toMatchObject({ kind: "dm", pageParam: { mode: "newest" } })
    expect(mocks.servers).toHaveLength(0)
    mocks.requests[0]!.reject(new ApiError("forbidden", 403))
    await vi.waitFor(() => {
      expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
    })

    expect(mocks.purgeMessageScope).toHaveBeenCalledWith("d1")
    expect(mocks.purgeChannel).toHaveBeenCalled()
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
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")

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
    expect(mocks.requests[1]!.pageParam).toEqual({ mode: "anchor", anchor: "m1" })
    mocks.requests[0]!.receipt({ channelId: "anchor", surfaceKind: "thread" })
    mocks.requests[0]!.resolve({ messages: [], hasMore: false })
    mocks.requests[1]!.resolve({ messages: [], hasMore: false })
    mocks.reads[0]!.resolve({ lastReadMessageId: "m0", lastReadAt: null, lastReadSeq: 4 })
    mocks.servers[0]!.resolve({ serverId: "s1", categories: [], channels: [] })
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("anchor"))).toMatchObject({
        lastReadSeq: 4,
      })
      expect(queryClient.getQueryData(serverDetailResourceKey("viewer", "s1"))).toEqual({
        serverId: "s1",
        categories: [],
        channels: [],
      })
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

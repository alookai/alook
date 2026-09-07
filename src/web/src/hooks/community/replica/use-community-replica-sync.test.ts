import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { ApiError } from "@/lib/errors"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  listIntents: vi.fn(),
  applyOutcomes: vi.fn(),
  listReadWal: vi.fn(),
  settleReadWal: vi.fn(),
  discardReadWal: vi.fn(),
}))

vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("@/lib/community/replica/shell", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/replica/shell")>(),
  cacheCommunityShellRoute: vi.fn(async () => ({ ok: true })),
}))
vi.mock("@/lib/community/replica/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/replica/store")>(),
  listCommunityReplicaIntents: mocks.listIntents,
  applyCommunityReplicaIntentOutcomes: mocks.applyOutcomes,
}))
vi.mock("@/lib/community/replica/read-wal", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/replica/read-wal")>(),
  listCommunityReplicaReadWal: mocks.listReadWal,
  settleCommunityReplicaReadWal: mocks.settleReadWal,
  discardCommunityReplicaReadWal: mocks.discardReadWal,
}))

import {
  buildCommunityReplicaBootstrapRequest,
  flushCommunityReplicaIntents,
  flushCommunityReplicaReadIntents,
  retainCommunityReplicaBootstrapTails,
  runCommunityReplicaSyncSingleFlight,
  selectCommunityReplicaDeltaFrontier,
  serializeCommunityReplicaSync,
  synchronizeCommunityReplica,
} from "./use-community-replica-sync"
import {
  deleteCommunityReplicaAccount,
  replaceCommunityReplicaBootstrap,
} from "@/lib/community/replica/store"
import { clearCommunityReplicaReadMutations } from "@/lib/community/replica/read-mutation"

const server: ServerDetail = {
  id: "s1",
  name: "Alook",
  discriminator: "0001",
  description: "",
  icon: null,
  ownerId: "owner",
  categories: [{
    id: "cat",
    name: "General",
    channels: Array.from({ length: 40 }, (_, index) => ({
      id: `c${index}`,
      name: `channel-${index}`,
      active: false,
      unread: false,
      type: "text" as const,
    })),
  }],
}

beforeEach(() => {
  vi.clearAllMocks()
  clearCommunityReplicaReadMutations("account-1")
  mocks.listIntents.mockResolvedValue([])
  mocks.listReadWal.mockReturnValue([])
})

afterEach(async () => {
  vi.useRealTimers()
  await deleteCommunityReplicaAccount("account-delta-only")
  await deleteCommunityReplicaAccount("account-bootstrap-publication")
  vi.unstubAllGlobals()
})

describe("community Replica bootstrap request", () => {
  it("puts the current leaf first, deduplicates, and caps tail coverage", () => {
    const request = buildCommunityReplicaBootstrapRequest("s1", "c20", server)
    expect(request).toMatchObject({ protocolVersion: 1, serverId: "s1" })
    expect(request.tails).toHaveLength(32)
    expect(request.tails[0]).toEqual({ channelId: "c20", limit: 100 })
    expect(new Set(request.tails.map((tail) => tail.channelId)).size).toBe(32)
  })

  it("retains verified prior tails ahead of unvisited server channels", () => {
    const request = buildCommunityReplicaBootstrapRequest("s1", "c20", server)
    const retained = retainCommunityReplicaBootstrapTails(request, ["thread-1", "c20", "thread-2"])

    expect(retained.tails.slice(0, 3)).toEqual([
      { channelId: "c20", limit: 100 },
      { channelId: "thread-1", limit: 100 },
      { channelId: "thread-2", limit: 100 },
    ])
    expect(retained.tails).toHaveLength(32)
    expect(new Set(retained.tails.map((tail) => tail.channelId)).size).toBe(32)
  })

  it("drains every covered journal so account/server permission changes cannot stay stale", () => {
    expect(selectCommunityReplicaDeltaFrontier([
      { scope: { kind: "account", id: "account-1" }, revision: 10 },
      { scope: { kind: "server", id: "s1" }, revision: 20 },
      { scope: { kind: "channel", id: "c1" }, revision: 30 },
      { scope: { kind: "channel", id: "c2" }, revision: 40 },
    ])).toEqual([
      { scope: { kind: "account", id: "account-1" }, revision: 10 },
      { scope: { kind: "server", id: "s1" }, revision: 20 },
      { scope: { kind: "channel", id: "c1" }, revision: 30 },
      { scope: { kind: "channel", id: "c2" }, revision: 40 },
    ])
  })

  it("uses one semantic key across equivalent seeded server objects", () => {
    const user = { id: "viewer", name: "Viewer", email: "v@example.com", avatar: "V", avatarVersion: 0 }
    const first = serializeCommunityReplicaSync(user, "/c/channels/s1/c1", "s1", "c1", server)
    const reseeded = serializeCommunityReplicaSync(
      { ...user },
      "/c/channels/s1/c1",
      "s1",
      "c1",
      structuredClone(server),
    )

    expect(reseeded).toBe(first)
  })

  it("changes the semantic key when the offline session identity changes", () => {
    const user = { id: "viewer", name: "Viewer", email: "v@example.com", avatar: "V", avatarVersion: 0 }
    const first = serializeCommunityReplicaSync(user, "/c/channels/s1/c1", "s1", "c1", server)
    const updated = serializeCommunityReplicaSync(
      { ...user, avatarVersion: 1 },
      "/c/channels/s1/c1",
      "s1",
      "c1",
      structuredClone(server),
    )

    expect(updated).not.toBe(first)
  })
})

describe("community Replica session single-flight", () => {
  it("joins an equivalent remount before aborting the shared work", async () => {
    vi.useFakeTimers()
    const queryClient = new QueryClient()
    const first = new AbortController()
    const second = new AbortController()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const run = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      await pending
    })

    const user = { id: "viewer", name: "Viewer", email: "v@example.com", avatar: "V", avatarVersion: 0 }
    const firstKey = serializeCommunityReplicaSync(user, "/c/channels/s1/c1", "s1", "c1", server)!
    const equivalentKey = serializeCommunityReplicaSync(
      { ...user },
      "/c/channels/s1/c1",
      "s1",
      "c1",
      structuredClone(server),
    )!
    const firstResult = runCommunityReplicaSyncSingleFlight(
      queryClient,
      firstKey,
      first.signal,
      run,
    )
    first.abort()
    const secondResult = runCommunityReplicaSyncSingleFlight(
      queryClient,
      equivalentKey,
      second.signal,
      run,
    )
    await vi.advanceTimersByTimeAsync(50)

    expect(run).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([firstResult, secondResult])
  })

  it("aborts work whose offline session identity was superseded", async () => {
    const queryClient = new QueryClient()
    const caller = new AbortController()
    const user = { id: "viewer", name: "Viewer", email: "v@example.com", avatar: "V", avatarVersion: 0 }
    const firstKey = serializeCommunityReplicaSync(user, "/c/channels/s1/c1", "s1", "c1", server)!
    const updatedKey = serializeCommunityReplicaSync(
      { ...user, avatarVersion: 1 },
      "/c/channels/s1/c1",
      "s1",
      "c1",
      server,
    )!
    let firstSignal!: AbortSignal
    const first = runCommunityReplicaSyncSingleFlight(
      queryClient,
      firstKey,
      caller.signal,
      async (signal) => {
        firstSignal = signal
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    )
    const second = runCommunityReplicaSyncSingleFlight(
      queryClient,
      updatedKey,
      caller.signal,
      async () => undefined,
    )

    expect(firstSignal.aborted).toBe(true)
    await expect(first).rejects.toBeDefined()
    await second
  })
})

describe("community Replica intent recovery", () => {
  it("replays durable reads without settling them before a snapshot proves persistence", async () => {
    mocks.listReadWal.mockReturnValue([
      { channelId: "c1", messageId: "m1", seq: 10, observedAt: "2026-09-06T03:00:00Z" },
      { channelId: "c2", messageId: "m2", seq: 20, observedAt: "2026-09-06T03:01:00Z" },
    ])
    mocks.apiFetch
      .mockResolvedValueOnce({ targetSeq: 10 })
      .mockRejectedValueOnce(new ApiError("forbidden", 403))

    await flushCommunityReplicaReadIntents("account-1", new AbortController().signal)

    expect(mocks.settleReadWal).not.toHaveBeenCalled()
    expect(mocks.discardReadWal).toHaveBeenCalledWith("account-1", "c2")
  })

  it("flushes every locally committed WAL intent in bounded batches", async () => {
    const intents = Array.from({ length: 17 }, (_, index) => ({
      intentId: `intent-${index}`,
      kind: "message.send" as const,
      scope: { kind: "channel" as const, id: "c1" },
      createdAt: "2026-09-06T03:00:00.000+08:00",
      payload: { content: `message ${index}` },
    }))
    mocks.listIntents
      .mockResolvedValueOnce(intents.map((intent) => ({
        intentId: intent.intentId,
        intent,
        state: "local-committed",
        outcome: null,
      })))
      .mockResolvedValueOnce([{
        intentId: intents[16]!.intentId,
        intent: intents[16],
        state: "local-committed",
        outcome: null,
      }])
      .mockResolvedValueOnce([])
    mocks.apiFetch.mockImplementation(async (_path, init) => {
      const request = JSON.parse(init.body)
      return {
        protocolVersion: 1,
        outcomes: request.intents.map((intent: { intentId: string }) => ({
          intentId: intent.intentId,
          status: "accepted",
          causalId: `causal-${intent.intentId}`,
          canonical: {
            scope: { kind: "channel", id: "c1" },
            revision: 1,
            messageId: `message-${intent.intentId}`,
            seq: 1,
          },
        })),
      }
    })

    await flushCommunityReplicaIntents("account-1", new AbortController().signal)

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mocks.apiFetch.mock.calls[0]![1].body).intents).toHaveLength(16)
    expect(JSON.parse(mocks.apiFetch.mock.calls[1]![1].body).intents).toHaveLength(1)
    expect(mocks.applyOutcomes).toHaveBeenCalledTimes(2)
  })
})

describe("community Replica steady-state synchronization", () => {
  it("publishes a newly bootstrapped route only after its final delta settles", async () => {
    const accountId = "account-bootstrap-publication"
    const pathname = "/c/channels/s1/c1"
    const checkedAt = "2026-09-06T03:00:00.000+08:00"
    const validUntil = "2027-09-06T03:00:00.000+08:00"
    const scopes = [
      { kind: "account" as const, id: accountId },
      { kind: "server" as const, id: "s1" },
      { kind: "channel" as const, id: "c1" },
    ]
    const snapshot = {
      protocolVersion: 1 as const,
      snapshotId: "bootstrap-publication-snapshot",
      takenAt: checkedAt,
      frontier: scopes.map((scope, index) => ({ scope, revision: index + 1 })),
      coverage: scopes.map((scope, index) => ({
        scope,
        revision: index + 1,
        completeness: scope.kind === "channel" ? "partial" as const : "complete" as const,
        permission: { epoch: `${scope.kind}-lease`, checkedAt, validUntil },
        messageRange: scope.kind === "channel"
          ? { firstSeq: 1, lastSeq: 1, hasOlder: false, hasNewer: false }
          : null,
      })),
      facts: [],
    }
    const values = new Map<string, string>()
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      get length() { return values.size },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    let settleDelta!: (value: unknown) => void
    const pendingDelta = new Promise((resolve) => { settleDelta = resolve })
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === "/api/community/replica/bootstrap") return snapshot
      if (path === "/api/community/replica/delta") return pendingDelta
      throw new Error(`unexpected bootstrap request ${path}`)
    })

    const synchronizing = synchronizeCommunityReplica(
      new QueryClient(),
      { id: accountId, name: "Viewer", email: "v@example.com", avatar: "V", avatarVersion: 0 },
      pathname,
      { protocolVersion: 1, serverId: "s1", tails: [{ channelId: "c1", limit: 100 }] },
      new AbortController().signal,
      vi.fn(),
    )
    await vi.waitFor(() => {
      expect(mocks.apiFetch.mock.calls.map(([path]) => path)).toEqual([
        "/api/community/replica/bootstrap",
        "/api/community/replica/delta",
      ])
    })
    expect(values.get("alook-community-replica-control-v1:active")).toBeUndefined()

    settleDelta({
      protocolVersion: 1,
      status: "ok",
      from: snapshot.frontier,
      batches: [],
      frontier: snapshot.frontier,
      hasMore: false,
    })
    await synchronizing

    expect(JSON.parse(values.get("alook-community-replica-control-v1:active") ?? "null"))
      .toMatchObject({ accountId, shellRoutes: [pathname] })
  })

  it("uses only bounded deltas for a compatible covered route", async () => {
    const accountId = "account-delta-only"
    const pathname = "/c/channels/s1/c1"
    const checkedAt = "2026-09-06T03:00:00.000+08:00"
    const validUntil = "2027-09-06T03:00:00.000+08:00"
    const scopes = [
      { kind: "account" as const, id: accountId },
      { kind: "server" as const, id: "s1" },
      { kind: "channel" as const, id: "c1" },
    ]
    const snapshot = {
      protocolVersion: 1 as const,
      snapshotId: "delta-only-snapshot",
      takenAt: checkedAt,
      frontier: scopes.map((scope, index) => ({ scope, revision: index + 1 })),
      coverage: scopes.map((scope, index) => ({
        scope,
        revision: index + 1,
        completeness: scope.kind === "channel" ? "partial" as const : "complete" as const,
        permission: { epoch: `${scope.kind}-lease`, checkedAt, validUntil },
        messageRange: scope.kind === "channel"
          ? { firstSeq: 1, lastSeq: 1, hasOlder: false, hasNewer: false }
          : null,
      })),
      facts: [],
    }
    const values = new Map<string, string>()
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      get length() { return values.size },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    await replaceCommunityReplicaBootstrap(accountId, snapshot)
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path !== "/api/community/replica/delta") {
        throw new Error(`unexpected steady-state request ${path}`)
      }
      return {
        protocolVersion: 1,
        status: "ok",
        from: snapshot.frontier,
        batches: [],
        frontier: snapshot.frontier,
        hasMore: false,
      }
    })

    await synchronizeCommunityReplica(
      new QueryClient(),
      { id: accountId, name: "Viewer", email: "v@example.com", avatar: "V", avatarVersion: 0 },
      pathname,
      { protocolVersion: 1, serverId: "s1", tails: [{ channelId: "c1", limit: 100 }] },
      new AbortController().signal,
      vi.fn(),
    )

    expect(mocks.apiFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/community/replica/delta",
    ])
  })
})

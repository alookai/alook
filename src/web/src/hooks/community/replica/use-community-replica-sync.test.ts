import { beforeEach, describe, expect, it, vi } from "vitest"
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
vi.mock("@/lib/community/replica/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/replica/store")>(),
  listCommunityReplicaIntents: mocks.listIntents,
  applyCommunityReplicaIntentOutcomes: mocks.applyOutcomes,
}))
vi.mock("@/lib/community/replica/read-wal", () => ({
  listCommunityReplicaReadWal: mocks.listReadWal,
  settleCommunityReplicaReadWal: mocks.settleReadWal,
  discardCommunityReplicaReadWal: mocks.discardReadWal,
}))

import {
  buildCommunityReplicaBootstrapRequest,
  flushCommunityReplicaIntents,
  flushCommunityReplicaReadIntents,
  retainCommunityReplicaBootstrapTails,
  selectCommunityReplicaDeltaFrontier,
} from "./use-community-replica-sync"

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

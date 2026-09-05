import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerDetail } from "@/hooks/community/use-servers"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  listIntents: vi.fn(),
  applyOutcomes: vi.fn(),
}))

vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("@/lib/community/replica/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/replica/store")>(),
  listCommunityReplicaIntents: mocks.listIntents,
  applyCommunityReplicaIntentOutcomes: mocks.applyOutcomes,
}))

import {
  buildCommunityReplicaBootstrapRequest,
  flushCommunityReplicaIntents,
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
})

describe("community Replica intent recovery", () => {
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

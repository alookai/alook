import { describe, expect, it } from "vitest"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { buildCommunityReplicaBootstrapRequest } from "./use-community-replica-sync"

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

describe("community Replica bootstrap request", () => {
  it("puts the current leaf first, deduplicates, and caps tail coverage", () => {
    const request = buildCommunityReplicaBootstrapRequest("s1", "c20", server)
    expect(request).toMatchObject({ protocolVersion: 1, serverId: "s1" })
    expect(request.tails).toHaveLength(32)
    expect(request.tails[0]).toEqual({ channelId: "c20", limit: 100 })
    expect(new Set(request.tails.map((tail) => tail.channelId)).size).toBe(32)
  })
})

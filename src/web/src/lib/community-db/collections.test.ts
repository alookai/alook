import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { writeCommunityCollectionRows } from "./collection-mutations"
import type { AttentionItemRow, MessageRow } from "./schema"

let registry: CommunityDbRegistry | null = null

afterEach(() => {
  registry?.cleanup()
  registry = null
})

describe("community message retention", () => {
  it("keeps the active scope, 20 inactive tails, and attention-referenced rows", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    await registry.preload()
    registry.activateMessageScope("scope-0")
    const messages: MessageRow[] = Array.from({ length: 22 }, (_, scope) => (
      Array.from({ length: 60 }, (_, index) => ({
        id: `m-${scope}-${index}`,
        channelId: `scope-${scope}`,
        type: "chat" as const,
        createdAt: new Date(Date.UTC(2026, 0, scope + 1, 0, index)).toISOString(),
      }))
    )).flat()
    writeCommunityCollectionRows(registry, "messages", messages, (row) => row.id)
    const attention: AttentionItemRow = {
      id: "attention-1",
      kind: "mention",
      sourceId: "source-1",
      scopeId: "scope-1",
      messageId: "m-1-0",
      actorUserId: "actor-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    writeCommunityCollectionRows(
      registry,
      "attentionItems",
      [attention],
      (row) => row.id,
    )
    await registry.preload()

    await registry.pruneMessageRetention()

    const retained = [...registry.collections.messages.values()]
    expect(retained.filter((row) => row.channelId === "scope-0")).toHaveLength(60)
    expect(retained.filter((row) => row.channelId === "scope-1").map((row) => row.id))
      .toEqual(["m-1-0"])
    expect(retained.filter((row) => row.channelId === "scope-2")).toHaveLength(50)
    expect(retained.filter((row) => row.channelId === "scope-21")).toHaveLength(50)
    expect(new Set(retained.map((row) => row.channelId)).size).toBe(22)
  })
})

import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { writeCommunityCollectionRows } from "./collection-mutations"
import type { AttentionItemRow, MessageRow } from "./schema"

let registry: CommunityDbRegistry | null = null

afterEach(() => {
  registry?.cleanup()
  registry = null
})

describe("community collection readiness", () => {
  it("owns one preload promise and publishes ready only after it resolves", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    const collection = registry.collections.messages
    const originalPreload = collection.preload.bind(collection)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const preload = vi.spyOn(collection, "preload").mockImplementation(async () => {
      await gate
      await originalPreload()
    })
    const listener = vi.fn()
    registry.subscribeCollectionReadiness(listener)

    const first = registry.ensureCollectionReady("messages")
    const second = registry.ensureCollectionReady("messages")
    expect(first).toBe(second)
    expect(registry.getCollectionReadiness("messages")).toBe("preloading")
    expect(registry.isCollectionReady("messages")).toBe(false)
    expect(preload).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(preload).toHaveBeenCalledOnce()
    release()
    await first
    expect(registry.getCollectionReadiness("messages")).toBe("ready")
    expect(registry.isCollectionReady("messages")).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("rejects writes to an already-ready collection after another preload fails", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-generation-failure")
    await registry.ensureCollectionReady("profiles")
    const failure = new Error("messages preload failed")
    vi.spyOn(registry.collections.messages, "preload").mockRejectedValueOnce(failure)

    await expect(registry.ensureCollectionReady("messages")).rejects.toBe(failure)
    const committed = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 }],
      (row) => row.userId,
    )

    await expect(committed).rejects.toBe(failure)
    expect(registry.collections.profiles.has("alice")).toBe(false)
  })

  it("fences a durable write queued before another collection fails", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-durable-generation-failure")
    await registry.ensureCollectionReady("profiles")
    const profiles = registry.collections.profiles
    let releasePersistence!: () => void
    const persistence = new Promise<void>((resolve) => { releasePersistence = resolve })
    Object.assign(profiles.utils, { getLeadershipState: vi.fn() })
    const acceptMutations = vi.spyOn(profiles.utils, "acceptMutations")
      .mockImplementationOnce(() => persistence)
    const first = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 }],
      (row) => row.userId,
    )
    await vi.waitFor(() => expect(acceptMutations).toHaveBeenCalledOnce())
    const second = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "bob", name: "Bob", discriminator: "0002", avatar: "B", avatarVersion: 0 }],
      (row) => row.userId,
    )
    const failure = new Error("messages preload failed")
    vi.spyOn(registry.collections.messages, "preload").mockRejectedValueOnce(failure)
    await expect(registry.ensureCollectionReady("messages")).rejects.toBe(failure)

    releasePersistence()
    await first
    await expect(second).rejects.toBe(failure)
    expect(acceptMutations).toHaveBeenCalledOnce()
    expect(profiles.has("bob")).toBe(false)
  })
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

import { QueryClient } from "@tanstack/react-query"
import type { PersistedCollectionPersistence } from "@tanstack/browser-db-sqlite-persistence"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyCommunityServerPatch,
  clearCommunityPersistenceForAccount,
  createCommunityDbRegistry,
  getCommunityDbRegistryBinding,
  registerCommunityDbRegistry,
  subscribeCommunityDbRegistryBinding,
  type CommunityDbRegistry,
} from "./collections"
import { writeCommunityCollectionRows } from "./collection-mutations"
import type { AttentionItemRow, MessageRow } from "./schema"
import type { MessageCollectionDemand } from "./message-resource"
import { readServerTreeProjection } from "./projections"

let registry: CommunityDbRegistry | null = null

function stubEmptyCommunityResources() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith("/api/community/users/me/read-state")
      ? { revision: 0, readStates: [] }
      : url.endsWith("/api/community/users/me/attention")
        ? {
            scopes: [], items: [], limit: 100, truncated: false,
            included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
          }
        : url.endsWith("/api/community/users/me/dms")
          ? { conversations: [] }
      : url.endsWith("/api/community/users/me/server-folders")
        ? { folders: [] }
        : url.endsWith("/api/community/users/me/notifications")
          ? []
          : url.includes("/api/community/channels/") && url.includes("/messages")
            ? {
                messages: [{
                  id: "message-1",
                  type: "chat",
                  seq: 1,
                  createdAt: "2026-09-29T00:00:00.000Z",
                  content: "hello",
                }],
                hasMore: false,
                latestSeq: 1,
              }
          : null
    if (body === null) throw new Error(`unexpected API fetch: ${url}`)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }))
}

afterEach(() => {
  registry?.cleanup()
  registry = null
  vi.unstubAllGlobals()
})

describe("community collection readiness", () => {
  it("does not project a server tree before both source collections are ready", () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-cold-tree")

    expect(readServerTreeProjection(registry, "server")).toBeUndefined()
  })

  it("keeps the newest registry binding when an older registration releases", async () => {
    const queryClient = new QueryClient()
    const first = createCommunityDbRegistry(queryClient, "viewer")
    const second = createCommunityDbRegistry(queryClient, "viewer")
    const listener = vi.fn()
    const unsubscribe = subscribeCommunityDbRegistryBinding(queryClient, listener)
    const unregisterFirst = registerCommunityDbRegistry(first)
    const firstBinding = getCommunityDbRegistryBinding(queryClient)
    const unregisterSecond = registerCommunityDbRegistry(second)
    const secondBinding = getCommunityDbRegistryBinding(queryClient)

    expect(firstBinding?.registry).toBe(first)
    expect(firstBinding?.generation).toBe(1)
    expect(secondBinding?.registry).toBe(second)
    expect(secondBinding?.generation).toBe(2)
    unregisterFirst()
    expect(getCommunityDbRegistryBinding(queryClient)).toBe(secondBinding)
    unregisterSecond()
    expect(getCommunityDbRegistryBinding(queryClient)).toBeNull()
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    await Promise.all([first.cleanup(), second.cleanup()])
  })

  it("owns one readiness promise without preloading an on-demand transport", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    const collection = registry.collections.messages
    const preload = vi.spyOn(collection, "preload")
    const listener = vi.fn()
    registry.subscribeCollectionReadiness(listener)

    const first = registry.ensureCollectionReady("messages")
    const second = registry.ensureCollectionReady("messages")
    expect(first).toBe(second)
    expect(registry.getCollectionReadiness("messages")).toBe("preloading")
    expect(registry.isCollectionReady("messages")).toBe(false)
    expect(preload).not.toHaveBeenCalled()

    await first
    expect(preload).not.toHaveBeenCalled()
    expect(registry.getCollectionReadiness("messages")).toBe("ready")
    expect(registry.isCollectionReady("messages")).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("announces restored server rows", async () => {
    let resolveFetch!: (response: Response) => void
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })))
    const server = {
      id: "restored-server",
      position: 0,
      name: "Restored",
      discriminator: "0001",
      description: "",
      ownerId: "viewer",
      icon: null,
      official: false,
      isOwner: true,
      unread: false,
      mentions: 0,
      detailComplete: false,
    }
    const persistence: PersistedCollectionPersistence = {
      adapter: {
        applyCommittedTx: async () => {},
        ensureIndex: async () => {},
        loadSubset: async (collectionId) => collectionId.endsWith(":servers")
          ? [{ key: server.id, value: server }]
          : [],
      },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    registry = createCommunityDbRegistry(queryClient, "viewer-restored", {
      persistence,
      serverTransport: true,
    })
    const restored = vi.fn()
    registry.subscribeRestoredCollections(restored)

    await vi.waitFor(() => {
      expect(registry?.hasRestoredCollection("servers")).toBe(true)
      expect(registry?.hasRestoredData()).toBe(true)
      expect(restored).toHaveBeenCalled()
    })
    resolveFetch(new Response(JSON.stringify({ servers: [] }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }))
    await registry.ensureCollectionReady("servers")
  })

  it("resolves the server-refetch wait when no refresh owns the slot", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-idle-refetch")

    await expect(registry.waitForServerRefetch()).resolves.toBeUndefined()
  })

  it("rejects writes to an already-ready collection after another preload fails", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-generation-failure")
    await registry.ensureCollectionReady("profiles")
    const failure = new Error("read-state preload failed")
    vi.spyOn(registry.collections.readStates, "preload").mockRejectedValueOnce(failure)

    await expect(registry.ensureCollectionReady("readStates")).rejects.toBe(failure)
    const committed = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 }],
      (row) => row.userId,
    )

    await expect(committed).rejects.toBe(failure)
    expect(registry.collections.profiles.has("alice")).toBe(false)
    expect(registry.isFailed()).toBe(true)
  })

  it("fences queued on-demand writes when another collection fails", async () => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-queued-generation-failure")
    await registry.ensureCollectionReady("profiles")
    const profiles = registry.collections.profiles
    let releaseReady!: () => void
    vi.spyOn(profiles, "startSyncImmediate").mockImplementation(() => undefined)
    vi.spyOn(profiles, "isReady").mockReturnValue(false)
    vi.spyOn(profiles, "onFirstReady").mockImplementation((callback) => {
      releaseReady = callback
      return vi.fn()
    })
    const syncNotInitialized = new Error("manual sync is not initialized")
    syncNotInitialized.name = "SyncNotInitializedError"
    const writeBatch = vi.spyOn(profiles.utils, "writeBatch")
      .mockImplementationOnce(() => { throw syncNotInitialized })
    const first = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 }],
      (row) => row.userId,
    )
    const second = writeCommunityCollectionRows(
      registry,
      "profiles",
      [{ userId: "bob", name: "Bob", discriminator: "0002", avatar: "B", avatarVersion: 0 }],
      (row) => row.userId,
    )
    const failure = new Error("read-state preload failed")
    vi.spyOn(registry.collections.readStates, "preload").mockRejectedValueOnce(failure)
    await expect(registry.ensureCollectionReady("readStates")).rejects.toBe(failure)

    releaseReady()
    await expect(first).rejects.toBe(failure)
    await expect(second).rejects.toBe(failure)
    expect(writeBatch).toHaveBeenCalledOnce()
    expect(profiles.has("alice")).toBe(false)
    expect(profiles.has("bob")).toBe(false)
  })

  it("rejects unsupported server patches and requests canonical repair", async () => {
    const queryClient = new QueryClient()
    registry = createCommunityDbRegistry(queryClient, "viewer")
    const unregister = registerCommunityDbRegistry(registry)
    await registry.ensureCollectionReady("servers")
    registry.collections.servers.utils.writeInsert({
      id: "server",
      position: 0,
      name: "Server",
      discriminator: "0001",
      description: "",
      ownerId: "viewer",
      icon: null,
      official: false,
      isOwner: true,
      unread: false,
      mentions: 0,
      detailComplete: false,
    })
    const refetch = vi.spyOn(registry, "requestServerRefetch").mockResolvedValue(undefined)

    expect(applyCommunityServerPatch(queryClient, "server", { ownerId: "other" })).toBe(false)
    expect(refetch).toHaveBeenCalledOnce()
    unregister()
  })

  it("clears every active account collection through the registered runtime", async () => {
    stubEmptyCommunityResources()
    const queryClient = new QueryClient()
    registry = createCommunityDbRegistry(queryClient, "viewer-clear")
    const unregister = registerCommunityDbRegistry(registry)
    await registry.preload()
    await writeCommunityCollectionRows(registry, "profiles", [{
      userId: "alice",
      name: "Alice",
      discriminator: "0001",
      avatar: "A",
      avatarVersion: 0,
    }], (row) => row.userId)

    await clearCommunityPersistenceForAccount("viewer-clear")

    expect(registry.collections.profiles.size).toBe(0)
    unregister()
  })
})

describe("community message retention", () => {
  const tailDemand: MessageCollectionDemand = {
    scope: {
      accountId: "viewer",
      kind: "server-channel",
      serverId: "server",
      channelId: "channel",
    },
    tag: null,
    sequence: {
      base: { mode: "tail" },
      direction: "older",
      order: ["seq", "asc", "id", "asc"],
    },
  }

  it("preloads and releases one canonical message window", async () => {
    stubEmptyCommunityResources()
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    await registry.ensureCollectionReady("messages")

    const acquired = await registry.preloadMessageWindow(tailDemand, 50)

    expect(acquired.publication).toMatchObject({
      hasMore: false,
      rows: [expect.objectContaining({ id: "message-1", channelId: "channel" })],
    })
    await acquired.release()
    await acquired.release()
  })

  it("releases an already-aborted message-window acquisition", async () => {
    stubEmptyCommunityResources()
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    await registry.ensureCollectionReady("messages")
    const controller = new AbortController()
    controller.abort()

    await expect(registry.preloadMessageWindow(tailDemand, 50, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" })
  })

  it("keeps the active scope, 20 inactive tails, and attention-referenced rows", async () => {
    stubEmptyCommunityResources()
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

  it("keeps a multiply-owned scope active until the final release", async () => {
    stubEmptyCommunityResources()
    registry = createCommunityDbRegistry(new QueryClient(), "viewer-refcount")
    await registry.preload()
    const rows: MessageRow[] = Array.from({ length: 52 }, (_, index) => ({
      id: `m-${String(index).padStart(2, "0")}`,
      channelId: "scope",
      type: "chat" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      seq: index < 2 ? 50 : index,
    }))
    await writeCommunityCollectionRows(registry, "messages", rows, (row) => row.id)
    const releaseFirst = registry.activateMessageScope("scope")
    const releaseSecond = registry.activateMessageScope("scope")
    releaseFirst()

    await registry.pruneMessageRetention()
    expect(registry.collections.messages.size).toBe(52)

    releaseSecond()
    await registry.pruneMessageRetention()
    expect(registry.collections.messages.size).toBe(50)
  })
})

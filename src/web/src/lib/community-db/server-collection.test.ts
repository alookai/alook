import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  applyCommunityServerPatch,
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "./collections"
import {
  normalizeServersResponse,
  serversCollectionQueryKey,
  type ServersResponse,
} from "./server-collection"
import { serverMembersRowsKey } from "./server-members-pagination"

const apiFetch = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

const rawServer = {
  id: "server-1",
  name: "Alook",
  discriminator: "0001",
  description: null,
  ownerId: "viewer",
  icon: null,
  official: true,
  role: "owner",
  unread: true,
  mentions: 3,
  unreadSources: [{ channelId: "channel-1", lastUnreadSeq: 8 }],
  mentionSources: [{ channelId: "channel-1", count: 1, lastSeq: 8 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

describe("official server collection", () => {
  it("normalizes identity rows and keeps attention as source evidence", () => {
    const response = normalizeServersResponse([rawServer])
    expect(response.servers).toEqual([expect.objectContaining({
      id: "server-1",
      position: 0,
      description: "",
      isOwner: true,
      unread: false,
      mentions: 0,
      detailComplete: false,
    })])
    expect(response.unreadSources).toEqual([
      { channelId: "channel-1", serverId: "server-1", lastUnreadSeq: 8 },
      {
        channelId: "channel-1",
        serverId: "server-1",
        lastUnreadSeq: 8,
        lastMentionSeq: 8,
        isMention: true,
      },
    ])
  })

  it("rejects malformed transport rows before applying attention evidence", () => {
    expect(() => normalizeServersResponse([{
      ...rawServer,
      name: undefined,
    } as never])).toThrow()
  })

  it("hydrates the collection without creating the old DB shadow query", async () => {
    apiFetch.mockResolvedValue({ servers: [rawServer] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer", { serverTransport: true })

    await registry.ensureCollectionReady("servers")

    expect(registry.collections.servers.get("server-1")).toMatchObject({
      id: "server-1",
      name: "Alook",
    })
    expect(queryClient.getQueryData(serversCollectionQueryKey())).toEqual(expect.objectContaining({
      servers: [expect.objectContaining({ id: "server-1" })],
    }))
    expect(queryClient.getQueryData(communityKeys.servers())).toBeUndefined()
    expect(queryClient.getQueryData(
      communityKeys.communityDbCollection("viewer", "servers"),
    )).toBeUndefined()
    const query = queryClient.getQueryCache().find({
      queryKey: serversCollectionQueryKey(),
      exact: true,
    })
    expect(query?.options.staleTime).toBe(Infinity)
    expect(query?.options.refetchOnReconnect).toBe(true)

    registry.cleanup()
    queryClient.clear()
  })

  it("coalesces concurrent authoritative refetches", async () => {
    apiFetch.mockResolvedValue({ servers: [rawServer] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer", { serverTransport: true })
    await registry.ensureCollectionReady("servers")

    apiFetch.mockResolvedValue({ servers: [{ ...rawServer, name: "Renamed" }] })
    const first = registry.requestServerRefetch()
    const second = registry.requestServerRefetch()
    expect(first).toBe(second)
    await first
    expect(registry.collections.servers.get("server-1")?.name).toBe("Renamed")

    registry.cleanup()
    queryClient.clear()
  })

  it("applies only exact partial patches and refetches a missing row", async () => {
    apiFetch.mockResolvedValue({ servers: [rawServer] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer", { serverTransport: true })
    const unregister = registerCommunityDbRegistry(registry)
    await registry.ensureCollectionReady("servers")

    expect(applyCommunityServerPatch(queryClient, "server-1", { name: "Patched" })).toBe(true)
    expect(registry.collections.servers.get("server-1")).toMatchObject({
      name: "Patched",
      description: "",
      icon: null,
    })

    const refetch = vi.spyOn(registry, "requestServerRefetch").mockResolvedValue(undefined)
    expect(applyCommunityServerPatch(queryClient, "server-1", { name: undefined })).toBe(false)
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(applyCommunityServerPatch(queryClient, "missing", { name: "No insert" })).toBe(false)
    expect(registry.collections.servers.has("missing")).toBe(false)
    expect(refetch).toHaveBeenCalledTimes(2)

    unregister()
    registry.cleanup()
    queryClient.clear()
  })

  it("keeps nested resource caches isolated from row update and delete writes", async () => {
    apiFetch.mockResolvedValue({ servers: [rawServer] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer", { serverTransport: true })
    await registry.ensureCollectionReady("servers")
    const detailKey = communityKeys.server("server-1")
    const membersKey = serverMembersRowsKey("viewer", "server-1")
    const invitesKey = communityKeys.invites("server-1")
    const detail = { id: "server-1", categories: [] }
    const members = {
      pages: [{ members: [{ id: "member-1", userId: "viewer" }], hasMore: false }],
      pageParams: [null],
    }
    const invites = { invites: [{ id: "invite-1" }] }
    queryClient.setQueryData(detailKey, detail)
    queryClient.setQueryData(membersKey, members)
    queryClient.setQueryData(invitesKey, invites)

    registry.collections.servers.utils.writeUpdate({ id: "server-1", name: "Updated" })
    expect(queryClient.getQueryData(detailKey)).toBe(detail)
    expect(queryClient.getQueryData(membersKey)).toBe(members)
    expect(queryClient.getQueryData(invitesKey)).toBe(invites)

    registry.collections.servers.utils.writeDelete("server-1")
    expect(queryClient.getQueryData(detailKey)).toBe(detail)
    expect(queryClient.getQueryData(membersKey)).toBe(members)
    expect(queryClient.getQueryData(invitesKey)).toBe(invites)

    registry.cleanup()
    queryClient.clear()
  })

  it("keeps wrapped unread sources intact when apply-time selection maps servers", async () => {
    apiFetch.mockResolvedValue({ servers: [rawServer] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer", { serverTransport: true })
    await registry.ensureCollectionReady("servers")
    const initial = queryClient.getQueryData<ServersResponse>(serversCollectionQueryKey())!
    const unreadSources = initial.unreadSources

    registry.collections.servers.utils.writeUpdate({
      id: "server-1",
      detailComplete: true,
    })
    queryClient.setQueryData<ServersResponse>(serversCollectionQueryKey(), (current) => ({
      ...current!,
      servers: current!.servers.map((server) => ({
        ...server,
        detailComplete: false,
      })),
    }))
    await vi.waitFor(() => {
      expect(registry.collections.servers.get("server-1")?.detailComplete).toBe(true)
    })

    registry.collections.servers.utils.writeUpdate({ id: "server-1", name: "Updated" })
    const updated = queryClient.getQueryData<ServersResponse>(serversCollectionQueryKey())!
    expect(updated.servers).toEqual([
      expect.objectContaining({ id: "server-1", name: "Updated", detailComplete: true }),
    ])
    expect(updated.unreadSources).toBe(unreadSources)

    registry.cleanup()
    queryClient.clear()
  })

  it("clears official server rows without routing through local mutation utilities", async () => {
    apiFetch.mockImplementation(async (url: unknown) => {
      if (url === "/api/community/servers") return { servers: [rawServer] }
      if (url === "/api/community/users/me/read-state") {
        return { revision: 0, readStates: [] }
      }
      if (url === "/api/community/users/me/server-folders") return { folders: [] }
      if (url === "/api/community/users/me/notifications") return []
      if (url === "/api/community/users/me/dms") return { conversations: [] }
      if (url === "/api/community/users/me/attention") {
        return {
          scopes: [],
          items: [],
          limit: 100,
          truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
        }
      }
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer", { serverTransport: true })
    await registry.preload()

    await registry.clear()

    expect(registry.collections.servers.size).toBe(0)
    expect(queryClient.getQueryData<ServersResponse>(serversCollectionQueryKey())?.servers).toEqual([])
    registry.cleanup()
    queryClient.clear()
  })
})

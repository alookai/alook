import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { foldersResourceKey } from "@/lib/community-db/folders-resource"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import { serverMembersRowsKey } from "@/lib/community-db/server-members-pagination"

const apiFetchMock = vi.fn()
const useMutationMock = vi.fn()
let queryClient: QueryClient
let registry: CommunityDbRegistry
let unregister: () => void

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => queryClient,
    useMutation: (options: unknown) => useMutationMock(options),
  }
})

import { useServerRailCommit } from "./server-rail"

const before = {
  serverOrder: ["a", "b", "c"],
  folderOrder: ["one"],
  folders: { one: ["c"] },
  expanded: [],
}
const after = {
  serverOrder: ["b", "a", "c"],
  folderOrder: ["one", "temp_1"],
  folders: { one: ["c"], temp_1: ["a", "b"] },
  expanded: ["temp_1"],
}
const args = {
  before,
  after,
  commands: [{ kind: "create-folder", clientId: "temp_1", name: "Group", serverIds: ["a", "b"] }] as const,
}

describe("useServerRailCommit", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    apiFetchMock.mockImplementation(async (url: unknown) => {
      if (url === "/api/community/users/me/server-folders") {
        return {
          folders: [{
            id: "one",
            name: "One",
            position: 0,
            servers: [{ id: "c", name: "C", icon: null }],
          }],
        }
      }
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    registry = createCommunityDbRegistry(queryClient, "viewer")
    unregister = registerCommunityDbRegistry(registry)
    await registry.ensureCollectionReady("servers")
    registry.collections.servers.utils.writeInsert(["a", "b", "c"].map((id, position) => ({
      id,
      position,
      name: id.toUpperCase(),
      discriminator: "0001",
      description: "",
      ownerId: "viewer",
      icon: null,
      official: false,
      isOwner: false,
      unread: false,
      mentions: 0,
      detailComplete: false,
    })))
    useMutationMock.mockImplementation((options) => options)
    queryClient.setQueryData(serversCollectionQueryKey(), {
      servers: ["a", "b", "c"].map((id) => ({
        id,
        name: id.toUpperCase(),
        initial: id.toUpperCase(),
        active: false,
        mentions: 0,
      })),
    })
  })

  afterEach(() => {
    unregister()
    registry.cleanup()
    queryClient.clear()
  })

  it("uses one PATCH with the full command batch", async () => {
    const options = useServerRailCommit() as any
    apiFetchMock.mockResolvedValue({ createdFolderIds: {} })
    await options.mutationFn(args)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/server-rail",
      { method: "PATCH", body: JSON.stringify({ commands: args.commands }) },
    )
  })

  it("cancels both caches before one synchronous optimistic projection", async () => {
    const options = useServerRailCommit() as any
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const detail = { id: "a", categories: [] }
    const members = { pages: [{ members: [{ id: "m", userId: "viewer" }] }], pageParams: [null] }
    const invites = { invites: [{ id: "invite" }] }
    queryClient.setQueryData(communityKeys.server("a"), detail)
    queryClient.setQueryData(serverMembersRowsKey("viewer", "a"), members)
    queryClient.setQueryData(communityKeys.invites("a"), invites)
    const context = await options.onMutate(args)
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(Array.from(registry.collections.servers.values())
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
      .map((server) => server.id)).toEqual(["b", "a", "c"])
    expect([...registry.collections.folders.values()]).toMatchObject([
      { id: "one", position: 0 },
      { id: "temp_1", position: 1 },
    ])
    expect([...registry.collections.folderItems.values()]).toMatchObject([
      { folderId: "one", serverId: "c", position: 0 },
      { folderId: "temp_1", serverId: "a", position: 0 },
      { folderId: "temp_1", serverId: "b", position: 1 },
    ])
    expect(context.servers.map((server: any) => server.id)).toEqual(["a", "b", "c"])
    expect(queryClient.getQueryData(communityKeys.server("a"))).toBe(detail)
    expect(queryClient.getQueryData(serverMembersRowsKey("viewer", "a"))).toBe(members)
    expect(queryClient.getQueryData(communityKeys.invites("a"))).toBe(invites)
  })

  it("restores both exact snapshots on failure", async () => {
    const options = useServerRailCommit() as any
    const context = await options.onMutate(args)
    registry.collections.servers.utils.writeDelete("a")
    options.onError(new Error("failed"), args, context)
    expect(Array.from(registry.collections.servers.values())
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
      .map((server) => server.id)).toEqual(["a", "b", "c"])
    expect([...registry.collections.folders.values()]).toEqual(context.folders)
    expect([...registry.collections.folderItems.values()]).toEqual(context.folderItems)
  })

  it("refetches authoritative ids and invalidates the folder resource on settle", async () => {
    const options = useServerRailCommit() as any
    await options.onMutate(args)
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined as never)
    const refetchServers = vi.spyOn(registry, "requestServerRefetch").mockResolvedValue(undefined)
    await options.onSettled()
    expect(refetchServers).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it("invalidates the server query when no canonical registry is bound", async () => {
    unregister()
    unregister = () => {}
    const options = useServerRailCommit() as any
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined as never)

    await options.onSettled()

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: serversCollectionQueryKey(),
      exact: true,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: foldersResourceKey("anon"),
      exact: true,
    })
  })

})

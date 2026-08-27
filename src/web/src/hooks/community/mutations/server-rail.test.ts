import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
const useMutationMock = vi.fn()
let queryClient: QueryClient

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
  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    useMutationMock.mockImplementation((options) => options)
    queryClient.setQueryData(communityKeys.servers(), {
      servers: ["a", "b", "c"].map((id) => ({
        id,
        name: id.toUpperCase(),
        initial: id.toUpperCase(),
        active: false,
        mentions: 0,
      })),
    })
    queryClient.setQueryData(communityKeys.folders(), {
      folders: [{
        id: "one",
        name: "One",
        position: 0,
        servers: [{ id: "c", name: "C", initial: "C", icon: null }],
      }],
    })
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
    const context = await options.onMutate(args)
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryData<any>(communityKeys.servers()).servers.map((server: any) => server.id))
      .toEqual(["b", "a", "c"])
    expect(queryClient.getQueryData<any>(communityKeys.folders()).folders).toMatchObject([
      { id: "one", position: 0, servers: [{ id: "c" }] },
      { id: "temp_1", position: 1, servers: [{ id: "a" }, { id: "b" }] },
    ])
    expect(context.servers.servers.map((server: any) => server.id)).toEqual(["a", "b", "c"])
  })

  it("restores both exact snapshots on failure", async () => {
    const options = useServerRailCommit() as any
    const context = await options.onMutate(args)
    options.onError(new Error("failed"), args, context)
    expect(queryClient.getQueryData(communityKeys.servers())).toEqual(context.servers)
    expect(queryClient.getQueryData(communityKeys.folders())).toEqual(context.folders)
  })

  it("reconciles temporary ids and invalidates both caches on settle", async () => {
    const options = useServerRailCommit() as any
    await options.onMutate(args)
    options.onSuccess({ createdFolderIds: { temp_1: "folder_real" } })
    expect(queryClient.getQueryData<any>(communityKeys.folders()).folders[1].id).toBe("folder_real")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined as never)
    await options.onSettled()
    expect(invalidate).toHaveBeenCalledTimes(2)
  })
})

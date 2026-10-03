import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { QueryClient, type QueryFunctionContext } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

let qc: QueryClient, registry: CommunityDbRegistry, unregister: () => void
beforeEach(async () => {
  apiFetchMock.mockReset()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  registry = createCommunityDbRegistry(qc, "viewer")
  unregister = registerCommunityDbRegistry(registry)
  await registry.preload()
})
afterEach(async () => { unregister(); await registry.cleanup(); qc.clear() })

function context(): QueryFunctionContext {
  return { client: qc, queryKey: communityKeys.folders(), signal: new AbortController().signal, meta: undefined }
}

describe("useFolders / foldersQueryFn", () => {
  it("materialises folder rows with avatar initials", async () => {
    apiFetchMock.mockResolvedValueOnce({
      folders: [
        {
          id: "fld_1",
          name: "Group",
          position: 2,
          servers: [{ id: "srv_1", name: "Alook", icon: null }],
        },
      ],
    })
    const { foldersQueryFn } = await import("./use-folders")
    const data = await foldersQueryFn(context())
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/server-folders", expect.objectContaining({ authenticationAccount: "viewer", signal: expect.any(AbortSignal) }))
    expect(data.folders[0].servers[0].initial).toBe("A")
    expect(data.folders[0].position).toBe(2)
  })

  it("populates queryClient at communityKeys.folders()", async () => {
    apiFetchMock.mockResolvedValueOnce({ folders: [] })
    const { foldersProjectedQueryFn } = await import("./use-folders")
    const key = communityKeys.folders()
    await qc.fetchQuery({ queryKey: key, queryFn: foldersProjectedQueryFn(qc) })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/server-folders",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
    expect(qc.getQueryData(key)).toEqual([])
  })

  it("rejects a folder response captured before the access epoch changes", async () => {

    let release!: (value: { folders: [] }) => void
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const { foldersProjectedQueryFn } = await import("./use-folders")

    const pending = qc.fetchQuery({ queryKey: communityKeys.folders(), queryFn: foldersProjectedQueryFn(qc) }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    registry.runtime.ws.actions.revokeServerAccess("server_1")
    release({ folders: [] })

    expect(await pending).toMatchObject({ name: "AbortError" })
  })

  it("does not issue a folder request without the native account owner", async () => {
    const { foldersQueryFn } = await import("./use-folders")
    const bare = new QueryClient()
    await expect(foldersQueryFn({ ...context(), client: bare })).rejects.toMatchObject({ name: "AbortError" })
    expect(apiFetchMock).not.toHaveBeenCalled()
    bare.clear()
  })
})

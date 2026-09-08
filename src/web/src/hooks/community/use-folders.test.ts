import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  useCommunityWsStore.getState().reset()
})

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
    const data = await foldersQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/server-folders")
    expect(data.folders[0].servers[0].initial).toBe("A")
    expect(data.folders[0].position).toBe(2)
  })

  it("populates queryClient at communityKeys.folders()", async () => {
    apiFetchMock.mockResolvedValueOnce({ folders: [] })
    const { foldersQueryFn } = await import("./use-folders")
    const qc = new QueryClient()
    const key = communityKeys.folders()
    await qc.fetchQuery({ queryKey: key, queryFn: foldersQueryFn })
    expect(qc.getQueryData(key)).toEqual({ folders: [] })
  })

  it("rejects a folder response captured before the access epoch changes", async () => {
    useCommunityWsStore.getState().activateProfileAccount("viewer_1")
    let release!: (value: { folders: [] }) => void
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const { foldersQueryFn } = await import("./use-folders")

    const pending = foldersQueryFn()
    useCommunityWsStore.getState().revokeServerAccess("server_1")
    release({ folders: [] })

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})

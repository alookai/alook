import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useDms / dmsQueryFn", () => {
  it("returns the DM conversations from GET /api/community/dm", async () => {
    const conversations = [
      { id: "dm_1", userId: "u_1", name: "Alice", avatar: "A", status: "offline", preview: "" },
    ]
    apiFetchMock.mockResolvedValueOnce({ conversations })
    const { dmsQueryFn } = await import("./use-dms")
    const data = await dmsQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/dm")
    expect(data.conversations).toEqual(conversations)
  })

  it("populates queryClient at communityKeys.dms()", async () => {
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    const { dmsQueryFn } = await import("./use-dms")
    const qc = new QueryClient()
    const key = communityKeys.dms()
    await qc.fetchQuery({ queryKey: key, queryFn: dmsQueryFn })
    expect(qc.getQueryData(key)).toEqual({ conversations: [] })
  })
})

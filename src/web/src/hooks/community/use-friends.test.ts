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

describe("useFriends / friendsQueryFn", () => {
  it("fetches friends+blocked and pending in parallel and merges", async () => {
    apiFetchMock
      .mockImplementationOnce(async (url: string) => {
        expect(url).toBe("/api/community/friends")
        return { friends: [{ id: "f_1", name: "n", avatar: "a", status: "offline", sub: "" }], blocked: [{ id: "b_1", name: "b", avatar: "a" }] }
      })
      .mockImplementationOnce(async (url: string) => {
        expect(url).toBe("/api/community/friends/pending")
        return { pending: [{ id: "p_1", name: "n", avatar: "a", kind: "incoming" }] }
      })

    const { friendsQueryFn } = await import("./use-friends")
    const data = await friendsQueryFn()
    expect(data.friends).toHaveLength(1)
    expect(data.blocked).toHaveLength(1)
    expect(data.pending).toHaveLength(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  it("populates queryClient at communityKeys.friends() and is invalidated by prefix", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ friends: [], blocked: [] })
      .mockResolvedValueOnce({ pending: [] })
    const { friendsQueryFn } = await import("./use-friends")
    const qc = new QueryClient()
    const key = communityKeys.friends()
    await qc.fetchQuery({ queryKey: key, queryFn: friendsQueryFn })
    expect(qc.getQueryData(key)).toBeDefined()
    await qc.invalidateQueries({ queryKey: communityKeys.all })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })
})

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

describe("useUserProfile / userProfileQueryFn", () => {
  it("fetches from /users/:id/profile and returns the profile envelope", async () => {
    const profile = {
      id: "u_1",
      name: "Alice",
      image: null,
      aboutMe: "about",
      bannerColor: null,
      mutualServers: 2,
    }
    apiFetchMock.mockResolvedValueOnce(profile)
    const { userProfileQueryFn } = await import("./use-user-profile")
    const data = await userProfileQueryFn("u_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/u_1/profile")
    expect(data).toEqual(profile)
  })

  it("populates queryClient at communityKeys.profile(userId)", async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: "u_1",
      name: "Alice",
      image: null,
      aboutMe: "",
      bannerColor: null,
      mutualServers: 0,
    })
    const { userProfileQueryFn } = await import("./use-user-profile")
    const qc = new QueryClient()
    const key = communityKeys.profile("u_1")
    await qc.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn("u_1") })
    expect(qc.getQueryData(key)).toBeDefined()
    await qc.invalidateQueries({ queryKey: communityKeys.all })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })
})

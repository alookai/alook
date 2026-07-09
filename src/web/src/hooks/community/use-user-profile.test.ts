import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { PROFILE_STALE_TIME_MS } from "./use-user-profile"

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

  it("exports a positive PROFILE_STALE_TIME_MS", () => {
    expect(PROFILE_STALE_TIME_MS).toBeGreaterThan(0)
  })

  it("a re-fetch for the same userId within the stale window resolves from cache, no second network call", async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: "u_1",
      name: "Alice",
      image: null,
      aboutMe: "hi",
      bannerColor: null,
      mutualServers: 3,
    })
    const { userProfileQueryFn } = await import("./use-user-profile")
    const qc = new QueryClient()
    const key = communityKeys.profile("u_1")

    const first = await qc.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn("u_1"), staleTime: PROFILE_STALE_TIME_MS })
    const second = await qc.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn("u_1"), staleTime: PROFILE_STALE_TIME_MS })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it("a re-fetch past the stale window hits the network again", async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: "u_1",
      name: "Alice",
      image: null,
      aboutMe: "hi",
      bannerColor: null,
      mutualServers: 3,
    })
    apiFetchMock.mockResolvedValueOnce({
      id: "u_1",
      name: "Alice",
      image: null,
      aboutMe: "updated",
      bannerColor: null,
      mutualServers: 4,
    })
    const { userProfileQueryFn } = await import("./use-user-profile")
    const qc = new QueryClient()
    const key = communityKeys.profile("u_1")
    const shortStale = 1

    await qc.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn("u_1"), staleTime: shortStale })
    await new Promise((r) => setTimeout(r, 5))
    await qc.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn("u_1"), staleTime: shortStale })

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })
})

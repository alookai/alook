import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { PROFILE_STALE_TIME_MS, userProfileQueryFn } from "./use-user-profile"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const profile = {
  id: "u_1", name: "Alice", discriminator: "0042", image: null, avatarVersion: 2,
  aboutMe: "about", bannerColor: null, mutualServers: 2, kind: "human" as const,
  statusEmoji: null, statusText: null,
}
beforeEach(() => { apiFetchMock.mockReset() })

describe("useUserProfile / userProfileQueryFn", () => {
  it("fetches the profile envelope into canonical DB and caches only its ID", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile)
    const key = communityKeys.profile(profile.id)
    expect(await client.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn(profile.id) })).toEqual({ id: profile.id })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/u_1/profile", expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(registry.collections.profiles.get(profile.id)).toMatchObject({ userId: profile.id, name: "Alice", aboutMe: "about", mutualServers: 2, avatarVersion: 2 })
    expect(client.getQueryData(key)).toEqual({ id: profile.id })
  })

  it("populates queryClient at communityKeys.profile(userId) and supports prefix invalidation", async () => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile)
    const key = communityKeys.profile(profile.id)
    await client.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn(profile.id) })
    await client.invalidateQueries({ queryKey: communityKeys.all })
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("exports a positive PROFILE_STALE_TIME_MS", () => expect(PROFILE_STALE_TIME_MS).toBeGreaterThan(0))

  it("a re-fetch for the same userId within the stale window resolves from cache, no second network call", async () => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile)
    const options = { queryKey: communityKeys.profile(profile.id), queryFn: userProfileQueryFn(profile.id), staleTime: PROFILE_STALE_TIME_MS }
    const first = await client.fetchQuery(options)
    expect(await client.fetchQuery(options)).toEqual(first)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("a re-fetch past the stale window hits the network again and refreshes canonical facts", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile).mockResolvedValueOnce({ ...profile, aboutMe: "updated", mutualServers: 4 })
    const options = { queryKey: communityKeys.profile(profile.id), queryFn: userProfileQueryFn(profile.id), staleTime: 1 }
    await client.fetchQuery(options)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await client.fetchQuery(options)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(registry.collections.profiles.get(profile.id)).toMatchObject({ aboutMe: "updated", mutualServers: 4 })
  })

  it("native cancellation aborts a held request and prevents late canonical publication", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    let release!: (data: typeof profile) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const key = communityKeys.profile(profile.id)
    const result = client.fetchQuery({ queryKey: key, queryFn: userProfileQueryFn(profile.id) }).then(() => null, (error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    const signal = apiFetchMock.mock.calls[0]![1].signal as AbortSignal
    await client.cancelQueries({ queryKey: key, exact: true })
    expect(signal.aborted).toBe(true)
    release(profile)
    expect(await result).toBeTruthy()
    await Promise.resolve()
    expect(registry.collections.profiles.get(profile.id)).toBeUndefined()
  })
})

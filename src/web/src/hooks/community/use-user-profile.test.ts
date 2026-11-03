import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { PROFILE_STALE_TIME_MS, userProfileQueryFn } from "./use-user-profile"
import { ApiError } from "@/lib/errors"
import { communityUserProfilePatch, writeCommunityProfilePatches } from "@/lib/community/profile-seed"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const profile = {
  id: "u_1", name: "Alice", discriminator: "0042", image: null, avatarVersion: 2,
  aboutMe: "about", bannerColor: null, mutualServers: 2, kind: "human" as const,
  statusEmoji: null, statusText: null,
}
beforeEach(() => { apiFetchMock.mockReset() })

it.each([404, 500])("handles an authoritative %s without confusing a failed refresh with deletion", async status => {
  const { client, registry, runtime } = await createCommunityQueryOwner()
  apiFetchMock.mockResolvedValueOnce(profile)
  const options = { queryKey: communityKeys.profile(profile.id), queryFn: userProfileQueryFn(profile.id) }
  await client.query(options)
  runtime.ws.actions.setPresence(profile.id, "online")
  apiFetchMock.mockRejectedValueOnce(new ApiError("response", status))
  await expect(client.query(options)).rejects.toThrow()
  if (status === 404) {
    expect(registry.collections.profiles.get(profile.id)).toBeUndefined()
    expect(runtime.ws.get().presenceByUserId.has(profile.id)).toBe(false)
  } else expect(registry.collections.profiles.get(profile.id)).toMatchObject({ name: "Alice", presence: "online" })
})

it.each(["identity", "presence"])("does not let an older 404 retire a newer %s event", async field => {
  const { client, registry, runtime } = await createCommunityQueryOwner()
  apiFetchMock.mockResolvedValueOnce(profile)
  const options = { queryKey: communityKeys.profile(profile.id), queryFn: userProfileQueryFn(profile.id) }
  await client.query(options)
  let reject!: (error: Error) => void
  apiFetchMock.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
  const fetching = client.query(options).catch(error => error)
  await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
  if (field === "identity") writeCommunityProfilePatches([communityUserProfilePatch(profile.id, { name: "New event" })], registry, { event: true })
  else runtime.ws.actions.setPresence(profile.id, "online")
  reject(new ApiError("not found", 404))
  await fetching
  expect(registry.collections.profiles.has(profile.id)).toBe(true)
  expect(registry.collections.profiles.get(profile.id)?.name).toBe(field === "identity" ? "New event" : "Alice")
})

describe("useUserProfile / userProfileQueryFn", () => {
  it("fetches the profile envelope into canonical DB and caches only its ID", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile)
    const key = communityKeys.profile(profile.id)
    expect(await client.query({ queryKey: key, queryFn: userProfileQueryFn(profile.id) })).toEqual({ id: profile.id })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/u_1/profile", expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(registry.collections.profiles.get(profile.id)).toMatchObject({ id: profile.id, name: "Alice", aboutMe: "about", mutualServers: 2, avatarVersion: 2 })
    expect(client.getQueryData(key)).toEqual({ id: profile.id })
  })

  it("populates queryClient at communityKeys.profile(userId) and supports prefix invalidation", async () => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile)
    const key = communityKeys.profile(profile.id)
    await client.query({ queryKey: key, queryFn: userProfileQueryFn(profile.id) })
    await client.invalidateQueries({ queryKey: communityKeys.all })
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("a re-fetch for the same userId within the stale window resolves from cache, no second network call", async () => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile)
    const options = { queryKey: communityKeys.profile(profile.id), queryFn: userProfileQueryFn(profile.id), staleTime: PROFILE_STALE_TIME_MS }
    const first = await client.query(options)
    expect(await client.query(options)).toEqual(first)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("a re-fetch past the stale window hits the network again and refreshes canonical facts", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(profile).mockResolvedValueOnce({ ...profile, aboutMe: "updated", mutualServers: 4 })
    const options = { queryKey: communityKeys.profile(profile.id), queryFn: userProfileQueryFn(profile.id), staleTime: 1 }
    await client.query(options)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await client.query(options)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(registry.collections.profiles.get(profile.id)).toMatchObject({ aboutMe: "updated", mutualServers: 4 })
  })

  it("native cancellation aborts a held request and prevents late canonical publication", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    let release!: (data: typeof profile) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const key = communityKeys.profile(profile.id)
    const result = client.query({ queryKey: key, queryFn: userProfileQueryFn(profile.id) }).then(() => null, (error) => error)
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

it.each(["missing-core", "wrong-target", "invalid-late-field"])("rejects a warm complete card %s before any canonical write", async defect => {
  const { communityRegistrySnapshot } = await import("@/test/community-registry-snapshot")
  const { client, registry } = await createCommunityQueryOwner()
  const options = { queryKey: communityKeys.profile(profile.id), queryFn: userProfileQueryFn(profile.id) }
  apiFetchMock.mockResolvedValueOnce(profile)
  await client.query(options)
  const before = communityRegistrySnapshot(registry)
  const malformed: Record<string, unknown> = { ...profile, name: "Must not publish" }
  if (defect === "missing-core") delete malformed.avatarVersion
  if (defect === "wrong-target") malformed.id = "foreign-target"
  if (defect === "invalid-late-field") malformed.mutualServers = -1
  apiFetchMock.mockResolvedValueOnce(malformed)
  await expect(client.query(options)).rejects.toThrow()
  expect(communityRegistrySnapshot(registry)).toEqual(before)
})

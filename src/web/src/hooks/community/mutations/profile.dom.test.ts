import { createElement, type PropsWithChildren } from "react"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  readUploadError: vi.fn(),
}))

beforeEach(() => { apiFetchMock.mockReset() })

describe("useUpdateProfile", () => {
  it("returns the authoritative PATCH response for guarded canonical commit", async () => {
    const response = {
      id: "viewer",
      name: "Renamed",
      discriminator: "0042",
      avatar: "avatar",
      avatarVersion: 3,
      aboutMe: "about",
      bannerColor: null,
      statusEmoji: "🌿",
      statusText: "Here",
    }
    apiFetchMock.mockResolvedValue(response)
    const { useUpdateProfile } = await import("./profile")
    const { client: queryClient } = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(() => useUpdateProfile(), { wrapper })

    let result!: unknown
    await act(async () => {
      result = await rendered.result.current.mutateAsync({
        name: "Renamed",
        statusText: "Here",
      })
    })

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/profile",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", statusText: "Here" }),
        authenticationAccount: "viewer", signal: expect.any(AbortSignal), assertActive: expect.any(Function),
      }),
    )
    expect(result).toEqual(response)
  })

  it("keeps public methods stable and returns only the original business input to per-call callbacks", async () => {
    const owner = await createCommunityQueryOwner()
    owner.registry.collections.profiles.utils.writeUpsert({ id: "viewer", name: "Before", discriminator: "0042", avatar: null, avatarVersion: 0 })
    const { useUpdateProfile } = await import("./profile")
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const rendered = renderHook(() => useUpdateProfile(), { wrapper })
    const methods = [rendered.result.current.mutate, rendered.result.current.mutateAsync]
    let resolve!: (value: unknown) => void
    apiFetchMock.mockImplementation(() => new Promise((done) => { resolve = done }))
    const input = { name: "Renamed" }, onSuccess = vi.fn(), onSettled = vi.fn()
    const response = { id: "viewer", name: "Renamed", discriminator: "0042", avatar: "V", avatarVersion: 0, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: null }
    let request!: Promise<unknown>
    act(() => { request = rendered.result.current.mutateAsync(input, { onSuccess, onSettled }) })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    rendered.rerender()
    expect([rendered.result.current.mutate, rendered.result.current.mutateAsync]).toEqual(methods)
    await act(async () => { resolve(response); await request })
    expect(onSuccess.mock.calls[0]?.[1]).toEqual(input)
    expect(onSettled.mock.calls[0]?.[2]).toEqual(input)
    expect(onSuccess.mock.calls[0]?.[1]).not.toHaveProperty("original")
    expect(owner.registry.collections.profiles.get("viewer")?.name).toBe("Renamed")
    expect([rendered.result.current.mutate, rendered.result.current.mutateAsync]).toEqual(methods)
  })

  it("suppresses all public per-call effects after the original account retires", async () => {
    const owner = await createCommunityQueryOwner()
    const { useUpdateProfile } = await import("./profile")
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const rendered = renderHook(() => useUpdateProfile(), { wrapper })
    let resolve!: (value: unknown) => void
    apiFetchMock.mockImplementation(() => new Promise((done) => { resolve = done }))
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    let request!: Promise<unknown>
    act(() => { request = rendered.result.current.mutateAsync({ name: "Retired" }, callbacks).catch((error) => error) })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    await act(async () => { await owner.registry.cleanup(); resolve({ id: "viewer", name: "Retired" }); await request })
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled()
    expect(owner.registry.collections.profiles.has("viewer")).toBe(false)
  })
})

it.each(["missing-core", "wrong-self"])("rejects a warm complete PATCH %s before command publication", async defect => {
  const { communityRegistrySnapshot } = await import("@/test/community-registry-snapshot")
  const { useUpdateProfile } = await import("./profile")
  const owner = await createCommunityQueryOwner()
  const initial = { id: "viewer", name: "Before", discriminator: "0042", avatar: null, avatarVersion: 3, aboutMe: "Keep about", bannerColor: null, statusEmoji: null, statusText: "Keep status" }
  owner.registry.collections.profiles.utils.writeUpsert(initial)
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const hook = renderHook(() => useUpdateProfile(), { wrapper })
  const before = communityRegistrySnapshot(owner.registry)
  const malformed: Record<string, unknown> = { ...initial, name: "Must not publish" }
  if (defect === "missing-core") delete malformed.avatarVersion
  if (defect === "wrong-self") malformed.id = "foreign"
  apiFetchMock.mockResolvedValueOnce(malformed)
  await act(async () => { await expect(hook.result.current.mutateAsync({ name: "Must not publish" })).rejects.toThrow() })
  expect(communityRegistrySnapshot(owner.registry)).toEqual(before)
  hook.unmount()
})

it("publishes only the confirmed command fields and keeps newer unrelated profile facts", async () => {
  const { writeCommunityProfilePatches } = await import("@/lib/community/profile-seed")
  const { useUpdateProfile } = await import("./profile")
  const owner = await createCommunityQueryOwner()
  const initial = { id: "viewer", name: "Before", discriminator: "0042", avatar: null, avatarVersion: 3, aboutMe: "Original about", bannerColor: null, statusEmoji: null, statusText: "Original status" }
  owner.registry.collections.profiles.utils.writeUpsert(initial)
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const hook = renderHook(() => useUpdateProfile(), { wrapper })
  let release!: (value: unknown) => void
  apiFetchMock.mockImplementationOnce(() => new Promise(done => { release = done }))
  let operation!: Promise<unknown>
  act(() => { operation = hook.result.current.mutateAsync({ name: "Confirmed" }) })
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
  act(() => writeCommunityProfilePatches([{ id: "viewer", avatar: { avatar: "newer-avatar", avatarVersion: 6 }, status: { statusEmoji: "🌿", statusText: "Newer status" } }], owner.registry, { event: true }))
  await act(async () => { release({ ...initial, name: "Confirmed", aboutMe: "Unrequested response about", bannerColor: "#abcdef" }); await operation })
  expect(owner.registry.collections.profiles.get("viewer")).toMatchObject({ ...initial, name: "Confirmed", avatar: "newer-avatar", avatarVersion: 6, statusEmoji: "🌿", statusText: "Newer status" })
  expect(apiFetchMock).toHaveBeenCalledOnce()
  hook.unmount()
})

it.each([
  { label: "status-only", command: { statusText: "Command status" }, name: "Read identity", status: "Command status" },
  { label: "status-null", command: { statusText: null }, name: "Read identity", status: null },
  { label: "name-only", command: { name: "Command name" }, name: "Command name", status: "Read status" },
  { label: "name-with-undefined-status", command: { name: "Command name", statusText: undefined }, name: "Command name", status: "Read status" },
])("keeps the in-flight card's independent groups for $label", async scenario => {
  const { useUpdateProfile } = await import("./profile")
  const { userProfileQueryFn } = await import("../use-user-profile")
  const { communityKeys } = await import("@/lib/query-keys")
  const { beginCommunityProfileSeed } = await import("@/lib/community/profile-seed")
  const owner = await createCommunityQueryOwner()
  const initial = { id: "viewer", name: "Before", discriminator: "0042", avatar: null, avatarVersion: 3, aboutMe: "Original about", bannerColor: null, statusEmoji: null, statusText: "Original status" }
  owner.registry.collections.profiles.utils.writeUpsert(initial)
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const hook = renderHook(() => useUpdateProfile(), { wrapper })
  let releaseCard!: (value: unknown) => void
  apiFetchMock.mockImplementation((path: string, options: { method?: string }) => {
    if (path === "/api/community/users/viewer/profile") return new Promise(done => { releaseCard = done })
    if (path === "/api/community/users/me/profile" && options.method === "PATCH") return Promise.resolve({
      ...initial,
      ...(scenario.command.name === undefined ? {} : { name: scenario.command.name }),
      ...(scenario.command.statusText === undefined ? {} : { statusText: scenario.command.statusText }),
    })
    throw new Error(`Unexpected profile transport: ${path}`)
  })
  let read!: Promise<unknown>
  act(() => { read = owner.client.query({ queryKey: communityKeys.profile("viewer"), queryFn: userProfileQueryFn("viewer") }) })
  await waitFor(() => expect(releaseCard).toBeTypeOf("function"))
  const beforeCommand = beginCommunityProfileSeed(owner.registry).revision
  await act(async () => { await hook.result.current.mutateAsync(scenario.command) })
  const afterCommand = beginCommunityProfileSeed(owner.registry).revision
  expect(afterCommand).toBe(beforeCommand + 1)
  const { avatar: _avatar, ...cardFields } = initial
  await act(async () => { releaseCard({ ...cardFields, kind: "human", name: "Read identity", image: null, mutualServers: 2, statusText: "Read status" }); await read })
  expect(owner.registry.collections.profiles.get("viewer")).toMatchObject({ name: scenario.name, statusText: scenario.status })
  expect(beginCommunityProfileSeed(owner.registry).revision).toBe(afterCommand)
  expect(apiFetchMock).toHaveBeenCalledTimes(2)
  hook.unmount()
})

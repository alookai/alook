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

    let result!: typeof response
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
    expect(result).toBe(response)
  })

  it("keeps public methods stable and returns only the original business input to per-call callbacks", async () => {
    const owner = await createCommunityQueryOwner()
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

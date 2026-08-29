import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  readUploadError: vi.fn(),
}))

beforeEach(() => apiFetchMock.mockReset())

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
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    let mutation!: ReturnType<typeof useUpdateProfile>
    function Probe() {
      mutation = useUpdateProfile()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Probe),
      ))
    })

    let result!: typeof response
    await act(async () => {
      result = await mutation.mutateAsync({ name: "Renamed", statusText: "Here" })
    })

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/profile",
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", statusText: "Here" }),
      },
    )
    expect(result).toBe(response)
    act(() => renderer.unmount())
  })
})

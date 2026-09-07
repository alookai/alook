import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"

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
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
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
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", statusText: "Here" }),
      },
    )
    expect(result).toBe(response)
  })
})

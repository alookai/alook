import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

describe("useDms / dmsQueryFn", () => {
  it("returns the DM conversations from GET /api/community/users/me/dms", async () => {
    const conversations = [
      { id: "dm_1", userId: "u_1", name: "Alice", discriminator: "0000", avatar: "A", status: "offline", preview: "" },
    ]
    apiFetchMock.mockResolvedValueOnce({ conversations })
    const { dmsQueryFn } = await import("./use-dms")
    const data = await dmsQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/dms")
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

  it("projects the canonical peer profile without rewriting the raw DM cache", async () => {
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const raw = {
      conversations: [{
        id: "dm_1",
        userId: "u_1",
        name: "Raw Alice",
        discriminator: "0001",
        avatar: "raw",
        avatarVersion: 1,
        status: "offline",
        preview: "hello",
      }],
    }
    qc.setQueryData(communityKeys.dms(), raw)
    const store = useCommunityWsStore.getState()
    store.patchProfiles(store.beginProfileSnapshot(), [{
      id: "u_1",
      identityAbout: { name: "Global Alice", discriminator: "0042" },
      avatar: { avatar: "global", avatarVersion: 7 },
      presence: "online",
    }])
    let projected!: ReturnType<typeof useDms>
    function Probe() {
      projected = useDms()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe),
      ))
    })

    expect(projected.dms[0]).toMatchObject({
      name: "Global Alice",
      discriminator: "0042",
      avatar: "global",
      avatarVersion: 7,
      status: "online",
      preview: "hello",
    })
    expect(qc.getQueryData(communityKeys.dms())).toBe(raw)
    act(() => renderer.unmount())
  })
})

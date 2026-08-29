import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { DM } from "@/lib/community/models/people"

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
    await act(async () => renderer.unmount())
  })

  it("projects unread arrivals alongside canonical peer profiles", async () => {
    const conversations = [
      {
        id: "dm_1", userId: "u_1", name: "Alice", discriminator: "0001",
        avatar: "a", avatarVersion: 1, status: "offline", preview: "one", unread: false,
      },
      {
        id: "dm_2", userId: "u_2", name: "Bob", discriminator: "0002",
        avatar: "b", avatarVersion: 1, status: "offline", preview: "two",
        unread: true, lastUnreadSeq: 3,
      },
      {
        id: "dm_legacy", userId: "u_3", name: "Carol", discriminator: "0003",
        avatar: "c", avatarVersion: 1, status: "offline", preview: "three", unread: true,
      },
    ] as DM[]
    apiFetchMock.mockResolvedValue({ conversations })
    const { useDms } = await import("./use-dms")
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.dms(), { conversations })
    getActiveAccountUnreadProjection(qc).recordArrival({ channelId: "dm_1", seq: 2 })
    let latest: ReturnType<typeof useDms> | undefined

    function Harness() {
      latest = useDms()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })

    expect(latest?.dms[0]?.unread).toBe(true)
    expect(latest?.dms[1]?.unread).toBe(true)
    expect(latest?.dms[2]?.unread).toBe(true)
    expect(qc.getQueryData(communityKeys.dms())).toEqual({ conversations })
    await act(async () => renderer.unmount())
  })

  it("returns a stable empty projection while the query has no data", async () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined))
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let latest: ReturnType<typeof useDms> | undefined
    function Harness() {
      latest = useDms()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    const first = latest?.dms
    await act(async () => renderer.update(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    )))
    expect(latest?.dms).toBe(first)
    expect(latest?.dms).toEqual([])
    await act(async () => renderer.unmount())
  })
})

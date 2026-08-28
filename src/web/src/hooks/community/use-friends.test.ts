import { describe, it, expect, vi, beforeEach } from "vitest"
import { createElement } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useFriends / friendsQueryFn", () => {
  it("fetches accepted + blocked + pending buckets in parallel and merges", async () => {
    // Legacy aggregate GET /friends retired — each bucket from its sub-resource.
    const byUrl: Record<string, unknown> = {
      "/api/community/friends/accepted": { friends: [{ id: "f_1", name: "n", discriminator: "0000", avatar: "a", status: "offline", sub: "" }] },
      "/api/community/friends/blocked": { blocked: [{ id: "b_1", name: "b", avatar: "a" }] },
      "/api/community/friends/pending": { pending: [{ id: "p_1", userId: "u_1", name: "n", avatar: "a", kind: "incoming" }] },
    }
    apiFetchMock.mockImplementation(async (url: string) => {
      if (!(url in byUrl)) throw new Error(`unexpected url ${url}`)
      return byUrl[url]
    })

    const { friendsQueryFn } = await import("./use-friends")
    const data = await friendsQueryFn()
    expect(data.friends).toHaveLength(1)
    expect(data.blocked).toHaveLength(1)
    expect(data.pending).toHaveLength(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    const urls = apiFetchMock.mock.calls.map((c) => c[0]).sort()
    expect(urls).toEqual([
      "/api/community/friends/accepted",
      "/api/community/friends/blocked",
      "/api/community/friends/pending",
    ])
  })

  it("populates queryClient at communityKeys.friends() and is invalidated by prefix", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ friends: [] })
      .mockResolvedValueOnce({ blocked: [] })
      .mockResolvedValueOnce({ pending: [] })
    const { friendsQueryFn } = await import("./use-friends")
    const qc = new QueryClient()
    const key = communityKeys.friends()
    await qc.fetchQuery({ queryKey: key, queryFn: friendsQueryFn })
    expect(qc.getQueryData(key)).toBeDefined()
    await qc.invalidateQueries({ queryKey: communityKeys.all })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })
})

describe("useFriendsPresence / friendsPresenceQueryFn", () => {
  it("fetches the friends-scoped presence endpoint", async () => {
    apiFetchMock.mockImplementationOnce(async (url: string) => {
      expect(url).toBe("/api/community/friends/presence")
      return { online: ["u1", "u2"] }
    })

    const { friendsPresenceQueryFn } = await import("./use-friends")
    const data = await friendsPresenceQueryFn()
    expect(data.online).toEqual(["u1", "u2"])
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("populates queryClient at communityKeys.friendsPresence(), nested under friends()", async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ["u1"] })
    const { friendsPresenceQueryFn } = await import("./use-friends")
    const qc = new QueryClient()
    const key = communityKeys.friendsPresence()
    expect(key.slice(0, communityKeys.friends().length)).toEqual(communityKeys.friends())
    await qc.fetchQuery({ queryKey: key, queryFn: friendsPresenceQueryFn })
    expect(qc.getQueryData(key)).toEqual({ online: ["u1"] })
    // Invalidating the parent `friends()` key also invalidates the nested
    // presence key — one invalidation refreshes both.
    await qc.invalidateQueries({ queryKey: communityKeys.friends() })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("can defer the friends presence fetch until its surface opens", async () => {
    apiFetchMock.mockResolvedValue({ online: ["u1"] })
    const { useFriendsPresence } = await import("./use-friends")
    const TestRenderer = await import("react-test-renderer")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function Probe({ enabled }: { enabled: boolean }) {
      useFriendsPresence(enabled)
      return null
    }

    let renderer: ReturnType<typeof TestRenderer.create> | undefined
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Probe, { enabled: false }),
      ))
    })
    expect(apiFetchMock).not.toHaveBeenCalled()

    await TestRenderer.act(async () => {
      renderer?.update(createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Probe, { enabled: true }),
      ))
    })
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())

    await TestRenderer.act(async () => renderer?.unmount())
    qc.clear()
  })
})

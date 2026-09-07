import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function wrapperFor(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

describe("useFriends / friendsQueryFn", () => {
  it("fetches accepted + blocked + pending buckets in parallel and merges", async () => {
    const byUrl: Record<string, unknown> = {
      "/api/community/friends/accepted": {
        friends: [{
          id: "f_1",
          userId: "friend_1",
          name: "n",
          discriminator: "0000",
          avatar: "a",
          avatarVersion: 1,
          status: "offline",
          sub: "",
        }],
      },
      "/api/community/friends/blocked": {
        blocked: [
          { id: "b_1", userId: "blocked_1", name: "b", avatar: "b", avatarVersion: 2 },
          { id: "b_legacy", name: "legacy", avatar: "l", avatarVersion: 0 },
        ],
      },
      "/api/community/friends/pending": {
        pending: [{
          id: "p_1",
          userId: "pending_1",
          name: "p",
          avatar: "p",
          avatarVersion: 3,
          kind: "incoming",
        }],
      },
    }
    apiFetchMock.mockImplementation(async (url: string) => {
      if (!(url in byUrl)) throw new Error(`unexpected url ${url}`)
      return byUrl[url]
    })

    const { friendsQueryFn } = await import("./use-friends")
    const data = await friendsQueryFn()
    expect(data.friends).toHaveLength(1)
    expect(data.blocked).toHaveLength(2)
    expect(data.pending).toHaveLength(1)
    expect(useCommunityWsStore.getState().profilesByUserId).toMatchObject(new Map([
      ["friend_1", expect.objectContaining({ name: "n", avatarVersion: 1 })],
      ["blocked_1", expect.objectContaining({ name: "b", avatarVersion: 2 })],
      ["pending_1", expect.objectContaining({ name: "p", avatarVersion: 3 })],
    ]))
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    expect(apiFetchMock.mock.calls.map((call) => call[0]).sort()).toEqual([
      "/api/community/friends/accepted",
      "/api/community/friends/blocked",
      "/api/community/friends/pending",
    ])
  })

  it("projects canonical profiles while preserving raw friend presentation fields", async () => {
    const { useFriends } = await import("./use-friends")
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const raw = {
      friends: [
        {
          id: "f1",
          userId: "friend_1",
          name: "raw friend",
          discriminator: "0001",
          avatar: "raw",
          avatarVersion: 1,
          status: "offline",
          statusEmoji: null,
          statusText: "",
          sub: "raw presentation",
        },
        {
          id: "legacy",
          name: "legacy",
          discriminator: "0002",
          avatar: "legacy",
          avatarVersion: 0,
          status: "offline",
          statusEmoji: null,
          statusText: "",
          sub: "legacy presentation",
        },
      ],
      pending: [{
        id: "p1",
        userId: "pending_1",
        name: "raw pending",
        avatar: "raw",
        avatarVersion: 1,
        kind: "incoming",
      }],
      blocked: [
        { id: "b1", userId: "blocked_1", name: "raw blocked", avatar: "raw", avatarVersion: 1 },
        { id: "legacy-blocked", name: "legacy blocked", avatar: "legacy", avatarVersion: 0 },
      ],
    }
    queryClient.setQueryData(communityKeys.friends(), raw)
    const store = useCommunityWsStore.getState()
    store.patchProfiles(store.beginProfileSnapshot(), [
      {
        id: "friend_1",
        identityAbout: { name: "Global Friend", discriminator: "0042" },
        avatar: { avatar: "friend-global", avatarVersion: 4 },
        presence: "online",
        status: { statusEmoji: "🌿", statusText: "Here" },
      },
      {
        id: "pending_1",
        identityAbout: { name: "Global Pending" },
        avatar: { avatar: "pending-global", avatarVersion: 5 },
      },
      {
        id: "blocked_1",
        identityAbout: { name: "Global Blocked" },
        avatar: { avatar: "blocked-global", avatarVersion: 6 },
      },
    ])
    const rendered = renderHook(() => useFriends(), {
      wrapper: wrapperFor(queryClient),
    })

    expect(rendered.result.current.friends).toEqual([
      expect.objectContaining({
        name: "Global Friend",
        discriminator: "0042",
        avatar: "friend-global",
        avatarVersion: 4,
        status: "online",
        statusEmoji: "🌿",
        statusText: "Here",
        sub: "raw presentation",
      }),
      expect.objectContaining({ name: "legacy", sub: "legacy presentation" }),
    ])
    expect(rendered.result.current.pending[0]).toMatchObject({
      name: "Global Pending",
      avatar: "pending-global",
      avatarVersion: 5,
    })
    expect(rendered.result.current.blocked).toEqual([
      expect.objectContaining({
        name: "Global Blocked",
        avatar: "blocked-global",
        avatarVersion: 6,
      }),
      expect.objectContaining({ name: "legacy blocked" }),
    ])
    expect(queryClient.getQueryData(communityKeys.friends())).toBe(raw)
  })

  it("populates queryClient at communityKeys.friends() and is invalidated by prefix", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ friends: [] })
      .mockResolvedValueOnce({ blocked: [] })
      .mockResolvedValueOnce({ pending: [] })
    const { friendsQueryFn } = await import("./use-friends")
    const queryClient = new QueryClient()
    const key = communityKeys.friends()
    await queryClient.fetchQuery({ queryKey: key, queryFn: friendsQueryFn })
    expect(queryClient.getQueryData(key)).toBeDefined()
    await queryClient.invalidateQueries({ queryKey: communityKeys.all })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
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
    expect(apiFetchMock).toHaveBeenCalledOnce()
  })

  it("populates queryClient at communityKeys.friendsPresence(), nested under friends()", async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ["u1"] })
    const { friendsPresenceQueryFn } = await import("./use-friends")
    const queryClient = new QueryClient()
    const key = communityKeys.friendsPresence()
    expect(key.slice(0, communityKeys.friends().length)).toEqual(communityKeys.friends())
    await queryClient.fetchQuery({ queryKey: key, queryFn: friendsPresenceQueryFn })
    expect(queryClient.getQueryData(key)).toEqual({ online: ["u1"] })
    await queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("can defer the friends presence fetch until its surface opens", async () => {
    apiFetchMock.mockResolvedValue({ online: ["u1"] })
    const { useFriendsPresence } = await import("./use-friends")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rendered = renderHook(
      ({ enabled }: { enabled: boolean }) => useFriendsPresence(enabled),
      {
        initialProps: { enabled: false },
        wrapper: wrapperFor(queryClient),
      },
    )
    expect(apiFetchMock).not.toHaveBeenCalled()

    rendered.rerender({ enabled: true })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    queryClient.clear()
  })

  it("fetches by default when no enabled override is provided", async () => {
    apiFetchMock.mockResolvedValue({ online: ["u1"] })
    const { useFriendsPresence } = await import("./use-friends")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useFriendsPresence(), { wrapper: wrapperFor(queryClient) })

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    queryClient.clear()
  })
})

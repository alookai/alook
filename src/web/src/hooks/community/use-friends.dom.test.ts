import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { type QueryClient } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { friendshipSchema, profileSchema } from "@/lib/community-db/schema"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function wrapperFor(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient, registry: getCommunityDbRegistry(queryClient)! }, children)
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()


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
    const { client } = await createCommunityQueryOwner()
    const data = await client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn })
    expect(data.ids).toEqual(["f_1", "p_1", "blocked:blocked_1", "blocked:b_legacy"])
    expect([...getCommunityDbRegistry(client)!.collections.friendships.values()]).toHaveLength(4)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    expect(apiFetchMock.mock.calls.map((call) => call[0]).sort()).toEqual([
      "/api/community/friends/accepted",
      "/api/community/friends/blocked",
      "/api/community/friends/pending",
    ])
  })

  it("projects canonical profiles while preserving raw friend presentation fields", async () => {
    const { useFriends } = await import("./use-friends")
    const { client: queryClient } = await createCommunityQueryOwner()
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
        {
          id: "missing",
          userId: "friend_missing",
          name: "missing friend",
          discriminator: "0003",
          avatar: "missing",
          avatarVersion: 0,
          status: "offline",
          sub: "missing presentation",
        },
      ],
      pending: [
        {
          id: "p1", userId: "pending_1", name: "raw pending", avatar: "raw",
          avatarVersion: 1, kind: "incoming",
        },
        {
          id: "p-missing", userId: "pending_missing", name: "missing pending",
          avatar: "missing", avatarVersion: 0, kind: "outgoing",
        },
      ],
      blocked: [
        { id: "b1", userId: "blocked_1", name: "raw blocked", avatar: "raw", avatarVersion: 1 },
        { id: "legacy-blocked", name: "legacy blocked", avatar: "legacy", avatarVersion: 0 },
        { id: "missing-blocked", userId: "blocked_missing", name: "missing blocked", avatar: "missing", avatarVersion: 0 },
      ],
    }
    const registry = getCommunityDbRegistry(queryClient)!
    for (const row of [...raw.friends.map((friend) => ({ id: friend.id, userId: "userId" in friend ? friend.userId : friend.id, kind: "accepted", sub: friend.sub })),
      ...raw.pending.map((pending) => ({ ...pending })),
      ...raw.blocked.map((blocked) => ({ id: "blocked:" + ("userId" in blocked ? blocked.userId : blocked.id), userId: "userId" in blocked ? blocked.userId : blocked.id, kind: "blocked" }))]) await act(async () => { registry.collections.friendships.utils.writeUpsert(friendshipSchema.parse(row)) });
    for (const row of [...raw.friends, ...raw.pending, ...raw.blocked]) {
      const userId = "userId" in row ? row.userId : row.id
      await act(async () => { registry.collections.profiles.utils.writeUpsert(profileSchema.parse({ discriminator: "", ...row, kind: "human", userId })) });
    }
    const window = { ids: [...registry.collections.friendships.values()].map((row) => row.id) }
    queryClient.setQueryData(communityKeys.friends(), window)
    const canonicalProfiles = new Map<string, Record<string, unknown>>([
      ["friend_1", {
        id: "friend_1",
        name: "Global Friend",
        discriminator: "0042",
        avatar: "friend-global",
        avatarVersion: 4,
        presence: "online",
        statusEmoji: "🌿",
        statusText: "Here",
      }],
      ["pending_1", {
        id: "pending_1",
        name: "Global Pending",
        avatar: "pending-global",
        avatarVersion: 5,
      }],
      ["blocked_1", {
        id: "blocked_1",
        name: "Global Blocked",
        avatar: "blocked-global",
        avatarVersion: 6,
      }],
    ])
    for (const [userId, fields] of canonicalProfiles) await act(async () => { registry.collections.profiles.utils.writeUpsert(profileSchema.parse({ ...registry.collections.profiles.get(userId), ...fields, userId })) });
    await act(async () => { registry.runtime.ws.actions.seedPresence(registry.runtime.ws.actions.beginPresenceSnapshot(), [["friend_1", "online"]]) });
    let rendered!: ReturnType<typeof renderHook<ReturnType<typeof useFriends>, unknown>>
    await act(async () => { rendered = renderHook(() => useFriends(), {
      wrapper: wrapperFor(queryClient),
    }) })

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
      expect.objectContaining({ name: "missing friend", sub: "missing presentation" }),
    ])
    expect(rendered.result.current.pending.find((row) => row.id === "p1")).toMatchObject({
      name: "Global Pending",
      avatar: "pending-global",
      avatarVersion: 5,
    })
    expect(rendered.result.current.pending.find((row) => row.id === "p-missing")).toMatchObject({ name: "missing pending" })
    expect(rendered.result.current.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Global Blocked",
        avatar: "blocked-global",
        avatarVersion: 6,
      }),
      expect.objectContaining({ name: "legacy blocked" }),
      expect.objectContaining({ name: "missing blocked" }),
    ]))
    expect(rendered.result.current.blocked).toHaveLength(3)
    expect(queryClient.getQueryData(communityKeys.friends())).toBe(window)
  })

  it("populates queryClient at communityKeys.friends() and is invalidated by prefix", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ friends: [] })
      .mockResolvedValueOnce({ blocked: [] })
      .mockResolvedValueOnce({ pending: [] })
    const { friendsQueryFn } = await import("./use-friends")
    const { client: queryClient } = await createCommunityQueryOwner()
    const key = communityKeys.friends()
    await queryClient.query({ queryKey: key, queryFn: friendsQueryFn })
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
    const { client } = await createCommunityQueryOwner()
    const data = await client.query({ queryKey: communityKeys.friendsPresence(), queryFn: friendsPresenceQueryFn })
    expect(data.online).toEqual(["u1", "u2"])
    expect(apiFetchMock).toHaveBeenCalledOnce()
  })

  it("populates queryClient at communityKeys.friendsPresence(), nested under friends()", async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ["u1"] })
    const { friendsPresenceQueryFn } = await import("./use-friends")
    const { client: queryClient } = await createCommunityQueryOwner()
    const key = communityKeys.friendsPresence()
    expect(key.slice(0, communityKeys.friends().length)).toEqual(communityKeys.friends())
    await queryClient.query({ queryKey: key, queryFn: friendsPresenceQueryFn })
    expect(queryClient.getQueryData(key)).toEqual({ online: ["u1"] })
    await queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("can defer the friends presence fetch until its surface opens", async () => {
    apiFetchMock.mockResolvedValue({ online: ["u1"] })
    const { useFriendsPresence } = await import("./use-friends")
    const { client: queryClient } = await createCommunityQueryOwner()
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
    const { client: queryClient } = await createCommunityQueryOwner()
    renderHook(() => useFriendsPresence(), { wrapper: wrapperFor(queryClient) })

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    queryClient.clear()
  })
})

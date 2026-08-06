import { beforeEach, describe, expect, it, vi } from "vitest"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

import { addableMembersQueryFn } from "./use-channel-members"
import { invitableFriendsQueryFn } from "./use-invitable-friends"

const alice = { id: "membership_1", userId: "alice", name: "Alice", discriminator: "0001", avatar: "a", status: "offline", sub: "", role: "member" }
const bob = { id: "membership_2", userId: "bob", name: "Bob", discriminator: "0002", avatar: "b", status: "offline", sub: "", role: "member" }

describe("membership facade composition", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("pages the canonical server roster before subtracting channel members", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/members?limit=200&cursor=")) return { members: [bob], hasMore: false }
      if (url.includes("/servers/s1/members?")) return { members: [alice], hasMore: true, cursor: "next" }
      if (url === "/api/community/channels/c1/members") return { members: [{ userId: "alice" }] }
      throw new Error(`unexpected ${url}`)
    })
    await expect(addableMembersQueryFn("s1", "c1")).resolves.toEqual({
      members: [{ userId: "bob", name: "Bob", discriminator: "0002", avatar: "b" }],
    })
  })

  it("subtracts canonical server members from accepted friends", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/community/friends/accepted") return { friends: [{ ...alice, id: "friend_1" }, { ...bob, id: "friend_2" }] }
      if (url.includes("/api/community/servers/s1/members?")) return { members: [alice], hasMore: false }
      throw new Error(`unexpected ${url}`)
    })
    const result = await invitableFriendsQueryFn("s1")
    expect(result.friends.map((friend) => friend.userId)).toEqual(["bob"])
  })
})

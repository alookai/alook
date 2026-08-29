import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetchMock = vi.fn()
const fetchAllServerMembersMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("./fetch-all-server-members", () => ({
  fetchAllServerMembers: (...args: unknown[]) => fetchAllServerMembersMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  fetchAllServerMembersMock.mockReset()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

describe("invitableFriendsQueryFn", () => {
  it("seeds identified friends and preserves identifier-free rows", async () => {
    const identified = {
      id: "friendship_1",
      userId: "friend_1",
      name: "Alice",
      discriminator: "0042",
      avatar: "A",
      avatarVersion: 2,
      status: "offline",
      sub: "",
    }
    const legacy = {
      id: "legacy",
      name: "Legacy",
      discriminator: "0000",
      avatar: "L",
      avatarVersion: 0,
      status: "offline",
      sub: "",
    }
    apiFetchMock.mockResolvedValue({ friends: [identified, legacy] })
    fetchAllServerMembersMock.mockResolvedValue([{ userId: "someone_else" }])
    const { invitableFriendsQueryFn } = await import("./use-invitable-friends")

    const result = await invitableFriendsQueryFn("server_1")

    expect(result.friends).toEqual([identified, legacy])
    expect(useCommunityWsStore.getState().profilesByUserId.get("friend_1")).toMatchObject({
      name: "Alice",
      avatarVersion: 2,
    })
  })
})

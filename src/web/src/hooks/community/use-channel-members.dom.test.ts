import { createElement, type PropsWithChildren } from "react"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { PARTICIPANT_SOURCE } from "@alook/shared/constants/community"
import { channelMembershipKey } from "@/lib/community-db/schema"

const apiFetchMock = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useChannelMembers", () => {
  it("fetches the roster through the identity-aware query function", async () => {
    apiFetchMock.mockResolvedValue({
      members: [{
        id: "membership_1",
        userId: "member_1",
        name: "Alice",
        discriminator: "0042",
        avatar: "A",
        avatarVersion: 4,
        sub: "",
        role: "member",
        status: "offline",
        statusEmoji: null,
        statusText: "",
        source: "explicit",
        isCreator: false,
      }],
    })
    const { useChannelMembers } = await import("./use-channel-members")
    const queryClient = (await createCommunityQueryOwner()).client
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(() => useChannelMembers("private/channel", true, "server_1"), { wrapper })

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/channels/private%2Fchannel/members",
        expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
      )
    })
    await waitFor(() => expect(rendered.result.current.members).toHaveLength(1))
  })

  it.each(Object.values(PARTICIPANT_SOURCE))(
    "recovers a failed notify roster with source %s while retaining its resolved parent",
    async (source) => {
      const { useChannelMembers } = await import("./use-channel-members")
      const owner = await createCommunityQueryOwner()
      const wrapper = ({ children }: PropsWithChildren) => createElement(
        QueryClientProvider, { client: owner.client }, children,
      )
      const member = (userId: string, name: string) => ({
        id: `membership_${userId}`, userId, name, discriminator: "0042", avatar: name,
        avatarVersion: 0, sub: "", role: "member", status: "offline", statusEmoji: null,
        statusText: "", isCreator: userId === "viewer",
      })
      const parentMembers = [
        { ...member("viewer", "Viewer"), role: "owner", source: "admin" },
        { ...member("bob", "Bob"), source: "explicit" },
        { ...member("carol", "Carol"), source: "inherited" },
      ]
      const participants = parentMembers.slice(0, 2).map((row) => ({ ...row, source }))
      let failParticipants = true
      let participantGets = 0
      let parentGets = 0
      apiFetchMock.mockImplementation((url: string) => {
        if (url.endsWith("/thread/members")) {
          participantGets += 1
          return failParticipants
            ? Promise.reject(new Error("controlled first-load failure"))
            : Promise.resolve({ members: participants })
        }
        if (url.endsWith("/parent/members")) {
          parentGets += 1
          return Promise.resolve({ members: parentMembers })
        }
        throw new Error(`Unexpected roster request: ${url}`)
      })
      const rendered = renderHook(() => ({
        participants: useChannelMembers("thread", true, "server", "notify"),
        parent: useChannelMembers("parent", true, "server", "access"),
      }), { wrapper })
      await waitFor(() => {
        expect(rendered.result.current.participants.isError).toBe(true)
        expect(rendered.result.current.participants.data).toBeUndefined()
        expect(rendered.result.current.parent.data?.members.map((row) => row.name).sort())
          .toEqual(["Bob", "Carol", "Viewer"])
      })
      expect(parentGets).toBe(1)
      failParticipants = false
      await act(async () => { await rendered.result.current.participants.refetch() })
      await waitFor(() => {
        expect(rendered.result.current.participants.isSuccess).toBe(true)
        expect(rendered.result.current.participants.data?.members.map((row) => row.name).sort())
          .toEqual(["Bob", "Viewer"])
        expect(rendered.result.current.participants.members.map((row) => row.source))
          .toEqual([source, source])
      })
      expect(participantGets).toBe(2)
      expect(parentGets).toBe(1)
      expect(owner.registry.collections.channelMemberships
        .get(channelMembershipKey("thread", "bob", "notify"))?.source).toBe(source)
      expect(owner.registry.collections.channelMemberships
        .get(channelMembershipKey("parent", "carol", "access"))?.source).toBe("inherited")
      expect(rendered.result.current.parent.data?.members.map((row) => row.name).sort())
        .toEqual(["Bob", "Carol", "Viewer"])
    },
  )
})

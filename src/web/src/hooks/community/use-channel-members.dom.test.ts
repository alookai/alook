import { createElement, type PropsWithChildren } from "react"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { PARTICIPANT_SOURCE } from "@alook/shared/constants/community"
import { channelMembershipKey, profileSchema, serverMembershipKey } from "@/lib/community-db/schema"

const apiFetchMock = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useChannelMembers", () => {
  it("retains authorized canonical access members on transport failure and recovers through the same refetch", async () => {
    const { useChannelMembers } = await import("./use-channel-members")
    const { publishCommunityChannelMembersSnapshot, captureCommunityLiveSnapshotToken } = await import("@/lib/community-db/sync")
    const owner = await createCommunityQueryOwner()
    const peer = { id: "m-peer", userId: "peer", name: "Peer", discriminator: "0042", avatar: "P", avatarVersion: 0, sub: "", role: "member", status: "offline", source: "explicit", isCreator: false }
    publishCommunityChannelMembersSnapshot(owner.client, "server", "private", "access", [{ channelId: "private", userId: "peer", relation: "access", memberId: "m-peer", role: "member", source: "explicit", isCreator: false }], { token: captureCommunityLiveSnapshotToken(owner.client) }, [{ id: "peer", name: "Peer", discriminator: "0042", avatar: "P", avatarVersion: 0 }])
    apiFetchMock.mockRejectedValue(new Error("controlled first read failure"))
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, children)
    const rendered = renderHook(() => useChannelMembers("private", true, "server", "access"), { wrapper })
    await waitFor(() => expect(rendered.result.current).toMatchObject({ isError: true, failed: true, members: [expect.objectContaining({ userId: "peer", discriminator: "0042" })] }))
    expect(rendered.result.current.data).toBeUndefined()
    apiFetchMock.mockResolvedValue({ members: [peer] })
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current).toMatchObject({ isSuccess: true, loading: false, failed: false, members: [expect.objectContaining({ userId: "peer" })] }))
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })
  it("separates missing usable profiles from true empty and withdraws disabled access candidates", async () => {
    const { useChannelMembers } = await import("./use-channel-members")
    const owner = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValue({ members: [{ id: "m-peer", userId: "peer", name: "Peer", discriminator: "", avatar: "P", avatarVersion: 0, sub: "", role: "member", status: "offline", source: "explicit", isCreator: false }] })
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, children)
    const rendered = renderHook(({ enabled }) => useChannelMembers("private", enabled, "server", "access"), { wrapper, initialProps: { enabled: true } })
    await waitFor(() => expect(rendered.result.current).toMatchObject({ isSuccess: true, loading: false, failed: true }))
    await act(async () => owner.registry.collections.profiles.utils.writeUpsert(profileSchema.parse({ userId: "peer", name: "Peer", discriminator: "0042", avatar: "P", avatarVersion: 0 })))
    await waitFor(() => expect(rendered.result.current).toMatchObject({ loading: false, failed: false, members: [expect.objectContaining({ userId: "peer", discriminator: "0042" })] }))
    expect(rendered.result.current.profiles.get("peer")?.discriminator).toBe("0042")
    await act(async () => owner.registry.collections.serverMemberships.utils.writeDelete(serverMembershipKey("server", "peer")))
    await waitFor(() => expect(rendered.result.current).toMatchObject({ loading: false, failed: false, members: [] }))
    rendered.rerender({ enabled: false })
    expect(rendered.result.current).toMatchObject({ loading: false, failed: false, members: [] })
    expect(rendered.result.current.data).toBeUndefined()
    expect(apiFetchMock).toHaveBeenCalledOnce()
  })
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
        "/api/community/channels/private%2Fchannel/members?relation=access",
        expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
      )
    })
    await waitFor(() => expect(rendered.result.current.members).toHaveLength(1))
  })

  it("renders a DM access pair without inventing a server membership or role", async () => {
    const { useChannelMembers } = await import("./use-channel-members")
    const { publishCommunityChannelMetadata, captureCommunityLiveSnapshotToken } = await import("@/lib/community-db/sync")
    const owner = await createCommunityQueryOwner()
    publishCommunityChannelMetadata(owner.client, { metadata: { id: "dm", serverId: null, name: null, type: "dm", parentChannelId: null, parentMessageId: null, creatorId: null, archived: false, lastMessageAt: null }, proof: { token: captureCommunityLiveSnapshotToken(owner.client) } })
    apiFetchMock.mockResolvedValue({ members: ["viewer", "peer"].map((userId) => ({ id: userId, userId, name: userId, discriminator: "0001", avatar: "", avatarVersion: 0, sub: "", role: null, status: "offline", statusEmoji: null, statusText: "", source: "explicit", isCreator: false })) })
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, children)
    const rendered = renderHook(() => useChannelMembers("dm", true, undefined, "access"), { wrapper })
    await waitFor(() => expect(rendered.result.current.members).toHaveLength(2))
    expect(rendered.result.current.members.map((member) => member.role)).toEqual([null, null])
    expect([...owner.registry.collections.serverMemberships.values()]).toEqual([])
    expect(owner.client.getQueryData(["community", "channel", "dm", "members", "access"])).toMatchObject({ serverId: null, relation: "access" })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/dm/members?relation=access", expect.anything())
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
        if (url.endsWith("/thread/members?relation=notify")) {
          participantGets += 1
          return failParticipants
            ? Promise.reject(new Error("controlled first-load failure"))
            : Promise.resolve({ members: participants })
        }
        if (url.endsWith("/parent/members?relation=access")) {
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

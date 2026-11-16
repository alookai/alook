import { BUSINESS_SCHEMA_VERSION, CommunityMembersReadSchema, type CommunityMemberRelation, type CommunityResourceProfile } from "@alook/shared"
import { createElement, type PropsWithChildren } from "react"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { PARTICIPANT_SOURCE } from "@alook/shared/constants/community"
import { channelMembershipKey, profileSchema, serverMembershipKey } from "@/lib/community-db/schema"

const profile = (id: string, name: string, discriminator = "0042", avatarVersion = 0): CommunityResourceProfile => ({ id, name, discriminator, avatar: name[0], avatarVersion })
const relationRow = (channelId: string, userId: string, relation: CommunityMemberRelation["relation"] = "access", source: CommunityMemberRelation["source"] = "explicit", role: string | null = "member", memberId: string | null = `membership_${userId}`, isCreator = false): CommunityMemberRelation => ({ channelId, userId, relation, source, role, memberId, isCreator })
const roster = (channelId: string, relation: CommunityMemberRelation["relation"], members: CommunityMemberRelation[], profiles: CommunityResourceProfile[]) => CommunityMembersReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, channelId, relation, members, profiles })

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
    const peer = relationRow("private", "peer", "access", "explicit", "member", "m-peer")
    await publishCommunityChannelMembersSnapshot(owner.client, "server", "private", "access", [peer], { token: captureCommunityLiveSnapshotToken(owner.client) }, [profile("peer", "Peer")])
    apiFetchMock.mockRejectedValue(new Error("controlled first read failure"))
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, children)
    const rendered = renderHook(() => useChannelMembers("private", true, "server", "access"), { wrapper })
    await waitFor(() => expect(rendered.result.current).toMatchObject({ isError: true, failed: true, members: [expect.objectContaining({ userId: "peer", discriminator: "0042" })] }))
    expect(rendered.result.current.data).toBeUndefined()
    apiFetchMock.mockResolvedValue(roster("private", "access", [peer], [profile("peer", "Peer")]))
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current).toMatchObject({ isSuccess: true, loading: false, failed: false, members: [expect.objectContaining({ userId: "peer" })] }))
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })
  it("separates missing usable profiles from true empty and withdraws disabled access candidates", async () => {
    const { useChannelMembers } = await import("./use-channel-members")
    const owner = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValue(roster("private", "access", [relationRow("private", "peer", "access", "explicit", "member", "m-peer")], []))
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, children)
    const rendered = renderHook(({ enabled }) => useChannelMembers("private", enabled, "server", "access"), { wrapper, initialProps: { enabled: true } })
    await waitFor(() => expect(rendered.result.current).toMatchObject({ isSuccess: true, loading: false, failed: true }))
    await act(async () => owner.registry.collections.profiles.utils.writeUpsert(profileSchema.parse(profile("peer", "Peer"))))
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
    apiFetchMock.mockResolvedValue(roster("private/channel", "access", [relationRow("private/channel", "member_1", "access", "explicit", "member", "membership_1")], [profile("member_1", "Alice", "0042", 4)]))
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
    await publishCommunityChannelMetadata(owner.client, { metadata: { categoryId: null, topic: "", position: 0, messageCount: 0, createdAt: "2026-10-01T00:00:00Z", id: "dm", serverId: null, name: null, type: "dm", parentChannelId: null, parentMessageId: null, creatorId: null, archived: false, lastMessageAt: null }, proof: { token: captureCommunityLiveSnapshotToken(owner.client) } })
    apiFetchMock.mockResolvedValue(roster("dm", "access", ["viewer", "peer"].map(userId => relationRow("dm", userId, "access", "explicit", null, null)), [profile("viewer", "viewer", "0001"), profile("peer", "peer", "0001")]))
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
      const profiles = [profile("viewer", "Viewer"), profile("bob", "Bob"), profile("carol", "Carol")]
      const parentMembers = [
        relationRow("parent", "viewer", "access", "admin", "owner", "membership_viewer", true),
        relationRow("parent", "bob", "access", "explicit"),
        relationRow("parent", "carol", "access", "inherited"),
      ]
      const participants = parentMembers.slice(0, 2).map(row => ({ ...row, channelId: "thread", relation: "notify" as const, source }))
      let failParticipants = true
      let participantGets = 0
      let parentGets = 0
      apiFetchMock.mockImplementation((url: string) => {
        if (url.endsWith("/thread/members?relation=notify")) {
          participantGets += 1
          return failParticipants
            ? Promise.reject(new Error("controlled first-load failure"))
            : Promise.resolve(roster("thread", "notify", participants, profiles.slice(0, 2)))
        }
        if (url.endsWith("/parent/members?relation=access")) {
          parentGets += 1
          return Promise.resolve(roster("parent", "access", parentMembers, profiles))
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

  it("retires private channel reading on confirmed self-removal without aborting post-delete completion", async () => {
    const { useRemoveChannelMember } = await import("./use-channel-members")
    const { publishCommunityChannelMetadata, publishCommunityChannelMembersSnapshot, captureCommunityLiveSnapshotToken } = await import("@/lib/community-db/sync")
    const owner = await createCommunityQueryOwner()
    const token = captureCommunityLiveSnapshotToken(owner.client)
    await publishCommunityChannelMetadata(owner.client, {
      metadata: { categoryId: "cat_priv", topic: "", position: 0, messageCount: 1, createdAt: "2026-10-01T00:00:00Z", id: "private", serverId: "server", name: "secret", type: "text", parentChannelId: null, parentMessageId: null, creatorId: "bob", archived: false, lastMessageAt: null },
      proof: { token },
    })
    await publishCommunityChannelMembersSnapshot(
      owner.client,
      "server",
      "private",
      "access",
      [
        relationRow("private", "viewer", "access", "explicit", "member", "m-viewer"),
        relationRow("private", "bob", "access", "explicit", "member", "m-bob"),
      ],
      { token },
      [profile("viewer", "Viewer"), profile("bob", "Bob")],
    )
    apiFetchMock.mockResolvedValue({ ok: true })
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, children)
    const rendered = renderHook(() => useRemoveChannelMember("private", "server", "viewer"), { wrapper })
    const onPeerSuccess = vi.fn()
    const onSelfSuccess = vi.fn()
    await act(async () => {
      await expect(rendered.result.current.mutateAsync({ userId: "bob" }, { onSuccess: onPeerSuccess })).resolves.toBeUndefined()
      await expect(rendered.result.current.mutateAsync({ userId: "viewer" }, { onSuccess: onSelfSuccess })).resolves.toBeUndefined()
    })
    expect(onPeerSuccess).toHaveBeenCalledOnce()
    expect(onSelfSuccess).toHaveBeenCalledOnce()
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/private/members/viewer",
      expect.objectContaining({ method: "DELETE" }),
    )
    expect(owner.registry.collections.channels.has("private")).toBe(false)
    expect(owner.registry.collections.channelMemberships.has(channelMembershipKey("private", "viewer", "access"))).toBe(false)
    expect(owner.registry.runtime.ws.actions.isChannelAccessRevoked("private", "server")).toBe(true)
  })

  it("completes self-removal when WS revocation arrives before HTTP DELETE resolves and fences callers after route exit", async () => {
    const { useRemoveChannelMember } = await import("./use-channel-members")
    const {
      publishCommunityChannelMetadata,
      publishCommunityChannelMembersSnapshot,
      captureCommunityLiveSnapshotToken,
      setCanonicalCommunityChannelMember,
      retireCommunityChannelReading,
    } = await import("@/lib/community-db/sync")
    const owner = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, children)
    const seedPrivate = async (id: string) => {
      const token = captureCommunityLiveSnapshotToken(owner.client)
      await publishCommunityChannelMetadata(owner.client, {
        metadata: { categoryId: "cat_priv", topic: "", position: 0, messageCount: 1, createdAt: "2026-10-01T00:00:00Z", id, serverId: "server", name: id, type: "text", parentChannelId: null, parentMessageId: null, creatorId: "bob", archived: false, lastMessageAt: null },
        proof: { token },
      })
      await publishCommunityChannelMembersSnapshot(
        owner.client, "server", id, "access",
        [relationRow(id, "viewer", "access", "explicit", "member", "m-viewer")],
        { token }, [profile("viewer", "Viewer")],
      )
    }

    // Order 2: WS revocation arrives while HTTP DELETE is still in flight; user stays on route.
    await seedPrivate("ws-first")
    let resolveDelete!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveDelete = resolve }))
    const wsFirst = renderHook(() => useRemoveChannelMember("ws-first", "server", "viewer"), { wrapper })
    let pending!: Promise<void>
    act(() => { pending = wsFirst.result.current.mutateAsync({ userId: "viewer" }) })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => {
      setCanonicalCommunityChannelMember(owner.client, "ws-first", "viewer", "access", false, { event: true })
      retireCommunityChannelReading(owner.registry, "ws-first", { reason: "read-denied", serverId: "server" })
    })
    await act(async () => {
      resolveDelete({ ok: true })
      await expect(pending).resolves.toBeUndefined()
    })
    expect(owner.registry.runtime.ws.actions.isChannelAccessRevoked("ws-first", "server")).toBe(true)

    // Order 3: User leaves the route while HTTP DELETE is in flight; old response retires DB but rejects caller with AbortError.
    await seedPrivate("left-page")
    let resolveStaleDelete!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveStaleDelete = resolve }))
    const leftPage = renderHook(() => useRemoveChannelMember("left-page", "server", "viewer"), { wrapper })
    const routeController = new AbortController()
    const assertRoute = Object.assign(() => {
      if (routeController.signal.aborted) throw new DOMException("Left route", "AbortError")
    }, { signal: routeController.signal })
    let staleOutcome!: Promise<unknown>
    act(() => { staleOutcome = leftPage.result.current.mutateAsync({ userId: "viewer", assertActive: assertRoute }).catch((error) => error) })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    routeController.abort()
    await act(async () => {
      resolveStaleDelete({ ok: true })
      expect(await staleOutcome).toMatchObject({ name: "AbortError" })
    })
    expect(owner.registry.collections.channels.has("left-page")).toBe(false)
    expect(owner.registry.runtime.ws.actions.isChannelAccessRevoked("left-page", "server")).toBe(true)
  })
})

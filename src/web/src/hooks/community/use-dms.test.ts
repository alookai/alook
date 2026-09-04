import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { DM } from "@/lib/community/models/people"
import { inboxDmRowTarget } from "./inbox-read-reservation"

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

  it("uses a complete DM list as authoritative negative evidence", async () => {
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    const { dmsProjectedQueryFn } = await import("./use-dms")
    const { AccountUnreadProjection } = await import("./account-unread-projection")
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "dm_1", seq: 3 })

    await dmsProjectedQueryFn(projection)()

    expect(projection.projectUnread("dms", "dm_1", false)).toBe(false)
  })

  it("reuses a projected DM across layout mounts without refetching the canonical list", async () => {
    const conversations = [{
      id: "dm_projected",
      userId: "u_1",
      name: "Alice",
      discriminator: "0001",
      avatar: "a",
      status: "offline",
      preview: "projected from inbox",
    }]
    apiFetchMock.mockResolvedValue({ conversations })
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.dms(), { conversations })

    function Probe() {
      useDms()
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

    expect(apiFetchMock).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
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

  it("projects and rolls back the exact Inbox DM reservation without hiding a sibling", async () => {
    const conversations = [
      {
        id: "dm_1", userId: "u_1", name: "Alice", discriminator: "0001",
        avatar: "a", avatarVersion: 1, status: "offline", preview: "one",
        unread: true, lastUnreadSeq: 2,
      },
      {
        id: "dm_2", userId: "u_2", name: "Bob", discriminator: "0002",
        avatar: "b", avatarVersion: 1, status: "offline", preview: "two",
        unread: true, lastUnreadSeq: 3,
      },
    ] as DM[]
    const inboxDm = {
      channelId: "dm_1",
      otherUserId: "u_1",
      otherUserName: "Alice",
      otherUserDiscriminator: "0001",
      otherUserAvatar: "a",
      otherUserAvatarVersion: 1,
      lastMessageAt: "2026-09-02T00:00:00.000Z",
      lastUnreadSeq: 2,
    }
    const { useDms } = await import("./use-dms")
    const { useInboxAutoCollapse } = await import("./use-inbox-auto-collapse")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.dms(), { conversations })
    let latest: ReturnType<typeof useDms> | undefined
    let collapse: ReturnType<typeof useInboxAutoCollapse> | undefined
    function Harness() {
      latest = useDms()
      collapse = useInboxAutoCollapse({
        queryClient: qc,
        publishedHref: "/c/me",
        navigationPending: false,
        pendingHref: null,
      })
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

    let epoch = 0
    await act(async () => {
      epoch = collapse!.beginProjection(inboxDmRowTarget(inboxDm), "/c/me/dm_1")
    })
    expect(latest?.dms.map((dm) => dm.unread)).toEqual([false, true])

    await act(async () => {
      collapse!.rollbackProjection(epoch)
    })
    expect(latest?.dms.map((dm) => dm.unread)).toEqual([true, true])
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

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { DM } from "@/lib/community/models/people"
import { inboxDmRowTarget } from "./inbox-read-reservation"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import {
  createDmsResourceQueryFn,
  dmsResourceKey,
  type DmsResource,
} from "@/lib/community-db/dms-resource"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function dm(id: string): DM {
  return {
    id,
    userId: `${id}-peer`,
    name: id,
    discriminator: "0001",
    avatar: id,
    status: "offline",
    preview: "",
  }
}

function dmsResource(conversations: DM[]): DmsResource {
  return { conversations, channels: [], channelMemberships: [], profiles: [] }
}

function dmsContext(queryClient: QueryClient, accountId: string, signal = new AbortController().signal) {
  return {
    queryKey: dmsResourceKey(accountId),
    signal,
    meta: undefined,
    client: queryClient,
  } as never
}

function emptyAttention() {
  return {
    scopes: [], items: [], limit: 100, truncated: false,
    included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/api/community/servers") return { servers: [] }
    if (path === "/api/community/users/me/read-state") {
      return { revision: 0, readStates: [] }
    }
    if (path === "/api/community/users/me/attention") return emptyAttention()
    if (path === "/api/community/users/me/server-folders") return { folders: [] }
    if (path === "/api/community/users/me/notifications") return []
    if (path === "/api/community/users/me/dms") return { conversations: [] }
    throw new Error(`unexpected API fetch: ${path}`)
  })
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
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/dms", undefined)
    expect(data.conversations).toEqual(conversations)
  })

  it("populates the account-scoped DMs resource", async () => {
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    const { dmsQueryFn } = await import("./use-dms")
    const qc = new QueryClient()
    const key = dmsResourceKey("anon")
    await qc.fetchQuery({ queryKey: key, queryFn: dmsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/dms",
      { signal: expect.any(AbortSignal) },
    )
    expect(qc.getQueryData(key)).toEqual(dmsResource([]))
  })

  it("uses a complete DM list as authoritative negative evidence", async () => {
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    const queryClient = new QueryClient()
    const projection = getActiveAccountUnreadProjection(queryClient)
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "dm_1", seq: 3 })
    await createDmsResourceQueryFn(queryClient, "viewer")(
      dmsContext(queryClient, "viewer"),
    )

    expect(projection.projectUnread("dms", "dm_1", false)).toBe(false)
  })

  it.each(["cancel", "account", "access"] as const)(
    "rejects a %s-superseded DM list before destructive publication",
    async (race) => {
      const queryClient = new QueryClient()
      const key = dmsResourceKey("viewer")
      const current = dmsResource([dm("dm-current")])
      queryClient.setQueryData(key, current)
      const request = deferred<{ conversations: DM[] }>()
      apiFetchMock.mockReturnValueOnce(request.promise)
      const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
      const projection = getActiveAccountUnreadProjection(queryClient)
      const controller = new AbortController()

      const pending = createDmsResourceQueryFn(queryClient, "viewer")(
        dmsContext(queryClient, "viewer", controller.signal),
      )
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/users/me/dms",
        { signal: controller.signal },
      )
      if (race === "cancel") controller.abort()
      else if (race === "account") useCommunityWsStore.getState().activateProfileAccount("other")
      else useCommunityWsStore.setState((state) => ({ accessEpoch: state.accessEpoch + 1 }))
      request.resolve({ conversations: [] })

      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(queryClient.getQueryData(key)).toBe(current)
      expect(projection.inspectForTests().pendingSnapshots).toBe(0)
    },
  )

  it("lets a current DM-list generation replace canonical rows", async () => {
    const queryClient = new QueryClient()
    const key = dmsResourceKey("viewer")
    queryClient.setQueryData(key, dmsResource([dm("dm-current")]))
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    await queryClient.fetchQuery({
      queryKey: key,
      queryFn: createDmsResourceQueryFn(queryClient, "viewer"),
      staleTime: 0,
    })

    expect(queryClient.getQueryData<DmsResource>(key)?.conversations).toEqual([])
  })

  it("cancels DM snapshot coverage when the transport fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("offline"))
    const queryClient = new QueryClient()
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    const projection = getActiveAccountUnreadProjection(queryClient)

    await expect(createDmsResourceQueryFn(queryClient, "u1")(
      dmsContext(queryClient, "u1"),
    )).rejects.toThrow("offline")

    expect(projection.inspectForTests().pendingSnapshots).toBe(0)
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
    qc.setQueryData(dmsResourceKey("anon"), dmsResource(conversations))

    function Probe() {
      useDms()
      return null
    }

    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Probe),
    ))

    expect(apiFetchMock).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it("uses transport conversations without a canonical registry", async () => {
    const conversations = [dm("dm-providerless")]
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    qc.setQueryData(dmsResourceKey("anon"), dmsResource(conversations))
    let latest: ReturnType<typeof useDms> | undefined

    function Probe() {
      latest = useDms()
      return null
    }

    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Probe),
    ))
    expect(latest?.dms.map(({ id }) => id)).toEqual(["dm-providerless"])
    await act(async () => renderer.unmount())
  })

  it("uses canonical conversations while a registry is active", async () => {
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const registry = createCommunityDbRegistry(qc, "viewer")
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    const disposeRegistry = registry.cleanup.bind(registry)
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/community/users/me/dms") {
        return { conversations: [dm("dm-canonical")] }
      }
      throw new Error(`unexpected API fetch after preload: ${path}`)
    })
    await qc.fetchQuery({
      queryKey: dmsResourceKey("viewer"),
      queryFn: createDmsResourceQueryFn(qc, "viewer"),
      staleTime: 0,
    })
    let latest: ReturnType<typeof useDms> | undefined

    function Probe() {
      latest = useDms()
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(CommunityDbProvider, { registry }, React.createElement(Probe)),
    ))
    await waitFor(() => expect(latest?.dms.map(({ id }) => id)).toEqual(["dm-canonical"]))
    await act(async () => renderer.unmount())
    unregister()
    await disposeRegistry()
  })

  it("uses transient presence without rewriting the raw canonical DM identity", async () => {
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const conversations = [{
        id: "dm_1",
        userId: "u_1",
        name: "Raw Alice",
        discriminator: "0001",
        avatar: "raw",
        avatarVersion: 1,
        status: "offline",
        preview: "hello",
      }]
    const raw = dmsResource(conversations)
    qc.setQueryData(dmsResourceKey("anon"), raw)
    useCommunityWsStore.getState().setPresence("u_1", "online")
    let projected!: ReturnType<typeof useDms>
    function Probe() {
      projected = useDms()
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Probe),
    ))

    expect(projected.dms[0]).toMatchObject({
      name: "Raw Alice",
      discriminator: "0001",
      avatar: "raw",
      avatarVersion: 1,
      status: "online",
      preview: "hello",
    })
    expect(qc.getQueryData(dmsResourceKey("anon"))).toBe(raw)
    await act(async () => renderer.unmount())
  })

  it("renders persisted DM identity without a live profile seed", async () => {
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    qc.setQueryData(dmsResourceKey("anon"), dmsResource([{
        id: "dm_cached",
        userId: "u_cached",
        name: "Cached Alice",
        discriminator: "0042",
        avatar: "cached-avatar",
        avatarVersion: 7,
        status: "online",
        preview: "cached preview",
      }]))
    let projected!: ReturnType<typeof useDms>
    function Probe() {
      projected = useDms()
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Probe),
    ))

    expect(projected.dms[0]).toMatchObject({
      name: "Cached Alice",
      discriminator: "0042",
      avatar: "cached-avatar",
      avatarVersion: 7,
      status: "offline",
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it("keeps legacy unread flags subordinate to canonical attention", async () => {
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
    qc.setQueryData(dmsResourceKey("anon"), dmsResource(conversations))
    getActiveAccountUnreadProjection(qc).recordArrival({ channelId: "dm_1", seq: 2 })
    let latest: ReturnType<typeof useDms> | undefined

    function Harness() {
      latest = useDms()
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    ))

    expect(latest?.dms[0]?.unread).toBe(false)
    expect(latest?.dms[1]?.unread).toBe(false)
    expect(latest?.dms[2]?.unread).toBe(false)
    expect(qc.getQueryData<DmsResource>(dmsResourceKey("anon"))?.conversations)
      .toEqual(conversations)
    await act(async () => renderer.unmount())
  })

  it("does not let a legacy Inbox reservation mutate canonical DM attention", async () => {
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
    qc.setQueryData(dmsResourceKey("anon"), dmsResource(conversations))
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
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    ))

    let epoch = 0
    await act(async () => {
      epoch = collapse!.beginProjection(inboxDmRowTarget(inboxDm), "/c/me/dm_1")
    })
    expect(latest?.dms.map((dm) => dm.unread)).toEqual([false, false])

    await act(async () => {
      collapse!.rollbackProjection(epoch)
    })
    expect(latest?.dms.map((dm) => dm.unread)).toEqual([false, false])
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
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    ))
    const first = latest?.dms
    renderer.rerender(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    ))
    expect(latest?.dms).toBe(first)
    expect(latest?.dms).toEqual([])
    await act(async () => renderer.unmount())
  })
})

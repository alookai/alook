import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { QueryClient, QueryClientProvider as BareQueryClientProvider } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"
import { dmsProjectedQueryFn } from "./use-dms"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { DM } from "@/lib/community/models/people"
import { inboxDmRowTarget } from "./inbox-read-reservation"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  getCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ingestDms } from "@/lib/community-db/sync"

function seedDms(client: QueryClient, data: { conversations: DM[] }) {
  ingestDms(getCommunityDbRegistry(client)!, data)
  client.setQueryData(communityKeys.dms(), { ids: data.conversations.map((dm) => dm.id) })
}

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

beforeEach(() => {
  apiFetchMock.mockReset()


})

describe("useDms / dmsQueryFn", () => {
  it("returns the DM conversations from GET /api/community/users/me/dms", async () => {
    const conversations = [
      { id: "dm_1", userId: "u_1", name: "Alice", discriminator: "0000", avatar: "A", status: "offline", preview: "" },
    ]
    apiFetchMock.mockResolvedValueOnce({ conversations })
    const { client: qc, registry } = await createCommunityQueryOwner()
    const data = await qc.query({ queryKey: communityKeys.dms(), queryFn: dmsProjectedQueryFn(getActiveAccountUnreadProjection(qc), qc) })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/dms", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(data).toEqual({ ids: ["dm_1"] })
    expect(registry.collections.channels.get("dm_1")?.type).toBe("dm")
    expect(registry.collections.profiles.get("u_1")?.name).toBe("Alice")
  })

  it("populates queryClient at communityKeys.dms()", async () => {
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    const { client: qc } = await createCommunityQueryOwner()
    const key = communityKeys.dms()
    await qc.query({ queryKey: key, queryFn: dmsProjectedQueryFn(getActiveAccountUnreadProjection(qc), qc) })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/dms",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(qc.getQueryData(key)).toEqual({ ids: [] })
  })

  it("uses a complete DM list as authoritative negative evidence", async () => {
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    const { dmsProjectedQueryFn } = await import("./use-dms")
    const { AccountUnreadProjection } = await import("./account-unread-projection")
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "dm_1", seq: 3 })
    const { client: queryClient } = await createCommunityQueryOwner()

    await queryClient.query({ queryKey: communityKeys.dms(), queryFn: dmsProjectedQueryFn(projection, queryClient) })

    expect(projection.projectUnread("dms", "dm_1", false)).toBe(false)
  })

  it.each(["cancel", "account", "access"] as const)(
    "rejects a %s-superseded DM list before destructive publication",
    async (race) => {
      const { client: queryClient } = await createCommunityQueryOwner()
      const registry = createCommunityDbRegistry(queryClient, "viewer")
      await registry.preload()
      const unregister = registerCommunityDbRegistry(registry)
      const disposeRegistry = registry.cleanup
      ingestDms(registry, { conversations: [dm("dm-current")] })
      const request = deferred<{ conversations: DM[] }>()
      apiFetchMock.mockReturnValueOnce(request.promise)
      const { dmsProjectedQueryFn } = await import("./use-dms")
      const { AccountUnreadProjection } = await import("./account-unread-projection")
      const projection = new AccountUnreadProjection("viewer")
      const controller = new AbortController()

      const pending = dmsProjectedQueryFn(projection, queryClient)({
        client: queryClient, signal: controller.signal,
      } as never)
      await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/users/me/dms",
        expect.objectContaining({ signal: controller.signal }),
      ))
      if (race === "cancel") controller.abort()
      else if (race === "account") registry.runtime.ws.actions.activateProfileAccount("other")
      else registry.runtime.ws.setState((state) => ({ ...state,  accessEpoch: state.accessEpoch + 1 }))
      request.resolve({ conversations: [] })

      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(registry.collections.channels.get("dm-current")).toBeDefined()
      expect(projection.inspectForTests().pendingSnapshots).toBe(0)
      unregister()
      await disposeRegistry()
    },
  )

  it("lets a current DM-list generation replace canonical rows", async () => {
    const { client: queryClient } = await createCommunityQueryOwner()
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    const disposeRegistry = registry.cleanup
    ingestDms(registry, { conversations: [dm("dm-current")] })
    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    const { dmsProjectedQueryFn } = await import("./use-dms")
    const { AccountUnreadProjection } = await import("./account-unread-projection")

    await queryClient.query({ queryKey: communityKeys.dms(), queryFn: dmsProjectedQueryFn(new AccountUnreadProjection("viewer"), queryClient) })

    expect(registry.collections.channels.get("dm-current")).toBeUndefined()
    unregister()
    await disposeRegistry()
  })

  it("cancels DM snapshot coverage when the transport fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("offline"))
    const { dmsProjectedQueryFn } = await import("./use-dms")
    const { AccountUnreadProjection } = await import("./account-unread-projection")
    const projection = new AccountUnreadProjection("u1")

    const { client: qc } = await createCommunityQueryOwner()
    await expect(qc.query({ queryKey: communityKeys.dms(), queryFn: dmsProjectedQueryFn(projection, qc) })).rejects.toThrow("offline")

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
    const { client: qc } = await createCommunityQueryOwner()
    seedDms(qc, { conversations })

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

  it("ignores legacy transport conversations without a canonical provider", async () => {
    const conversations = [dm("dm-providerless")]
    const { useDms } = await import("./use-dms")
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    qc.setQueryData(communityKeys.dms(), { conversations })
    let latest: ReturnType<typeof useDms> | undefined

    function Probe() {
      latest = useDms()
      return null
    }

    const renderer = render(React.createElement(
      BareQueryClientProvider,
      { client: qc },
      React.createElement(Probe),
    ))
    expect(latest?.dms).toEqual([])
    await act(async () => renderer.unmount())
  })

  it("uses canonical conversations while a registry is active", async () => {
    const { useDms } = await import("./use-dms")
    const { client: qc } = await createCommunityQueryOwner()
    const registry = createCommunityDbRegistry(qc, "viewer")
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    const disposeRegistry = registry.cleanup
    ingestDms(registry, { conversations: [dm("dm-canonical")] })
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
    expect(latest?.dms.map(({ id }) => id)).toEqual(["dm-canonical"])
    await act(async () => renderer.unmount())
    unregister()
    await disposeRegistry()
  })

  it("uses transient presence without rewriting the raw canonical DM identity", async () => {
    const { useDms } = await import("./use-dms")
    const { client: qc } = await createCommunityQueryOwner()
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
    seedDms(qc, raw)
    createCommunityDbRegistry(qc, "viewer").runtime.ws.actions.setPresence("u_1", "online")
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
    expect(qc.getQueryData(communityKeys.dms())).toEqual({ ids: raw.conversations.map((dm) => dm.id) })
    await act(async () => renderer.unmount())
  })

  it("renders persisted DM identity without a live profile seed", async () => {
    const { useDms } = await import("./use-dms")
    const { client: qc } = await createCommunityQueryOwner()
    seedDms(qc, {
      conversations: [{
        id: "dm_cached",
        userId: "u_cached",
        name: "Cached Alice",
        discriminator: "0042",
        avatar: "cached-avatar",
        avatarVersion: 7,
        status: "online",
        preview: "cached preview",
      }],
    })
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
    const { client: qc } = await createCommunityQueryOwner()
    seedDms(qc, { conversations })
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
    expect(qc.getQueryData(communityKeys.dms())).toEqual({ ids: conversations.map((dm) => dm.id) })
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
    const { client: qc } = await createCommunityQueryOwner()
    seedDms(qc, { conversations })
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
    const { client: qc } = await createCommunityQueryOwner()
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

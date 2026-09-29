import { createElement, useEffect, type MutableRefObject } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@/test/react-dom-harness"
import type { Member } from "@/lib/community/models/people"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import {
  applyUpdateEvent,
  dispatchMemberOverlayEvent,
  mergeMemberSearchPage,
  SEARCH_DEBOUNCE_MS,
  subscribeMemberOverlayEvents,
  useServerMembers,
  type MemberOverlayEvent,
} from "./use-server-members"
import type { CommunityMemberUpdate } from "@alook/shared"
import { serverMembershipKey } from "@/lib/community-db/schema"
import { serverMembersPagesKey } from "@/lib/community-db/server-members-pagination"

const apiFetchMock = vi.fn()
const toastApiErrorMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  toastApiError: (...args: unknown[]) => toastApiErrorMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  toastApiErrorMock.mockReset()
})

afterEach(() => vi.useRealTimers())

function member(id: string, role: Member["role"] = "member"): Member {
  return {
    id,
    userId: id,
    name: `n_${id}`,
    discriminator: "0000",
    avatar: "A",
    avatarVersion: 0,
    status: "offline",
    sub: "",
    role,
  }
}

type ServerMembersResult = ReturnType<typeof useServerMembers>
type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function HookProbe({ serverId, resultRef }: {
  serverId: string | null
  resultRef: MutableRefObject<ServerMembersResult | null>
}) {
  const result = useServerMembers(serverId)
  useEffect(() => {
    resultRef.current = result
  }, [result, resultRef])
  return null
}

async function mountServerMembers(serverId = "srv_1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  await Promise.all([
    registry.ensureCollectionReady("serverMemberships"),
    registry.ensureCollectionReady("profiles"),
  ])
  const unregister = registerCommunityDbRegistry(registry)
  const disposeRegistry = registry.cleanup.bind(registry)
  const resultRef = { current: null } as MutableRefObject<ServerMembersResult | null>
  const tree = (id: string | null) => createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      CommunityDbProvider,
      { registry },
      createElement(HookProbe, { serverId: id, resultRef }),
    ),
  )
  const renderer = render(tree(serverId))
  await act(async () => { await Promise.resolve() })
  return {
    queryClient,
    registry,
    renderer,
    resultRef,
    rerender: (id: string | null) => renderer.rerender(tree(id)),
    dispose: async () => {
      await act(async () => renderer.unmount())
      unregister()
      await disposeRegistry()
      queryClient.clear()
    },
  }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function isSearchUrl(value: unknown): value is string {
  return typeof value === "string" && value.includes("/members/search?")
}

function defaultApiResponse(url: unknown) {
  if (url === "/api/community/users/me/dms") return { conversations: [] }
  return { members: [], hasMore: false, limit: 50, total: 0 }
}

describe("server member view helpers", () => {
  it("deduplicates serial search pages", () => {
    const first = [member("a"), member("b")]
    expect(mergeMemberSearchPage(first, [member("b"), member("c")]).map((row) => row.id))
      .toEqual(["a", "b", "c"])
    expect(mergeMemberSearchPage(first, [member("a")])).toBe(first)
  })

  it("patches role and nickname in search overlays", () => {
    const event: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "a",
      userId: "a",
      changes: { role: "admin", nickname: "Alias" },
    }
    expect(applyUpdateEvent([member("a"), member("b")], event)).toMatchObject([
      { id: "a", role: "admin", name: "Alias" },
      { id: "b", role: "member" },
    ])
  })

  it("delivers overlay events until unsubscribe", () => {
    const received: MemberOverlayEvent[] = []
    const unsubscribe = subscribeMemberOverlayEvents((event) => received.push(event))
    dispatchMemberOverlayEvent({ type: "kick", serverId: "srv_1", memberId: "a" })
    unsubscribe()
    dispatchMemberOverlayEvent({ type: "kick", serverId: "srv_1", memberId: "b" })
    expect(received).toEqual([{ type: "kick", serverId: "srv_1", memberId: "a" }])
  })
})

describe("useServerMembers search lifecycle", () => {
  it("debounces, appends continuation pages, and ignores duplicate calls", async () => {
    vi.useFakeTimers()
    const first = deferred<{ members: Member[]; hasMore: boolean; cursor?: string; limit: number }>()
    const second = deferred<{ members: Member[]; hasMore: boolean; cursor?: string; limit: number }>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (!isSearchUrl(url)) return Promise.resolve(defaultApiResponse(url))
      return url.includes("cursor=next") ? second.promise : first.promise
    })
    const harness = await mountServerMembers()

    await act(async () => {
      harness.resultRef.current!.searchMembers(" ad ")
      harness.resultRef.current!.searchMembers("ad")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toEqual([
      ["/api/community/servers/srv_1/members/search?q=ad"],
    ])

    first.resolve({ members: [member("a"), member("b")], hasMore: true, cursor: "next", limit: 50 })
    await flushEffects()
    second.resolve({ members: [member("b"), member("c")], hasMore: false, limit: 50 })
    await flushEffects()

    expect(harness.resultRef.current).toMatchObject({
      isSearching: true,
      members: [member("a"), member("b"), member("c")],
      searchStatus: "ready",
    })
    await harness.dispose()
  })

  it("keeps the newest search when an older response settles late", async () => {
    vi.useFakeTimers()
    const requests = new Map<string, Deferred<{ members: Member[]; hasMore: boolean; limit: number }>>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (!isSearchUrl(url)) return Promise.resolve(defaultApiResponse(url))
      const query = new URL(url, "https://alook.local").searchParams.get("q")!
      const request = deferred<{ members: Member[]; hasMore: boolean; limit: number }>()
      requests.set(query, request)
      return request.promise
    })
    const harness = await mountServerMembers()
    await act(async () => {
      harness.resultRef.current!.searchMembers("old")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
      harness.resultRef.current!.searchMembers("new")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    requests.get("old")!.resolve({ members: [member("old")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({ searchQuery: "new", members: [] })
    requests.get("new")!.resolve({ members: [member("new")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      searchQuery: "new",
      members: [member("new")],
      searchStatus: "ready",
    })
    await harness.dispose()
  })

  it("drops the prior server overlay and ignores its late response", async () => {
    vi.useFakeTimers()
    const old = deferred<{ members: Member[]; hasMore: boolean; limit: number }>()
    apiFetchMock.mockImplementation((url: unknown) => (
      isSearchUrl(url) ? old.promise : Promise.resolve(defaultApiResponse(url))
    ))
    const harness = await mountServerMembers()
    await act(async () => {
      harness.resultRef.current!.searchMembers("old")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
      harness.rerender("srv_2")
      await Promise.resolve()
    })
    old.resolve({ members: [member("old")], hasMore: false, limit: 50 })
    await flushEffects()

    expect(harness.resultRef.current).toMatchObject({
      isSearching: false,
      searchQuery: "",
      members: [],
    })
    expect(toastApiErrorMock).not.toHaveBeenCalled()
    await harness.dispose()
  })
})

describe("useServerMembers canonical actions", () => {
  it("grows the acquired roster window through loadMore", async () => {
    apiFetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("cursor=next")) {
        return { members: [member("last")], hasMore: false, limit: 50, total: 51 }
      }
      if (String(url).includes("/members")) {
        return {
          members: Array.from({ length: 50 }, (_, index) => member(`m-${index}`)),
          hasMore: true,
          cursor: "next",
          limit: 50,
          total: 51,
        }
      }
      return defaultApiResponse(url)
    })
    const harness = await mountServerMembers()
    await vi.waitFor(() => expect(harness.resultRef.current?.hasMore).toBe(true))

    await act(async () => harness.resultRef.current!.loadMore())

    await vi.waitFor(() => expect(harness.resultRef.current?.members).toHaveLength(51))
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("cursor=next"))).toBe(true)
    await harness.dispose()
  })

  it("reconciles on reset and refresh and applies exact role and kick writes", async () => {
    apiFetchMock.mockImplementation(async (url: unknown) => defaultApiResponse(url))
    const harness = await mountServerMembers()
    const reconcile = vi.spyOn(harness.registry, "reconcileServerMembers").mockResolvedValue()
    const membershipId = serverMembershipKey("srv_1", "user-1")
    await act(async () => {
      harness.registry.collections.profiles.utils.writeInsert({
        userId: "user-1",
        name: "Visible member",
        discriminator: "0001",
        avatar: "A",
        avatarVersion: 2,
        presence: "online",
      })
      harness.registry.collections.serverMemberships.utils.writeInsert({
        id: membershipId,
        serverId: "srv_1",
        userId: "user-1",
        memberId: "member-1",
        role: "member",
        viewer: true,
      })
      harness.queryClient.setQueryData(serverMembersPagesKey("viewer", "srv_1"), {
        pages: [{ rows: [], nextCursor: null, total: 1 }],
        pageParams: [undefined],
      })
    })
    await vi.waitFor(() => expect(harness.resultRef.current?.members).toEqual([
      expect.objectContaining({
        id: "member-1",
        name: "Visible member",
        discriminator: "0001",
        avatar: "A",
        avatarVersion: 2,
        status: "online",
      }),
    ]))

    await act(async () => {
      harness.resultRef.current!.reset()
      harness.resultRef.current!.refresh()
      harness.resultRef.current!.applyRoleChange("member-1", "admin")
    })
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(harness.registry.collections.serverMemberships.get(membershipId)?.role).toBe("admin")

    await act(async () => harness.resultRef.current!.applyKick("member-1"))
    expect(harness.registry.collections.serverMemberships.has(membershipId)).toBe(false)
    expect(harness.queryClient.getQueryData<any>(
      serverMembersPagesKey("viewer", "srv_1"),
    )?.pages[0].total).toBe(0)
    await harness.dispose()
  })

  it("keeps null-server actions inert", async () => {
    const harness = await mountServerMembers(null)

    await act(async () => {
      harness.resultRef.current!.refresh()
      harness.resultRef.current!.applyRoleChange("member-1", "admin")
      harness.resultRef.current!.applyKick("member-1")
    })

    expect(harness.resultRef.current).toMatchObject({ members: [], loading: false })
    await harness.dispose()
  })
})

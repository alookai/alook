import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createElement, useEffect, type RefObject } from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { QueryClient, type InfiniteData } from "@tanstack/react-query"
import { act, render } from "@/test/react-dom-harness"

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

afterEach(() => {
  vi.useRealTimers()
})

import {
  membersPageQueryFn,
  SEARCH_DEBOUNCE_MS,
  useServerMembers,
  type MemberWindow,
} from "./use-server-members"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { profileSchema, serverMembershipKey, serverMembershipSchema } from "@/lib/community-db/schema"
import { createCommunityDbRegistry, getCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, publishCommunityMemberRemoval } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import type { Member } from "@/lib/community/models/people"
function m(id: string, userId = id, role: Member["role"] = "member"): Member & { statusEmoji: null; statusText: string } {
  return { id, userId, name: `n_${id}`, discriminator: "0000", avatar: `A`, avatarVersion: 0, status: "offline", sub: "", role, statusEmoji: null, statusText: "" }
}

type MembersTransportFixture = { members: Member[]; hasMore: boolean; cursor?: string; limit: number; total: number }

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

function HookProbe({ serverId, resultRef, observations }: {
  serverId: string | null
  resultRef: RefObject<ServerMembersResult | null>
  observations?: ServerMembersResult[]
}) {
  const result = useServerMembers(serverId)
  observations?.push(result)
  useEffect(() => {
    resultRef.current = result
  }, [result, resultRef])
  return null
}

async function mountServerMembers(serverId = "srv_1") {
  const queryClient = (await createCommunityQueryOwner("viewer", {
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  })).client
  const resultRef = { current: null } as RefObject<ServerMembersResult | null>
  const renderer = render(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(HookProbe, { serverId, resultRef }),
  ))
  await act(async () => { await Promise.resolve() })
  return { queryClient, renderer, resultRef }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1)
  })
}

function isSearchUrl(value: unknown): value is string {
  return typeof value === "string" && value.includes("/members/search?")
}

function makeEnvelope(members: Member[], hasMore: boolean, total = members.length): MembersTransportFixture & { viewerId: string; serverId: string } {
  return { viewerId: "viewer", serverId: "srv_1", members, hasMore, limit: 50, total, ...(hasMore ? { cursor: "cur_next" } : {}) }
}

function makeSearchEnvelope(members: ReturnType<typeof m>[], hasMore: boolean) {
  return { viewerId: "viewer", serverId: "srv_1", members, hasMore, limit: 50, ...(hasMore ? { cursor: "cur_next" } : {}) }
}

it("keeps a queued member search until account confirmation resumes its debounce", async () => {
  vi.useFakeTimers()
  apiFetchMock.mockImplementation((url: string) => Promise.resolve(isSearchUrl(url) ? makeSearchEnvelope([], false) : makeEnvelope([], false)))
  const harness = await mountServerMembers()
  const registry = getCommunityDbRegistry(harness.queryClient)!
  await act(async () => {
    harness.resultRef.current!.searchMembers("pending")
    registry.bindAuthentication(() => undefined, async () => {})
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1)
  })
  expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toEqual([])
  await act(async () => {
    registry.bindAuthentication(() => "viewer", async () => {})
    registry.confirmAuthentication()
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1)
  })
  expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toHaveLength(1)
})

describe("membersPageQueryFn", () => {
  it("hits /members with no query string on page 1 and appends cursor on later pages", async () => {
    apiFetchMock.mockResolvedValueOnce({ viewerId: "viewer", serverId: "srv_1", members: [], hasMore: false, limit: 50, total: 0 })
    const { client } = await createCommunityQueryOwner()
    const fn = membersPageQueryFn("srv_1")
    await fn({ pageParam: null, client })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/servers/srv_1/members", expect.objectContaining({ authenticationAccount: "viewer" }))

    apiFetchMock.mockResolvedValueOnce({ viewerId: "viewer", serverId: "srv_1", members: [], hasMore: false, limit: 50, total: 0 })
    await fn({ pageParam: "cur_1|abc", client })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/servers/srv_1/members?cursor=cur_1%7Cabc",
      expect.objectContaining({ authenticationAccount: "viewer" }),
    )
  })

  it("populates queryClient at communityKeys.members(serverId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ viewerId: "viewer", serverId: "srv_1", members: [], hasMore: false, limit: 50, total: 0 })
    const qc = (await createCommunityQueryOwner()).client
    const key = communityKeys.members("srv_1")
    await qc.infiniteQuery({
      queryKey: key,
      queryFn: membersPageQueryFn("srv_1"),
      initialPageParam: null as string | null,
    })
    expect(qc.getQueryData(key)).toBeDefined()
    await qc.invalidateQueries({ queryKey: communityKeys.server("srv_1") })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("fetchNextPage produces a new page under the same key", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ viewerId: "viewer", serverId: "srv_1", members: [m("a")], hasMore: true, cursor: "cur_1|a", limit: 50, total: 2 })
      .mockResolvedValueOnce({ viewerId: "viewer", serverId: "srv_1", members: [m("b")], hasMore: false, limit: 50, total: 2 })
    const qc = (await createCommunityQueryOwner()).client
    const key = communityKeys.members("srv_1")
    await qc.infiniteQuery({
      queryKey: key,
      queryFn: membersPageQueryFn("srv_1"),
      initialPageParam: null as string | null,
      getNextPageParam: (last: MemberWindow) =>
        last.hasMore ? (last.cursor ?? null) : undefined,
      pages: 2,
    })
    const data = qc.getQueryData<InfiniteData<MemberWindow>>(key)
    expect(data?.pages).toHaveLength(2)
    expect(data?.pages[0].members.map((x) => x.id)).toEqual(["a"])
    expect(data?.pages[1].members.map((x) => x.id)).toEqual(["b"])
  })
})

describe("native member subscriptions", () => {
  it("publishes canonical role and removal changes, and unsubscribe stops delivery", async () => {
    const { registry } = await createCommunityQueryOwner()
    const collection = registry.collections.serverMemberships
    const row = serverMembershipSchema.parse({ id: serverMembershipKey("srv_1", "user_1"), serverId: "srv_1", userId: "user_1", memberId: "mem_1", role: "member", viewer: false })
    collection.utils.writeUpsert(row)
    const changed = vi.fn()
    const subscription = collection.subscribeChanges(changed)
    await act(async () => collection.utils.writeUpsert({ ...row, role: "admin" }))
    expect(collection.get(row.id)?.role).toBe("admin")
    await act(async () => collection.utils.writeDelete(row.id))
    expect(collection.get(row.id)).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
    subscription.unsubscribe()
    await act(async () => collection.utils.writeUpsert(row))
    expect(changed).toHaveBeenCalledTimes(2)
  })
  it("canonical member removal drops the exact row from an active search window", async () => {
    vi.useFakeTimers()
    apiFetchMock.mockImplementation((url: string) => Promise.resolve(isSearchUrl(url) ? makeSearchEnvelope([m("mem_1"), m("mem_2"), m("mem_3")], false) : makeEnvelope([m("mem_1"), m("mem_2"), m("mem_3")], false)))
    const harness = await mountServerMembers()
    await act(async () => harness.resultRef.current!.searchMembers("mem"))
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1))
    await vi.waitFor(() => expect(harness.resultRef.current?.members.map((member) => member.id)).toEqual(["mem_1", "mem_2", "mem_3"]))
    await act(async () => { publishCommunityMemberRemoval(harness.queryClient, serverMembershipKey("srv_1", "mem_2"), "mem_2", { token: captureCommunityLiveSnapshotToken(harness.queryClient) }) })
    await vi.waitFor(() => expect(harness.resultRef.current?.members.map((member) => member.id)).toEqual(["mem_1", "mem_3"]))
  })
})

describe("useServerMembers search lifecycle", () => {
  it("ignores search effects and retained callbacks after the member view is disabled", async () => {
    apiFetchMock.mockResolvedValue(makeEnvelope([], false, 0))
    const harness = await mountServerMembers()
    const retired = harness.resultRef.current!
    function SearchConsumer({ serverId }: { serverId: string | null }) {
      const result = useServerMembers(serverId)
      const { searchMembers } = result
      useEffect(() => { searchMembers("") }, [searchMembers])
      useEffect(() => { harness.resultRef.current = result }, [result])
      return null
    }
    try {
      await act(async () => harness.renderer.rerender(createElement(
        QueryClientProvider,
        { client: harness.queryClient },
        createElement(SearchConsumer, { serverId: "srv_1" }),
      )))
      const reads = apiFetchMock.mock.calls.length
      await act(async () => harness.renderer.rerender(createElement(
        QueryClientProvider,
        { client: harness.queryClient },
        createElement(SearchConsumer, { serverId: null }),
      )))
      await act(async () => {
        retired.searchMembers("retired")
        harness.resultRef.current!.searchMembers("disabled")
      })
      await flushEffects()
      expect(harness.resultRef.current).toMatchObject({ members: [], searchQuery: "", searchStatus: "idle" })
      expect(apiFetchMock).toHaveBeenCalledTimes(reads)
      expect(toastApiErrorMock).not.toHaveBeenCalled()
    } finally {
      await act(async () => harness.renderer.unmount())
      harness.queryClient.clear()
    }
  })

  it("does not carry an earlier query failure into the next query debounce", async () => {
    vi.useFakeTimers()
    apiFetchMock.mockImplementation((url: unknown) => isSearchUrl(url) ? Promise.reject(new Error("controlled search error")) : Promise.resolve(makeEnvelope([], false, 0)))
    const harness = await mountServerMembers()
    await act(async () => { harness.resultRef.current!.searchMembers("failed"); await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1) })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({ searchStatus: "error", failed: true })
    await act(async () => harness.resultRef.current!.searchMembers("next"))
    expect(harness.resultRef.current).toMatchObject({ searchQuery: "next", searchStatus: "loading", failed: false, members: [] })
    harness.renderer.unmount()
    harness.queryClient.clear()
  })
  it("does not complete a cached transport window while its native profile projection is pending", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const restore = deferred<void>()
    const registry = createCommunityDbRegistry(queryClient, "viewer", { waitForRestore: restore.promise })
    const person = m("a")
    queryClient.setQueryData(communityKeys.members("srv_1"), { pages: [{ members: [{ id: person.id, userId: person.userId }], hasMore: false, limit: 50, total: 1, liveRevision: 0 }], pageParams: [null] })
    queryClient.setQueryData(communityKeys.communityDbCollection(registry.scopeId, "serverMemberships"), [serverMembershipSchema.parse({ id: serverMembershipKey("srv_1", person.userId), serverId: "srv_1", userId: person.userId, memberId: person.id, role: "member", viewer: false })])
    const resultRef = { current: null } as RefObject<ServerMembersResult | null>
    const observations: ServerMembersResult[] = []
    const renderer = render(createElement(QueryClientProvider, { client: queryClient, registry }, createElement(HookProbe, { serverId: "srv_1", resultRef, observations })))
    try {
      await flushEffects()
      expect(queryClient.getQueryState(communityKeys.members("srv_1"))?.status).toBe("success")
      expect(resultRef.current).toMatchObject({ loading: true, failed: false })
      expect(observations.every((value) => value.loading || value.failed)).toBe(true)
      await act(async () => {
        queryClient.setQueryData(communityKeys.communityDbCollection(registry.scopeId, "profiles"), [profileSchema.parse({ id: person.userId, name: person.name, discriminator: person.discriminator, avatar: person.avatar, avatarVersion: 0 })])
        restore.resolve(); await registry.preload()
      })
      await vi.waitFor(() => expect(resultRef.current).toMatchObject({ loading: false, failed: false, members: [expect.objectContaining({ id: "a", discriminator: "0000" })] }))
      expect(apiFetchMock).not.toHaveBeenCalled()
    } finally { restore.resolve(); renderer.unmount(); await registry.cleanup(); queryClient.clear() }
  })
  it("debounces once, leaves the first page ready, and appends only requested continuation pages", async () => {
    vi.useFakeTimers()
    const first = deferred<ReturnType<typeof makeSearchEnvelope>>()
    const second = deferred<ReturnType<typeof makeSearchEnvelope>>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (!isSearchUrl(url)) return Promise.resolve(makeEnvelope([], false, 0))
      if (url.includes("q=none")) {
        return Promise.resolve({ viewerId: "viewer", serverId: "srv_1", members: [], hasMore: false, limit: 50 })
      }
      return url.includes("cursor=cur_2") ? second.promise : first.promise
    })
    const harness = await mountServerMembers()

    await act(async () => {
      harness.resultRef.current!.searchMembers(" ad ")
      harness.resultRef.current!.searchMembers("ad")
    })
    expect(harness.resultRef.current).toMatchObject({
      isSearching: true,
      searchQuery: "ad",
      searchStatus: "loading",
      members: [],
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199)
    })
    expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toEqual([
      ["/api/community/servers/srv_1/members/search?q=ad", expect.objectContaining({ authenticationAccount: "viewer", signal: expect.any(AbortSignal) })],
    ])

    first.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("a"), m("b")], hasMore: true, cursor: "cur_2", limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("a"), m("b")],
      searchStatus: "ready",
      hasMore: true,
      loadingMore: false,
    })
    expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toHaveLength(1)
    await act(async () => { harness.resultRef.current!.loadMore(); await vi.advanceTimersByTimeAsync(1) })
    expect(harness.resultRef.current!.loadingMore).toBe(true)
    expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toEqual([
      ["/api/community/servers/srv_1/members/search?q=ad", expect.objectContaining({ authenticationAccount: "viewer", signal: expect.any(AbortSignal) })],
      ["/api/community/servers/srv_1/members/search?cursor=cur_2&q=ad", expect.objectContaining({ authenticationAccount: "viewer", signal: expect.any(AbortSignal) })],
    ])

    second.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("b"), m("c")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("a"), m("b"), m("c")],
      searchStatus: "ready",
    })

    await act(async () => {
      harness.resultRef.current!.searchMembers("none")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [],
      searchStatus: "empty",
      searchQuery: "none",
    })

    await act(async () => harness.renderer.unmount())
    harness.queryClient.clear()
  })

  it("keeps the latest query when older success and error responses settle late", async () => {
    vi.useFakeTimers()
    const requests = new Map<string, Deferred<ReturnType<typeof makeSearchEnvelope>>>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (!isSearchUrl(url)) return Promise.resolve(makeEnvelope([], false, 0))
      const query = new URL(url, "https://alook.local").searchParams.get("q")!
      const request = deferred<ReturnType<typeof makeSearchEnvelope>>()
      requests.set(query, request)
      return request.promise
    })
    const harness = await mountServerMembers()

    await act(async () => {
      harness.resultRef.current!.searchMembers("old-success")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
      harness.resultRef.current!.searchMembers("new-success")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    requests.get("old-success")!.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("old")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      searchQuery: "new-success",
      searchStatus: "loading",
      members: [],
    })
    requests.get("new-success")!.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("new")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      searchQuery: "new-success",
      searchStatus: "ready",
      members: [m("new")],
    })

    await act(async () => {
      harness.resultRef.current!.searchMembers("old-error")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
      harness.resultRef.current!.searchMembers("final")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    requests.get("old-error")!.reject(new Error("stale failure"))
    await flushEffects()
    expect(toastApiErrorMock).not.toHaveBeenCalled()
    expect(harness.resultRef.current).toMatchObject({
      searchQuery: "final",
      searchStatus: "loading",
      members: [],
    })
    requests.get("final")!.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("final")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      searchQuery: "final",
      searchStatus: "ready",
      members: [m("final")],
    })

    await act(async () => harness.renderer.unmount())
    harness.queryClient.clear()
  })

  it("retains accumulated members on a current continuation error and same-term refresh", async () => {
    vi.useFakeTimers()
    const first = deferred<ReturnType<typeof makeSearchEnvelope>>()
    const continuation = deferred<ReturnType<typeof makeSearchEnvelope>>()
    const refreshed = deferred<ReturnType<typeof makeSearchEnvelope>>()
    let searchCall = 0
    apiFetchMock.mockImplementation((url: unknown) => {
      if (!isSearchUrl(url)) return Promise.resolve(makeEnvelope([], false, 0))
      searchCall += 1
      if (searchCall === 1) return first.promise
      if (searchCall === 2) return continuation.promise
      return refreshed.promise
    })
    const harness = await mountServerMembers()

    await act(async () => {
      harness.resultRef.current!.searchMembers("ad")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    first.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("a")], hasMore: true, cursor: "next", limit: 50 })
    await flushEffects()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(searchCall).toBe(1)
    await act(async () => harness.resultRef.current!.loadMore())
    expect(searchCall).toBe(2)
    continuation.reject(new Error("current failure"))
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("a")],
      searchStatus: "error",
    })
    expect(toastApiErrorMock).toHaveBeenCalledOnce()
    expect(toastApiErrorMock).toHaveBeenCalledWith(expect.any(Error), "Search failed", expect.any(Function))

    await act(async () => {
      harness.resultRef.current!.refresh()
    })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("a")],
      searchStatus: "loading",
      searchQuery: "ad",
    })
    refreshed.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("refreshed")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("refreshed")],
      searchStatus: "ready",
    })

    await act(async () => {
      harness.resultRef.current!.searchMembers("")
      harness.resultRef.current!.refresh()
    })
    expect(searchCall).toBe(3)
    expect(harness.resultRef.current).toMatchObject({ isSearching: false, searchStatus: "idle" })

    await act(async () => harness.renderer.unmount())
    harness.queryClient.clear()
  })

  it("clears pending searches and cancels the debounce on unmount", async () => {
    vi.useFakeTimers()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (isSearchUrl(url)) return Promise.resolve({ viewerId: "viewer", serverId: "srv_1", members: [], hasMore: false, limit: 50 })
      return Promise.resolve(makeEnvelope([], false, 0))
    })
    const harness = await mountServerMembers()

    await act(async () => {
      harness.resultRef.current!.searchMembers("cancelled")
      harness.resultRef.current!.searchMembers("")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    expect(apiFetchMock.mock.calls.some(([url]) => isSearchUrl(url))).toBe(false)
    expect(harness.resultRef.current).toMatchObject({ isSearching: false, searchStatus: "idle" })

    await act(async () => {
      harness.resultRef.current!.searchMembers("unmounted")
    })
    await act(async () => harness.renderer.unmount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    expect(apiFetchMock.mock.calls.some(([url]) => isSearchUrl(url))).toBe(false)
    harness.queryClient.clear()
  })

  it("drops the previous server overlay and ignores its late response", async () => {
    vi.useFakeTimers()
    const oldResponse = deferred<ReturnType<typeof makeSearchEnvelope>>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (isSearchUrl(url)) return oldResponse.promise
      return Promise.resolve({ ...makeEnvelope([], false, 0), serverId: new URL(String(url), "https://alook.local").pathname.split("/")[4] })
    })
    const harness = await mountServerMembers()

    await act(async () => {
      harness.resultRef.current!.searchMembers("old")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    await act(async () => {
      harness.renderer.rerender(
        createElement(
          QueryClientProvider,
          { client: harness.queryClient },
          createElement(HookProbe, { serverId: "srv_2", resultRef: harness.resultRef }),
        ),
      )
      await Promise.resolve()
    })
    expect(harness.resultRef.current).toMatchObject({
      isSearching: false,
      searchQuery: "",
      searchStatus: "idle",
    })

    oldResponse.resolve({ viewerId: "viewer", serverId: "srv_1", members: [m("old")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      isSearching: false,
      searchQuery: "",
      searchStatus: "idle",
      members: [],
    })
    expect(toastApiErrorMock).not.toHaveBeenCalled()

    await act(async () => harness.renderer.unmount())
    harness.queryClient.clear()
  })
})

it.each(["missing-later-core", "wrong-server", "wrong-viewer", "duplicate-user"])("rejects an entire warm member page %s before any canonical write", async defect => {
  const { communityRegistrySnapshot } = await import("@/test/community-registry-snapshot")
  const { client, registry } = await createCommunityQueryOwner()
  const fn = membersPageQueryFn("srv_1")
  const first = { ...m("first"), statusEmoji: null, statusText: "" }
  const second = { ...m("second"), statusEmoji: null, statusText: "" }
  const envelope = { viewerId: "viewer", serverId: "srv_1", members: [first, second], hasMore: false, limit: 50, total: 2 }
  apiFetchMock.mockResolvedValueOnce(envelope)
  await fn({ pageParam: null, client })
  const before = communityRegistrySnapshot(registry)
  const malformed = structuredClone(envelope)
  malformed.members[0]!.name = "Must not publish first"
  malformed.members[1]!.name = "Must not publish later"
  if (defect === "missing-later-core") delete (malformed.members[1] as Partial<typeof second>).avatarVersion
  if (defect === "wrong-server") malformed.serverId = "foreign-server"
  if (defect === "wrong-viewer") malformed.viewerId = "foreign-viewer"
  if (defect === "duplicate-user") malformed.members[1]!.userId = first.userId
  apiFetchMock.mockResolvedValueOnce(malformed)
  await expect(fn({ pageParam: null, client })).rejects.toThrow()
  expect(communityRegistrySnapshot(registry)).toEqual(before)
})

import { createElement, useEffect, type MutableRefObject } from "react"
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer"
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest"
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query"

const apiFetchMock = vi.fn()
const toastApiErrorMock = vi.fn()
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
const previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  toastApiError: (...args: unknown[]) => toastApiErrorMock(...args),
}))

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  apiFetchMock.mockReset()
  toastApiErrorMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment
})

import {
  applyJoinEvent,
  applyLeaveEvent,
  applyUpdateEvent,
  patchCacheJoin,
  patchCacheLeave,
  patchCacheUpdate,
  patchCacheKick,
  patchCacheRole,
  membersPageQueryFn,
  SEARCH_DEBOUNCE_MS,
  dispatchMemberOverlayEvent,
  subscribeMemberOverlayEvents,
  mergeMemberSearchPage,
  useServerMembers,
  type MembersEnvelope,
  type MemberOverlayEvent,
} from "./use-server-members"
import { communityKeys } from "@/lib/query-keys"
import type { Member } from "@/lib/community/models/people"
import type {
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
} from "@alook/shared"

// This suite exercises the pure WS-event reducers pulled out of the hook.
// The React harness for the hook itself isn't available in the repo (no
// jsdom / testing-library setup); the reducers hold every non-side-effect
// piece of the plan's insertion strategy, so testing them here pins the
// behaviour the plan calls for in one place.

function m(id: string, userId = id, role: Member["role"] = "member"): Member {
  return { id, userId, name: `n_${id}`, discriminator: "0000", avatar: `A`, status: "offline", sub: "", role }
}

function joinEvent(userId: string, id = userId): CommunityMemberJoin {
  return {
    type: "community:member.join",
    serverId: "srv_1",
    member: { id, userId, name: `n_${userId}`, discriminator: "0000", role: "member", joinedAt: "2026-07-03T00:00:00.000Z" },
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
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  })
  const resultRef = { current: null } as MutableRefObject<ServerMembersResult | null>
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(HookProbe, { serverId, resultRef }),
      ),
    )
    await Promise.resolve()
  })
  return { queryClient, renderer, resultRef }
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

describe("SEARCH_DEBOUNCE_MS", () => {
  it("is 200ms (matches plan)", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(200)
  })
})

describe("mergeMemberSearchPage", () => {
  it("appends serial search pages and drops duplicate boundary rows", () => {
    const first = [m("a"), m("b")]
    const merged = mergeMemberSearchPage(first, [m("b"), m("c")])
    expect(merged.map((member) => member.id)).toEqual(["a", "b", "c"])
  })

  it("preserves the accumulated reference when a page adds nothing", () => {
    const first = [m("a"), m("b")]
    expect(mergeMemberSearchPage(first, [m("a")])).toBe(first)
  })
})

describe("applyJoinEvent", () => {
  it("appends at tail when hasMore=false", () => {
    const prev = [m("a"), m("b")]
    const next = applyJoinEvent(prev, joinEvent("c"), false)
    expect(next.map((x) => x.id)).toEqual(["a", "b", "c"])
    // Order is preserved — joiner sorts after every existing row because its
    // server-assigned joinedAt is the largest.
  })

  it("is a no-op when hasMore=true (drops the event; user will see the joiner on scroll)", () => {
    const prev = [m("a"), m("b")]
    const next = applyJoinEvent(prev, joinEvent("c"), true)
    expect(next).toBe(prev)
  })

  it("dedupes by userId (guards against a stale WS retry)", () => {
    const prev = [m("a"), m("b")]
    const next = applyJoinEvent(prev, joinEvent("a"), false)
    expect(next).toBe(prev)
  })

  it("carries the discriminator from the event onto the produced Member", () => {
    const prev = [m("a")]
    const event: CommunityMemberJoin = {
      ...joinEvent("c"),
      member: { ...joinEvent("c").member, discriminator: "0042" },
    }
    const next = applyJoinEvent(prev, event, false)
    expect(next.find((x) => x.id === "c")?.discriminator).toBe("0042")
  })
})

describe("applyLeaveEvent", () => {
  it("filters by userId without any refetch", () => {
    const prev = [m("a"), m("b"), m("c")]
    const leaveEvent: CommunityMemberLeave = { type: "community:member.leave", serverId: "srv_1", userId: "b" }
    const next = applyLeaveEvent(prev, leaveEvent)
    expect(next.map((x) => x.id)).toEqual(["a", "c"])
  })

  it("returns a same-length array when the userId is unknown", () => {
    const prev = [m("a"), m("b")]
    const leaveEvent: CommunityMemberLeave = { type: "community:member.leave", serverId: "srv_1", userId: "z" }
    const next = applyLeaveEvent(prev, leaveEvent)
    expect(next).toHaveLength(prev.length)
  })
})

describe("applyUpdateEvent", () => {
  it("patches role in place without a refetch", () => {
    const prev = [m("a", "u_a", "member"), m("b", "u_b", "member")]
    const upd: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "a",
      changes: { role: "admin" },
    }
    const next = applyUpdateEvent(prev, upd)
    expect(next[0].role).toBe("admin")
    expect(next[1].role).toBe("member")
  })

  it("patches nickname (falls back to old name when null)", () => {
    const prev = [{ ...m("a"), name: "Alice" }]
    const upd: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "a",
      changes: { nickname: "Alicia" },
    }
    const next = applyUpdateEvent(prev, upd)
    expect(next[0].name).toBe("Alicia")

    const clearNickname: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "a",
      changes: { nickname: null },
    }
    const restored = applyUpdateEvent(next, clearNickname)
    // nickname === null keeps the previous display name (which is now "Alicia")
    expect(restored[0].name).toBe("Alicia")
  })

  it("no-ops when memberId is unknown", () => {
    const prev = [m("a")]
    const upd: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "zzz",
      changes: { role: "admin" },
    }
    const next = applyUpdateEvent(prev, upd)
    expect(next).toHaveLength(1)
    expect(next[0].role).toBe("member")
  })
})

// ── Infinite-query cache patch helpers ──────────────────────────────────────

function makeCache(pages: MembersEnvelope[]): InfiniteData<MembersEnvelope> {
  return { pages, pageParams: pages.map((_, i) => (i === 0 ? null : `cur_${i}`)) }
}

function makeEnvelope(members: Member[], hasMore: boolean, total = members.length): MembersEnvelope {
  return { members, hasMore, limit: 50, total, ...(hasMore ? { cursor: "cur_next" } : {}) }
}

describe("patchCacheJoin", () => {
  it("appends to the last page when the last page has hasMore=false", () => {
    const cache = makeCache([makeEnvelope([m("a"), m("b")], false, 2)])
    const next = patchCacheJoin(cache, joinEvent("c"))
    expect(next).not.toBe(cache)
    expect(next!.pages[0].members.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(next!.pages[0].total).toBe(3)
  })

  it("bumps total even when hasMore=true (joiner lives on an unloaded page)", () => {
    // The joiner belongs on a page we haven't fetched, but the server-wide
    // total must still tick up so the header count stays accurate.
    const cache = makeCache([makeEnvelope([m("a")], true, 3)])
    const next = patchCacheJoin(cache, joinEvent("z"))
    expect(next).not.toBe(cache)
    expect(next!.pages[0].members.map((x) => x.id)).toEqual(["a"])
    expect(next!.pages[0].total).toBe(4)
  })

  it("dedupes across all cached pages (repeated event is a no-op)", () => {
    const cache = makeCache([
      makeEnvelope([m("a", "u_a")], false, 2),
      makeEnvelope([m("b", "u_b")], false, 2),
    ])
    // userId u_a already exists on an earlier page — treat as re-delivery
    // and skip the total bump entirely.
    const next = patchCacheJoin(cache, joinEvent("u_a"))
    expect(next).toBe(cache)
  })
})

describe("patchCacheLeave", () => {
  it("removes the user and normalizes total across every page (fixes non-last-page staleness)", () => {
    const cache = makeCache([
      makeEnvelope([m("a", "u_a"), m("b", "u_b")], true, 3),
      makeEnvelope([m("c", "u_c")], false, 3),
    ])
    const ev: CommunityMemberLeave = { type: "community:member.leave", serverId: "srv_1", userId: "u_b" }
    const next = patchCacheLeave(cache, ev)
    expect(next).not.toBe(cache)
    expect(next!.pages[0].members.map((x) => x.id)).toEqual(["a"])
    // total is server-wide, not per-page — every page's copy must decrement so
    // the derived `total` matches regardless of which page the reader inspects.
    expect(next!.pages[0].total).toBe(2)
    expect(next!.pages[1].total).toBe(2)
  })

  it("decrements total even when the leaver lives on an unloaded page", () => {
    // The leaver's userId is not present on any cached page (they live on an
    // unfetched page). The paged members stay untouched but the server-wide
    // total must still tick down.
    const cache = makeCache([makeEnvelope([m("a", "u_a")], true, 5)])
    const ev: CommunityMemberLeave = { type: "community:member.leave", serverId: "srv_1", userId: "u_ghost" }
    const next = patchCacheLeave(cache, ev)
    expect(next).not.toBe(cache)
    expect(next!.pages[0].members.map((x) => x.id)).toEqual(["a"])
    expect(next!.pages[0].total).toBe(4)
  })
})

describe("patchCacheUpdate", () => {
  it("patches role in place across pages", () => {
    const cache = makeCache([
      makeEnvelope([m("a", "u_a", "member")], true),
      makeEnvelope([m("b", "u_b", "member")], false),
    ])
    const ev: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "b",
      changes: { role: "admin" },
    }
    const next = patchCacheUpdate(cache, ev)!
    expect(next.pages[0].members[0].role).toBe("member")
    expect(next.pages[1].members[0].role).toBe("admin")
  })
})

describe("patchCacheKick", () => {
  it("removes the member and decrements total on any page it lives on", () => {
    const cache = makeCache([makeEnvelope([m("a"), m("b")], false, 2)])
    const next = patchCacheKick(cache, "a")!
    expect(next.pages[0].members.map((x) => x.id)).toEqual(["b"])
    expect(next.pages[0].total).toBe(1)
  })

  it("decrements total even when the memberId lives on an unloaded page", () => {
    // The kicked member is not on any cached page, but the server-wide total
    // must still tick down because the kick actually removed them.
    const cache = makeCache([makeEnvelope([m("a")], true, 5)])
    const next = patchCacheKick(cache, "mem_ghost")!
    expect(next.pages[0].members.map((x) => x.id)).toEqual(["a"])
    expect(next.pages[0].total).toBe(4)
  })
})

describe("patchCacheRole", () => {
  it("updates the role field only on the matching row", () => {
    const cache = makeCache([makeEnvelope([m("a"), m("b")], false)])
    const next = patchCacheRole(cache, "a", "admin")!
    expect(next.pages[0].members[0].role).toBe("admin")
    expect(next.pages[0].members[1].role).toBe("member")
  })
})

describe("membersPageQueryFn", () => {
  it("hits /members with no query string on page 1 and appends cursor on later pages", async () => {
    apiFetchMock.mockResolvedValueOnce({ members: [], hasMore: false, limit: 50, total: 0 })
    const fn = membersPageQueryFn("srv_1")
    await fn({ pageParam: null })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/servers/srv_1/members")

    apiFetchMock.mockResolvedValueOnce({ members: [], hasMore: false, limit: 50, total: 0 })
    await fn({ pageParam: "cur_1|abc" })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/servers/srv_1/members?cursor=cur_1%7Cabc",
    )
  })

  it("populates queryClient at communityKeys.members(serverId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ members: [], hasMore: false, limit: 50, total: 0 })
    const qc = new QueryClient()
    const key = communityKeys.members("srv_1")
    await qc.fetchInfiniteQuery({
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
      .mockResolvedValueOnce({ members: [m("a")], hasMore: true, cursor: "cur_1|a", limit: 50, total: 2 })
      .mockResolvedValueOnce({ members: [m("b")], hasMore: false, limit: 50, total: 2 })
    const qc = new QueryClient()
    const key = communityKeys.members("srv_1")
    await qc.fetchInfiniteQuery({
      queryKey: key,
      queryFn: membersPageQueryFn("srv_1"),
      initialPageParam: null as string | null,
      getNextPageParam: (last: MembersEnvelope) =>
        last.hasMore ? (last.cursor ?? null) : undefined,
      pages: 2,
    })
    const data = qc.getQueryData<InfiniteData<MembersEnvelope>>(key)
    expect(data?.pages).toHaveLength(2)
    expect(data?.pages[0].members.map((x) => x.id)).toEqual(["a"])
    expect(data?.pages[1].members.map((x) => x.id)).toEqual(["b"])
  })
})

describe("member overlay bus", () => {
  it("delivers dispatched events to subscribers, and unsubscribe stops delivery", () => {
    const received: MemberOverlayEvent[] = []
    const unsub = subscribeMemberOverlayEvents((ev) => received.push(ev))
    dispatchMemberOverlayEvent({ type: "kick", serverId: "srv_1", memberId: "mem_1" })
    dispatchMemberOverlayEvent({ type: "role", serverId: "srv_1", memberId: "mem_1", role: "admin" })
    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ type: "kick", serverId: "srv_1", memberId: "mem_1" })
    expect(received[1]).toEqual({ type: "role", serverId: "srv_1", memberId: "mem_1", role: "admin" })
    unsub()
    dispatchMemberOverlayEvent({ type: "kick", serverId: "srv_1", memberId: "mem_2" })
    expect(received).toHaveLength(2)
  })

  it("mirror-patch shape: a kick overlay event filters the memberId out of a search list", () => {
    // Mirrors the reducer logic the hook uses inside its bus subscription:
    // when a kick event fires, the local search overlay must drop the row.
    const searchResults: Member[] = [m("mem_1"), m("mem_2"), m("mem_3")]
    let overlay: Member[] | null = searchResults
    const unsub = subscribeMemberOverlayEvents((ev) => {
      if (overlay === null) return
      if (ev.type === "kick") {
        overlay = overlay.filter((x) => x.id !== ev.memberId)
      }
    })
    dispatchMemberOverlayEvent({ type: "kick", serverId: "srv_1", memberId: "mem_2" })
    expect(overlay?.map((x) => x.id)).toEqual(["mem_1", "mem_3"])
    unsub()
  })
})

describe("useServerMembers search lifecycle", () => {
  it("debounces the first page, serially appends continuation pages, and ignores duplicate search calls", async () => {
    vi.useFakeTimers()
    const first = deferred<{ members: Member[]; hasMore: boolean; cursor?: string; limit: number }>()
    const second = deferred<{ members: Member[]; hasMore: boolean; cursor?: string; limit: number }>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (!isSearchUrl(url)) return Promise.resolve(makeEnvelope([], false, 0))
      if (url.includes("q=none")) {
        return Promise.resolve({ members: [], hasMore: false, limit: 50 })
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
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toEqual([
      ["/api/community/servers/srv_1/members/search?q=ad"],
    ])

    first.resolve({ members: [m("a"), m("b")], hasMore: true, cursor: "cur_2", limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("a"), m("b")],
      searchStatus: "loading-more",
    })
    expect(apiFetchMock.mock.calls.filter(([url]) => isSearchUrl(url))).toEqual([
      ["/api/community/servers/srv_1/members/search?q=ad"],
      ["/api/community/servers/srv_1/members/search?q=ad&cursor=cur_2"],
    ])

    second.resolve({ members: [m("b"), m("c")], hasMore: false, limit: 50 })
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
    const requests = new Map<string, Deferred<{ members: Member[]; hasMore: boolean; limit: number }>>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (!isSearchUrl(url)) return Promise.resolve(makeEnvelope([], false, 0))
      const query = new URL(url, "https://alook.local").searchParams.get("q")!
      const request = deferred<{ members: Member[]; hasMore: boolean; limit: number }>()
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
    requests.get("old-success")!.resolve({ members: [m("old")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      searchQuery: "new-success",
      searchStatus: "loading",
      members: [],
    })
    requests.get("new-success")!.resolve({ members: [m("new")], hasMore: false, limit: 50 })
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
    requests.get("final")!.resolve({ members: [m("final")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      searchQuery: "final",
      searchStatus: "ready",
      members: [m("final")],
    })

    await act(async () => harness.renderer.unmount())
    harness.queryClient.clear()
  })

  it("retains accumulated members on a current continuation error and refreshes the active query", async () => {
    vi.useFakeTimers()
    const first = deferred<{ members: Member[]; hasMore: boolean; cursor?: string; limit: number }>()
    const continuation = deferred<{ members: Member[]; hasMore: boolean; limit: number }>()
    const refreshed = deferred<{ members: Member[]; hasMore: boolean; limit: number }>()
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
    first.resolve({ members: [m("a")], hasMore: true, cursor: "next", limit: 50 })
    await flushEffects()
    continuation.reject(new Error("current failure"))
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("a")],
      searchStatus: "error",
    })
    expect(toastApiErrorMock).toHaveBeenCalledOnce()
    expect(toastApiErrorMock).toHaveBeenCalledWith(expect.any(Error), "Search failed")

    await act(async () => {
      dispatchMemberOverlayEvent({ type: "refresh", serverId: "srv_1" })
    })
    expect(harness.resultRef.current).toMatchObject({
      members: [],
      searchStatus: "loading",
      searchQuery: "ad",
    })
    refreshed.resolve({ members: [m("refreshed")], hasMore: false, limit: 50 })
    await flushEffects()
    expect(harness.resultRef.current).toMatchObject({
      members: [m("refreshed")],
      searchStatus: "ready",
    })

    await act(async () => {
      harness.resultRef.current!.searchMembers("")
      dispatchMemberOverlayEvent({ type: "refresh", serverId: "srv_1" })
    })
    expect(searchCall).toBe(3)
    expect(harness.resultRef.current).toMatchObject({ isSearching: false, searchStatus: "idle" })

    await act(async () => harness.renderer.unmount())
    harness.queryClient.clear()
  })

  it("clears pending searches and cancels the debounce on unmount", async () => {
    vi.useFakeTimers()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (isSearchUrl(url)) return Promise.resolve({ members: [], hasMore: false, limit: 50 })
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
    const oldResponse = deferred<{ members: Member[]; hasMore: boolean; limit: number }>()
    apiFetchMock.mockImplementation((url: unknown) => {
      if (isSearchUrl(url)) return oldResponse.promise
      return Promise.resolve(makeEnvelope([], false, 0))
    })
    const harness = await mountServerMembers()

    await act(async () => {
      harness.resultRef.current!.searchMembers("old")
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    await act(async () => {
      harness.renderer.update(
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

    oldResponse.resolve({ members: [m("old")], hasMore: false, limit: 50 })
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

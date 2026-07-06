import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, type InfiniteData } from "@tanstack/react-query"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
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
  type MembersEnvelope,
  type MemberOverlayEvent,
} from "./use-server-members"
import { communityKeys } from "@/lib/query-keys"
import type { Member } from "@/components/community/_types"
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
  return { id, userId, name: `n_${id}`, avatar: `A`, status: "offline", sub: "", role }
}

function joinEvent(userId: string, id = userId): CommunityMemberJoin {
  return {
    type: "community:member.join",
    serverId: "srv_1",
    member: { id, userId, name: `n_${userId}`, role: "member", joinedAt: "2026-07-03T00:00:00.000Z" },
  }
}

describe("SEARCH_DEBOUNCE_MS", () => {
  it("is 200ms (matches plan)", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(200)
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
    dispatchMemberOverlayEvent({ type: "kick", memberId: "mem_1" })
    dispatchMemberOverlayEvent({ type: "role", memberId: "mem_1", role: "admin" })
    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ type: "kick", memberId: "mem_1" })
    expect(received[1]).toEqual({ type: "role", memberId: "mem_1", role: "admin" })
    unsub()
    dispatchMemberOverlayEvent({ type: "kick", memberId: "mem_2" })
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
    dispatchMemberOverlayEvent({ type: "kick", memberId: "mem_2" })
    expect(overlay?.map((x) => x.id)).toEqual(["mem_1", "mem_3"])
    unsub()
  })
})

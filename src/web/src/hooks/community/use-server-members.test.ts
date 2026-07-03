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
  type MembersEnvelope,
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

  it("returns the same reference when the last page still has more pages behind it", () => {
    const cache = makeCache([makeEnvelope([m("a")], true, 3)])
    const next = patchCacheJoin(cache, joinEvent("z"))
    expect(next).toBe(cache)
  })

  it("dedupes across all cached pages", () => {
    const cache = makeCache([
      makeEnvelope([m("a", "u_a")], false, 2),
      makeEnvelope([m("b", "u_b")], false, 2),
    ])
    // The last page has hasMore=false — normally we'd append, but userId u_a
    // already exists on an earlier page, so the helper bails out.
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

  it("returns the same reference when nothing changes", () => {
    const cache = makeCache([makeEnvelope([m("a")], false)])
    const ev: CommunityMemberLeave = { type: "community:member.leave", serverId: "srv_1", userId: "u_none" }
    const next = patchCacheLeave(cache, ev)
    expect(next).toBe(cache)
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

  it("no-op when the memberId is unknown", () => {
    const cache = makeCache([makeEnvelope([m("a")], false)])
    const next = patchCacheKick(cache, "zzz")
    expect(next).toBe(cache)
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

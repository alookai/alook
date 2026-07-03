import { describe, it, expect } from "vitest"
import {
  applyJoinEvent,
  applyLeaveEvent,
  applyUpdateEvent,
  SEARCH_DEBOUNCE_MS,
} from "./use-server-members"
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

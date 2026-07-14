import { beforeEach, describe, expect, it } from "vitest"
import {
  BOT_AUDIT_RING_MAX,
  SEEN_MESSAGE_MAX,
  SEEN_MESSAGE_TRIM_TO,
  useCommunityWsStore,
} from "./ws"

beforeEach(() => {
  useCommunityWsStore.getState().reset()
})

describe("useCommunityWsStore", () => {
  it("starts with empty presence + seen sets", () => {
    const s = useCommunityWsStore.getState()
    expect(s.onlineUserIds.size).toBe(0)
    expect(s.seenMessageIds.size).toBe(0)
  })

  it("setPresence adds and removes user ids", () => {
    useCommunityWsStore.getState().setPresence("u1", true)
    useCommunityWsStore.getState().setPresence("u2", true)
    expect(useCommunityWsStore.getState().onlineUserIds.has("u1")).toBe(true)
    expect(useCommunityWsStore.getState().onlineUserIds.has("u2")).toBe(true)

    useCommunityWsStore.getState().setPresence("u1", false)
    expect(useCommunityWsStore.getState().onlineUserIds.has("u1")).toBe(false)
    // Removing an offline user is a no-op — no throw.
    useCommunityWsStore.getState().setPresence("u3", false)
    expect(useCommunityWsStore.getState().onlineUserIds.has("u3")).toBe(false)
  })

  it("setPresence swaps the Set reference so React selectors re-run", () => {
    const before = useCommunityWsStore.getState().onlineUserIds
    useCommunityWsStore.getState().setPresence("u1", true)
    const after = useCommunityWsStore.getState().onlineUserIds
    expect(after).not.toBe(before)
  })

  it("resetPresence empties online set without touching seen ids", () => {
    useCommunityWsStore.getState().setPresence("u1", true)
    useCommunityWsStore.getState().markSeenMessage("m1")

    useCommunityWsStore.getState().resetPresence()
    expect(useCommunityWsStore.getState().onlineUserIds.size).toBe(0)
    expect(useCommunityWsStore.getState().seenMessageIds.has("m1")).toBe(true)
  })

  it("resetPresence is a no-op (no reference swap) when already empty", () => {
    const before = useCommunityWsStore.getState().onlineUserIds
    useCommunityWsStore.getState().resetPresence()
    expect(useCommunityWsStore.getState().onlineUserIds).toBe(before)
  })

  it("hydratePresence replaces the set atomically", () => {
    useCommunityWsStore.getState().setPresence("u_stale", true)
    useCommunityWsStore.getState().hydratePresence(["u1", "u2", "u3"])
    const online = useCommunityWsStore.getState().onlineUserIds
    expect(online.has("u_stale")).toBe(false)
    expect(online.has("u1")).toBe(true)
    expect(online.has("u2")).toBe(true)
    expect(online.has("u3")).toBe(true)
    expect(online.size).toBe(3)
  })

  it("hydratePresence bails when the incoming set matches current", () => {
    useCommunityWsStore.getState().hydratePresence(["u1", "u2"])
    const before = useCommunityWsStore.getState().onlineUserIds
    // Identical-content, different-reference input MUST NOT swap the Set —
    // that's the load-bearing invariant that prevents the render loop.
    useCommunityWsStore.getState().hydratePresence(["u1", "u2"])
    expect(useCommunityWsStore.getState().onlineUserIds).toBe(before)
  })

  it("markSeenMessage deduplicates", () => {
    useCommunityWsStore.getState().markSeenMessage("m1")
    const first = useCommunityWsStore.getState().seenMessageIds
    useCommunityWsStore.getState().markSeenMessage("m1")
    const second = useCommunityWsStore.getState().seenMessageIds

    // Duplicate mark is a no-op — same Set reference, size still 1.
    expect(second.size).toBe(1)
    expect(second).toBe(first)
    expect(useCommunityWsStore.getState().hasSeenMessage("m1")).toBe(true)
    expect(useCommunityWsStore.getState().hasSeenMessage("m2")).toBe(false)
  })

  it("marks distinct messages independently", () => {
    useCommunityWsStore.getState().markSeenMessage("m1")
    useCommunityWsStore.getState().markSeenMessage("m2")
    expect(useCommunityWsStore.getState().seenMessageIds.size).toBe(2)
  })

  it("trims to the sliding-window size once the max is exceeded", () => {
    // Fill up to the boundary so the next insert crosses it.
    for (let i = 0; i < SEEN_MESSAGE_MAX; i++) {
      useCommunityWsStore.getState().markSeenMessage(`m${i}`)
    }
    expect(useCommunityWsStore.getState().seenMessageIds.size).toBe(
      SEEN_MESSAGE_MAX,
    )

    // One more triggers the trim.
    useCommunityWsStore.getState().markSeenMessage(`m${SEEN_MESSAGE_MAX}`)

    const after = useCommunityWsStore.getState().seenMessageIds
    expect(after.size).toBe(SEEN_MESSAGE_TRIM_TO)

    // The newest id must survive; the oldest must be evicted.
    expect(after.has(`m${SEEN_MESSAGE_MAX}`)).toBe(true)
    expect(after.has("m0")).toBe(false)
  })

  it("reset clears both online and seen sets", () => {
    useCommunityWsStore.getState().setPresence("u1", true)
    useCommunityWsStore.getState().markSeenMessage("m1")

    useCommunityWsStore.getState().reset()

    expect(useCommunityWsStore.getState().onlineUserIds.size).toBe(0)
    expect(useCommunityWsStore.getState().seenMessageIds.size).toBe(0)
  })

  it("starts with an empty userStatuses map", () => {
    expect(useCommunityWsStore.getState().userStatuses.size).toBe(0)
  })

  it("setUserStatus stores per-user and overwrites on repeat calls", () => {
    useCommunityWsStore.getState().setUserStatus("u1", "🎧", "Vibing")
    expect(useCommunityWsStore.getState().userStatuses.get("u1")).toEqual({
      emoji: "🎧",
      text: "Vibing",
    })

    useCommunityWsStore.getState().setUserStatus("u1", null, null)
    expect(useCommunityWsStore.getState().userStatuses.get("u1")).toEqual({
      emoji: null,
      text: null,
    })
  })

  it("setUserStatus swaps the Map reference so React selectors re-run", () => {
    const before = useCommunityWsStore.getState().userStatuses
    useCommunityWsStore.getState().setUserStatus("u1", "🎧", "Vibing")
    const after = useCommunityWsStore.getState().userStatuses
    expect(after).not.toBe(before)
  })

  it("resetUserStatuses clears the map without touching presence/seen state", () => {
    useCommunityWsStore.getState().setUserStatus("u1", "🎧", "Vibing")
    useCommunityWsStore.getState().setPresence("u2", true)
    useCommunityWsStore.getState().markSeenMessage("m1")

    useCommunityWsStore.getState().resetUserStatuses()

    expect(useCommunityWsStore.getState().userStatuses.size).toBe(0)
    expect(useCommunityWsStore.getState().onlineUserIds.has("u2")).toBe(true)
    expect(useCommunityWsStore.getState().seenMessageIds.has("m1")).toBe(true)
  })

  it("resetUserStatuses is a no-op (no reference swap) when already empty", () => {
    const before = useCommunityWsStore.getState().userStatuses
    useCommunityWsStore.getState().resetUserStatuses()
    expect(useCommunityWsStore.getState().userStatuses).toBe(before)
  })

  it("reset also clears userStatuses", () => {
    useCommunityWsStore.getState().setUserStatus("u1", "🎧", "Vibing")
    useCommunityWsStore.getState().reset()
    expect(useCommunityWsStore.getState().userStatuses.size).toBe(0)
  })

  it("pushBotAuditEvent prepends newest-first, dedups on id, and bounds each per-bot ring", () => {
    const push = useCommunityWsStore.getState().pushBotAuditEvent
    push({
      id: "e1",
      botId: "b1",
      kind: "tool_call",
      payload: { name: "Read" },
      createdAt: "2025-01-01T00:00:00.000Z",
    })
    push({
      id: "e2",
      botId: "b1",
      kind: "cli_invocation",
      payload: { subcommand: "send" },
      createdAt: "2025-01-01T00:00:01.000Z",
    })
    const events = useCommunityWsStore.getState().botAuditEvents.get("b1") ?? []
    expect(events[0]!.id).toBe("e2")
    expect(events[1]!.id).toBe("e1")

    // Dedup on id — a second push of e2 must not duplicate.
    push({
      id: "e2",
      botId: "b1",
      kind: "cli_invocation",
      payload: { subcommand: "send" },
      createdAt: "2025-01-01T00:00:01.000Z",
    })
    expect((useCommunityWsStore.getState().botAuditEvents.get("b1") ?? []).length).toBe(2)
  })

  it("bounds each bot's ring independently — a chatty bot doesn't evict a quiet bot's events", () => {
    const push = useCommunityWsStore.getState().pushBotAuditEvent
    // Chatty bot A: overflow the ring.
    for (let i = 0; i < BOT_AUDIT_RING_MAX + 5; i++) {
      push({
        id: `a${i}`,
        botId: "bot_a",
        kind: "tool_call",
        payload: { name: "Read" },
        createdAt: `2025-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      })
    }
    // Quiet bot B: one event, way earlier in wall-clock, must survive.
    push({
      id: "b1",
      botId: "bot_b",
      kind: "cli_invocation",
      payload: { subcommand: "send" },
      createdAt: "2020-01-01T00:00:00.000Z",
    })
    const aRing = useCommunityWsStore.getState().botAuditEvents.get("bot_a") ?? []
    const bRing = useCommunityWsStore.getState().botAuditEvents.get("bot_b") ?? []
    expect(aRing.length).toBe(BOT_AUDIT_RING_MAX)
    expect(aRing[0]!.id).toBe(`a${BOT_AUDIT_RING_MAX + 4}`)
    // Oldest chatty-bot events dropped.
    expect(aRing.some((e) => e.id === "a0")).toBe(false)
    // Quiet bot untouched.
    expect(bRing).toEqual([
      expect.objectContaining({ id: "b1", botId: "bot_b" }),
    ])
  })
})

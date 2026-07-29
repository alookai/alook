import { describe, it, expect, vi, beforeEach } from "vitest"

const mockResolveEffectiveLevelForUsers = vi.fn()
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    queries: {
      communityNotificationSetting: {
        resolveEffectiveLevelForUsers: (...a: unknown[]) =>
          mockResolveEffectiveLevelForUsers(...(a as [unknown, string[], string])),
      },
    },
  }
})

const mockBroadcastToUser = vi.fn(() => Promise.resolve())
vi.mock("../broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))

import { dispatchMessageNotify, shouldDeliver } from "./notify"

const db = {} as never

function bumpEvents() {
  return mockBroadcastToUser.mock.calls.map((c) => c[1]).filter((e: any) => e.type === "community:unread.bump")
}
function mentionEvents() {
  return mockBroadcastToUser.mock.calls.map((c) => c[1]).filter((e: any) => e.type === "community:mention.create")
}

describe("shouldDeliver", () => {
  it("all → always", () => {
    expect(shouldDeliver("all", false)).toBe(true)
    expect(shouldDeliver("all", true)).toBe(true)
  })
  it("mentions → only when mentioned", () => {
    expect(shouldDeliver("mentions", false)).toBe(false)
    expect(shouldDeliver("mentions", true)).toBe(true)
  })
  it("nothing → never", () => {
    expect(shouldDeliver("nothing", false)).toBe(false)
    expect(shouldDeliver("nothing", true)).toBe(false)
  })
})

describe("dispatchMessageNotify", () => {
  beforeEach(() => vi.clearAllMocks())

  const msg = { id: "m1", channelId: "c1" }
  const ctx = { authorName: "Alice" }

  it("all-level recipient: gets a badge; a mentioned all-level recipient also gets the mention push", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(
      new Map([["u_plain", "all"], ["u_mentioned", "all"]]),
    )
    await dispatchMessageNotify(db, ctx, msg, ["u_plain", "u_mentioned"], {
      mentionedUserIds: ["u_mentioned"],
    })
    expect(bumpEvents().map((e: any) => e.userId).sort()).toEqual(["u_mentioned", "u_plain"])
    expect(mentionEvents().map((e: any) => e.userId)).toEqual(["u_mentioned"])
  })

  it("mentions-level: plain recipient gets nothing; mentioned recipient gets badge + push", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(
      new Map([["u_plain", "mentions"], ["u_mentioned", "mentions"]]),
    )
    await dispatchMessageNotify(db, ctx, msg, ["u_plain", "u_mentioned"], {
      mentionedUserIds: ["u_mentioned"],
    })
    expect(bumpEvents().map((e: any) => e.userId)).toEqual(["u_mentioned"])
    expect(mentionEvents().map((e: any) => e.userId)).toEqual(["u_mentioned"])
  })

  it("@everyone counts as a mention: a mentions-level recipient in the mention set gets badge + push", async () => {
    // @everyone expands into mentionedUserIds upstream — no carve-out (Gener #28).
    mockResolveEffectiveLevelForUsers.mockResolvedValue(new Map([["u_e", "mentions"]]))
    await dispatchMessageNotify(db, ctx, msg, ["u_e"], { mentionedUserIds: ["u_e"] })
    expect(bumpEvents().map((e: any) => e.userId)).toEqual(["u_e"])
    expect(mentionEvents().map((e: any) => e.userId)).toEqual(["u_e"])
  })

  it("nothing-level recipient (even mentioned): NO badge, NO push (mention ROW is written elsewhere, not here)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(new Map([["u_muted", "nothing"]]))
    await dispatchMessageNotify(db, ctx, msg, ["u_muted"], { mentionedUserIds: ["u_muted"] })
    expect(bumpEvents()).toEqual([])
    expect(mentionEvents()).toEqual([])
    // Never emits MESSAGE_CREATE — that's the caller's unconditional fan-out.
    const anyMessageCreate = mockBroadcastToUser.mock.calls.some(
      (c: any) => c[1]?.type === "community:message.create",
    )
    expect(anyMessageCreate).toBe(false)
  })

  it("missing level defaults to 'all' (DM independence — resolver returns no row)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(new Map())
    await dispatchMessageNotify(db, ctx, msg, ["u_dm"], { mentionedUserIds: [] })
    expect(bumpEvents().map((e: any) => e.userId)).toEqual(["u_dm"])
  })

  it("absorbs a resolver failure without throwing (send must not fail on a notify blip)", async () => {
    mockResolveEffectiveLevelForUsers.mockRejectedValue(new Error("d1 blip"))
    await expect(
      dispatchMessageNotify(db, ctx, msg, ["u1"], { mentionedUserIds: [] }),
    ).resolves.toBeUndefined()
    expect(bumpEvents()).toEqual([])
  })
})

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockResolveEffectiveLevelForUsers = vi.fn()
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    queries: {
      communityNotificationSetting: {
        resolveEffectiveLevelForUsers: (...a: unknown[]) => mockResolveEffectiveLevelForUsers(...a),
      },
    },
  }
})

const mockBroadcastToUser = vi.fn()
vi.mock("../broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))

const mockEnqueueBotWakes = vi.fn()
vi.mock("./wake-producer", () => ({
  enqueueBotWakes: (...a: unknown[]) => mockEnqueueBotWakes(...a),
}))

import { dispatchMessageNotify } from "./notify"
import { WS_EVENTS } from "@alook/shared"
import type { NotificationLevelValue } from "@alook/shared"

const db = {} as never
const wakeMessageRow = { id: "m1", seq: 7, authorId: "author", channelId: "c1", dmConversationId: null }

function levels(map: Record<string, NotificationLevelValue>): Map<string, NotificationLevelValue> {
  return new Map(Object.entries(map))
}

/** Users who received a per-user event of `type`. */
function targetsOf(type: string): string[] {
  return mockBroadcastToUser.mock.calls
    .filter((c) => (c[1] as { type: string }).type === type)
    .map((c) => c[0] as string)
    .sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBroadcastToUser.mockResolvedValue(undefined)
  mockEnqueueBotWakes.mockResolvedValue(undefined)
})

describe("dispatchMessageNotify — 3-tier matrix (humans + bots, same rule)", () => {
  it("all: plain msg → badge + wake; no mention push (not mentioned)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "all" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: [],
    })

    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual(["u2"])
    expect(targetsOf(WS_EVENTS.MENTION_CREATE)).toEqual([])
    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    expect(mockEnqueueBotWakes).toHaveBeenCalledWith({
      recipients: ["u2"],
      channelId: "c1",
      messageRow: wakeMessageRow,
    })
  })

  it("all: mentioned → badge + wake + mention push", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "all" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: ["u2"],
    })

    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual(["u2"])
    expect(targetsOf(WS_EVENTS.MENTION_CREATE)).toEqual(["u2"])
    expect(mockEnqueueBotWakes).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ["u2"] }),
    )
  })

  it("mentions: plain msg → silent (no badge, no wake, no push)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "mentions" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: [],
    })

    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual([])
    expect(targetsOf(WS_EVENTS.MENTION_CREATE)).toEqual([])
    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })

  it("mentions: mentioned → badge + wake + mention push", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "mentions" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: ["u2"],
    })

    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual(["u2"])
    expect(targetsOf(WS_EVENTS.MENTION_CREATE)).toEqual(["u2"])
    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
  })

  it("nothing: plain msg → silent", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "nothing" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: [],
    })

    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual([])
    expect(targetsOf(WS_EVENTS.MENTION_CREATE)).toEqual([])
    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })

  it("nothing: mentioned → NO badge/wake/push (mention row written elsewhere, not here)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "nothing" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: ["u2"],
    })

    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual([])
    expect(targetsOf(WS_EVENTS.MENTION_CREATE)).toEqual([])
    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })
})

describe("dispatchMessageNotify — R23 per-user badge (not a shared boolean)", () => {
  it("A muted / B not, same channel → only B gets the badge signal", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ uA: "nothing", uB: "all" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["uA", "uB"], {
      mentionedUserIds: [],
    })

    // Per-user: only the non-muted recipient receives UNREAD_BUMP.
    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual(["uB"])
    // Wake likewise only carries the delivering subset.
    expect(mockEnqueueBotWakes).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ["uB"] }),
    )
  })
})

describe("dispatchMessageNotify — R1: never emits MESSAGE_CREATE", () => {
  it("emits no MESSAGE_CREATE regardless of level (content-sync stays in fanOutToChannel)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "nothing", u3: "all" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2", "u3"], {
      mentionedUserIds: ["u2"],
    })

    expect(targetsOf(WS_EVENTS.MESSAGE_CREATE)).toEqual([])
  })
})

describe("dispatchMessageNotify — DM scope (R15/O4): mute bypassed, channel legs skipped", () => {
  it("DM message (no channelId): mention push delivers for everyone, no badge, no channel wake here", async () => {
    const dmRow = { id: "m1", seq: 3, authorId: "author", channelId: null, dmConversationId: "dm1" }

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow: dmRow }, dmRow, ["u2"], {
      mentionedUserIds: ["u2"],
    })

    // No channelId ⇒ no level resolution query (mute isn't in DM scope).
    expect(mockResolveEffectiveLevelForUsers).not.toHaveBeenCalled()
    // Mention push still delivers (DM not muteable).
    expect(targetsOf(WS_EVENTS.MENTION_CREATE)).toEqual(["u2"])
    // Badge + wake are channel-scope only; DM wake stays on fanOutToDM.
    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual([])
    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })
})

describe("dispatchMessageNotify — wake filtering is additive (bots as recipients)", () => {
  it("passes only the delivering subset to enqueueBotWakes, unchanged otherwise (findWakeCandidates gates still apply downstream)", async () => {
    // bot_all delivers, bot_nothing dropped by level; enqueue still receives
    // the SAME opts shape it always did (recipients/channelId/messageRow) — the
    // producer's own bot-filter + catch-up gates run unchanged on top.
    mockResolveEffectiveLevelForUsers.mockResolvedValue(
      levels({ bot_all: "all", bot_nothing: "nothing" }),
    )

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["bot_all", "bot_nothing"], {
      mentionedUserIds: [],
    })

    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    expect(mockEnqueueBotWakes).toHaveBeenCalledWith({
      recipients: ["bot_all"],
      channelId: "c1",
      messageRow: wakeMessageRow,
    })
  })

  it("skips the wake enqueue entirely when no wakeMessageRow (system/card messages)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "all" }))

    await dispatchMessageNotify(db, { authorName: "A" }, wakeMessageRow, ["u2"], {
      mentionedUserIds: [],
    })

    // Badge still fires (a system message can still bump unread), but no wake.
    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual(["u2"])
    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })

  it("skips the wake enqueue when the delivering subset is empty", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(levels({ u2: "nothing" }))

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: [],
    })

    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })
})

describe("dispatchMessageNotify — resilience", () => {
  it("absorbs a level-resolution failure (never rejects — message already synced via MESSAGE_CREATE)", async () => {
    mockResolveEffectiveLevelForUsers.mockRejectedValue(new Error("d1 down"))

    await expect(
      dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
        mentionedUserIds: [],
      }),
    ).resolves.toBeUndefined()
  })

  it("defaults an unresolved recipient to 'all' (map miss → delivers)", async () => {
    mockResolveEffectiveLevelForUsers.mockResolvedValue(new Map())

    await dispatchMessageNotify(db, { authorName: "A", wakeMessageRow }, wakeMessageRow, ["u2"], {
      mentionedUserIds: [],
    })

    expect(targetsOf(WS_EVENTS.UNREAD_BUMP)).toEqual(["u2"])
  })
})

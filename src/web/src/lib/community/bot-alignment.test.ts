import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetLatestSeqForScope = vi.fn()
const mockGetReadState = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessage: {
        scopeKeyForTarget: (t: { channelId?: string; dmConversationId?: string }) =>
          t.channelId ? `channel:${t.channelId}` : `dm:${t.dmConversationId}`,
      },
      communityAgentInbox: {
        getLatestSeqForScope: (...a: unknown[]) => mockGetLatestSeqForScope(...a),
      },
      communityReadState: {
        getReadState: (...a: unknown[]) => mockGetReadState(...a),
      },
    },
  }
})

import { checkBotAlignment, alignmentBlockedResponse } from "./bot-alignment"

const db = {} as never

describe("checkBotAlignment", () => {
  beforeEach(() => vi.clearAllMocks())

  it("blocks when the scope is ahead of the bot's tracked lastReadSeq", async () => {
    mockGetLatestSeqForScope.mockResolvedValue(9)
    mockGetReadState.mockResolvedValue({ lastReadSeq: 5 })
    const gate = await checkBotAlignment(db, "bot_1", { channelId: "c1" }, undefined)
    expect(gate.blocked).not.toBeNull()
    const body = await gate.blocked!.json()
    expect(body).toEqual({ state: "blocked", reason: "unaligned", unreadCount: 4, latestSeq: 9 })
  })

  it("passes when the bot is caught up (latestSeq === seen)", async () => {
    mockGetLatestSeqForScope.mockResolvedValue(5)
    mockGetReadState.mockResolvedValue({ lastReadSeq: 5 })
    const gate = await checkBotAlignment(db, "bot_1", { channelId: "c1" }, undefined)
    expect(gate.blocked).toBeNull()
    expect(gate.latestSeq).toBe(5)
    expect(gate.seen).toBe(5)
  })

  it("uses the client-supplied seenUpToSeq over the tracked cursor when present", async () => {
    mockGetLatestSeqForScope.mockResolvedValue(9)
    mockGetReadState.mockResolvedValue({ lastReadSeq: 0 })
    const gate = await checkBotAlignment(db, "bot_1", { channelId: "c1" }, 9)
    expect(gate.blocked).toBeNull()
  })

  it("cannot be bypassed by omitting seenUpToSeq (falls back to lastReadSeq, then 0)", async () => {
    mockGetLatestSeqForScope.mockResolvedValue(3)
    mockGetReadState.mockResolvedValue(null)
    const gate = await checkBotAlignment(db, "bot_1", { dmConversationId: "d1" }, undefined)
    expect(gate.blocked).not.toBeNull()
    const body = await gate.blocked!.json()
    expect(body.unreadCount).toBe(3)
  })
})

describe("alignmentBlockedResponse", () => {
  it("clamps a negative unread to 0", async () => {
    const res = alignmentBlockedResponse(2, 5)
    expect(await res.json()).toEqual({ state: "blocked", reason: "unaligned", unreadCount: 0, latestSeq: 2 })
  })
})

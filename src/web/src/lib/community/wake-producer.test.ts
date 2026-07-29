import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockCtxWaitUntil = vi.fn((p: Promise<unknown>) => p)
const mockGetCloudflareContext = vi.fn(() => ({
  env: { DB: {}, WAKE_QUEUE: { __queue: true } },
  ctx: { waitUntil: mockCtxWaitUntil },
}))
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...(a as [])),
}))

const mockFindWakeCandidates = vi.fn()
const mockCanBotReadWakeScope = vi.fn()
// Default: every bot resolves to "all" (no mute) — existing tests wake as
// before. The mute-gate tests below override this.
const mockResolveEffectiveLevelForUsers = vi.fn(
  async (_db: unknown, userIds: string[]) => new Map(userIds.map((id) => [id, "all"])),
)
const mockWarn = vi.fn()
const mockInfo = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: (...a: unknown[]) => mockInfo(...a),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    queries: {
      communityBot: {
        findWakeCandidates: (...a: unknown[]) => mockFindWakeCandidates(...a),
      },
      communityMember: {
        canBotReadWakeScope: (...a: unknown[]) => mockCanBotReadWakeScope(...a),
      },
      communityNotificationSetting: {
        resolveEffectiveLevelForUsers: (...a: unknown[]) => mockResolveEffectiveLevelForUsers(...(a as [unknown, string[]])),
      },
    },
  }
})

vi.mock("../db", () => ({
  getDb: vi.fn(() => ({})),
}))

const mockQueueSend = vi.fn()
const mockDevHttpSend = vi.fn()
const mockCreateQueueWakeTransport = vi.fn(() => ({ send: mockQueueSend }))
const mockCreateDevHttpWakeTransport = vi.fn(() => ({ send: mockDevHttpSend }))
vi.mock("./wake-transport", () => ({
  createQueueWakeTransport: (...a: unknown[]) => mockCreateQueueWakeTransport(...a),
  createDevHttpWakeTransport: (...a: unknown[]) => mockCreateDevHttpWakeTransport(...a),
}))

import { enqueueBotWakes } from "./wake-producer"

const messageRow = {
  id: "msg_1",
  seq: 7,
  authorId: "human_1",
  channelId: "c1",
  dmConversationId: null,
}

describe("enqueueBotWakes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQueueSend.mockResolvedValue(undefined)
    mockDevHttpSend.mockResolvedValue(undefined)
    // Default: every candidate passes the wake gate. Tests that need to
    // exercise gate-filtering override this per case.
    mockCanBotReadWakeScope.mockResolvedValue(true)
  })

  it("no-ops when recipients is empty — never queries or picks a transport", async () => {
    await enqueueBotWakes({ recipients: [], channelId: "c1", messageRow })

    expect(mockFindWakeCandidates).not.toHaveBeenCalled()
    expect(mockCreateQueueWakeTransport).not.toHaveBeenCalled()
    expect(mockCreateDevHttpWakeTransport).not.toHaveBeenCalled()
  })

  it("no-ops when no candidates are behind — zero transport.send calls, not an empty one", async () => {
    mockFindWakeCandidates.mockResolvedValue([])

    await enqueueBotWakes({ recipients: ["bot1"], channelId: "c1", messageRow })

    expect(mockQueueSend).not.toHaveBeenCalled()
  })

  it("builds a minimal { messageId, botUserId } payload per candidate and sends a single batch via the queue transport", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" },
      { botUserId: "bot2", name: "kai", machineId: "m2", runtime: "codex" },
    ])

    await enqueueBotWakes({ recipients: ["bot1", "bot2"], channelId: "c1", messageRow })

    expect(mockFindWakeCandidates).toHaveBeenCalledWith(
      {},
      { recipients: ["bot1", "bot2"], channelId: "c1", dmConversationId: undefined, newSeq: 7 },
    )
    expect(mockCreateQueueWakeTransport).toHaveBeenCalledTimes(1)
    expect(mockCreateDevHttpWakeTransport).not.toHaveBeenCalled()
    expect(mockQueueSend).toHaveBeenCalledTimes(1)
    const [payloads] = mockQueueSend.mock.calls[0]!
    expect(payloads).toEqual([
      { messageId: "msg_1", botUserId: "bot1" },
      { messageId: "msg_1", botUserId: "bot2" },
    ])
  })

  it("drops candidates that fail the wake gate (visibility / participation) before sending", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot_visible", name: "zoe", machineId: "m1", runtime: "claude" },
      { botUserId: "bot_hidden", name: "kai", machineId: "m2", runtime: "codex" },
    ])
    mockCanBotReadWakeScope.mockImplementation(async (_db: unknown, botId: string) =>
      botId === "bot_visible",
    )

    await enqueueBotWakes({ recipients: ["bot_visible", "bot_hidden"], channelId: "c1", messageRow })

    expect(mockQueueSend).toHaveBeenCalledTimes(1)
    const [payloads] = mockQueueSend.mock.calls[0]!
    expect(payloads).toEqual([{ messageId: "msg_1", botUserId: "bot_visible" }])
  })

  // ── Mute gate (net-new #4) ──────────────────────────────────────────────
  it("MUTE GATE — a bot at 'nothing' never wakes, even when mentioned", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot_muted", name: "z", machineId: "m1", runtime: "claude" },
    ])
    mockResolveEffectiveLevelForUsers.mockResolvedValue(new Map([["bot_muted", "nothing"]]))

    await enqueueBotWakes({
      recipients: ["bot_muted"],
      channelId: "c1",
      messageRow,
      mentionedUserIds: ["bot_muted"], // even mentioned
    })

    expect(mockQueueSend).not.toHaveBeenCalled()
  })

  it("MUTE GATE — a bot at 'mentions' wakes only when in the mention set (incl. @everyone)", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot_mentioned", name: "a", machineId: "m1", runtime: "claude" },
      { botUserId: "bot_plain", name: "b", machineId: "m2", runtime: "codex" },
    ])
    mockResolveEffectiveLevelForUsers.mockResolvedValue(
      new Map([
        ["bot_mentioned", "mentions"],
        ["bot_plain", "mentions"],
      ]),
    )

    await enqueueBotWakes({
      recipients: ["bot_mentioned", "bot_plain"],
      channelId: "c1",
      messageRow,
      mentionedUserIds: ["bot_mentioned"], // only this one is in the mention set
    })

    expect(mockQueueSend).toHaveBeenCalledTimes(1)
    const [payloads] = mockQueueSend.mock.calls[0]!
    expect(payloads).toEqual([{ messageId: "msg_1", botUserId: "bot_mentioned" }])
  })

  it("MUTE GATE — a bot at 'all' wakes on any unread, mentioned or not", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot_all", name: "a", machineId: "m1", runtime: "claude" },
    ])
    mockResolveEffectiveLevelForUsers.mockResolvedValue(new Map([["bot_all", "all"]]))

    await enqueueBotWakes({
      recipients: ["bot_all"],
      channelId: "c1",
      messageRow,
      mentionedUserIds: [], // not mentioned — still wakes at 'all'
    })

    expect(mockQueueSend).toHaveBeenCalledTimes(1)
    const [payloads] = mockQueueSend.mock.calls[0]!
    expect(payloads).toEqual([{ messageId: "msg_1", botUserId: "bot_all" }])
  })

  it("MUTE GATE — a bot with no setting defaults to 'all' (wakes) — covers DM independence (no server/parent to inherit a mute from)", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot_dm", name: "a", machineId: "m1", runtime: "claude" },
    ])
    // resolver returns an empty map → levelOf falls back to "all"
    mockResolveEffectiveLevelForUsers.mockResolvedValue(new Map())

    await enqueueBotWakes({
      recipients: ["bot_dm"],
      channelId: "dm_channel",
      messageRow,
      mentionedUserIds: [],
    })

    expect(mockQueueSend).toHaveBeenCalledTimes(1)
  })

  it("drops (does NOT throw or collapse the batch) when a single candidate's gate check rejects", async () => {
    // Regression guard: a transient D1 blip on ONE candidate's gate check
    // must not wipe every wake for the message — `allSettled`, not `all`.
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot_ok_1", name: "a", machineId: "m1", runtime: "claude" },
      { botUserId: "bot_flaky", name: "b", machineId: "m2", runtime: "codex" },
      { botUserId: "bot_ok_2", name: "c", machineId: "m3", runtime: "claude" },
    ])
    mockCanBotReadWakeScope.mockImplementation(async (_db: unknown, botId: string) => {
      if (botId === "bot_flaky") throw new Error("d1 blip")
      return true
    })

    await enqueueBotWakes({
      recipients: ["bot_ok_1", "bot_flaky", "bot_ok_2"],
      channelId: "c1",
      messageRow,
    })

    expect(mockQueueSend).toHaveBeenCalledTimes(1)
    const [payloads] = mockQueueSend.mock.calls[0]!
    expect(payloads).toEqual([
      { messageId: "msg_1", botUserId: "bot_ok_1" },
      { messageId: "msg_1", botUserId: "bot_ok_2" },
    ])
  })

  it("no-ops when every candidate fails the gate — never picks a transport", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot_a", name: "a", machineId: "m1", runtime: "claude" },
      { botUserId: "bot_b", name: "b", machineId: "m2", runtime: "codex" },
    ])
    mockCanBotReadWakeScope.mockResolvedValue(false)

    await enqueueBotWakes({ recipients: ["bot_a", "bot_b"], channelId: "c1", messageRow })

    expect(mockQueueSend).not.toHaveBeenCalled()
    expect(mockCreateQueueWakeTransport).not.toHaveBeenCalled()
  })

  it("chunks into 100-candidate slices for large fanouts", async () => {
    const candidates = Array.from({ length: 250 }, (_, i) => ({
      botUserId: `bot${i}`,
      name: `bot${i}`,
      machineId: `m${i}`,
      runtime: "claude",
    }))
    mockFindWakeCandidates.mockResolvedValue(candidates)

    await enqueueBotWakes({
      recipients: candidates.map((c) => c.botUserId),
      channelId: "c1",
      messageRow,
    })

    expect(mockQueueSend).toHaveBeenCalledTimes(3)
    expect(mockQueueSend.mock.calls[0]![0]).toHaveLength(100)
    expect(mockQueueSend.mock.calls[1]![0]).toHaveLength(100)
    expect(mockQueueSend.mock.calls[2]![0]).toHaveLength(50)
  })

  it("partial chunk failure: sibling chunks still send, failure is logged, call does not throw", async () => {
    const candidates = Array.from({ length: 250 }, (_, i) => ({
      botUserId: `bot${i}`,
      name: `bot${i}`,
      machineId: `m${i}`,
      runtime: "claude",
    }))
    mockFindWakeCandidates.mockResolvedValue(candidates)
    mockQueueSend
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined)

    await expect(
      enqueueBotWakes({ recipients: candidates.map((c) => c.botUserId), channelId: "c1", messageRow }),
    ).resolves.toBeUndefined()

    expect(mockQueueSend).toHaveBeenCalledTimes(3)
    expect(mockWarn).toHaveBeenCalledWith(
      "wake_batch_chunk_failed",
      expect.objectContaining({
        botIds: candidates.slice(100, 200).map((c) => c.botUserId),
        err: expect.stringContaining("queue unavailable"),
      }),
    )
  })

  it("registers ctx.waitUntil synchronously and does not require the caller to await", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" },
    ])

    const promise = enqueueBotWakes({ recipients: ["bot1"], channelId: "c1", messageRow })
    expect(mockCtxWaitUntil).toHaveBeenCalledTimes(1)
    await promise
  })

  it("falls back to running standalone (no throw) when not in a CF request context", async () => {
    mockGetCloudflareContext.mockImplementationOnce(() => ({
      env: { DB: {}, WAKE_QUEUE: { __queue: true } },
      ctx: { waitUntil: () => { throw new Error("no request context") } },
    }))
    mockFindWakeCandidates.mockResolvedValue([])

    await expect(enqueueBotWakes({ recipients: ["bot1"], channelId: "c1", messageRow })).resolves.toBeUndefined()
  })
})

describe("enqueueBotWakes — dev HTTP transport selection (NODE_ENV=development)", () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.clearAllMocks()
    mockQueueSend.mockResolvedValue(undefined)
    mockDevHttpSend.mockResolvedValue(undefined)
    process.env.NODE_ENV = "development"
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it("picks the dev HTTP transport instead of the queue transport", async () => {
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" },
      { botUserId: "bot2", name: "kai", machineId: "m2", runtime: "codex" },
    ])

    await enqueueBotWakes({ recipients: ["bot1", "bot2"], channelId: "c1", messageRow })

    expect(mockCreateDevHttpWakeTransport).toHaveBeenCalledTimes(1)
    expect(mockCreateQueueWakeTransport).not.toHaveBeenCalled()
    expect(mockDevHttpSend).toHaveBeenCalledTimes(1)
    expect(mockQueueSend).not.toHaveBeenCalled()
    expect(mockDevHttpSend).toHaveBeenCalledWith([
      { messageId: "msg_1", botUserId: "bot1" },
      { messageId: "msg_1", botUserId: "bot2" },
    ])
  })

  it("logs and does not throw when the dev HTTP transport rejects", async () => {
    mockFindWakeCandidates.mockResolvedValue([{ botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" }])
    mockDevHttpSend.mockRejectedValue(new Error("alook-wake-worker unreachable"))

    await expect(
      enqueueBotWakes({ recipients: ["bot1"], channelId: "c1", messageRow }),
    ).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "wake_batch_chunk_failed",
      expect.objectContaining({ err: expect.stringContaining("alook-wake-worker unreachable") }),
    )
  })
})

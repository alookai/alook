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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "@alook/shared"

const mocks = vi.hoisted(() => ({ recent: vi.fn(), author: vi.fn(), pending: vi.fn(), previous: vi.fn(), decide: vi.fn(), create: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityMessage: {
    ...actual.queries.communityMessage, listRecentMessagesForDuplicateCheck: mocks.recent,
  }, user: { ...actual.queries.user, getUserSelf: mocks.author }, communityAttachment: { findPendingAttachmentsForSender: mocks.pending, listByMessageIds: mocks.previous } } }
})
vi.mock("./jev-wake-gate", async () => {
  const actual = await vi.importActual<typeof import("./jev-wake-gate")>("./jev-wake-gate")
  return { ...actual, createJevDecisionProvider: mocks.create }
})
import { isDuplicateBotMessage } from "./jev-send-dedup"

const now = new Date("2026-09-24T12:00:00Z")
const input = {
  db: {} as Database,
  env: { OPENROUTER_API_KEY: "test-key" },
  channelId: "channel", authorId: "bot", content: "The release is complete.",
}
const row = (seq: number, age = 1_000) => ({
  authorId: "other", name: `other${seq}`, discriminator: "1234", content: `Release update ${seq}.`, createdAt: new Date(now.getTime() - age).toISOString(),
})

describe("bot send duplicate judgment", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.resetAllMocks()
    mocks.recent.mockResolvedValue([row(3), row(2, 90_000), row(1, 180_000)])
    mocks.author.mockResolvedValue({ name: "helper", discriminator: "5678" })
    mocks.pending.mockResolvedValue([])
    mocks.previous.mockResolvedValue([])
    mocks.create.mockReturnValue({ name: "openrouter", decide: mocks.decide })
    mocks.decide.mockResolvedValue({ answers: { duplicate: { type: "noul", noul: 0.9 } }, model: "test" })
  })
  afterEach(() => vi.useRealTimers())

  it("compares all three messages including older context, in chronological order", async () => {
    expect(await isDuplicateBotMessage(input)).toBe(true)
    const request = mocks.decide.mock.calls[0][0]
    expect(request.state).toEqual({
      proposed_message: { handle: "helper#5678", content: input.content },
      recent_messages: [1, 2, 3].map((seq) => ({ handle: `other${seq}#1234`, content: `Release update ${seq}.` })),
    })
    expect(mocks.author).toHaveBeenCalledExactlyOnceWith(input.db, "bot")
    expect(mocks.pending).not.toHaveBeenCalled()
    expect(mocks.previous).not.toHaveBeenCalled()
    expect(mocks.recent).toHaveBeenCalledExactlyOnceWith(input.db, "channel")
    expect(mocks.create.mock.calls[0][0].threshold).toBe(0.5)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("skips when the latest message is its own, without scanning backwards or looking up its handle", async () => {
    mocks.recent.mockResolvedValue([{ ...row(3), authorId: "bot" }, row(2), row(1)])
    expect(await isDuplicateBotMessage(input)).toBe(false)
    expect(mocks.author).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it.each([60_000, 59_999])("checks within the inclusive window at %i ms", async (age) => {
    mocks.recent.mockResolvedValue([row(1, age)])
    expect(await isDuplicateBotMessage(input)).toBe(true)
  })
  it.each([60_001, -1])("bypasses outside the window at %i ms", async (age) => {
    mocks.recent.mockResolvedValue([row(1, age)])
    expect(await isDuplicateBotMessage(input)).toBe(false)
    expect(mocks.decide).not.toHaveBeenCalled()
  })
  it("bypasses empty channels and invalid timestamps", async () => {
    mocks.recent.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...row(1), createdAt: "invalid" }])
    expect(await isDuplicateBotMessage(input)).toBe(false)
    expect(await isDuplicateBotMessage(input)).toBe(false)
    expect(mocks.decide).not.toHaveBeenCalled()
  })
  it("fails open when the sender lookup fails or finds no sender", async () => {
    mocks.author.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("DB unavailable"))
    expect(await isDuplicateBotMessage(input)).toBe(false)
    expect(await isDuplicateBotMessage(input)).toBe(false)
    expect(mocks.decide).not.toHaveBeenCalled()
  })
  it.each([0, 0.499, 0.5, 1])("applies the duplicate probability boundary to %f", async (noul) => {
    mocks.decide.mockResolvedValue({ answers: { duplicate: { type: "noul", noul } } })
    expect(await isDuplicateBotMessage(input)).toBe(noul >= 0.5)
  })
  it.each([undefined, {}, { type: "choice", noul: 1 }, { type: "noul", noul: -1 },
    { type: "noul", noul: 1.1 }, { type: "noul", noul: NaN }, { type: "noul", noul: "1" }])("fails open for invalid answers: %j", async (answer) => {
    mocks.decide.mockResolvedValue({ answers: { duplicate: answer } })
    expect(await isDuplicateBotMessage(input)).toBe(false)
  })
  it("fails open for missing credentials, independently of retired wake threshold", async () => {
    expect(await isDuplicateBotMessage({ ...input, env: {} })).toBe(false)
    expect(mocks.recent).not.toHaveBeenCalled()
    expect(await isDuplicateBotMessage({ ...input, env: { ...input.env, JEV_WAKE_THRESHOLD: "invalid" } })).toBe(true)
  })
  it("fails open on query/provider initialization/request failure", async () => {
    mocks.recent.mockRejectedValueOnce(new Error("DB unavailable"))
    expect(await isDuplicateBotMessage(input)).toBe(false)
    mocks.create.mockImplementationOnce(() => { throw new Error("init") })
    expect(await isDuplicateBotMessage(input)).toBe(false)
    mocks.decide.mockRejectedValueOnce(new Error("upstream failed"))
    expect(await isDuplicateBotMessage(input)).toBe(false)
  })
  it("bounds a provider that ignores cancellation and aborts its signal", async () => {
    mocks.decide.mockImplementation(() => new Promise(() => {}))
    const result = isDuplicateBotMessage(input)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await result).toBe(false)
    expect(mocks.decide.mock.calls[0][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("fails open rather than truncating oversized input", async () => {
    mocks.recent.mockResolvedValue([{ ...row(1), content: "界".repeat(50_000) }])
    expect(await isDuplicateBotMessage(input)).toBe(false)
    expect(mocks.decide).not.toHaveBeenCalled()
  })
})

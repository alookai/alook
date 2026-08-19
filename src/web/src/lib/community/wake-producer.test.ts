import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockGetCloudflareContext = vi.fn(() => ({
  env: { WAKE_QUEUE: { queue: true } },
}))
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => mockGetCloudflareContext(),
}))

const mockQueueSend = vi.fn()
const mockDevSend = vi.fn()
const mockCreateQueueWakeTransport = vi.fn(() => ({ send: mockQueueSend }))
const mockCreateDevHttpWakeTransport = vi.fn(() => ({ send: mockDevSend }))
vi.mock("./wake-transport", () => ({
  createQueueWakeTransport: (...args: unknown[]) => mockCreateQueueWakeTransport(...args),
  createDevHttpWakeTransport: (...args: unknown[]) => mockCreateDevHttpWakeTransport(...args),
}))

import { enqueueBotWakePayloads } from "./wake-producer"

describe("enqueueBotWakePayloads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("NODE_ENV", "test")
    mockQueueSend.mockResolvedValue(undefined)
    mockDevSend.mockResolvedValue(undefined)
  })

  afterEach(() => vi.unstubAllEnvs())

  it("does not construct a transport for an empty plan", async () => {
    await expect(enqueueBotWakePayloads([])).resolves.toBeUndefined()
    expect(mockCreateQueueWakeTransport).not.toHaveBeenCalled()
    expect(mockCreateDevHttpWakeTransport).not.toHaveBeenCalled()
  })

  it("sends only stable minimal payloads through the queue", async () => {
    const payloads = [
      { messageId: "msg_1", botUserId: "bot_1" },
      { messageId: "msg_1", botUserId: "bot_2" },
    ]
    await enqueueBotWakePayloads(payloads)
    expect(mockQueueSend).toHaveBeenCalledWith(payloads)
    expect(mockDevSend).not.toHaveBeenCalled()
  })

  it("chunks the transport at 100 payloads", async () => {
    const payloads = Array.from({ length: 201 }, (_, index) => ({
      messageId: "msg_1",
      botUserId: `bot_${index}`,
    }))
    await enqueueBotWakePayloads(payloads)
    expect(mockQueueSend).toHaveBeenCalledTimes(3)
    expect(mockQueueSend.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 1])
  })

  it("uses the dev HTTP transport only in development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const payloads = [{ messageId: "msg_1", botUserId: "bot_1" }]
    await enqueueBotWakePayloads(payloads)
    expect(mockDevSend).toHaveBeenCalledWith(payloads)
    expect(mockQueueSend).not.toHaveBeenCalled()
  })

  it("settles every chunk and rejects when any chunk fails", async () => {
    mockQueueSend
      .mockRejectedValueOnce(new Error("queue down"))
      .mockResolvedValueOnce(undefined)
    const payloads = Array.from({ length: 101 }, (_, index) => ({
      messageId: "msg_1",
      botUserId: `bot_${index}`,
    }))
    await expect(enqueueBotWakePayloads(payloads)).rejects.toThrow("1 chunk")
    expect(mockQueueSend).toHaveBeenCalledTimes(2)
  })
})

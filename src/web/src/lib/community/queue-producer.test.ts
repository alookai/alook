import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockGetCloudflareContext = vi.fn(() => ({
  env: { TASK_QUEUE: { queue: true } },
}))
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => mockGetCloudflareContext(),
}))

const mockQueueSend = vi.fn()
const mockDevSend = vi.fn()
const mockCreateQueueTransport = vi.fn(() => ({ send: mockQueueSend }))
const mockCreateDevHttpQueueTransport = vi.fn(() => ({ send: mockDevSend }))
vi.mock("./queue-transport", () => ({
  createQueueTransport: (...args: unknown[]) => mockCreateQueueTransport(...args),
  createDevHttpQueueTransport: (...args: unknown[]) => mockCreateDevHttpQueueTransport(...args),
}))

import { enqueueQueueTasks } from "./queue-producer"

describe("enqueueQueueTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("NODE_ENV", "test")
    mockQueueSend.mockResolvedValue(undefined)
    mockDevSend.mockResolvedValue(undefined)
  })

  afterEach(() => vi.unstubAllEnvs())

  it("does not construct a transport for an empty plan", async () => {
    await expect(enqueueQueueTasks([])).resolves.toBeUndefined()
    expect(mockCreateQueueTransport).not.toHaveBeenCalled()
    expect(mockCreateDevHttpQueueTransport).not.toHaveBeenCalled()
  })

  it("sends only stable minimal payloads through the queue", async () => {
    const payloads = [
      { version: 1 as const, kind: "bot-wake" as const, messageId: "msg_1", botUserId: "bot_1" },
      { version: 1 as const, kind: "mobile-push" as const, messageId: "msg_1", userId: "user_1" },
    ]
    await enqueueQueueTasks(payloads)
    expect(mockQueueSend).toHaveBeenCalledWith(payloads)
    expect(mockDevSend).not.toHaveBeenCalled()
  })

  it("chunks the transport at 100 payloads", async () => {
    const payloads = Array.from({ length: 201 }, (_, index) => ({
      version: 1 as const,
      kind: "mobile-push" as const,
      messageId: "msg_1",
      userId: `user_${index}`,
    }))
    await enqueueQueueTasks(payloads)
    expect(mockQueueSend).toHaveBeenCalledTimes(3)
    expect(mockQueueSend.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 1])
  })

  it("uses the dev HTTP transport only in development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const payloads = [{ version: 1 as const, kind: "bot-wake" as const, messageId: "msg_1", botUserId: "bot_1" }]
    await enqueueQueueTasks(payloads)
    expect(mockDevSend).toHaveBeenCalledWith(payloads)
    expect(mockQueueSend).not.toHaveBeenCalled()
  })

  it("settles every chunk and rejects when any chunk fails", async () => {
    mockQueueSend
      .mockRejectedValueOnce(new Error("queue down"))
      .mockResolvedValueOnce(undefined)
    const payloads = Array.from({ length: 101 }, (_, index) => ({
      version: 1 as const,
      kind: "bot-wake" as const,
      messageId: "msg_1",
      botUserId: `bot_${index}`,
    }))
    await expect(enqueueQueueTasks(payloads)).rejects.toThrow("1 chunk")
    expect(mockQueueSend).toHaveBeenCalledTimes(2)
  })
})

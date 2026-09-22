import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockCreateDb = vi.fn((..._args: unknown[]) => ({ database: true }))
const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }))
vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockLogWarn,
      error: vi.fn(),
      child() { return this },
    }),
    createDb: (...args: unknown[]) => mockCreateDb(...args),
  }
})

const mockExecuteQueueTask = vi.fn()
vi.mock("./task-handler", () => ({
  executeQueueTask: (...args: unknown[]) => mockExecuteQueueTask(...args),
}))

import handler from "./index"

const legacyWake = { messageId: "message-1", botUserId: "bot-1" }
const botWake = {
  version: 1 as const,
  kind: "bot-wake" as const,
  messageId: "message-1",
  botUserId: "bot-1",
}
const mobilePush = {
  version: 1 as const,
  kind: "mobile-push" as const,
  messageId: "message-1",
  userId: "user-1",
}

function makeMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() }
}

function request(method: string, body?: unknown) {
  return new Request("http://internal/", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe("queue-worker queue consumer", () => {
  const env = { DB: {} } as Env

  beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteQueueTask.mockResolvedValue(undefined)
  })

  it.each([
    ["legacy bot wake", legacyWake, botWake],
    ["v1 bot wake", botWake, botWake],
    ["v1 mobile push", mobilePush, mobilePush],
  ])("normalizes and ACKs a completed %s", async (_name, body, expected) => {
    const message = makeMessage(body)

    await handler.queue({ messages: [message] } as never, env)

    expect(mockCreateDb).toHaveBeenCalledWith(env.DB)
    expect(mockExecuteQueueTask).toHaveBeenCalledWith(
      { database: true },
      env,
      expected,
    )
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
  })

  it.each([
    ["malformed", { messageId: "message-1" }, "malformed"],
    ["unknown", { version: 1, kind: "email", messageId: "message-1", userId: "user-1" }, "unknown_kind"],
    ["unsupported", { version: 2, kind: "bot-wake", messageId: "message-1", botUserId: "bot-1" }, "unsupported_version"],
  ])("ACKs a %s poison task without opening D1", async (_name, body, reason) => {
    const message = makeMessage(body)

    await handler.queue({ messages: [message] } as never, env)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mockCreateDb).not.toHaveBeenCalled()
    expect(mockExecuteQueueTask).not.toHaveBeenCalled()
    expect(mockLogWarn).toHaveBeenCalledWith("queue_task_ignored", { reason })
  })

  it("retries a thrown bot-wake failure by five seconds", async () => {
    mockExecuteQueueTask.mockRejectedValueOnce(new Error("D1 unavailable"))
    const message = makeMessage(botWake)

    await handler.queue({ messages: [message] } as never, env)

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 })
    expect(message.ack).not.toHaveBeenCalled()
  })

  it("keeps per-message ACK/retry isolated within one batch", async () => {
    mockExecuteQueueTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined)
    const messages = [
      makeMessage(botWake),
      makeMessage({ ...botWake, botUserId: "bot-2" }),
      makeMessage(mobilePush),
    ]

    await handler.queue({ messages } as never, env)

    expect(messages[0]!.ack).toHaveBeenCalledTimes(1)
    expect(messages[1]!.retry).toHaveBeenCalledWith({ delaySeconds: 5 })
    expect(messages[2]!.ack).toHaveBeenCalledTimes(1)
  })
})

describe("queue-worker development HTTP entrypoint", () => {
  const env = { DB: {} } as Env

  beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteQueueTask.mockResolvedValue(undefined)
  })

  afterEach(() => vi.useRealTimers())

  it("accepts mixed versioned tasks and normalizes legacy wakes", async () => {
    const response = await handler.fetch!(request("POST", [legacyWake, mobilePush]), env)

    expect(response.status).toBe(202)
    expect(mockExecuteQueueTask.mock.calls.map((call) => call[2])).toEqual([
      botWake,
      mobilePush,
    ])
  })

  it("deduplicates only the same kind/message/recipient tuple", async () => {
    const response = await handler.fetch!(request("POST", [
      legacyWake,
      botWake,
      mobilePush,
      { ...mobilePush, userId: "user-2" },
    ]), env)

    expect(response.status).toBe(202)
    expect(mockExecuteQueueTask).toHaveBeenCalledTimes(3)
  })

  it.each([
    ["non-array", legacyWake],
    ["malformed item", [legacyWake, { messageId: "message-2" }]],
    ["unknown item", [legacyWake, { version: 1, kind: "email", messageId: "message-2", userId: "user-2" }]],
  ])("rejects a %s body before D1", async (_name, body) => {
    const response = await handler.fetch!(request("POST", body), env)
    expect(response.status).toBe(400)
    expect(mockCreateDb).not.toHaveBeenCalled()
    expect(mockExecuteQueueTask).not.toHaveBeenCalled()
  })

  it("retries only a failing task and returns its normalized stable key after exhaustion", async () => {
    vi.useFakeTimers()
    mockExecuteQueueTask.mockImplementation(async (_db, _env, task) => {
      if (task.kind === "bot-wake" && task.botUserId === "bot-1") {
        throw new Error("transient")
      }
    })

    const responsePromise = handler.fetch!(request("POST", [legacyWake, mobilePush]), env)
    await vi.runAllTimersAsync()
    const response = await responsePromise

    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ failed: [botWake] })
    expect(mockExecuteQueueTask.mock.calls.filter((call) => call[2].kind === "bot-wake")).toHaveLength(3)
    expect(mockExecuteQueueTask.mock.calls.filter((call) => call[2].kind === "mobile-push")).toHaveLength(1)
    expect(mockLogWarn).toHaveBeenCalledWith("dev_http_queue_task_retrying", expect.objectContaining({
      attempt: 1,
      delayMs: 25,
    }))
    expect(mockLogWarn).toHaveBeenCalledWith("dev_http_queue_task_retrying", expect.objectContaining({
      attempt: 2,
      delayMs: 100,
    }))
    expect(mockLogWarn).toHaveBeenCalledWith("dev_http_queue_task_exhausted", expect.objectContaining({
      attempts: 3,
    }))
  })

  it.each([
    [1, []],
    [2, [25]],
    [3, [25, 100]],
  ])("succeeds on attempt %i after only the expected waits", async (successAttempt, delays) => {
    vi.useFakeTimers()
    let attempt = 0
    mockExecuteQueueTask.mockImplementation(async () => {
      attempt += 1
      if (attempt < successAttempt) throw new Error("transient")
    })

    const responsePromise = handler.fetch!(request("POST", [botWake]), env)
    await vi.runAllTimersAsync()
    const response = await responsePromise

    expect(response.status).toBe(202)
    expect(mockExecuteQueueTask).toHaveBeenCalledTimes(successAttempt)
    expect(mockLogWarn.mock.calls
      .filter(([event]) => event === "dev_http_queue_task_retrying")
      .map(([, details]) => details.delayMs)).toEqual(delays)
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      "dev_http_queue_task_exhausted",
      expect.anything(),
    )
  })

  it("serves health and rejects invalid methods or JSON", async () => {
    await expect((await handler.fetch!(new Request("http://internal/health"), env)).json())
      .resolves.toEqual({ status: "ok" })
    expect((await handler.fetch!(request("GET"), env)).status).toBe(405)
    expect((await handler.fetch!(new Request("http://internal/", {
      method: "POST",
      body: "not-json",
    }), env)).status).toBe(400)
  })
})

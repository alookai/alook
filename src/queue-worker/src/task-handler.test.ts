import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
}))
vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: mockLogInfo,
      warn: mockLogWarn,
      error: vi.fn(),
      child() { return this },
    }),
  }
})

import { executeQueueTask } from "./task-handler"

describe("queue task handler", () => {
  beforeEach(() => vi.clearAllMocks())

  it("preserves bot-wake dispatch semantics and lets transient failures throw", async () => {
    const dispatchWake = vi.fn(async () => ({ outcome: "attempted" as const }))
    const task = {
      version: 1 as const,
      kind: "bot-wake" as const,
      messageId: "message-1",
      botUserId: "bot-1",
    }
    await executeQueueTask({} as never, {} as Env, task, {
      dispatchWake,
      processMobilePush: vi.fn(),
    })
    expect(dispatchWake).toHaveBeenCalledWith({}, {}, {
      messageId: "message-1",
      botUserId: "bot-1",
    })

    dispatchWake.mockRejectedValueOnce(new Error("D1 unavailable"))
    await expect(executeQueueTask({} as never, {} as Env, task, {
      dispatchWake,
      processMobilePush: vi.fn(),
    })).rejects.toThrow("D1 unavailable")
  })

  it("logs a bot wake that reached a machine with no active session", async () => {
    const dispatchWake = vi.fn(async () => ({
      outcome: "attempted_nowhere" as const,
      machineId: "machine-1",
    }))
    const task = {
      version: 1 as const,
      kind: "bot-wake" as const,
      messageId: "message-1",
      botUserId: "bot-1",
    }

    await executeQueueTask({} as never, {} as Env, task, {
      dispatchWake,
      processMobilePush: vi.fn(),
    })

    expect(mockLogInfo).toHaveBeenCalledWith("bot_wake_attempted_nowhere", {
      kind: "bot-wake",
      botUserId: "bot-1",
      machineId: "machine-1",
    })
  })

  it("catches mobile processing failures so the consumer can ACK", async () => {
    const processPush = vi.fn(async () => {
      throw new Error("provider unavailable")
    })
    const task = {
      version: 1 as const,
      kind: "mobile-push" as const,
      messageId: "message-1",
      userId: "user-1",
    }

    await expect(executeQueueTask({} as never, {} as Env, task, {
      dispatchWake: vi.fn(),
      processMobilePush: processPush,
    })).resolves.toBeUndefined()
    expect(mockLogWarn).toHaveBeenCalledWith("mobile_push_task_failed", {
      kind: "mobile-push",
      messageId: "message-1",
      userId: "user-1",
      errorName: "Error",
    })
  })
})

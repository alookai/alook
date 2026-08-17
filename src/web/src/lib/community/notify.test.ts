import { beforeEach, describe, expect, it, vi } from "vitest"

const mockInfo = vi.fn()
const mockWarn = vi.fn()
const mockWaitUntil = vi.fn()
const mockGetCloudflareContext = vi.fn()
const mockResolveNotificationEligibilityForUsers = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => mockGetCloudflareContext(),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: (...args: unknown[]) => mockInfo(...args),
      warn: (...args: unknown[]) => mockWarn(...args),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    queries: {
      communityNotificationSetting: {
        policyAllows: actual.queries.communityNotificationSetting.policyAllows,
      },
      communityNotificationEligibility: {
        resolveNotificationEligibilityForUsers: (...args: unknown[]) =>
          mockResolveNotificationEligibilityForUsers(...args),
      },
    },
  }
})

const mockBroadcastToUser = vi.fn()
vi.mock("../broadcast", () => ({
  broadcastToUser: (...args: unknown[]) => mockBroadcastToUser(...args),
}))

import {
  dispatchMessageNotify,
  settleNotifyTasks,
} from "./notify"

const db = {} as never
const message = { id: "m1", channelId: "c1" }
const notifyContext = { authorName: "Alice" }

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function eventsOfType(type: string): Record<string, unknown>[] {
  return mockBroadcastToUser.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .filter((event) => event.type === type)
}

function deliveryStates(
  ids: string[],
  overrides: Partial<{
    currentLevel: "all" | "mentions" | "nothing"
    hasAttention: boolean
    isUnread: boolean
    isReadable: boolean
  }> = {},
) {
  return new Map(ids.map((id) => [id, {
    currentLevel: "all" as const,
    hasAttention: false,
    isUnread: true,
    isReadable: true,
    ...overrides,
  }]))
}

describe("settleNotifyTasks", () => {
  it.each([0, 1, 3, 4, 1001])(
    "settles %i tasks with at most three active",
    async (taskCount) => {
      let active = 0
      let observedMaxActive = 0
      const tasks = Array.from({ length: taskCount }, (_, index) => index)

      const settled = await settleNotifyTasks(tasks, async () => {
        active += 1
        observedMaxActive = Math.max(observedMaxActive, active)
        await Promise.resolve()
        active -= 1
      })

      expect(settled.results).toHaveLength(taskCount)
      expect(settled.results.every((result) => result.status === "fulfilled")).toBe(true)
      expect(settled.maxActive).toBe(Math.min(taskCount, 3))
      expect(observedMaxActive).toBe(Math.min(taskCount, 3))
    },
  )

  it("starts the fourth task only after one of the first three settles", async () => {
    const gates = Array.from({ length: 4 }, () => deferred<void>())
    const started: number[] = []
    const work = settleNotifyTasks([0, 1, 2, 3], async (index) => {
      started.push(index)
      await gates[index].promise
    })

    expect(started).toEqual([0, 1, 2])
    gates[1].resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3])

    gates[0].resolve(undefined)
    gates[2].resolve(undefined)
    gates[3].resolve(undefined)
    await expect(work).resolves.toMatchObject({ maxActive: 3 })
  })

  it("keeps results aligned by input index when tasks settle out of order", async () => {
    const gates = Array.from({ length: 3 }, () => deferred<void>())
    const failure = new Error("task one failed")
    const work = settleNotifyTasks([0, 1, 2], (index) => gates[index].promise)

    gates[2].resolve(undefined)
    gates[1].reject(failure)
    gates[0].resolve(undefined)

    const { results } = await work
    expect(results[0]).toEqual({ status: "fulfilled", value: undefined })
    expect(results[1]).toEqual({ status: "rejected", reason: failure })
    expect(results[2]).toEqual({ status: "fulfilled", value: undefined })
  })

  it("continues with later tasks after a synchronous rejection", async () => {
    const started: number[] = []
    const failure = new Error("rejected")
    const { results } = await settleNotifyTasks([0, 1, 2, 3], async (index) => {
      started.push(index)
      if (index === 1) throw failure
    })

    expect(started).toEqual([0, 1, 2, 3])
    expect(results[1]).toEqual({ status: "rejected", reason: failure })
    expect(results[3]).toEqual({ status: "fulfilled", value: undefined })
  })
})

describe("dispatchMessageNotify", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBroadcastToUser.mockReset()
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockGetCloudflareContext.mockReturnValue({ ctx: { waitUntil: mockWaitUntil } })
  })

  it("registers the returned work before the level resolver settles", async () => {
    const states = deferred<ReturnType<typeof deliveryStates>>()
    mockResolveNotificationEligibilityForUsers.mockReturnValue(states.promise)

    const work = dispatchMessageNotify(db, notifyContext, message, ["u1"], {
      mentionedUserIds: [],
    })

    expect(mockWaitUntil).toHaveBeenCalledWith(work)
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
    states.resolve(deliveryStates(["u1"]))
    await work
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1)
  })

  it("keeps aggregate work pending until every lazily started leaf settles", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(
      deliveryStates(["u0", "u1", "u2", "u3"]),
    )
    const gates = Array.from({ length: 4 }, () => deferred<void>())
    mockBroadcastToUser.mockImplementation(() => {
      const index = mockBroadcastToUser.mock.calls.length - 1
      return gates[index].promise
    })

    const work = dispatchMessageNotify(
      db,
      notifyContext,
      message,
      ["u0", "u1", "u2", "u3"],
      { mentionedUserIds: [] },
    )
    let settled = false
    void work.then(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(3)
    expect(settled).toBe(false)

    gates[0].resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(4)
    expect(settled).toBe(false)

    gates[1].resolve(undefined)
    gates[2].resolve(undefined)
    gates[3].resolve(undefined)
    await work
    expect(settled).toBe(true)
    expect(mockWaitUntil).toHaveBeenCalledWith(work)
  })

  it("builds mention tasks before deduplicated unread tasks", async () => {
    const states = deliveryStates(["u_plain", "u_mentioned", "u_extra"])
    states.set("u_mentioned", { ...states.get("u_mentioned")!, hasAttention: true })
    states.set("u_extra", { ...states.get("u_extra")!, hasAttention: true })
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(states)

    await dispatchMessageNotify(
      db,
      notifyContext,
      message,
      ["u_plain", "u_mentioned", "u_plain"],
      { mentionedUserIds: ["u_mentioned", "u_extra", "u_mentioned"] },
    )

    expect(mockBroadcastToUser.mock.calls.map((call) => [
      call[0],
      (call[1] as { type: string }).type,
    ])).toEqual([
      ["u_mentioned", "community:mention.create"],
      ["u_extra", "community:mention.create"],
      ["u_plain", "community:unread.bump"],
      ["u_mentioned", "community:unread.bump"],
    ])
    expect(mockInfo).toHaveBeenCalledWith(
      "dispatch_message_notify_complete",
      expect.objectContaining({
        recipientCount: 2,
        mentionedCount: 2,
        leafTaskCount: 4,
        mentionSuccess: 2,
        mentionFailure: 0,
        unreadSuccess: 2,
        unreadFailure: 0,
        maxActive: 3,
        durationMs: expect.any(Number),
      }),
    )
  })

  it("isolates one rejected leaf and continues remaining deliveries", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(
      deliveryStates(["u0", "u1", "u2", "u3"]),
    )
    mockBroadcastToUser.mockImplementation((userId: string) => (
      userId === "u1" ? Promise.reject(new Error("binding failed")) : Promise.resolve()
    ))

    await expect(dispatchMessageNotify(
      db,
      notifyContext,
      message,
      ["u0", "u1", "u2", "u3"],
      { mentionedUserIds: [] },
    )).resolves.toBeUndefined()

    expect(mockBroadcastToUser).toHaveBeenCalledTimes(4)
    expect(mockInfo).toHaveBeenCalledWith(
      "dispatch_message_notify_complete",
      expect.objectContaining({
        unreadSuccess: 3,
        unreadFailure: 1,
      }),
    )
  })

  it("preserves all and mentions notification-level behavior", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(new Map([
      ["u_all", { currentLevel: "all", hasAttention: false, isUnread: true, isReadable: true }],
      ["u_mentions_plain", { currentLevel: "mentions", hasAttention: false, isUnread: true, isReadable: true }],
      ["u_mentions_hit", { currentLevel: "mentions", hasAttention: true, isUnread: true, isReadable: true }],
    ]))

    await dispatchMessageNotify(
      db,
      notifyContext,
      message,
      ["u_all", "u_mentions_plain", "u_mentions_hit"],
      { mentionedUserIds: ["u_mentions_hit"] },
    )

    expect(eventsOfType("community:mention.create").map((event) => event.userId)).toEqual([
      "u_mentions_hit",
    ])
    expect(eventsOfType("community:unread.bump").map((event) => event.userId)).toEqual([
      "u_all",
      "u_mentions_hit",
    ])
  })

  it("suppresses nothing-level deliveries without emitting message-create", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(new Map([
      ["u_muted", { currentLevel: "nothing", hasAttention: true, isUnread: true, isReadable: true }],
    ]))

    await dispatchMessageNotify(db, notifyContext, message, ["u_muted"], {
      mentionedUserIds: ["u_muted"],
    })

    expect(mockBroadcastToUser).not.toHaveBeenCalled()
    expect(mockInfo).toHaveBeenCalledWith(
      "dispatch_message_notify_complete",
      expect.objectContaining({ leafTaskCount: 0, maxActive: 0 }),
    )
  })

  it("fails closed when a recipient is missing from the delivery snapshot", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(new Map())

    await dispatchMessageNotify(db, notifyContext, message, ["u_dm"], {
      mentionedUserIds: [],
    })

    expect(mockBroadcastToUser).not.toHaveBeenCalled()
  })

  it("does not relight a message cleared before deferred notify, but delivers a newer unread", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValueOnce(new Map([
      ["u_mentioned", { currentLevel: "mentions", hasAttention: true, isUnread: false, isReadable: true }],
    ]))

    await dispatchMessageNotify(db, notifyContext, message, ["u_mentioned"], {
      mentionedUserIds: ["u_mentioned"],
    })
    expect(mockBroadcastToUser).not.toHaveBeenCalled()

    mockResolveNotificationEligibilityForUsers.mockResolvedValueOnce(new Map([
      ["u_mentioned", { currentLevel: "mentions", hasAttention: true, isUnread: true, isReadable: true }],
    ]))
    await dispatchMessageNotify(
      db,
      notifyContext,
      { id: "m2", channelId: "c1" },
      ["u_mentioned"],
      { mentionedUserIds: ["u_mentioned"] },
    )
    expect(mockBroadcastToUser.mock.calls.map((call) => (call[1] as { type: string }).type)).toEqual([
      "community:mention.create",
      "community:unread.bump",
    ])
  })

  it("does not notify a captured recipient after current access is revoked", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(new Map([
      ["u_removed", { currentLevel: "all", hasAttention: true, isUnread: true, isReadable: false }],
    ]))

    await dispatchMessageNotify(db, notifyContext, message, ["u_removed"], {
      mentionedUserIds: ["u_removed"],
    })

    expect(mockBroadcastToUser).not.toHaveBeenCalled()

    await dispatchMessageNotify(
      db,
      notifyContext,
      { id: "m_after_revoke", channelId: "c1" },
      ["u_removed"],
      { mentionedUserIds: ["u_removed"] },
    )
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
  })

  it("preserves optional unread routing fields", async () => {
    const states = deliveryStates(["u_plain", "u_mentioned"])
    states.set("u_mentioned", { ...states.get("u_mentioned")!, hasAttention: true })
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(states)

    await dispatchMessageNotify(db, notifyContext, message, ["u_plain", "u_mentioned"], {
      mentionedUserIds: ["u_mentioned"],
      serverId: "srv_1",
      railChannelId: "parent_c1",
    })

    const unreadEvents = eventsOfType("community:unread.bump")
    for (const event of unreadEvents) {
      expect(event.serverId).toBe("srv_1")
      expect(event.railChannelId).toBe("parent_c1")
      expect(event.channelId).toBe("c1")
    }
    expect(unreadEvents.find((event) => event.userId === "u_mentioned")?.isMention).toBe(true)
    expect(unreadEvents.find((event) => event.userId === "u_plain")?.isMention).toBe(false)
  })

  it("omits optional unread routing fields for a direct message", async () => {
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(deliveryStates(["u_dm"]))

    await dispatchMessageNotify(db, notifyContext, message, ["u_dm"], {
      mentionedUserIds: [],
    })

    const [event] = eventsOfType("community:unread.bump")
    expect(event.serverId).toBeUndefined()
    expect(event.railChannelId).toBeUndefined()
    expect(event.isMention).toBe(false)
  })

  it("absorbs a resolver failure and records its duration", async () => {
    mockResolveNotificationEligibilityForUsers.mockRejectedValue(new Error("d1 blip"))

    const work = dispatchMessageNotify(db, notifyContext, message, ["u1"], {
      mentionedUserIds: [],
    })

    expect(mockWaitUntil).toHaveBeenCalledWith(work)
    await expect(work).resolves.toBeUndefined()
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith(
      "dispatch_message_notify_failed",
      expect.objectContaining({
        messageId: "m1",
        err: "Error: d1 blip",
        durationMs: expect.any(Number),
      }),
    )
  })

  it("continues when Cloudflare context lookup is unavailable", async () => {
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("not in a request context")
    })
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(deliveryStates(["u1"]))

    await expect(dispatchMessageNotify(
      db,
      notifyContext,
      message,
      ["u1"],
      { mentionedUserIds: [] },
    )).resolves.toBeUndefined()

    expect(mockWaitUntil).not.toHaveBeenCalled()
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1)
  })
})

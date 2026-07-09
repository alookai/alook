import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetCloudflareContext = vi.fn(() => ({ env: { DB: {} } }))
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...(a as [])),
}))

const mockWarn = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    queries: {
      communityMember: {
        listMembers: (...a: unknown[]) => mockListMembers(...a),
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
      },
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
      },
    },
  }
})

vi.mock("../db", () => ({
  getDb: vi.fn(() => ({})),
}))

const mockBroadcastToUser = vi.fn()
vi.mock("../broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))

const mockEnqueueBotWakes = vi.fn()
vi.mock("./wake-producer", () => ({
  enqueueBotWakes: (...a: unknown[]) => mockEnqueueBotWakes(...a),
}))

const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockGetChannel = vi.fn()
const mockGetDM = vi.fn()

import {
  fanOutToServerMembers,
  fanOutToChannel,
  fanOutToDM,
  broadcastToUserSafe,
} from "./fanout"
import { WS_EVENTS } from "@alook/shared"

describe("fanOutToServerMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
  })

  it("resolves recipients via listMemberUserIds (not listMembers) and skips excludeUserId", async () => {
    // 5 members, author (u1) excluded → 4 broadcasts.
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3", "u4", "u5"])

    await fanOutToServerMembers(
      "srv_1",
      {
        type: WS_EVENTS.MEMBER_UPDATE,
        serverId: "srv_1",
        memberId: "m1",
        changes: { role: "admin" },
      },
      { excludeUserId: "u1" },
    )

    expect(mockListMemberUserIds).toHaveBeenCalledTimes(1)
    expect(mockListMembers).not.toHaveBeenCalled()

    expect(mockBroadcastToUser).toHaveBeenCalledTimes(4)
    const targets = mockBroadcastToUser.mock.calls.map((c) => c[0]).sort()
    expect(targets).toEqual(["u2", "u3", "u4", "u5"])
  })

  it("broadcasts to every recipient when excludeUserId is absent", async () => {
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3"])

    await fanOutToServerMembers("srv_1", {
      type: WS_EVENTS.MEMBER_UPDATE,
      serverId: "srv_1",
      memberId: "m1",
      changes: { role: "admin" },
    })

    expect(mockBroadcastToUser).toHaveBeenCalledTimes(3)
  })

  it("fanOutToChannel resolves through channel → server → listMemberUserIds", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "srv_1" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)

    expect(mockListMemberUserIds).toHaveBeenCalledTimes(1)
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(2)
  })
})

describe("wake dispatch (minimal-wake-queue-unread-notice) — only fires for MESSAGE_CREATE with a wakeMessageRow", () => {
  const wakeMessageRow = {
    id: "msg_1",
    seq: 7,
    authorId: "u1",
    channelId: "c1",
    dmConversationId: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockEnqueueBotWakes.mockResolvedValue(undefined)
  })

  it("fanOutToChannel enqueues wakes using the same recipient list, minus excludeUserId", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "srv_1" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3"])

    await fanOutToChannel(
      "c1",
      { type: WS_EVENTS.MESSAGE_CREATE, channelId: "c1", message: {} as never } as never,
      { excludeUserId: "u1", wakeMessageRow },
    )

    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    expect(mockEnqueueBotWakes).toHaveBeenCalledWith({
      recipients: ["u2", "u3"],
      channelId: "c1",
      messageRow: wakeMessageRow,
    })
  })

  it("fanOutToDM enqueues wakes with dmConversationId scope", async () => {
    mockGetDM.mockResolvedValue({ id: "dm1", user1Id: "u1", user2Id: "u2" })

    await fanOutToDM(
      "dm1",
      { type: WS_EVENTS.MESSAGE_CREATE, dmConversationId: "dm1", message: {} as never } as never,
      { excludeUserId: "u1", wakeMessageRow: { ...wakeMessageRow, channelId: null, dmConversationId: "dm1" } },
    )

    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    expect(mockEnqueueBotWakes).toHaveBeenCalledWith({
      recipients: ["u2"],
      dmConversationId: "dm1",
      messageRow: { ...wakeMessageRow, channelId: null, dmConversationId: "dm1" },
    })
  })

  it("does not enqueue wakes when wakeMessageRow is omitted", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "srv_1" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)

    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })

  it("does not enqueue wakes for non-MESSAGE_CREATE events even with a wakeMessageRow", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "srv_1" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel(
      "c1",
      {
        type: WS_EVENTS.CHILD_CHANNEL_UPDATE,
        parentChannelId: "parent1",
        channelId: "c1",
        changes: { messageCount: 1, lastMessageAt: "2026-01-01T00:00:00.000Z" },
      } as never,
      { wakeMessageRow } as never,
    )

    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })

  it("a failing enqueueBotWakes does not reject fanOutToChannel", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "srv_1" })
    mockListMemberUserIds.mockResolvedValue(["u1"])
    mockEnqueueBotWakes.mockRejectedValue(new Error("queue down"))

    await expect(
      fanOutToChannel(
        "c1",
        { type: WS_EVENTS.MESSAGE_CREATE, channelId: "c1", message: {} as never } as never,
        { wakeMessageRow },
      ),
    ).resolves.toBeUndefined()
  })
})

describe("fanout helpers absorb setup failures", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBroadcastToUser.mockResolvedValue(undefined)
  })

  it("fanOutToServerMembers resolves and logs when getCloudflareContext throws", async () => {
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context")
    })

    const event = {
      type: WS_EVENTS.MEMBER_UPDATE,
      serverId: "srv_1",
      memberId: "m1",
      changes: { role: "admin" },
    } as const

    await expect(fanOutToServerMembers("srv_1", event)).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "fanout_to_server_members_failed",
      expect.objectContaining({
        eventType: event.type,
        targetId: "srv_1",
        err: expect.stringContaining("no cf context"),
      }),
    )
  })

  it("fanOutToChannel resolves and logs when getCloudflareContext throws", async () => {
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context")
    })

    const event = {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never

    await expect(fanOutToChannel("c1", event)).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "fanout_to_channel_failed",
      expect.objectContaining({
        eventType: WS_EVENTS.MESSAGE_CREATE,
        targetId: "c1",
        err: expect.stringContaining("no cf context"),
      }),
    )
  })

  it("fanOutToDM resolves and logs when getCloudflareContext throws", async () => {
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context")
    })

    const event = {
      type: "community:message.create",
      dmConversationId: "dm1",
    } as never

    await expect(fanOutToDM("dm1", event)).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "fanout_to_dm_failed",
      expect.objectContaining({
        eventType: "community:message.create",
        targetId: "dm1",
        err: expect.stringContaining("no cf context"),
      }),
    )
  })
})

describe("broadcastToUserSafe", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
  })

  it("resolves and logs when broadcastToUser rejects", async () => {
    mockBroadcastToUser.mockRejectedValue(new Error("ws-do 500"))

    await expect(
      broadcastToUserSafe("u1", {
        type: "community:machine.removed",
        machineId: "m1",
      } as never),
    ).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast_to_user_failed",
      expect.objectContaining({
        eventType: "community:machine.removed",
        targetId: "u1",
        err: expect.stringContaining("ws-do 500"),
      }),
    )
  })

  it("does not log when broadcastToUser resolves", async () => {
    mockBroadcastToUser.mockResolvedValue(undefined)
    await broadcastToUserSafe("u1", {
      type: "community:machine.removed",
      machineId: "m1",
    } as never)
    expect(mockWarn).not.toHaveBeenCalled()
  })
})

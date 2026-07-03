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
    createDb: vi.fn(() => ({})),
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

const mockBroadcastToUser = vi.fn()
vi.mock("../broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
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

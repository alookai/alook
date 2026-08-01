import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetCloudflareContext = vi.fn(() => ({ env: { DB: {} } }))
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...(a as [])),
}))

const mockWarn = vi.fn()
const mockError = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: (...a: unknown[]) => mockError(...a),
      debug: vi.fn(),
    }),
    queries: {
      communityMember: {
        listMembers: (...a: unknown[]) => mockListMembers(...a),
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
        getCoMemberUserIds: (...a: unknown[]) => mockGetCoMemberUserIds(...a),
      },
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getChannelType: (...a: unknown[]) => mockGetChannelType(...a),
        isChannelPrivate: (...a: unknown[]) => mockIsChannelPrivate(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
        listChannelMemberUserIds: (...a: unknown[]) => mockListChannelMemberUserIds(...a),
      },
      communityMembersResolver: {
        resolveScopeMemberUserIds: (...a: unknown[]) => mockResolveScopeMemberUserIds(...a),
      },
      communityThread: {
        listThreadParticipantUserIds: (...a: unknown[]) => mockListThreadParticipantUserIds(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
      },
      communityFriendship: {
        getFriendUserIds: (...a: unknown[]) => mockGetFriendUserIds(...a),
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
const mockIsChannelPrivate = vi.fn(() => false)
const mockGetPrivateChannelAudienceUserIds = vi.fn(() => [] as string[])
const mockGetDM = vi.fn()
const mockListChannelMemberUserIds = vi.fn()
const mockGetCoMemberUserIds = vi.fn()
const mockGetFriendUserIds = vi.fn()
const mockResolveScopeMemberUserIds = vi.fn(() => [] as string[])
// Default: non-thread channel → fan-out uses the shared resolver path.
const mockGetChannelType = vi.fn(() => "text" as string | null)
const mockListThreadParticipantUserIds = vi.fn(() => [] as string[])

import {
  fanOutToServerMembers,
  fanOutToChannel,
  fanOutToDM,
  fanOutStatusUpdate,
  broadcastToUserSafe,
} from "./fanout"
import { WS_EVENTS } from "@alook/shared"

describe("fanOutToServerMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
    // Default to a non-thread channel so fan-out uses the shared resolver path;
    // the thread test overrides this. (clearAllMocks resets call history, not
    // the resolved-value impl, so re-assert the default each test.)
    mockGetChannelType.mockResolvedValue("text")
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

  it("fanOutToChannel resolves recipients via the shared member resolver", async () => {
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)

    expect(mockResolveScopeMemberUserIds).toHaveBeenCalledTimes(1)
    expect(mockResolveScopeMemberUserIds).toHaveBeenCalledWith(expect.anything(), {
      scope: "channel",
      scopeId: "c1",
    })
    // The old inline split (getChannel + isChannelPrivate) is gone.
    expect(mockGetChannel).not.toHaveBeenCalled()
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(2)
  })

  it("fanOutToChannel routes a DM to its access members (not the empty server-scoped resolver)", async () => {
    // Regression: a DM has server_id=NULL. Before the isDm branch, it fell
    // through to resolveScopeMemberUserIds({scope:"channel"}) → WHERE
    // server_id = NULL → [] → the peer never received the live message frame.
    mockGetChannelType.mockResolvedValue("dm")
    mockListChannelMemberUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel(
      "dm1",
      { type: WS_EVENTS.MESSAGE_CREATE, channelId: "dm1", message: {} as never } as never,
      { excludeUserId: "u1" },
    )

    expect(mockListChannelMemberUserIds).toHaveBeenCalledWith(expect.anything(), "dm1")
    // Must NOT fall through to the server-scoped resolver (empty for a DM).
    expect(mockResolveScopeMemberUserIds).not.toHaveBeenCalled()
    // u1 excluded → only the peer receives the frame.
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUser.mock.calls[0][0]).toBe("u2")
  })

  it("fanOutToChannel routes a THREAD to its participant set (not the channel audience)", async () => {
    mockGetChannelType.mockResolvedValue("thread")
    mockListThreadParticipantUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("t1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "t1",
      message: {} as never,
    } as never)

    expect(mockListThreadParticipantUserIds).toHaveBeenCalledWith(expect.anything(), "t1")
    // Thread fan-out must NOT fall back to the channel-audience resolver.
    expect(mockResolveScopeMemberUserIds).not.toHaveBeenCalled()
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(2)
  })
})

describe("fanOutStatusUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
    // Default to a non-thread channel so fan-out uses the shared resolver path;
    // the thread test overrides this. (clearAllMocks resets call history, not
    // the resolved-value impl, so re-assert the default each test.)
    mockGetChannelType.mockResolvedValue("text")
  })

  it("broadcasts to the deduped union of co-members and friends", async () => {
    mockGetCoMemberUserIds.mockResolvedValue(["u1", "u2"])
    mockGetFriendUserIds.mockResolvedValue(["u2", "u3"])

    await fanOutStatusUpdate("self1", "🎧", "Vibing")

    expect(mockGetCoMemberUserIds).toHaveBeenCalledWith(expect.anything(), "self1")
    expect(mockGetFriendUserIds).toHaveBeenCalledWith(expect.anything(), "self1")
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(3)
    const targets = mockBroadcastToUser.mock.calls.map((c) => c[0]).sort()
    expect(targets).toEqual(["u1", "u2", "u3"])
    for (const call of mockBroadcastToUser.mock.calls) {
      expect(call[1]).toEqual({
        type: "community:status.update",
        userId: "self1",
        statusEmoji: "🎧",
        statusText: "Vibing",
      })
    }
  })

  it("does not broadcast when the audience is empty", async () => {
    mockGetCoMemberUserIds.mockResolvedValue([])
    mockGetFriendUserIds.mockResolvedValue([])

    await fanOutStatusUpdate("self1", null, null)

    expect(mockBroadcastToUser).not.toHaveBeenCalled()
  })

  it("never throws — absorbs a recipient-read DB error and logs it OBSERVABLY (error, not warn)", async () => {
    mockGetCoMemberUserIds.mockRejectedValue(new Error("db down"))

    await expect(fanOutStatusUpdate("self1", "🎧", "Vibing")).resolves.toBeUndefined()

    // The audience read is the false-negative risk: its failure is surfaced at
    // error level under its own category (not the phase-2 best-effort warn).
    expect(mockError).toHaveBeenCalledWith(
      "fanout_status_audience_failed",
      expect.objectContaining({
        userId: "self1",
        err: expect.objectContaining({ message: expect.stringContaining("db down") }),
      }),
    )
    // Must not also log the phase-2 broadcast warn — the read never reached it.
    expect(mockWarn).not.toHaveBeenCalledWith("fanout_status_update_failed", expect.anything())
  })
})

describe("wake dispatch (minimal-wake-queue-unread-notice) — only fires for MESSAGE_CREATE with a wakeMessageRow", () => {
  const wakeMessageRow = {
    id: "msg_1",
    seq: 7,
    authorId: "u1",
    channelId: "c1",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockEnqueueBotWakes.mockResolvedValue(undefined)
  })

  it("fanOutToChannel enqueues wakes using the same recipient list, minus excludeUserId", async () => {
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1", "u2", "u3"])

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

  it("fanOutToDM enqueues wakes with channelId scope via listChannelMemberUserIds", async () => {
    mockGetDM.mockResolvedValue({ id: "dm1" })
    mockListChannelMemberUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToDM(
      "dm1",
      { type: WS_EVENTS.MESSAGE_CREATE, channelId: "dm1", message: {} as never } as never,
      { excludeUserId: "u1", wakeMessageRow: { ...wakeMessageRow, channelId: "dm1" } },
    )

    expect(mockListChannelMemberUserIds).toHaveBeenCalledWith(expect.anything(), "dm1")
    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    expect(mockEnqueueBotWakes).toHaveBeenCalledWith({
      recipients: ["u2"],
      channelId: "dm1",
      messageRow: { ...wakeMessageRow, channelId: "dm1" },
    })
  })

  it("does not enqueue wakes when wakeMessageRow is omitted", async () => {
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)

    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })

  it("does not enqueue wakes for non-MESSAGE_CREATE events even with a wakeMessageRow", async () => {
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1", "u2"])

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
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1"])
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

    // Setup failure happens in phase 1 (recipient read) → observable error.
    expect(mockError).toHaveBeenCalledWith(
      "fanout_server_members_failed",
      expect.objectContaining({
        eventType: event.type,
        targetId: "srv_1",
        err: expect.objectContaining({ message: expect.stringContaining("no cf context") }),
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

    expect(mockError).toHaveBeenCalledWith(
      "fanout_channel_recipients_failed",
      expect.objectContaining({
        eventType: WS_EVENTS.MESSAGE_CREATE,
        targetId: "c1",
        err: expect.objectContaining({ message: expect.stringContaining("no cf context") }),
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

    expect(mockError).toHaveBeenCalledWith(
      "fanout_dm_recipients_failed",
      expect.objectContaining({
        eventType: "community:message.create",
        targetId: "dm1",
        err: expect.objectContaining({ message: expect.stringContaining("no cf context") }),
      }),
    )
  })
})

describe("swallow-class fix — recipient read is retried and observable, never a silent false-negative", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockGetChannelType.mockResolvedValue("text")
  })

  it("a TRANSIENT on the recipient read is retried, then delivery still happens (positive delivery, not error-absence)", async () => {
    // First attempt hits a transient in the retry whitelist, second succeeds.
    mockResolveScopeMemberUserIds
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"))
      .mockResolvedValueOnce(["u1", "u2"])

    await fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)

    // The retry produced the true recipient list → the broadcast actually
    // fired to both. Asserting delivery HAPPENED, not "no error thrown".
    expect(mockResolveScopeMemberUserIds.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(2)
    expect(mockError).not.toHaveBeenCalled()
  })

  it("retry-exhausted recipient read → observable error + NO broadcast + never rejects", async () => {
    // A persistent transient exhausts the retries.
    mockResolveScopeMemberUserIds.mockRejectedValue(new Error("SQLITE_BUSY: database is locked"))

    await expect(
      fanOutToChannel("c1", {
        type: WS_EVENTS.MESSAGE_CREATE,
        channelId: "c1",
        message: {} as never,
      } as never),
    ).resolves.toBeUndefined()

    expect(mockError).toHaveBeenCalledWith(
      "fanout_channel_recipients_failed",
      expect.objectContaining({ targetId: "c1" }),
    )
    // No recipient list → nothing broadcast (the false-negative is now LOUD,
    // not silent). The read failure did not ride the phase-2 best-effort warn.
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
    expect(mockWarn).not.toHaveBeenCalledWith("fanout_to_channel_failed", expect.anything())
  })

  it("a broadcast (phase-2) failure is still absorbed as a best-effort warn — read succeeded", async () => {
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1", "u2"])
    mockBroadcastToUser.mockRejectedValue(new Error("ws-do 500"))

    await expect(
      fanOutToChannel("c1", {
        type: WS_EVENTS.MESSAGE_CREATE,
        channelId: "c1",
        message: {} as never,
      } as never),
    ).resolves.toBeUndefined()

    // broadcastToRecipients catches per-user rejections internally (warns), so
    // the phase-2 wrapper itself doesn't see an error here — the point is the
    // read succeeded and was NOT reported as a false-negative.
    expect(mockError).not.toHaveBeenCalled()
  })

  it("fanOutToDM: a missing DM is a LOGIC guard (warn+return), not an observable read failure", async () => {
    mockGetDM.mockResolvedValue(null)

    await expect(
      fanOutToDM("dm1", {
        type: WS_EVENTS.MESSAGE_CREATE,
        channelId: "dm1",
        message: {} as never,
      } as never),
    ).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith("fanOutToDM: DM channel not found", { channelId: "dm1" })
    // Not surfaced as a transient/read failure — a missing DM is legitimately
    // "nobody to fan out to", not a swallow-class false-negative.
    expect(mockError).not.toHaveBeenCalled()
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
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

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"

const mockGetCloudflareContext = vi.fn(() => ({ env: { DB: {} } }))
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...(a as [])),
}))

const mockWarn = vi.fn()
const mockWithD1Retry = vi.fn(async (fn: () => Promise<unknown>, _opts?: unknown) => fn())
const mockResolveChannelRecipientUserIds = vi.fn(() => Promise.resolve([] as string[]))

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
    withD1Retry: (...a: unknown[]) => mockWithD1Retry(...(a as [() => Promise<unknown>, unknown])),
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
        resolveChannelRecipientUserIds: (...a: unknown[]) => mockResolveChannelRecipientUserIds(...a),
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
const mockBroadcastToUsers = vi.fn()
vi.mock("../broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
  broadcastToUsers: (...a: unknown[]) => mockBroadcastToUsers(...a),
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
  resolveChannelRecipients,
} from "./fanout"
import { WS_EVENTS } from "@alook/shared"

describe("fanOutToServerMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockBroadcastToUsers.mockResolvedValue(undefined)
    mockWithD1Retry.mockImplementation(async (fn: () => Promise<unknown>, _opts?: unknown) => fn())
    mockResolveChannelRecipientUserIds.mockResolvedValue([])
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

    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["u1", "u2", "u3", "u4", "u5"],
      expect.objectContaining({ type: WS_EVENTS.MEMBER_UPDATE }),
      "u1",
    )
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
  })

  it("broadcasts to every recipient when excludeUserId is absent", async () => {
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3"])

    await fanOutToServerMembers("srv_1", {
      type: WS_EVENTS.MEMBER_UPDATE,
      serverId: "srv_1",
      memberId: "m1",
      changes: { role: "admin" },
    })

    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["u1", "u2", "u3"],
      expect.objectContaining({ type: WS_EVENTS.MEMBER_UPDATE }),
      undefined,
    )
  })

  it("registers recipient resolution with waitUntil before the D1 read settles", async () => {
    const waitUntil = vi.fn()
    mockGetCloudflareContext.mockImplementation(() => ({
      env: { DB: {} },
      ctx: { waitUntil },
    }))
    let release!: (ids: string[]) => void
    mockListMemberUserIds.mockReturnValue(new Promise<string[]>((resolve) => {
      release = resolve
    }))

    const work = fanOutToServerMembers("srv_1", {
      type: WS_EVENTS.MEMBER_UPDATE,
      serverId: "srv_1",
      memberId: "m1",
      changes: { role: "admin" },
    })

    expect(waitUntil).toHaveBeenCalledWith(work)
    expect(mockBroadcastToUsers).not.toHaveBeenCalled()
    release(["u1"])
    await work
    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
  })

  it("fanOutToChannel resolves recipients via the shared channel recipient resolver", async () => {
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)

    expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledTimes(1)
    expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      expect.any(Function),
    )
    expect(mockGetChannel).not.toHaveBeenCalled()
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
  })

  it("fanOutToChannel routes a DM to its access members (not the empty server-scoped resolver)", async () => {
    // Regression: a DM has server_id=NULL. Before the isDm branch, it fell
    // through to resolveScopeMemberUserIds({scope:"channel"}) → WHERE
    // server_id = NULL → [] → the peer never received the live message frame.
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel(
      "dm1",
      { type: WS_EVENTS.MESSAGE_CREATE, channelId: "dm1", message: {} as never } as never,
      { excludeUserId: "u1" },
    )

    expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledWith(
      expect.anything(),
      "dm1",
      expect.any(Function),
    )
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["u1", "u2"],
      expect.objectContaining({ type: WS_EVENTS.MESSAGE_CREATE }),
      "u1",
    )
  })

  it("fanOutToChannel routes a THREAD to its participant set (not the channel audience)", async () => {
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("t1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "t1",
      message: {} as never,
    } as never)

    expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledWith(
      expect.anything(),
      "t1",
      expect.any(Function),
    )
    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
  })

  it("keeps Web type and selected-branch retries as two independently labelled phases", async () => {
    const typeQuery = vi.fn(async () => "text")
    const scopeQuery = vi.fn(async () => ["u1"])
    mockResolveChannelRecipientUserIds.mockImplementationOnce(async (_db, _channelId, runQuery) => {
      await runQuery("channel-type", typeQuery)
      return runQuery("scope-members", scopeQuery)
    })

    await expect(resolveChannelRecipients({} as never, "c1")).resolves.toEqual(["u1"])

    expect(mockWithD1Retry).toHaveBeenCalledTimes(2)
    expect(mockWithD1Retry.mock.calls.map((call) => call[1])).toEqual([
      { route: "fanout:channel-type" },
      { route: "fanout:scope-members" },
    ])
    expect(typeQuery).toHaveBeenCalledTimes(1)
    expect(scopeQuery).toHaveBeenCalledTimes(1)
  })

  it("stops after a type-phase failure without starting the recipient phase", async () => {
    const failure = new Error("bad channel type")
    const scopeQuery = vi.fn(async () => ["u1"])
    mockResolveChannelRecipientUserIds.mockImplementationOnce(async (_db, _channelId, runQuery) => {
      await runQuery("channel-type", async () => { throw failure })
      return runQuery("scope-members", scopeQuery)
    })

    await expect(resolveChannelRecipients({} as never, "c1")).rejects.toBe(failure)
    expect(mockWithD1Retry).toHaveBeenCalledTimes(1)
    expect(mockWithD1Retry.mock.calls[0]?.[1]).toEqual({ route: "fanout:channel-type" })
    expect(scopeQuery).not.toHaveBeenCalled()
  })

  it("retries only the selected branch without re-reading channel type", async () => {
    const typeQuery = vi.fn(async () => "text")
    const scopeQuery = vi.fn()
      .mockRejectedValueOnce(new Error("SQLITE_BUSY"))
      .mockResolvedValueOnce(["u1"])
    mockWithD1Retry.mockImplementation(async (fn, opts) => {
      if ((opts as { route?: string }).route !== "fanout:scope-members") return fn()
      try { return await fn() } catch { return fn() }
    })
    mockResolveChannelRecipientUserIds.mockImplementationOnce(async (_db, _channelId, runQuery) => {
      await runQuery("channel-type", typeQuery)
      return runQuery("scope-members", scopeQuery)
    })

    await expect(resolveChannelRecipients({} as never, "c1")).resolves.toEqual(["u1"])
    expect(typeQuery).toHaveBeenCalledTimes(1)
    expect(scopeQuery).toHaveBeenCalledTimes(2)
  })

  it("contains no local reach classifier after delegating to shared", () => {
    const source = readFileSync(new URL("./fanout.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/\bchannelReach\b|\bisStoredChannelType\b|switch\s*\(\s*reach\s*\)/)
  })
})

describe("fanOutStatusUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockBroadcastToUsers.mockResolvedValue(undefined)
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
    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["u1", "u2", "u3"],
      {
        type: "community:status.update",
        userId: "self1",
        statusEmoji: "🎧",
        statusText: "Vibing",
      },
      undefined,
    )
  })

  it("does not broadcast when the audience is empty", async () => {
    mockGetCoMemberUserIds.mockResolvedValue([])
    mockGetFriendUserIds.mockResolvedValue([])

    await fanOutStatusUpdate("self1", null, null)

    expect(mockBroadcastToUsers).not.toHaveBeenCalled()
  })

  it("never throws — absorbs a DB error and logs a warning", async () => {
    mockGetCoMemberUserIds.mockRejectedValue(new Error("db down"))

    await expect(fanOutStatusUpdate("self1", "🎧", "Vibing")).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "fanout_status_update_failed",
      expect.objectContaining({ userId: "self1", err: expect.stringContaining("db down") }),
    )
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
    mockBroadcastToUsers.mockResolvedValue(undefined)
    mockEnqueueBotWakes.mockResolvedValue(undefined)
  })

  it("fanOutToChannel enqueues wakes using the same recipient list, minus excludeUserId", async () => {
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1", "u2", "u3"])

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

  it("starts wake enqueue before a slow recipient broadcast settles", async () => {
    let releaseBroadcast!: () => void
    mockBroadcastToUsers.mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseBroadcast = resolve
      }),
    )

    const pending = fanOutToChannel(
      "c1",
      { type: WS_EVENTS.MESSAGE_CREATE, channelId: "c1", message: {} as never } as never,
      {
        excludeUserId: "u1",
        recipients: ["u1", "u2"],
        wakeMessageRow,
      },
    )

    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    releaseBroadcast()
    await pending
  })

  it("starts wake enqueue even when the bulk hop rejects", async () => {
    mockBroadcastToUsers.mockRejectedValue(new Error("bulk down"))

    await expect(fanOutToChannel(
      "c1",
      { type: WS_EVENTS.MESSAGE_CREATE, channelId: "c1", message: {} as never } as never,
      {
        excludeUserId: "u1",
        recipients: ["u1", "u2"],
        wakeMessageRow,
      },
    )).resolves.toBeUndefined()

    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
  })

  it("fire-and-forget fanOut registers its waitUntil before recipient resolution settles", async () => {
    const waitUntil = vi.fn()
    mockGetCloudflareContext.mockImplementation(() => ({
      env: { DB: {} },
      ctx: { waitUntil },
    }))
    let releaseRecipients!: (ids: string[]) => void
    mockResolveChannelRecipientUserIds.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => {
        releaseRecipients = resolve
      }),
    )

    const floatingFanout = fanOutToChannel(
      "c1",
      { type: WS_EVENTS.MESSAGE_CREATE, channelId: "c1", message: {} as never } as never,
      {
        excludeUserId: "u1",
        wakeMessageRow,
      },
    )

    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()

    releaseRecipients(["u1", "u2"])
    await waitUntil.mock.calls[0]![0]
    expect(mockEnqueueBotWakes).toHaveBeenCalledTimes(1)
    await floatingFanout
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
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1", "u2"])

    await fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)

    expect(mockEnqueueBotWakes).not.toHaveBeenCalled()
  })

  it("does not enqueue wakes for non-MESSAGE_CREATE events even with a wakeMessageRow", async () => {
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1", "u2"])

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
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1"])
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
    mockBroadcastToUsers.mockResolvedValue(undefined)
  })

  it("all shared-payload fanout helpers absorb a bulk rejection", async () => {
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUsers.mockRejectedValue(new Error("bulk down"))
    mockListMemberUserIds.mockResolvedValue(["u1"])
    mockResolveChannelRecipientUserIds.mockResolvedValue(["u1"])
    mockGetDM.mockResolvedValue({ id: "dm1" })
    mockListChannelMemberUserIds.mockResolvedValue(["u1"])
    mockGetCoMemberUserIds.mockResolvedValue(["u1"])
    mockGetFriendUserIds.mockResolvedValue([])

    await expect(fanOutToServerMembers("srv1", {
      type: WS_EVENTS.MEMBER_UPDATE,
      serverId: "srv1",
      memberId: "m1",
      changes: { role: "admin" },
    })).resolves.toBeUndefined()
    await expect(fanOutToChannel("c1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "c1",
      message: {} as never,
    } as never)).resolves.toBeUndefined()
    await expect(fanOutToDM("dm1", {
      type: WS_EVENTS.MESSAGE_CREATE,
      channelId: "dm1",
      message: {} as never,
    } as never)).resolves.toBeUndefined()
    await expect(fanOutStatusUpdate("u1", null, null)).resolves.toBeUndefined()

    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(4)
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

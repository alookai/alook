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
        listDmPeerUserIds: (...a: unknown[]) => mockListDmPeerUserIds(...a),
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

const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockGetChannel = vi.fn()
const mockIsChannelPrivate = vi.fn(() => false)
const mockGetPrivateChannelAudienceUserIds = vi.fn(() => [] as string[])
const mockGetDM = vi.fn()
const mockListDmPeerUserIds = vi.fn(() => Promise.resolve([] as string[]))
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
  fanOutIdentityUpdate,
  fanOutProfileUpdate,
  broadcastToUserSafe,
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

  it("resolves recipients via listMemberUserIds and includes every account connection", async () => {
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3", "u4", "u5"])

    await fanOutToServerMembers(
      "srv_1",
      {
        type: WS_EVENTS.MEMBER_UPDATE,
        serverId: "srv_1",
        memberId: "m1",
        changes: { role: "admin" },
      },
    )

    expect(mockListMemberUserIds).toHaveBeenCalledTimes(1)
    expect(mockListMembers).not.toHaveBeenCalled()

    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["u1", "u2", "u3", "u4", "u5"],
      expect.objectContaining({ type: WS_EVENTS.MEMBER_UPDATE }),
    )
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
  })

  it("broadcasts to every recipient", async () => {
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
    )

    expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledWith(
      expect.anything(),
      "dm1",
      expect.any(Function),
    )
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["u1", "u2"],
      expect.objectContaining({ type: WS_EVENTS.MESSAGE_CREATE }),
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

  it("broadcasts to self plus the deduped union of co-members and friends", async () => {
    mockGetCoMemberUserIds.mockResolvedValue(["u1", "u2"])
    mockGetFriendUserIds.mockResolvedValue(["u2", "u3"])

    await fanOutStatusUpdate("self1", "🎧", "Vibing")

    expect(mockGetCoMemberUserIds).toHaveBeenCalledWith(expect.anything(), "self1")
    expect(mockGetFriendUserIds).toHaveBeenCalledWith(expect.anything(), "self1")
    expect(mockBroadcastToUsers).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["self1", "u1", "u2", "u3"],
      {
        type: "community:status.update",
        userId: "self1",
        statusEmoji: "🎧",
        statusText: "Vibing",
      },
    )
  })

  it("still broadcasts to the author's other tabs when no peer audience exists", async () => {
    mockGetCoMemberUserIds.mockResolvedValue([])
    mockGetFriendUserIds.mockResolvedValue([])

    await fanOutStatusUpdate("self1", null, null)

    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["self1"],
      expect.objectContaining({ type: "community:status.update" }),
    )
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

describe("fanOutIdentityUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({
      env: { DB: {} },
      ctx: { waitUntil: vi.fn() },
    }))
    mockBroadcastToUsers.mockResolvedValue(undefined)
  })

  it("broadcasts only to self plus the deduped co-member, friend, and DM audience", async () => {
    mockGetCoMemberUserIds.mockResolvedValue(["co-member", "shared"])
    mockGetFriendUserIds.mockResolvedValue(["friend", "shared"])
    mockListDmPeerUserIds.mockResolvedValue(["dm-peer", "friend"])

    await fanOutIdentityUpdate("self", "/api/community/users/self/avatar?v=5", 5)

    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["self", "co-member", "shared", "friend", "dm-peer"],
      {
        type: "community:identity.update",
        userId: "self",
        avatar: "/api/community/users/self/avatar?v=5",
        avatarVersion: 5,
      },
    )
    expect(mockBroadcastToUsers.mock.calls[0]![0]).not.toContain("stranger")
  })

  it("retains worker lifetime while recipient resolution is pending", async () => {
    const waitUntil = vi.fn()
    mockGetCloudflareContext.mockImplementation(() => ({
      env: { DB: {} },
      ctx: { waitUntil },
    }))
    let release!: (ids: string[]) => void
    mockGetCoMemberUserIds.mockReturnValue(new Promise((resolve) => { release = resolve }))
    mockGetFriendUserIds.mockResolvedValue([])
    mockListDmPeerUserIds.mockResolvedValue([])

    const work = fanOutIdentityUpdate("self", "/avatar?v=1", 1)
    expect(waitUntil).toHaveBeenCalledWith(work)
    release([])
    await work
    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["self"],
      expect.objectContaining({ type: "community:identity.update" }),
    )
  })

  it("absorbs an asynchronous identity audience failure", async () => {
    mockGetCoMemberUserIds.mockRejectedValue("D1 unavailable")
    mockGetFriendUserIds.mockResolvedValue([])
    mockListDmPeerUserIds.mockResolvedValue([])

    await expect(fanOutIdentityUpdate("self", "/avatar?v=1", 1)).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "fanout_identity_update_failed",
      { subjectId: "self", errorCategory: "NonError" },
    )
    expect(mockBroadcastToUsers).not.toHaveBeenCalled()
  })

  it("absorbs a synchronous identity fanout setup failure", async () => {
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no worker context")
    })

    await expect(fanOutIdentityUpdate("self", "/avatar?v=1", 1)).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "fanout_identity_update_failed",
      { subjectId: "self", errorCategory: "Error" },
    )
  })
})

describe("fanOutProfileUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockImplementation(() => ({ env: { DB: {} } }))
    mockBroadcastToUsers.mockResolvedValue(undefined)
    mockGetCoMemberUserIds.mockResolvedValue(["co-member", "shared"])
    mockGetFriendUserIds.mockResolvedValue(["friend", "shared"])
    mockListDmPeerUserIds.mockResolvedValue(["dm-peer"])
  })

  it("broadcasts the canonical bot profile to self, peers, and its owner", async () => {
    await fanOutProfileUpdate({
      id: "bot_1",
      name: "Bot",
      discriminator: "0042",
      aboutMe: "Helper",
      bannerColor: "#123456",
      identity: { kind: "bot", ownerProfile: { id: "owner_1" } },
    })

    expect(mockBroadcastToUsers).toHaveBeenCalledWith(
      ["bot_1", "co-member", "shared", "friend", "dm-peer", "owner_1"],
      {
        type: "community:profile.update",
        userId: "bot_1",
        name: "Bot",
        discriminator: "0042",
        aboutMe: "Helper",
        bannerColor: "#123456",
        kind: "bot",
        ownerUserId: "owner_1",
      },
    )
  })

  it("uses no owner for humans and contains audience failures", async () => {
    mockGetCoMemberUserIds.mockRejectedValueOnce(new Error("db down"))

    await expect(fanOutProfileUpdate({
      id: "human_1",
      name: "Human",
      discriminator: "0001",
      aboutMe: "",
      bannerColor: null,
      identity: { kind: "human" },
    })).resolves.toBeUndefined()

    expect(mockWarn).toHaveBeenCalledWith(
      "fanout_profile_update_failed",
      expect.objectContaining({ userId: "human_1", err: expect.stringContaining("db down") }),
    )
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

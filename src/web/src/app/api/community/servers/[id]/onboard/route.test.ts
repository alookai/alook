import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getMember: vi.fn(),
  addMember: vi.fn(),
  getBotOwnedBy: vi.fn(),
  getBotWakeContext: vi.fn(),
  getServer: vi.fn(),
  listServerChannels: vi.fn(),
  markRead: vi.fn(),
  push: vi.fn(),
  fanOutServer: vi.fn(),
  broadcastToUser: vi.fn(),
  messageBroadcast: vi.fn(),
  createMessage: vi.fn(),
}))

vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    queries: {
      communityMember: {
        getMember: (...args: unknown[]) => mocks.getMember(...args),
        addMember: (...args: unknown[]) => mocks.addMember(...args),
      },
      communityBot: {
        getBotOwnedBy: (...args: unknown[]) => mocks.getBotOwnedBy(...args),
        getBotWakeContext: (...args: unknown[]) => mocks.getBotWakeContext(...args),
      },
      communityChannel: {
        listServerChannels: (...args: unknown[]) => mocks.listServerChannels(...args),
      },
      communityServer: {
        getServer: (...args: unknown[]) => mocks.getServer(...args),
      },
      communityReadState: {
        markReadToMessageWithRevision: (...args: unknown[]) => mocks.markRead(...args),
      },
    },
  }
})
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: Function) => (req: NextRequest, context?: { params?: Record<string, string> }) =>
    handler(req, {
      env: {},
      userId: "owner-1",
      params: context?.params,
    }),
}))
vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...args: unknown[]) => mocks.push(...args),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...args: unknown[]) => mocks.fanOutServer(...args),
  broadcastToUserSafe: (...args: unknown[]) => mocks.broadcastToUser(...args),
}))
vi.mock("@/lib/community/message-handler", () => ({
  createCommunityMessage: (...args: unknown[]) => mocks.createMessage(...args),
}))
vi.mock("@/lib/community/storage", () => ({ canonicalUserImage: () => null }))

import { onboardingGettingReadyMessage, onboardingPromptWithSpace, POST } from "./route"

function request(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/server-1/onboard", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

function onboardBody(
  ids = ["bot-a", "bot-b"],
  action: { type: "wake"; botId: string } | { type: "finalize" } = {
    type: "wake",
    botId: ids[0]!,
  },
) {
  return {
    bots: ids.map((id) => ({ id, wakePrompt: `Wake ${id}` })),
    leadBotId: ids[0],
    action,
  }
}

const bot = (id: string) => ({
  id,
  name: id === "bot-a" ? "Lead" : id === "bot-b" ? "Doer" : "Reviewer",
  discriminator: id === "bot-a" ? "0001" : id === "bot-b" ? "0002" : "0003",
  image: null,
  avatarVersion: 0,
  machineId: "machine-1",
})
const wake = (id: string) => ({
  state: "ready" as const,
  botUserId: id,
  name: bot(id).name,
  discriminator: bot(id).discriminator,
  machineId: "machine-1",
  runtime: "codex",
  modelName: null,
  reasoningEffort: null,
  runtimeConfigRevision: 0,
  ownerUserId: "owner-1",
})

describe("POST /api/community/servers/[id]/onboard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMember.mockImplementation((_db, _serverId, userId) =>
      userId === "owner-1" ? { id: "owner-member", role: "owner" } : null,
    )
    mocks.getBotOwnedBy.mockImplementation((_db, id) => bot(id))
    mocks.getBotWakeContext.mockImplementation((_db, id) => wake(id))
    mocks.getServer.mockResolvedValue({
      id: "server-1",
      name: "Ada-dev-room",
      discriminator: "5620",
    })
    mocks.addMember.mockImplementation((_db, data) => ({
      id: `member-${data.userId}`,
      userId: data.userId,
      role: "member",
      joinedAt: "2026-09-04T00:00:00.000Z",
    }))
    mocks.listServerChannels.mockResolvedValue([
      { id: "public-1", name: "all", type: "text" },
      { id: "private-1", name: "room", type: "text" },
    ])
    mocks.createMessage.mockResolvedValue({
      ok: true,
      row: {
        id: "welcome-1",
        channelId: "public-1",
        createdAt: "2026-09-07T06:00:00.000Z",
        seq: 4,
      },
      attachments: [],
      broadcast: (...args: unknown[]) => mocks.messageBroadcast(...args),
    })
    mocks.markRead.mockResolvedValue({ count: 1, changed: true, revision: 7 })
    mocks.push.mockResolvedValue({ sent: 1 })
    mocks.fanOutServer.mockResolvedValue(undefined)
    mocks.messageBroadcast.mockResolvedValue(undefined)
    mocks.broadcastToUser.mockResolvedValue(undefined)
  })

  it("formats three or more teammate handles as an Oxford list", () => {
    expect(onboardingGettingReadyMessage(["@One#0001", "@Two#0002", "@Three#0003"]))
      .toContain("with @One#0001, @Two#0002, and @Three#0003")
  })

  it("adds every bot before per-bot wakes, then finalizes one Lead-authored welcome", async () => {
    const memberIds = new Set(["owner-1"])
    mocks.getMember.mockImplementation((_db, _serverId, userId) =>
      memberIds.has(userId)
        ? { id: `member-${userId}`, role: userId === "owner-1" ? "owner" : "member" }
        : null,
    )
    mocks.addMember.mockImplementation((_db, data) => {
      memberIds.add(data.userId)
      return {
        id: `member-${data.userId}`,
        userId: data.userId,
        role: "member",
        joinedAt: "2026-09-04T00:00:00.000Z",
      }
    })
    const ids = ["bot-a", "bot-b", "bot-c"]
    const wakeResponses = []
    for (const id of ids) {
      wakeResponses.push(await POST(request(onboardBody(ids, { type: "wake", botId: id })), {
        params: { id: "server-1" },
      }))
    }
    const finalizeResponse = await POST(request(onboardBody(ids, { type: "finalize" })), {
      params: { id: "server-1" },
    })

    expect(wakeResponses.map((response) => response.status)).toEqual([200, 200, 200])
    await expect(wakeResponses[0]!.json()).resolves.toEqual({ onboarded: 1, finalized: false })
    expect(finalizeResponse.status).toBe(200)
    expect(await finalizeResponse.json()).toEqual({ onboarded: 0, finalized: true })
    expect(mocks.addMember).toHaveBeenCalledTimes(3)
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      authorId: "bot-a",
      authorKind: "bot",
      target: { kind: "channel", channelId: "public-1", serverId: "server-1" },
      body: {
        content: onboardingGettingReadyMessage(["@Doer#0002", "@Reviewer#0003"]),
      },
      deferBroadcast: true,
      clientNonce: "srv:onboarding-ready:server-1",
    }))
    expect(mocks.createMessage.mock.calls[0]![0]).not.toHaveProperty("skipMentions")
    expect(mocks.markRead.mock.calls.map((call) => call[1])).toEqual([
      {
        userId: "owner-1",
        channelId: "public-1",
        message: expect.objectContaining({ id: "welcome-1", seq: 4 }),
      },
      {
        userId: "bot-a",
        channelId: "public-1",
        message: expect.objectContaining({ id: "welcome-1", seq: 4 }),
      },
      {
        userId: "bot-b",
        channelId: "public-1",
        message: expect.objectContaining({ id: "welcome-1", seq: 4 }),
      },
      {
        userId: "bot-c",
        channelId: "public-1",
        message: expect.objectContaining({ id: "welcome-1", seq: 4 }),
      },
    ])
    expect(mocks.messageBroadcast).toHaveBeenCalledOnce()
    expect(mocks.push.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.createMessage.mock.invocationCallOrder[0]!,
    )
    expect(mocks.messageBroadcast.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markRead.mock.invocationCallOrder[0]!,
    )
    expect(mocks.broadcastToUser).toHaveBeenCalledWith("owner-1", expect.objectContaining({
      revision: 7,
      inboxChanged: true,
    }))
    expect(mocks.push.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({
        type: "agent:event",
        agentId: "bot-a",
        includeRecentContext: true,
        prompt: onboardingPromptWithSpace("Wake bot-a", "Ada-dev-room#5620", "all"),
      }),
      expect.objectContaining({
        type: "agent:event",
        agentId: "bot-b",
        prompt: onboardingPromptWithSpace("Wake bot-b", "Ada-dev-room#5620", "all"),
      }),
      expect.objectContaining({
        type: "agent:event",
        agentId: "bot-c",
        prompt: onboardingPromptWithSpace("Wake bot-c", "Ada-dev-room#5620", "all"),
      }),
    ])
    expect(mocks.push.mock.calls[1]![2]).not.toHaveProperty("includeRecentContext")
    expect(mocks.push.mock.calls[2]![2]).not.toHaveProperty("includeRecentContext")
  })

  it("does not rebroadcast an idempotent getting-ready replay", async () => {
    mocks.createMessage.mockResolvedValue({
      ok: true,
      row: {
        id: "welcome-1",
        channelId: "public-1",
        createdAt: "2026-09-07T06:00:00.000Z",
        seq: 4,
      },
      attachments: [],
      deduped: true,
    })
    mocks.markRead.mockResolvedValue({ count: 1, changed: false, revision: 7 })

    const response = await POST(request(onboardBody(
      ["bot-a", "bot-b"],
      { type: "finalize" },
    )), { params: { id: "server-1" } })

    expect(response.status).toBe(200)
    expect(mocks.messageBroadcast).not.toHaveBeenCalled()
    expect(mocks.broadcastToUser).not.toHaveBeenCalled()
    expect(mocks.markRead).toHaveBeenCalledWith(expect.anything(), {
      userId: "owner-1",
      channelId: "public-1",
      message: expect.objectContaining({ id: "welcome-1", seq: 4 }),
    })
  })

  it("keeps existing memberships and reports an offline daemon", async () => {
    mocks.getMember.mockResolvedValue({ id: "member", role: "member" })
    mocks.push.mockResolvedValue({ sent: 0 })

    const response = await POST(request(onboardBody(["bot-a"])), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(409)
    expect(mocks.addMember).not.toHaveBeenCalled()
  })

  it("rejects a caller who is not a server member", async () => {
    mocks.getMember.mockResolvedValue(null)

    const response = await POST(request(onboardBody(["bot-a"])), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(403)
    expect(mocks.getBotOwnedBy).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("rejects a bot whose wake context is not ready before changing membership", async () => {
    mocks.getBotWakeContext.mockResolvedValue({ state: "machine_offline" })

    const response = await POST(request(onboardBody(["bot-a"])), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(409)
    expect(mocks.addMember).not.toHaveBeenCalled()
    expect(mocks.createMessage).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("recovers a concurrent membership insert by re-reading the member", async () => {
    const racedMember = {
      id: "member-bot-a",
      userId: "bot-a",
      role: "member",
      joinedAt: "2026-09-04T00:00:00.000Z",
    }
    mocks.getMember
      .mockResolvedValueOnce({ id: "owner-member", role: "owner" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(racedMember)
    mocks.addMember.mockRejectedValue(new Error("UNIQUE constraint failed"))

    const response = await POST(request(onboardBody(["bot-a"])), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(200)
    expect(mocks.getMember).toHaveBeenCalledTimes(3)
    expect(mocks.fanOutServer).toHaveBeenCalledTimes(1)
    expect(mocks.push).toHaveBeenCalledTimes(1)
  })

  it("rejects foreign bots and malformed bot lists", async () => {
    mocks.getBotOwnedBy.mockResolvedValue(null)
    const foreign = await POST(request(onboardBody(["bot-a"])), {
      params: { id: "server-1" },
    })
    expect(foreign.status).toBe(404)

    const duplicate = await POST(request({
      bots: [
        { id: "bot-a", wakePrompt: "Lead" },
        { id: "bot-a", wakePrompt: "Do" },
      ],
      leadBotId: "bot-a",
      action: { type: "wake", botId: "bot-a" },
    }), { params: { id: "server-1" } })
    expect(duplicate.status).toBe(400)

    const missingLead = await POST(request({
      bots: [{ id: "bot-a", wakePrompt: "Do" }],
      leadBotId: "bot-b",
      action: { type: "wake", botId: "bot-a" },
    }), { params: { id: "server-1" } })
    expect(missingLead.status).toBe(400)
  })

  it("rejects blank and oversized wake prompts", async () => {
    for (const wakePrompt of ["   ", "x".repeat(32_769)]) {
      const response = await POST(request({
        bots: [{ id: "bot-a", wakePrompt }],
        leadBotId: "bot-a",
        action: { type: "wake", botId: "bot-a" },
      }), { params: { id: "server-1" } })
      expect(response.status).toBe(400)
    }

    expect(mocks.getBotOwnedBy).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("rejects a prompt that exceeds the event limit after refs are appended", async () => {
    const response = await POST(request({
      bots: [{ id: "bot-a", wakePrompt: "x".repeat(32_768) }],
      leadBotId: "bot-a",
      action: { type: "wake", botId: "bot-a" },
    }), { params: { id: "server-1" } })

    expect(response.status).toBe(400)
    expect(mocks.addMember).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })
})

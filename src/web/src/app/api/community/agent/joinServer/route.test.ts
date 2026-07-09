import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockGetInviteByToken = vi.fn()
const mockUseInvite = vi.fn()
const mockGetServer = vi.fn()
const mockFanOutToServerMembers = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityInvite: {
        getInviteByToken: (...a: unknown[]) => mockGetInviteByToken(...a),
        useInvite: (...a: unknown[]) => mockUseInvite(...a),
      },
      communityServer: { getServer: (...a: unknown[]) => mockGetServer(...a) },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOutToServerMembers(...a),
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return {
    ...actual,
    logAudit: (...a: unknown[]) => mockLogAudit(...a),
  }
})

import { POST } from "./route"
import { isUniqueConstraintError } from "@alook/shared"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/joinServer", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/joinServer", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ invite: "tok_abc" }))
    expect(res.status).toBe(401)
    expect(mockGetInviteByToken).not.toHaveBeenCalled()
  })

  it("400 'Invalid or expired invite' for an unknown token", async () => {
    mockGetInviteByToken.mockResolvedValue(null)
    const res = await POST(req({ invite: "tok_unknown" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid or expired invite")
    expect(mockUseInvite).not.toHaveBeenCalled()
  })

  it("400 'Invalid or expired invite' (NOT a 403) when invite.createdBy is null", async () => {
    mockGetInviteByToken.mockResolvedValue({ id: "inv_1", serverId: "srv_1", createdBy: null })
    const res = await POST(req({ invite: "tok_abc" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid or expired invite")
    expect(mockUseInvite).not.toHaveBeenCalled()
  })

  it("403 with hint when invite.createdBy is a real, different user id than ctx.ownerUserId", async () => {
    mockGetInviteByToken.mockResolvedValue({ id: "inv_1", serverId: "srv_1", createdBy: "stranger_1" })
    const res = await POST(req({ invite: "tok_abc" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain("not created by your owner")
    expect(body.hint).toBe("Ask your owner to send an invite link they created themselves.")
    expect(mockUseInvite).not.toHaveBeenCalled()
  })

  it("400 'Already a member' on a unique-constraint re-join", async () => {
    mockGetInviteByToken.mockResolvedValue({ id: "inv_1", serverId: "srv_1", createdBy: "owner_1" })
    mockUseInvite.mockRejectedValue(new Error("UNIQUE constraint failed"))
    const res = await POST(req({ invite: "tok_abc" }, { Authorization: "Bearer crk_abc" }))
    // Guard the test against the mocked isUniqueConstraintError predicate diverging silently.
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed"))).toBe(true)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Already a member")
  })

  it("200 {server:{id,name}} on success; fanOutToServerMembers excludes the bot; logAudit uses BOT_JOINED_VIA_INVITE + botUserId", async () => {
    mockGetInviteByToken.mockResolvedValue({ id: "inv_1", serverId: "srv_1", createdBy: "owner_1" })
    mockUseInvite.mockResolvedValue({
      invite: { id: "inv_1", serverId: "srv_1" },
      member: { id: "mem_1", userId: "bot_1", role: "member", nickname: null, userName: "bot", userImage: null, discriminator: "1234", joinedAt: "2026-01-01" },
    })
    mockGetServer.mockResolvedValue({ id: "srv_1", name: "Design Studio" })

    const res = await POST(req({ invite: "tok_abc" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ server: { id: "srv_1", name: "Design Studio" } })

    expect(mockFanOutToServerMembers).toHaveBeenCalledWith(
      "srv_1",
      expect.objectContaining({ serverId: "srv_1" }),
      { excludeUserId: "bot_1" },
    )
    // The bot's owner isn't necessarily a server member, so the fan-out
    // above can't reach them. The route must ALSO notify the owner
    // directly so their bot-list / server-rail updates without a hard
    // refresh — regression guard for review finding #7.
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith(
      "owner_1",
      expect.objectContaining({ serverId: "srv_1" }),
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "community.bot.joined_via_invite",
        actorId: "bot_1",
        targetType: "invite",
        targetId: "inv_1",
      }),
    )
  })
})

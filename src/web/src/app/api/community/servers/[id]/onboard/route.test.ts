import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getMember: vi.fn(),
  addMember: vi.fn(),
  getBotOwnedBy: vi.fn(),
  getBotWakeContext: vi.fn(),
  push: vi.fn(),
  fanOut: vi.fn(),
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
  fanOutToServerMembers: (...args: unknown[]) => mocks.fanOut(...args),
}))
vi.mock("@/lib/community/storage", () => ({ canonicalUserImage: () => null }))

import { POST } from "./route"

function request(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/server-1/onboard", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const bot = (id: string) => ({
  id,
  name: id,
  discriminator: "0001",
  image: null,
  avatarVersion: 0,
  machineId: "machine-1",
})
const wake = (id: string) => ({
  state: "ready" as const,
  botUserId: id,
  name: id,
  discriminator: "0001",
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
    mocks.addMember.mockImplementation((_db, data) => ({
      id: `member-${data.userId}`,
      userId: data.userId,
      role: "member",
      joinedAt: "2026-09-04T00:00:00.000Z",
    }))
    mocks.push.mockResolvedValue({ sent: 1 })
    mocks.fanOut.mockResolvedValue(undefined)
  })

  it("adds missing bots and sends the same direct event to each one", async () => {
    const response = await POST(request({
      botIds: ["bot-a", "bot-b"],
      wakePrompt: "Welcome the user.",
    }), { params: { id: "server-1" } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ onboarded: 2 })
    expect(mocks.addMember).toHaveBeenCalledTimes(2)
    expect(mocks.push).toHaveBeenCalledTimes(2)
    expect(mocks.push.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ type: "agent:event", agentId: "bot-a", prompt: "Welcome the user." }),
      expect.objectContaining({ type: "agent:event", agentId: "bot-b", prompt: "Welcome the user." }),
    ])
  })

  it("keeps existing memberships and reports an offline daemon", async () => {
    mocks.getMember.mockResolvedValue({ id: "member", role: "member" })
    mocks.push.mockResolvedValue({ sent: 0 })

    const response = await POST(request({ botIds: ["bot-a"], wakePrompt: "Wake up" }), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(409)
    expect(mocks.addMember).not.toHaveBeenCalled()
  })

  it("rejects a caller who is not a server member", async () => {
    mocks.getMember.mockResolvedValue(null)

    const response = await POST(request({ botIds: ["bot-a"], wakePrompt: "Wake up" }), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(403)
    expect(mocks.getBotOwnedBy).not.toHaveBeenCalled()
    expect(mocks.addMember).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("rejects a bot whose wake context is not ready before changing membership", async () => {
    mocks.getBotWakeContext.mockResolvedValue({ state: "machine_offline" })

    const response = await POST(request({ botIds: ["bot-a"], wakePrompt: "Wake up" }), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(409)
    expect(mocks.addMember).not.toHaveBeenCalled()
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

    const response = await POST(request({ botIds: ["bot-a"], wakePrompt: "Wake up" }), {
      params: { id: "server-1" },
    })

    expect(response.status).toBe(200)
    expect(mocks.getMember).toHaveBeenCalledTimes(3)
    expect(mocks.fanOut).toHaveBeenCalledTimes(1)
    expect(mocks.push).toHaveBeenCalledTimes(1)
  })

  it("rejects a foreign bot, duplicate bot ids, and an empty bot list", async () => {
    mocks.getBotOwnedBy.mockResolvedValue(null)
    const foreign = await POST(request({ botIds: ["bot-a"], wakePrompt: "Wake up" }), {
      params: { id: "server-1" },
    })
    expect(foreign.status).toBe(404)

    const duplicate = await POST(request({ botIds: ["bot-a", "bot-a"], wakePrompt: "Wake up" }), {
      params: { id: "server-1" },
    })
    expect(duplicate.status).toBe(400)

    const empty = await POST(request({ botIds: [], wakePrompt: "Wake up" }), {
      params: { id: "server-1" },
    })
    expect(empty.status).toBe(400)
  })

  it("rejects blank and oversized wake prompts", async () => {
    for (const wakePrompt of ["   ", "x".repeat(32_769)]) {
      const response = await POST(request({ botIds: ["bot-a"], wakePrompt }), {
        params: { id: "server-1" },
      })
      expect(response.status).toBe(400)
    }

    expect(mocks.getBotOwnedBy).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })
})

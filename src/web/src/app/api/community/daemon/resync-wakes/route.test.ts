import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindCred = vi.fn()
const mockListBotsForMachine = vi.fn()
const mockGetLatestUnreadMessageForAgent = vi.fn()
const mockDispatchOneUnreadWake = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<any>("@alook/shared")
  return {
    ...actual,
    dispatchOneUnreadWake: (...a: unknown[]) => mockDispatchOneUnreadWake(...a),
    queries: {
      communityMachine: {
        findActiveCredentialByBearer: (...a: unknown[]) => mockFindCred(...a),
      },
      communityBot: {
        listBotsForMachine: (...a: unknown[]) => mockListBotsForMachine(...a),
      },
      communityAgentInbox: {
        getLatestUnreadMessageForAgent: (...a: unknown[]) => mockGetLatestUnreadMessageForAgent(...a),
      },
    },
  }
})

import { POST } from "./route"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/daemon/resync-wakes", {
    method: "POST",
    headers,
  })
}

describe("POST /api/community/daemon/resync-wakes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindCred.mockResolvedValue({ credentialId: "cmk_ok", userId: "u_1", machineId: "cm_1" })
  })

  it("returns { woken: 0 } and does nothing when the machine has no bots", async () => {
    mockListBotsForMachine.mockResolvedValue([])
    const res = await POST(req({ Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ woken: 0 })
    expect(mockGetLatestUnreadMessageForAgent).not.toHaveBeenCalled()
    expect(mockDispatchOneUnreadWake).not.toHaveBeenCalled()
  })

  it("dispatches a wake for a bot with pending unread and counts it", async () => {
    mockListBotsForMachine.mockResolvedValue([{ id: "bot_1", name: "cindy", description: "" }])
    mockGetLatestUnreadMessageForAgent.mockResolvedValue({ messageId: "msg_1" })
    mockDispatchOneUnreadWake.mockResolvedValue({ outcome: "sent" })

    const res = await POST(req({ Authorization: "Bearer cmk_ok" }))

    expect(mockDispatchOneUnreadWake).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { messageId: "msg_1", botUserId: "bot_1" }
    )
    expect(await res.json()).toEqual({ woken: 1 })
  })

  it("skips bots with no pending unread — not counted, dispatch never called for them", async () => {
    mockListBotsForMachine.mockResolvedValue([{ id: "bot_1", name: "cindy", description: "" }])
    mockGetLatestUnreadMessageForAgent.mockResolvedValue(null)

    const res = await POST(req({ Authorization: "Bearer cmk_ok" }))

    expect(mockDispatchOneUnreadWake).not.toHaveBeenCalled()
    expect(await res.json()).toEqual({ woken: 0 })
  })

  it("does not count a skip/delivered_nowhere outcome as woken", async () => {
    mockListBotsForMachine.mockResolvedValue([
      { id: "bot_1", name: "a", description: "" },
      { id: "bot_2", name: "b", description: "" },
    ])
    mockGetLatestUnreadMessageForAgent.mockResolvedValue({ messageId: "msg_x" })
    mockDispatchOneUnreadWake
      .mockResolvedValueOnce({ outcome: "skip", reason: "already_read" })
      .mockResolvedValueOnce({ outcome: "delivered_nowhere", machineId: "cm_1" })

    const res = await POST(req({ Authorization: "Bearer cmk_ok" }))

    expect(await res.json()).toEqual({ woken: 0 })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(mockListBotsForMachine).not.toHaveBeenCalled()
  })

  it("401 with unknown credential", async () => {
    mockFindCred.mockResolvedValue(null)
    const res = await POST(req({ Authorization: "Bearer cmk_bad" }))
    expect(res.status).toBe(401)
  })
})

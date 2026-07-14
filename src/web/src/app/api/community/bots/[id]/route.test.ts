import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetBotOwnedBy = vi.fn()
const mockUpdateBot = vi.fn()
const mockGetUserPublic = vi.fn()
const mockPushBotEventToMachine = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: {
        getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
        updateBot: (...a: unknown[]) => mockUpdateBot(...a),
      },
      user: {
        getUserPublic: (...a: unknown[]) => mockGetUserPublic(...a),
      },
    },
  }
})

vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...a: unknown[]) => mockPushBotEventToMachine(...a),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: vi.fn(),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  },
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  const actual = await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
  return {
    ...actual,
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { PATCH } from "./route"

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/bots/b1", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}
const ctx = { params: { id: "b1" } } as any

describe("PATCH /api/community/bots/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
    })
    mockUpdateBot.mockResolvedValue({
      id: "b1", name: "New", discriminator: "0001", description: "new desc", image: null,
    })
    mockGetUserPublic.mockResolvedValue({ id: "u1", name: "Owner", discriminator: "9999" })
  })

  it("updates and pushes bot:updated to the daemon when the name changed", async () => {
    const res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBot).toHaveBeenCalled()
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({ type: "bot:updated", name: "New", ownerName: "Owner" }),
    )
  })

  it("resolves the owner BEFORE mutating: an unresolvable owner fails 500 without writing", async () => {
    mockGetUserPublic.mockResolvedValue(null)
    const res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(500)
    // The row must NOT have been mutated — otherwise a retry sees no diff and
    // never pushes, leaving the daemon prompt permanently stale.
    expect(mockUpdateBot).not.toHaveBeenCalled()
    expect(mockPushBotEventToMachine).not.toHaveBeenCalled()
  })

  it("image-only change does not resolve the owner or push (display-only)", async () => {
    mockUpdateBot.mockResolvedValue({ id: "b1", name: "Old", discriminator: "0001", description: "old desc", image: "avatar:sunset" })
    const res = await PATCH(patchReq({ image: "avatar:sunset" }), ctx)
    expect(res.status).toBe(200)
    expect(mockGetUserPublic).not.toHaveBeenCalled()
    expect(mockPushBotEventToMachine).not.toHaveBeenCalled()
    expect(mockUpdateBot).toHaveBeenCalled()
  })
})

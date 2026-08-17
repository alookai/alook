import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getBotOwnedBy = vi.fn()
const setServerLevel = vi.fn()
const requireServerMember = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: { getBotOwnedBy: (...args: unknown[]) => getBotOwnedBy(...args) },
      communityNotificationSetting: {
        getServerSetting: vi.fn(),
        setServerLevel: (...args: unknown[]) => setServerLevel(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({
  requireServerMember: (...args: unknown[]) => requireServerMember(...args),
}))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: NextRequest, ctx: any) => handler(req, {
    env: { DB: {} }, userId: ctx.actor ?? "owner", email: "owner@test", params: ctx.params,
  }),
}))

import { PUT } from "./route"

const ctx = { params: { id: "bot_1", scopeId: "server_1" } } as any
const put = () => new NextRequest("http://local", { method: "PUT", body: JSON.stringify({ level: "nothing" }) })

describe("owner bot server notification settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getBotOwnedBy.mockResolvedValue({ id: "bot_1", ownerUserId: "owner" })
    requireServerMember.mockResolvedValue({ ok: true, value: { role: "member" } })
    setServerLevel.mockResolvedValue({ level: "nothing" })
  })

  it("checks bot membership and writes the bot user id", async () => {
    const response = await PUT(put(), ctx)
    expect(response.status).toBe(200)
    expect(requireServerMember).toHaveBeenCalledWith({}, "server_1", "bot_1")
    expect(setServerLevel).toHaveBeenCalledWith({}, {
      userId: "bot_1", serverId: "server_1", level: "nothing",
    })
  })

  it("rejects a bot that cannot access the server", async () => {
    requireServerMember.mockResolvedValue({ ok: false, status: 403, error: "not a member" })
    const response = await PUT(put(), ctx)
    expect(response.status).toBe(403)
    expect(setServerLevel).not.toHaveBeenCalled()
  })
})

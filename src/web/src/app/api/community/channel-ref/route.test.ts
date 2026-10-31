import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ db: {}, resolve: vi.fn() }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => m.db }))
vi.mock("@/lib/community/channel-ref-target", () => ({ resolveChannelRefTarget: m.resolve }))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: { resolve: async (request: NextRequest) => ({ context: { env: { DB: {} } as Env, userId: "viewer", email: "viewer@example.test" } }) } }))
import { GET } from "./route"
beforeEach(() => { m.resolve.mockReset() })
describe("human readonly channel ref route", () => {
  it("passes the authenticated viewer and original ref to the primary-db resolver", async () => {
    const target = { server: { id: "s", name: "Alook" }, channel: { id: "post", name: "Archived post", parentChannelId: "forum" } }
    m.resolve.mockResolvedValue({ target })
    const ref = "/Alook#5620/fix/#259#18"
    const response = await GET(new NextRequest(`https://test.local/api/community/channel-ref?${new URLSearchParams({ ref })}`))
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ target })
    expect(m.resolve).toHaveBeenCalledExactlyOnceWith(m.db, "viewer", ref)
  })
  it.each([[400, "invalid channel ref"], [403, "forbidden"], [404, "not found"]] as const)("returns only the safe %s outcome", async (status, error) => {
    m.resolve.mockResolvedValue({ error: status })
    const response = await GET(new NextRequest("https://test.local/api/community/channel-ref"))
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error })
  })
})

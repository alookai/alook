import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), db: {}, getInvite: vi.fn(), admin: vi.fn(), revoke: vi.fn(),
}))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: { resolve: mocks.resolve } }))
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }))
vi.mock("@/lib/community/permissions", () => ({ requireServerAdmin: mocks.admin }))
vi.mock("@alook/shared", () => ({
  queries: { communityInvite: { getInviteByToken: mocks.getInvite, revokeInvite: mocks.revoke } },
}))

import { DELETE } from "./route"

const request = () => new NextRequest("http://localhost/api/community/invites/token-a", { method: "DELETE" })
const route = () => ({ params: Promise.resolve({ token: "token-a" }) })

describe("invite revocation through the common auth entry", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.resolve.mockResolvedValue({ context: { env: { DB: {} }, userId: "owner-a" } })
    mocks.getInvite.mockResolvedValue({ id: "invite-a", serverId: "server-a" })
    mocks.admin.mockResolvedValue({ ok: true })
  })

  it("stops rejected credentials before looking up an invite", async () => {
    mocks.resolve.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await DELETE(request(), route())).status).toBe(401)
    expect(mocks.getInvite).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it("requires a token before querying", async () => {
    const response = await DELETE(request())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invite token is required" })
    expect(mocks.getInvite).not.toHaveBeenCalled()
  })

  it("returns 404 for a missing invite without a permission check or write", async () => {
    mocks.getInvite.mockResolvedValue(null)
    const response = await DELETE(request(), route())
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "invite not found" })
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it("preserves the permission failure and does not revoke", async () => {
    mocks.admin.mockResolvedValue({ ok: false, error: "forbidden", status: 403 })
    const response = await DELETE(request(), route())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "forbidden" })
    expect(mocks.admin).toHaveBeenCalledWith(mocks.db, "server-a", "owner-a")
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it("revokes the resolved invite after checking its server and authenticated owner", async () => {
    const response = await DELETE(request(), route())
    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(mocks.getInvite).toHaveBeenCalledWith(mocks.db, "token-a")
    expect(mocks.admin).toHaveBeenCalledWith(mocks.db, "server-a", "owner-a")
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(mocks.db, "invite-a")
    expect(mocks.admin.mock.invocationCallOrder[0]).toBeLessThan(mocks.revoke.mock.invocationCallOrder[0]!)
  })
})

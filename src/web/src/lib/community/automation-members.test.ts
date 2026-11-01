import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ server: vi.fn(), members: vi.fn() }))
vi.mock("@alook/shared", async (original) => ({ ...await original<typeof import("@alook/shared")>(), queries: {
  communityServer: { resolveServerByNameForMember: mocks.server },
  communityMember: { listMembersPaginated: mocks.members },
} }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
import { readAutomationMembers } from "./automation-read.server"
const request = (query = "") => new NextRequest(`https://alook.test/api/community/automation/servers/team%230042/members${query}`)
const context = () => ({ env: { DB: {} } as Env, userId: "owner", params: { id: "team#0042" }, beforeCreate: vi.fn(async (): Promise<Response | null> => null) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.server.mockResolvedValue([{ id: "server", name: "team", discriminator: "0042" }])
  mocks.members.mockResolvedValue({ members: [{ userName: "Helper", discriminator: "0001", role: "member", userId: "private", email: "private@example.test" }], hasMore: true, cursor: { joinedAt: "2026-10-31", id: "last-member" } })
})
it("scopes server lookup to the code owner before reading a bounded roster and strips private fields", async () => {
  const ctx = context()
  const response = await readAutomationMembers(request(), ctx)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ server: "team#0042", url: "https://alook.test/c/channels/server", members: [{ handle: "Helper#0001", role: "member" }], hasMore: true, cursor: "2026-10-31|last-member" })
  expect(mocks.server).toHaveBeenCalledExactlyOnceWith({ primary: true }, "owner", "team#0042")
  expect(mocks.members).toHaveBeenCalledExactlyOnceWith({ primary: true }, "server", { cursor: undefined, limit: 100 })
  expect(ctx.beforeCreate).toHaveBeenCalledOnce()
})
it("reads the next page and reports the end without an invented cursor", async () => {
  mocks.members.mockResolvedValue({ members: [], hasMore: false, cursor: null })
  expect(await (await readAutomationMembers(request("?cursor=2026-10-31%7Clast-member"), context())).json()).toEqual({ server: "team#0042", url: "https://alook.test/c/channels/server", members: [], hasMore: false })
  expect(mocks.members.mock.lastCall?.[2]).toEqual({ cursor: { joinedAt: "2026-10-31", id: "last-member" }, limit: 100 })
})
it("does not expose a nonmember server or read its members", async () => {
  mocks.server.mockResolvedValue([])
  const response = await readAutomationMembers(request(), context())
  expect(response.status).toBe(404)
  expect(mocks.members).not.toHaveBeenCalled()
})
it("rejects malformed input before quota and rejects exhausted quota before resource queries", async () => {
  const ctx = context()
  expect((await readAutomationMembers(request(), { ...ctx, params: { id: "bad" } })).status).toBe(400)
  expect((await readAutomationMembers(request("?cursor=bad"), ctx)).status).toBe(400)
  expect(ctx.beforeCreate).not.toHaveBeenCalled()
  ctx.beforeCreate.mockResolvedValue(Response.json({ error: "limited" }, { status: 429 }))
  expect((await readAutomationMembers(request(), ctx)).status).toBe(429)
  expect(mocks.server).not.toHaveBeenCalled()
  expect(mocks.members).not.toHaveBeenCalled()
})

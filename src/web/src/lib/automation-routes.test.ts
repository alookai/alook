import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), limiter: vi.fn(), action: vi.fn() }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: { DB: {} } }) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: mocks.limiter }))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: { resolve: () => { throw new Error("normal authentication must not be used") } } }))
vi.mock("@alook/shared", async (original) => ({ ...await original<typeof import("@alook/shared")>(), queries: { automation: { authenticateAccessCode: mocks.authenticate } } }))
vi.mock("@/lib/community/create-bot.server", () => ({ createBotForUser: mocks.action }))
vi.mock("@/lib/community/create-server.server", () => ({ createServerForUser: mocks.action }))
vi.mock("@/lib/community/automation-read.server", () => ({ readAutomationMachines: mocks.action, readAutomationFriends: mocks.action, readAutomationServers: mocks.action, readAutomationMembers: mocks.action }))
vi.mock("@/lib/community/automation-invite.server", () => ({ inviteAutomationFriend: mocks.action }))
vi.mock("@/lib/community/automation-message.server", () => ({ sendAutomationMessage: mocks.action }))
import { POST as createBot } from "@/app/api/community/automation/bots/route"
import { GET as servers, POST as createServer } from "@/app/api/community/automation/servers/route"
import { GET as machines } from "@/app/api/community/automation/machines/route"
import { GET as friends } from "@/app/api/community/automation/friends/route"
import { POST as invite } from "@/app/api/community/automation/servers/[id]/invites/route"
import { POST as send } from "@/app/api/community/automation/messages/route"
import { GET as members } from "@/app/api/community/automation/servers/[id]/members/route"
const routes = [[createBot, "bot.create"], [createServer, "server.create"], [servers, "server.read"], [members, "server.read"], [machines, "machine.read"], [friends, "friend.read"], [invite, "server.invite"], [send, "message.send"]] as const
const secret = "aac_" + "a".repeat(64)
const req = (token = secret) => new NextRequest("http://localhost/api/community/automation/test", { headers: { Authorization: `Bearer ${token}`, cookie: "session=present" } })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticate.mockImplementation(async (_db, _hash, permission) => ({ codeId: "one-code", ownerId: "owner", permission, limit: 2, period: "hour" }))
  mocks.limiter.mockImplementation(async () => Response.json({ allowed: true }))
  mocks.action.mockImplementation(async (_req, ctx) => await ctx.beforeCreate() ?? Response.json({ owner: ctx.userId, params: ctx.params }))
})
it("wires each dedicated operation to its own grant and code quota without normal authentication", async () => {
  for (const [route, permission] of routes) {
    const response = await route(req(), { params: { id: "demo#0001" } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ owner: "owner", params: { id: "demo#0001" } })
    expect(mocks.authenticate.mock.lastCall?.[2]).toBe(permission)
    expect(JSON.parse(mocks.limiter.mock.lastCall?.[2].body)).toEqual({ name: permission, key: "one-code", max: 2, period: "hour" })
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
})
it("rejects cookie-only, machine and bot credentials at every dedicated operation", async () => {
  for (const [route] of routes) {
    for (const token of ["", "al_machine", "crk_bot", "aac_bad"]) expect((await route(req(token))).status).toBe(401)
    expect((await route(new NextRequest("http://localhost/api/community/automation/test", { headers: { cookie: "session=present" } }))).status).toBe(401)
  }
  expect(mocks.action).not.toHaveBeenCalled()
  expect(mocks.authenticate).not.toHaveBeenCalled()
  expect(mocks.limiter).not.toHaveBeenCalled()
})
it("denies missing grants before a business action and returns each grant's quota failure", async () => {
  for (const [route] of routes) {
    mocks.authenticate.mockResolvedValueOnce(null)
    expect((await route(req())).status).toBe(401)
  }
  expect(mocks.action).not.toHaveBeenCalled()
  mocks.limiter.mockImplementation(async () => Response.json({ allowed: false, retryAfterSec: 9 }))
  for (const [route] of routes) {
    const response = await route(req())
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("9")
  }
})

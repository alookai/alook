import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { authenticate, expire, transport, fallback } = vi.hoisted(() => ({ authenticate: vi.fn(), expire: vi.fn(), transport: vi.fn(), fallback: vi.fn() }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: { DB: {} } }) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: transport }))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: {
  resolve: fallback.mockImplementation(async () => ({ context: { env: { DB: {} }, userId: "human" } })),
  respond: (_req: NextRequest, response: Response) => response,
} }))
vi.mock("@alook/shared", async (importOriginal) => ({ ...await importOriginal<typeof import("@alook/shared")>(), queries: { automation: { authenticateAccessCode: authenticate, expireAccessCode: expire } } }))

import { hashAutomationSecret, newAutomationSecret, withAutomation, withAutomationManagement } from "./automation"
import { POST as expireCode } from "@/app/api/community/automation/expire/route"

const secret = "aac_" + "a".repeat(64)
const request = (token = secret) => new NextRequest("http://localhost/api/community/bots", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "test" }) })
beforeEach(() => {
  vi.clearAllMocks()
  authenticate.mockResolvedValue({ codeId: "code", ownerId: "owner", permission: "bot.create", limit: 64, period: "hour" })
  transport.mockImplementation(async () => Response.json({ allowed: true }))
})
afterEach(() => vi.restoreAllMocks())
const create = async (_req: NextRequest, ctx: { userId: string; beforeCreate: () => Promise<Response | null> }) =>
  await ctx.beforeCreate() ?? Response.json({ ownerId: ctx.userId }, { status: 201 })

describe("automation authorization boundary", () => {
  it("self-expires a hashed credential without permissions, quota or normal-session authority", async () => {
    expire.mockResolvedValueOnce(true)
    const result = await expireCode(request())
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ expired: true })
    expect(result.headers.get("Cache-Control")).toBe("no-store")
    expect(expire).toHaveBeenCalledExactlyOnceWith({ primary: true }, await hashAutomationSecret(secret))
    expect(authenticate).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
    expire.mockResolvedValueOnce(false)
    expect((await expireCode(request())).status).toBe(401)
    expire.mockRejectedValueOnce(new Error("D1 unavailable"))
    expect((await expireCode(request())).status).toBe(503)
  })

  it("refuses missing, malformed, bot and machine credentials before self-expiry", async () => {
    for (const token of ["", "aac_bad", "al_machine", "crk_bot"]) expect((await expireCode(request(token))).status).toBe(401)
    const cookieOnly = new NextRequest("http://localhost/api/community/automation/expire", { method: "POST", headers: { Cookie: "session=present" } })
    expect((await expireCode(cookieOnly)).status).toBe(401)
    expect(expire).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it("derives owner from a hashed primary lookup and uses the indexed permission for its own limiter", async () => {
    const response = await withAutomation("bot.create", create)(request())
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ ownerId: "owner" })
    expect(authenticate).toHaveBeenCalledWith({ primary: true }, await hashAutomationSecret(secret), "bot.create")
    const payload = JSON.parse(transport.mock.calls[0]![2].body as string)
    expect(payload).toEqual({ name: "bot.create", key: "code", max: 64, period: "hour" })
    expect(JSON.stringify(payload)).not.toContain(secret)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(fallback).not.toHaveBeenCalled()
  })
  it("rejects missing permission, deleted/expired secrets and malformed credentials before creation", async () => {
    const handler = vi.fn(create)
    authenticate.mockResolvedValue(null)
    expect((await withAutomation("bot.create", handler)(request())).status).toBe(401)
    expect((await withAutomation("bot.create", handler)(request("al_machine"))).status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })
  it("fails closed on auth/limiter failure, invalid policy and invalid limiter results", async () => {
    authenticate.mockRejectedValueOnce(new Error("D1 down"))
    expect((await withAutomation("bot.create", create)(request())).status).toBe(503)
    for (const body of [null, { allowed: "true" }, { allowed: false }, { allowed: false, retryAfterSec: -1 }]) {
      transport.mockResolvedValueOnce(Response.json(body))
      expect((await withAutomation("bot.create", create)(request())).status).toBe(503)
    }
    transport.mockRejectedValueOnce(new Error("DO down"))
    expect((await withAutomation("bot.create", create)(request())).status).toBe(503)
    authenticate.mockResolvedValueOnce({ codeId: "code", ownerId: "owner", limit: 65, period: "hour" })
    expect((await withAutomation("bot.create", create)(request())).status).toBe(503)
  })
  it("returns Retry-After and does not run business creation when denied", async () => {
    transport.mockResolvedValue(Response.json({ allowed: false, retryAfterSec: 20 }))
    const response = await withAutomation("bot.create", create)(request())
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("20")
  })
  it("accepts only standalone access codes, even when a session cookie is present", async () => {
    const handler = vi.fn(create)
    const route = withAutomation("bot.create", handler)
    for (const token of ["aac_bad", "al_machine", "crk_bot", ""]) {
      const req = request(token)
      req.headers.set("cookie", "session=present")
      expect((await route(req)).status).toBe(401)
    }
    expect(handler).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })
  it("does not permit bearer credentials to manage their own codes", async () => {
    const managed = withAutomationManagement(async () => Response.json({ created: true }))
    expect((await managed(request())).status).toBe(401)
    expect((await managed(new NextRequest("http://localhost/api/community/automation/access-codes"))).status).toBe(200)
  })
  it("generates high-entropy secrets and stores only irreversible fixed-size digests", async () => {
    const one = newAutomationSecret(), two = newAutomationSecret()
    expect(one).toMatch(/^aac_[a-f0-9]{64}$/)
    expect(one).not.toBe(two)
    expect(await hashAutomationSecret(one)).toMatch(/^[a-f0-9]{64}$/)
    expect(await hashAutomationSecret(one)).not.toBe(await hashAutomationSecret(two))
  })
})

it("refuses absent credentials and an HTTP failure from the rate limiter", async () => {
  const missing = new NextRequest("http://localhost/api/community/bots", { method: "POST" })
  expect((await withAutomation("bot.create", create)(missing)).status).toBe(401)
  expect(authenticate).not.toHaveBeenCalled()
  transport.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
  expect((await withAutomation("bot.create", create)(request())).status).toBe(503)
})


describe("automation execution order", () => {
  it("does not read route params or consume quota until credential and policy validation succeeds", async () => {
    const handler = vi.fn(async (_req, ctx) => Response.json({ owner: ctx.userId, params: ctx.params }))
    const route = withAutomation("bot.create", handler)
    const readParams = vi.fn(() => Promise.resolve({ id: "resource" }))
    const context = { get params() { return readParams() } }
    expect((await route(request("invalid"), context)).status).toBe(401)
    authenticate.mockResolvedValueOnce(null)
    expect((await route(request(), context)).status).toBe(401)
    authenticate.mockResolvedValueOnce({ codeId: "code", ownerId: "owner", limit: 100, period: "hour" })
    expect((await route(request(), context)).status).toBe(503)
    expect(readParams).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    const response = await route(request(), context)
    expect(await response.json()).toEqual({ owner: "owner", params: { id: "resource" } })
    expect(readParams).toHaveBeenCalledOnce()
    expect(transport).not.toHaveBeenCalled()
  })

  it("sets no-store only after handler return and propagates thrown business errors", async () => {
    const route = withAutomation("bot.create", async () => Response.json({ error: "invalid body" }, { status: 400 }))
    expect((await route(request("invalid"))).headers.get("Cache-Control")).toBeNull()
    expect((await route(request())).headers.get("Cache-Control")).toBe("no-store")
    const failure = new Error("business failed")
    await expect(withAutomation("bot.create", async () => { throw failure })(request())).rejects.toBe(failure)
    expect(transport).not.toHaveBeenCalled()
  })

  it("keeps concurrent owners, quota keys and params isolated on a reused wrapper", async () => {
    const secondSecret = "aac_" + "b".repeat(64)
    const firstHash = await hashAutomationSecret(secret)
    authenticate.mockImplementation(async (_db, hash) => ({ codeId: hash === firstHash ? "one" : "two", ownerId: hash === firstHash ? "owner-one" : "owner-two", limit: 4, period: "day" }))
    const route = withAutomation("message.send", async (_req, ctx) => await ctx.beforeCreate() ?? Response.json({ owner: ctx.userId, params: ctx.params }))
    const results = await Promise.all([route(request(), { params: Promise.resolve({ id: "one" }) }), route(request(secondSecret), { params: Promise.resolve({ id: "two" }) })])
    expect(await Promise.all(results.map(result => result.json()))).toEqual([{ owner: "owner-one", params: { id: "one" } }, { owner: "owner-two", params: { id: "two" } }])
    expect(transport.mock.calls.map(call => JSON.parse(call[2].body).key).sort()).toEqual(["one", "two"])
    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(fallback).not.toHaveBeenCalled()
  })
})


it("self-expiry ignores route params and never uses permission or quota resolution", async () => {
  expire.mockResolvedValueOnce(true)
  const context = { get params(): never { throw new Error("expiry has no route parameters") } }
  expect((await expireCode(request(), context)).status).toBe(200)
  expect(expire).toHaveBeenCalledOnce()
  expect(authenticate).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()
})

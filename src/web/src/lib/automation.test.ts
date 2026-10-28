import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { authenticate, transport, fallback } = vi.hoisted(() => ({ authenticate: vi.fn(), transport: vi.fn(), fallback: vi.fn() }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: { DB: {} } }) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: transport }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: unknown) => fallback.mockImplementation(async (request: NextRequest) => (handler as (req: NextRequest, ctx: unknown) => Promise<Response>)(request, { env: { DB: {} }, userId: "human" })) }))
vi.mock("@alook/shared", async (importOriginal) => ({ ...await importOriginal<typeof import("@alook/shared")>(), queries: { automation: { authenticateAccessCode: authenticate } } }))

import { hashAutomationSecret, newAutomationSecret, withAutomation, withAutomationManagement, withAutomationOrExistingAuth } from "./automation"

const secret = "aac_" + "a".repeat(64)
const request = (token = secret) => new NextRequest("http://localhost/api/community/bots", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "test" }) })
beforeEach(() => {
  vi.clearAllMocks()
  authenticate.mockResolvedValue({ codeId: "code", ownerId: "owner", permission: "bot.create", limit: 64, period: "hour" })
  transport.mockResolvedValue(Response.json({ allowed: true }))
})
afterEach(() => vi.restoreAllMocks())
const create = async (_req: NextRequest, ctx: { userId: string; beforeCreate: () => Promise<Response | null> }) =>
  await ctx.beforeCreate() ?? Response.json({ ownerId: ctx.userId }, { status: 201 })

describe("automation authorization boundary", () => {
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
  it("does not fall back to cookie auth for a malformed access code", async () => {
    const existing = vi.fn(async () => Response.json({ existing: true }))
    const route = withAutomationOrExistingAuth("bot.create", create, existing)
    expect((await route(request("aac_bad"))).status).toBe(401)
    expect(existing).not.toHaveBeenCalled()
    expect((await route(request("al_machine"))).status).toBe(200)
    expect(existing).toHaveBeenCalledOnce()
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

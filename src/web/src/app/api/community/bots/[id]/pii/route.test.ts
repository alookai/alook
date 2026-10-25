import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ session: vi.fn(), liveUser: vi.fn(), bot: vi.fn(), machine: vi.fn(), dispatch: vi.fn() }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(async () => ({ env: { DB: {} }, ctx: { waitUntil: vi.fn() } })) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => ({})), getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session, signOut: vi.fn() } }) }))
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: mocks.dispatch }))
vi.mock("@alook/shared", async (original) => ({
  ...await original<typeof import("@alook/shared")>(),
  queries: {
    user: { getUserInternal: mocks.liveUser },
    communityBot: { getBotOwnedBy: mocks.bot },
    communityMachine: { getMachineByIdForUser: mocks.machine },
  },
}))
import { POST } from "./route"
const body = { requestId: "request", operation: { action: "list" } }
const request = (value: unknown = body, headers: Record<string, string> = {}) => new NextRequest("https://alook.ai/api/community/bots/bot/pii", {
  method: "POST", headers: { Origin: "https://alook.ai", "content-type": "application/json", ...headers }, body: JSON.stringify(value),
})
const context = { params: Promise.resolve({ id: "bot" }) }
describe("human-only PII management", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session.mockResolvedValue({ headers: new Headers(), response: { user: { id: "owner", email: "owner@test.local", isBot: false, deletedAt: null } } })
    mocks.liveUser.mockResolvedValue({ id: "owner", email: "owner@test.local", isBot: false, deletedAt: null })
    mocks.bot.mockResolvedValue({ machineId: "machine" })
    mocks.machine.mockResolvedValue({ id: "machine", status: "online" })
    mocks.dispatch.mockImplementation(async () => Response.json({ sent: 1, unsupported: 0 }))
  })
  it.each(["cmk_test", "crk_test", "vch_test", "al_test"])("rejects %s even alongside a valid human cookie before lookup or dispatch", async token => {
    expect((await POST(request(body, { Authorization: `Bearer ${token}` }), context)).status).toBe(401)
    expect(mocks.session).not.toHaveBeenCalled()
    expect(mocks.bot).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it("rejects cross-origin and non-human sessions", async () => {
    expect((await POST(request(body, { Origin: "https://other.example" }), context)).status).toBe(403)
    mocks.session.mockResolvedValue({ headers: new Headers(), response: { user: { id: "bot", isBot: true } } })
    expect((await POST(request(), context)).status).toBe(401)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it("scopes ownership before machine access and rejects offline targets", async () => {
    mocks.bot.mockResolvedValue(null)
    expect((await POST(request(), context)).status).toBe(404)
    expect(mocks.bot).toHaveBeenCalledWith({}, "bot", "owner")
    expect(mocks.machine).not.toHaveBeenCalled()
    mocks.bot.mockResolvedValue({ machineId: "machine" })
    mocks.machine.mockResolvedValue({ id: "machine", status: "offline" })
    expect((await POST(request(), context)).status).toBe(409)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it("validates operations and revision before dispatch", async () => {
    for (const operation of [{ action: "add", source: "private source" }, { action: "remove", pluginId: "p" }, { action: "list", source: "private source" }]) {
      expect((await POST(request({ requestId: "r", operation }), context)).status).toBe(400)
    }
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it("returns only a dispatch receipt and forwards the exact owner-selected operation", async () => {
    const value = { requestId: "r", operation: { action: "setEnabled", pluginId: "p", enabled: false, expectedRevision: 2 } }
    const response = await POST(request(value), context)
    expect(response.status).toBe(202)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({ dispatched: true, requestId: "r" })
    expect(mocks.dispatch.mock.calls[0][1]).toBe("/community-machine/by-id/machine/pii")
    expect(JSON.parse(mocks.dispatch.mock.calls[0][2].body)).toEqual({ type: "pii:manage", botId: "bot", ...value })
  })
  it("relays preview transiently, bounds UTF-8 input and never returns its plaintext in the HTTP receipt", async () => {
    const preview = { requestId: "preview", operation: { action: "preview", text: "private-test-input", expectedRevision: 0 } }
    const response = await POST(request(preview), context)
    expect(response.status).toBe(202)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({ dispatched: true, requestId: "preview" })
    expect(JSON.parse(mocks.dispatch.mock.calls[0][2].body)).toEqual({ type: "pii:manage", botId: "bot", ...preview })
    for (const operation of [{ ...preview.operation, text: "中".repeat(400) }, { ...preview.operation, text: " " }, { action: "preview", text: "text" }]) {
      expect((await POST(request({ requestId: "invalid", operation }), context)).status).toBe(400)
    }
    const escaped = await POST(request({ requestId: "escaped", operation: { ...preview.operation, text: "\u0000".repeat(1024) } }), context)
    expect(escaped.status).toBe(202)
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
  })
  it("does not claim dispatch or expose private data when the machine relay fails", async () => {
    for (const response of [new Response("PRIVATE_RESPONSE", { status: 503 }), new Response("PRIVATE_RESPONSE", { status: 200 })]) {
      mocks.dispatch.mockResolvedValueOnce(response)
      const result = await POST(request(), context)
      expect(result.status).toBe(503)
      expect(await result.json()).toEqual({ error: "PII_UNAVAILABLE" })
    }
    mocks.dispatch.mockRejectedValueOnce(new Error("PRIVATE_EXCEPTION"))
    const result = await POST(request(), context)
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: "PII_UNAVAILABLE" })
  })
  it.each([[{ sent: 0, unsupported: 1 }, 409, "UPGRADE_REQUIRED"], [{ sent: 0, unsupported: 0 }, 409, "MACHINE_OFFLINE"], [{ sent: "1" }, 503, "PII_UNAVAILABLE"]])("reports %j without claiming application", async (receipt, status, error) => {
    mocks.dispatch.mockResolvedValue(Response.json(receipt))
    const response = await POST(request(), context)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  })
})

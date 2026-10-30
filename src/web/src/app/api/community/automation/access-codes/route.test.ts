import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: (req: NextRequest, ctx: unknown) => Promise<Response>) => async (req: NextRequest, context?: { params?: Promise<Record<string, string>> }) => {
  if (req.headers.get("Cookie") !== "synthetic-human") return Response.json({}, { status: 401 })
  return handler(req, { env: { DB: {} }, userId: "owner", params: await context?.params })
} }))
vi.mock("@alook/shared", async (importOriginal) => ({ ...await importOriginal<typeof import("@alook/shared")>(), queries: { automation: { listAccessCodes: mocks.list, createAccessCode: mocks.create, updateAccessCode: mocks.update, deleteAccessCode: mocks.remove } } }))
import { GET, POST } from "./route"
import { PATCH, DELETE } from "./[codeId]/route"
import { hashAutomationSecret } from "@/lib/automation"

const code = { id: "code", name: "Task", createdAt: "now", expiresAt: null, permissions: [{ permission: "server.create", limit: 64, period: "hour" }] }
function request(method: string, body?: unknown) { return new NextRequest("http://localhost/api/community/automation/access-codes", { method, headers: { Cookie: "synthetic-human" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([code]); mocks.create.mockResolvedValue(code); mocks.update.mockResolvedValue(code); mocks.remove.mockResolvedValue(true) })

describe("Automation access-code management routes", () => {
  it("requires human login and refuses bearer-based code management", async () => {
    expect((await GET(new NextRequest("http://localhost/api/community/automation/access-codes"))).status).toBe(401)
    const req = request("POST", { name: "Task", permissions: code.permissions })
    req.headers.set("Authorization", "Bearer aac_" + "a".repeat(64))
    expect((await POST(req)).status).toBe(401)
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it("returns the generated secret once, and sends only its hash to persistence", async () => {
    const response = await POST(request("POST", { name: "Task", permissions: code.permissions }))
    expect(response.status).toBe(201)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    const body = await response.json()
    expect(body.accessCode).not.toHaveProperty("prefix")
    expect(body.secret).toMatch(/^aac_[a-f0-9]{64}$/)
    expect(mocks.create).toHaveBeenCalledWith({ primary: true }, "owner", { name: "Task", expiresIn: "24h", permissions: code.permissions }, await hashAutomationSecret(body.secret))
    expect(await (await GET(request("GET"))).json()).toEqual({ accessCodes: [code] })
  })
  it("validates requests and applies owner-scoped edits without implicit expiry renewal", async () => {
    expect((await POST(request("POST", { name: "Task", permissions: [{ permission: "unknown", limit: 1, period: "day" }] }))).status).toBe(400)
    const params = { params: Promise.resolve({ codeId: "code" }) }
    expect((await PATCH(request("PATCH", { name: "New" }), params)).status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith({ primary: true }, "owner", "code", { name: "New" })
    expect((await DELETE(request("DELETE"), params)).status).toBe(200)
    expect(mocks.remove).toHaveBeenCalledWith({ primary: true }, "owner", "code")
    mocks.update.mockResolvedValueOnce(null)
    expect((await PATCH(request("PATCH", { name: "New" }), params)).status).toBe(404)
    mocks.remove.mockResolvedValueOnce(false)
    expect((await DELETE(request("DELETE"), params)).status).toBe(404)
  })
})

it("rejects invalid edits and keeps missing route IDs within the signed-in owner scope", async () => {
  expect((await PATCH(request("PATCH", {}), { params: Promise.resolve({ codeId: "code" }) })).status).toBe(400)
  expect(mocks.update).not.toHaveBeenCalled()
  mocks.update.mockResolvedValueOnce(null)
  expect((await PATCH(request("PATCH", { name: "Missing ID" }))).status).toBe(404)
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ primary: true }, "owner", "", { name: "Missing ID" })
  mocks.remove.mockResolvedValueOnce(false)
  expect((await DELETE(request("DELETE"))).status).toBe(404)
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ primary: true }, "owner", "")
})

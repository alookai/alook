import { fingerprintRuntimeModelCatalog } from "@alook/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ machine: vi.fn(), dispatch: vi.fn(), bot: vi.fn() }))
vi.mock("@/lib/db", () => ({ getDb: () => ({ authDb: true }), getPrimaryDb: () => ({ db: true }) }))
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: mocks.dispatch }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityMachine: { getMachineByIdForUser: mocks.machine } } }
})
vi.mock("@/lib/middleware/auth", () => ({
  resolveHumanAuth: async () => ({ context: { env: { DB: {} }, userId: "owner" } }),
}))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: { DB: {} } }) }))
vi.mock("@/lib/middleware/community-agent-runner-auth", () => ({ resolveBotActor: mocks.bot }))
import { POST as routePost } from "./route"
const POST = (request: NextRequest, context = { params: { id: "machine" } }) => routePost(request, context)
const payload = { runtimeId: "codex", requestId: "request" }
const request = (body: unknown = payload) => new NextRequest("http://localhost/api/community/machines/machine/discover-models", { method: "POST", body: JSON.stringify(body) })
describe("model discovery owner route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.machine.mockResolvedValue({ status: "online", availableRuntimes: [{ id: "codex" }] })
    mocks.dispatch.mockResolvedValue(Response.json({ sent: 1, unsupported: 0 }))
    mocks.bot.mockResolvedValue({ kind: "ok", actor: { botUserId: "requester", ownerUserId: "owner", machineId: "source", isActive: true } })
  })
  it("scopes lookup before dispatch and acknowledges the correlated request", async () => {
    const response = await POST(request())
    expect(mocks.machine).toHaveBeenCalledWith({ db: true }, "owner", "machine")
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ dispatched: true, requestId: "request" })
    expect(mocks.dispatch.mock.calls[0]?.[1]).toBe("/community-machine/by-id/machine/discover-models")
    expect(JSON.parse(mocks.dispatch.mock.calls[0]?.[2].body)).toEqual(payload)
  })
  it("does not dispatch a missing or foreign-owner machine", async () => {
    mocks.machine.mockResolvedValue(null)
    expect((await POST(request())).status).toBe(404)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it.each([null, {}, { ...payload, runtimeId: "missing" }, { ...payload, command: "arbitrary" }, { ...payload, requestId: "x".repeat(129) }])("rejects invalid payload %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it("rejects offline machines before dispatch", async () => {
    mocks.machine.mockResolvedValue({ status: "offline" })
    expect((await POST(request())).status).toBe(409)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it.each([[{ sent: 0, unsupported: 1 }, 409, "UPGRADE_REQUIRED"], [{ sent: 0, unsupported: 0 }, 409, "MACHINE_OFFLINE"], [{ sent: "1" }, 503, "model discovery unavailable"]])("handles dispatch receipt %j", async (receipt, status, error) => {
    mocks.dispatch.mockResolvedValue(Response.json(receipt))
    const response = await POST(request())
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  })
  it("handles transport failure without reporting success", async () => {
    mocks.dispatch.mockRejectedValue(new Error("private transport data"))
    expect((await POST(request())).status).toBe(503)
  })
  it("bounds streamed bodies before parsing", async () => {
    expect((await POST(request({ ...payload, excess: "x".repeat(4096) }))).status).toBe(400)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})


describe("bot model discovery error and dispatch contract", () => {
  const botRequest = () => new NextRequest("http://localhost/api/community/machines/machine/discover-models", { method: "POST", headers: { authorization: "Bearer crk_synthetic" }, body: JSON.stringify(payload) })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bot.mockResolvedValue({ kind: "ok", actor: { botUserId: "requester", ownerUserId: "owner", machineId: "source", isActive: true } })
    mocks.machine.mockResolvedValue({ status: "online", availableRuntimes: [{ id: "codex" }] })
    mocks.dispatch.mockResolvedValue(Response.json({ sent: 1 }))
  })
  it("derives owner and requester from authentication and reuses the existing discovery request", async () => {
    const response = await POST(botRequest(), { params: { id: "machine" } })
    expect(response.status).toBe(202)
    expect(mocks.machine).toHaveBeenCalledWith({ db: true }, "owner", "machine")
    expect(JSON.parse(mocks.dispatch.mock.calls[0]?.[2].body)).toEqual(payload)
  })
  it.each([
    [null, "MACHINE_NOT_FOUND", 404],
    [{ status: "offline" }, "MACHINE_OFFLINE", 409],
    [{ status: "online", availableRuntimes: [] }, "BACKEND_NOT_FOUND", 400],
  ])("returns a structured machine validation failure %s", async (machine, code, status) => {
    mocks.machine.mockResolvedValue(machine)
    const response = await POST(botRequest(), { params: { id: "machine" } })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code, machineId: "machine" })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it.each([
    [{ sent: 0, unsupported: 1 }, "UPGRADE_REQUIRED", 409],
    [{ sent: 0, unsupported: 0 }, "MACHINE_OFFLINE", 409],
    [{ sent: "1" }, "DISCOVERY_UNAVAILABLE", 503],
  ])("preserves dispatch failure codes at the API boundary %j", async (receipt, code, status) => {
    mocks.dispatch.mockResolvedValue(Response.json(receipt))
    const response = await POST(botRequest(), { params: { id: "machine" } })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code, machineId: "machine" })
  })
})

describe("bot synchronous cached model queries", () => {
  const botRequest = (query = "?wait=1", body: unknown = payload) => new NextRequest(`http://localhost/api/community/machines/machine/discover-models${query}`, { method: "POST", headers: { authorization: "Bearer crk_synthetic" }, body: JSON.stringify(body) })
  const catalog = { updateMode: "unsupported", catalogOrigin: "native_report", defaultModelId: "provider/model", models: [{ id: "provider/model", supportedReasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }] }
  const fresh = { sent: 1, unsupported: 0, cached: false, observedAt: "2026-10-29T00:00:00Z", result: { status: "complete", catalog } }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bot.mockResolvedValue({ kind: "bot", actor: { botUserId: "requester", ownerUserId: "owner", machineId: "source", isActive: true } })
    mocks.machine.mockResolvedValue({ status: "online", availableRuntimes: [{ id: "codex" }] })
    mocks.dispatch.mockImplementation(async () => Response.json(fresh))
  })
  it("uses the authenticated owner and returns fresh/cache model reports through the same wait path", async () => {
    const response = await POST(botRequest(), { params: { id: "machine" } })
    expect(response.status).toBe(200)
    expect(mocks.machine).toHaveBeenCalledWith({ db: true }, "owner", "machine")
    expect(mocks.dispatch.mock.lastCall?.[1]).toBe("/community-machine/by-id/machine/discover-models?wait=1&cache=1")
    expect(await response.json()).toMatchObject({ source: "fresh_discovery", observedAt: fresh.observedAt, catalogState: "reported", catalogOrigin: "native_report", models: [{ id: "provider/model", reasoningEfforts: [{ value: "high" }] }] })
    mocks.machine.mockResolvedValueOnce({ status: "online", availableRuntimes: [{ id: "codex", status: "healthy", reasoning: catalog }] })
    mocks.dispatch.mockResolvedValueOnce(Response.json({ ...fresh, sent: 0, cached: true, catalogFingerprint: await fingerprintRuntimeModelCatalog(catalog as never) }))
    expect(await (await POST(botRequest(), { params: { id: "machine" } })).json()).toMatchObject({ source: "cached_report", observedAt: fresh.observedAt })
  })
  it("preserves model-specific projection and forces refresh without forwarding CLI-only fields", async () => {
    const response = await POST(botRequest("?wait=1&model=provider%2Fmodel", { ...payload, refresh: true }), { params: { id: "machine" } })
    expect(mocks.dispatch.mock.lastCall?.[1]).toBe("/community-machine/by-id/machine/discover-models?wait=1")
    expect(JSON.parse(mocks.dispatch.mock.lastCall?.[2].body)).toEqual(payload)
    expect(await response.json()).toMatchObject({ source: "fresh_discovery", inCatalog: true, model: { id: "provider/model", reasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" } })
    const unknown = await POST(botRequest("?wait=1&model=custom%2Funknown"), { params: { id: "machine" } })
    expect(await unknown.json()).toMatchObject({ inCatalog: false, model: { id: "custom/unknown", reasoningEfforts: null, defaultReasoningEffort: null } })
  })
  it("returns a discovery failure instead of a stored report and refuses corrupt force options", async () => {
    mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 1, unsupported: 0, result: { status: "error", code: "failed", message: "Failed" } }))
    const response = await POST(botRequest(), { params: { id: "machine" } })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: "failed" })
    expect((await POST(botRequest("?wait=1", { ...payload, refresh: "true" }), { params: { id: "machine" } })).status).toBe(400)
  })
  it("shares human fresh/cache/force discovery while returning the native UI catalog", async () => {
    const human = (body: unknown = payload) => new NextRequest("http://localhost/api/community/machines/machine/discover-models?wait=1", { method: "POST", body: JSON.stringify(body) })
    expect(await (await POST(human())).json()).toEqual({ machineId: "machine", backendId: "codex", requestId: "request", source: "fresh_discovery", observedAt: fresh.observedAt, result: fresh.result })
    expect(mocks.dispatch.mock.lastCall?.[1]).toBe("/community-machine/by-id/machine/discover-models?wait=1&cache=1")
    mocks.machine.mockResolvedValueOnce({ status: "online", availableRuntimes: [{ id: "codex", reasoning: catalog }] })
    mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 0, unsupported: 0, cached: true, observedAt: fresh.observedAt, catalogFingerprint: await fingerprintRuntimeModelCatalog(catalog as never) }))
    expect(await (await POST(human())).json()).toMatchObject({ source: "cached_report", result: fresh.result })
    expect((await POST(human({ ...payload, refresh: true }))).status).toBe(200)
    expect(mocks.dispatch.mock.lastCall?.[1]).toBe("/community-machine/by-id/machine/discover-models?wait=1")
    expect(JSON.parse(mocks.dispatch.mock.lastCall?.[2].body)).toEqual(payload)
  })
})

import { fingerprintRuntimeModelCatalog } from "@alook/shared"
import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ machine: vi.fn(), dispatch: vi.fn(), admit: vi.fn() }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: mocks.dispatch }))
vi.mock("@alook/shared", async (importOriginal) => { const actual = await importOriginal<typeof import("@alook/shared")>(); return { ...actual, queries: { ...actual.queries, communityMachine: { getMachineByIdForUser: mocks.machine } } } })
vi.mock("@/lib/middleware/community-actor", () => ({ withCommunityActor: (handler: unknown) => handler }))
vi.mock("@/lib/automation", () => ({ withAutomation: (permission: string, handler: (...args: any[]) => unknown) => {
  expect(permission).toBe("machine.read")
  return (req: NextRequest) => handler(req, { env: { DB: {} }, userId: "code-owner", params: { id: "m1" }, beforeCreate: mocks.admit })
} }))
import { POST } from "./route"
const catalog = { catalogOrigin: "native_report", updateMode: "unsupported", defaultModelId: "fresh/model", models: [{ id: "fresh/model", supportedReasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }] }
const request = (body: unknown = { requestId: "request", runtimeId: "codex" }) => new NextRequest("http://localhost/api/community/automation/machines/m1/discover-models", { method: "POST", body: JSON.stringify(body) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.machine.mockResolvedValue({ status: "online", availableRuntimes: [{ id: "codex", reasoning: { models: [{ id: "old" }] } }] })
  mocks.admit.mockResolvedValue(null)
  mocks.dispatch.mockResolvedValue(Response.json({ sent: 1, unsupported: 0, observedAt: "2026-10-29T00:00:00Z", result: { status: "complete", catalog } }))
})
it("admits once, refreshes the owner target and projects the matching fresh result", async () => {
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(mocks.machine).toHaveBeenCalledWith({ primary: true }, "code-owner", "m1")
  expect(mocks.admit).toHaveBeenCalledOnce()
  expect(mocks.dispatch).toHaveBeenCalledWith({ DB: {} }, "/community-machine/by-id/m1/discover-models?wait=1&cache=1", expect.objectContaining({ method: "POST", body: JSON.stringify({ requestId: "request", runtimeId: "codex" }) }))
  expect(await response.json()).toEqual({ machineId: "m1", backendId: "codex", source: "fresh_discovery", requestId: "request", readAt: expect.any(String), observedAt: "2026-10-29T00:00:00Z", modelRequired: false, defaultModelId: "fresh/model", models: [{ id: "fresh/model", reasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }] })
})
it("returns fresh missing and empty catalogs without the two removed metadata fields", async () => {
  for (const value of [null, { updateMode: "unsupported", models: [] }]) {
    mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 1, unsupported: 0, observedAt: "2026-10-29T00:00:00Z", result: { status: "complete", catalog: value } }))
    const body = await (await POST(request())).json()
    expect(body.models).toEqual(value ? [] : null)
    expect(body).not.toHaveProperty("catalogState")
    expect(body).not.toHaveProperty("catalogOrigin")
  }
})
it("does not dispatch on denied quota, malformed request, foreign/offline machine or unknown runtime", async () => {
  mocks.admit.mockResolvedValueOnce(Response.json({ error: "limited" }, { status: 429 }))
  expect((await POST(request())).status).toBe(429)
  expect((await POST(request({}))).status).toBe(400)
  mocks.machine.mockResolvedValueOnce(null)
  expect((await POST(request())).status).toBe(404)
  mocks.machine.mockResolvedValueOnce({ status: "offline" })
  expect((await POST(request())).status).toBe(409)
  expect((await POST(request({ requestId: "request", runtimeId: "missing" }))).status).toBe(400)
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it("returns discovery errors and refuses missing/corrupt results instead of using old models", async () => {
  mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 1, unsupported: 0, result: { status: "error", code: "AUTH_REQUIRED", message: "Sign in" } }))
  const response = await POST(request())
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: "Sign in", code: "AUTH_REQUIRED", machineId: "m1", backendId: "codex", requestId: "request" })
  for (const result of [undefined, {}, { status: "complete", catalog: "bad" }]) {
    mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 1, unsupported: 0, result }))
    expect((await POST(request())).status).toBe(503)
  }
})

it("returns a timestamped server cache hit and allows an explicit refresh without forwarding refresh to the daemon", async () => {
  mocks.machine.mockResolvedValueOnce({ status: "online", availableRuntimes: [{ id: "codex", status: "healthy", reasoning: catalog }] })
  mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 0, unsupported: 0, cached: true, observedAt: "2026-10-29T00:00:00Z", catalogFingerprint: await fingerprintRuntimeModelCatalog(catalog as never) }))
  expect(await (await POST(request())).json()).toMatchObject({ source: "cached_report", observedAt: "2026-10-29T00:00:00Z" })
  await POST(request({ requestId: "force", runtimeId: "codex", refresh: true }))
  expect(mocks.dispatch.mock.lastCall?.[1]).toBe("/community-machine/by-id/m1/discover-models?wait=1")
  expect(JSON.parse(mocks.dispatch.mock.lastCall?.[2].body)).toEqual({ requestId: "force", runtimeId: "codex" })
  expect((await POST(request({ requestId: "force", runtimeId: "codex", refresh: "yes" }))).status).toBe(400)
})

it("rejects mismatched cache metadata instead of pairing it with an unrelated D1 snapshot", async () => {
  mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 0, unsupported: 0, cached: true, observedAt: "2026-10-29T00:00:00Z", catalogFingerprint: "b".repeat(64) }))
  expect((await POST(request())).status).toBe(503)
})

it("fails closed on HTTP transport failure and invalid observation timestamps", async () => {
  mocks.dispatch.mockResolvedValueOnce(new Response("down", { status: 503 }))
  expect((await POST(request())).status).toBe(503)
  for (const observedAt of [undefined, "invalid"]) {
    mocks.dispatch.mockResolvedValueOnce(Response.json({ sent: 1, observedAt, result: { status: "complete", catalog } }))
    expect((await POST(request())).status).toBe(503)
  }
})

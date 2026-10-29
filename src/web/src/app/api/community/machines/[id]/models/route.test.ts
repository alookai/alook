import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ machine: vi.fn(), actor: { kind: "human", userId: "owner", ownerUserId: "owner" } }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return { ...actual, queries: { ...actual.queries, communityBot: { ...actual.queries.communityBot, getMachineForOwner: mocks.machine } } }
})
vi.mock("@/lib/middleware/community-actor", () => ({ withCommunityActor: (handler: (...args: any[]) => unknown) => (req: NextRequest) => handler(req, { env: { DB: {} }, actor: mocks.actor, params: { id: "m1" } }) }))
import { GET } from "./route"
const request = (backend = "codex") => new NextRequest(`http://localhost/api/community/machines/m1/models?backend=${backend}`)
beforeEach(() => { vi.clearAllMocks(); mocks.actor = { kind: "human", userId: "owner", ownerUserId: "owner" }; mocks.machine.mockResolvedValue({ id: "m1", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] }) })
it.each(["human", "bot"])("scopes the existing %s model read to the human owner", async (kind) => {
  mocks.actor = { kind, userId: kind === "bot" ? "bot" : "owner", ownerUserId: "owner" }
  const response = await GET(request())
  expect(mocks.machine).toHaveBeenCalledExactlyOnceWith({ primary: true }, "m1", "owner")
  expect(await response.json()).toMatchObject({ machineId: "m1", backendId: "codex", source: "stored_report", models: null })
})
it("retains owner, online and installed-backend guards", async () => {
  mocks.machine.mockResolvedValueOnce(null)
  expect((await GET(request())).status).toBe(404)
  mocks.machine.mockResolvedValueOnce({ id: "m1", status: "offline", availableRuntimes: [] })
  expect((await GET(request())).status).toBe(409)
  const response = await GET(request("missing"))
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ code: "BACKEND_NOT_FOUND" })
})
it("returns model defaults and effort options without runtime diagnostics", async () => {
  mocks.machine.mockResolvedValueOnce({ id: "m1", status: "online", availableRuntimes: [{ id: "codex", status: "healthy", lastError: "private", reasoning: { updateMode: "live_next_turn", defaultModelId: "provider/model", catalogOrigin: "native_report", models: [{ id: "provider/model", supportedReasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }] } }] })
  const body = await (await GET(request())).json()
  expect(body).toMatchObject({ defaultModelId: "provider/model", models: [{ id: "provider/model", reasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }] })
  expect(JSON.stringify(body)).not.toContain("private")
  expect(body.catalogState).toBe("reported")
  expect(body.catalogOrigin).toBe("native_report")
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRouterTestContext, getSharedMocks, loadRouter } from "./test-harness"
const mocks = getSharedMocks()
const command = { type: "pii:manage", requestId: "request", botId: "bot", operation: { action: "list" } }
const request = (body: unknown = command) => new Request("http://localhost/community-machine/by-id/machine/pii", { method: "POST", body: JSON.stringify(body) })
describe("PII control routing", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getActiveDoNamesForMachine.mockResolvedValue(["credential"]) })
  it("forwards only validated metadata operations to the current machine DO", async () => {
    const { env, doMock } = createRouterTestContext()
    doMock.stubFetch.mockResolvedValue(Response.json({ sent: 1, unsupported: 0 }))
    const response = await (await loadRouter()).fetch(request(), { ...env, DB: {} as D1Database })
    expect(await response.json()).toEqual({ sent: 1, unsupported: 0 })
    expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:credential")
    const forwarded = doMock.stubFetch.mock.calls[0]![0] as Request
    expect(new URL(forwarded.url).pathname).toBe("/pii")
    expect(await forwarded.json()).toEqual(command)
  })
  it("rejects source/add fields and corrupt receipts", async () => {
    const { env, doMock } = createRouterTestContext()
    expect((await (await loadRouter()).fetch(request({ ...command, source: "private" }), { ...env, DB: {} as D1Database })).status).toBe(400)
    expect(doMock.stubFetch).not.toHaveBeenCalled()
    doMock.stubFetch.mockResolvedValue(Response.json({ sent: "1", unsupported: 0 }))
    expect((await (await loadRouter()).fetch(request(), { ...env, DB: {} as D1Database })).status).toBe(503)
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRouterTestContext, getSharedMocks, loadRouter } from "./test-harness"
const mocks = getSharedMocks()
describe("model discovery worker routing", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getActiveDoNamesForMachine.mockResolvedValue(["credential"]) })
  const request = (body = { requestId: "request", runtimeId: "codex" }) => new Request("http://localhost/community-machine/by-id/machine/discover-models", { method: "POST", body: JSON.stringify(body) })
  it("resolves the current credential and forwards only the selected runtime command", async () => {
    const { env, doMock } = createRouterTestContext()
    doMock.stubFetch.mockResolvedValue(Response.json({ sent: 1, unsupported: 0 }))
    const response = await (await loadRouter()).fetch(request(), env as any)
    expect(await response.json()).toEqual({ sent: 1, unsupported: 0 })
    expect(mocks.getActiveDoNamesForMachine).toHaveBeenCalledWith({}, "machine")
    expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:credential")
    const forwarded = doMock.stubFetch.mock.calls[0][0] as Request
    expect(new URL(forwarded.url).pathname).toBe("/discover-models")
    expect(await forwarded.json()).toEqual({ type: "runtime:discover_models", requestId: "request", runtimeId: "codex" })
  })
  it("reports credential lookup failures as unavailable", async () => {
    const { env, doMock } = createRouterTestContext()
    mocks.getActiveDoNamesForMachine.mockRejectedValue(new Error("d1"))
    expect((await (await loadRouter()).fetch(request(), env as any)).status).toBe(503)
    expect(doMock.stubFetch).not.toHaveBeenCalled()
  })
  it("returns zero for a machine with no current credential", async () => {
    const { env, doMock } = createRouterTestContext()
    mocks.getActiveDoNamesForMachine.mockResolvedValue([])
    expect(await (await (await loadRouter()).fetch(request(), env as any)).json()).toEqual({ sent: 0, unsupported: 0 })
    expect(doMock.stubFetch).not.toHaveBeenCalled()
  })
  it("rejects corrupt receipts instead of claiming a delivered request", async () => {
    const { env, doMock } = createRouterTestContext()
    doMock.stubFetch.mockResolvedValue(Response.json({ sent: "1", unsupported: 0 }))
    expect((await (await loadRouter()).fetch(request(), env as any)).status).toBe(503)
  })
})

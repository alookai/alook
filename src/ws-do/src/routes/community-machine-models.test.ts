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

it("forwards the wait mode and returns only the selected credential's terminal discovery result", async () => {
  const { env, doMock } = createRouterTestContext()
  mocks.getActiveDoNamesForMachine.mockResolvedValue(["old", "current", "other"])
  const result = { status: "complete", catalog: null }
  doMock.stubFetch.mockResolvedValueOnce(Response.json({ sent: 0, unsupported: 0 })).mockResolvedValueOnce(Response.json({ sent: 1, unsupported: 0, observedAt: "2026-10-29T00:00:00Z", result }))
  const response = await (await loadRouter()).fetch(new Request("http://localhost/community-machine/by-id/machine/discover-models?wait=1", { method: "POST", body: JSON.stringify({ requestId: "fresh", runtimeId: "codex" }) }), env as any)
  expect(await response.json()).toEqual({ sent: 1, unsupported: 0, cached: false, observedAt: "2026-10-29T00:00:00Z", result })
  expect(doMock.stubFetch).toHaveBeenCalledTimes(2)
  expect((doMock.stubFetch.mock.calls[1][0] as Request).url).toBe("http://internal/discover-models?wait=1")
})
it("rejects a wait receipt without a terminal result", async () => {
  const { env, doMock } = createRouterTestContext()
  mocks.getActiveDoNamesForMachine.mockResolvedValue(["current"])
  doMock.stubFetch.mockResolvedValue(Response.json({ sent: 1, unsupported: 0 }))
  const response = await (await loadRouter()).fetch(new Request("http://localhost/community-machine/by-id/machine/discover-models?wait=1", { method: "POST", body: JSON.stringify({ requestId: "fresh", runtimeId: "codex" }) }), env as any)
  expect(response.status).toBe(503)
})

it("preserves a cache hit with zero dispatches and forwards the cache flag", async () => {
  const { env, doMock } = createRouterTestContext()
  mocks.getActiveDoNamesForMachine.mockResolvedValue(["current"])
  const receipt = { sent: 0, unsupported: 0, cached: true, observedAt: "2026-10-29T00:00:00Z", catalogFingerprint: "a".repeat(64) }
  doMock.stubFetch.mockResolvedValue(Response.json(receipt))
  const response = await (await loadRouter()).fetch(new Request("http://localhost/community-machine/by-id/machine/discover-models?wait=1&cache=1", { method: "POST", headers: { "x-model-catalog-fingerprint": "a".repeat(64) }, body: JSON.stringify({ requestId: "cache", runtimeId: "codex" }) }), env as any)
  expect(await response.json()).toEqual(receipt)
  expect((doMock.stubFetch.mock.calls[0][0] as Request).url).toBe("http://internal/discover-models?wait=1&cache=1")
})

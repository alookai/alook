import { afterEach, describe, expect, it, vi } from "vitest"
import { createProxyServerApi } from "./proxyServerApi"

afterEach(() => vi.useRealTimers())
describe("platform proxy transport", () => {
  it("reuses discovery dispatch without polling or reporting native completion", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ dispatched: true, requestId: "disc" }, { status: 202 }))
    const api = createProxyServerApi({ proxyUrl: "http://proxy", voucher: "voucher", fetchImpl })
    expect(await api.platformMachine!({ action: "models", machineId: "m1", backendId: "codex", requestId: "disc", refresh: true })).toEqual({ dispatched: true, requestId: "disc" })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][0]).toBe("http://proxy/api/community/machines/m1/discover-models")
  })
  it("keeps only agreed error evidence fields and never exposes arbitrary response properties", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "Unsupported effort", code: "INVALID_REASONING_EFFORT", itemIndex: 2, field: "reasoningEffort", allowedValues: ["low"], credential: "private", ownerSecret: "private" }, { status: 400 }))
    const api = createProxyServerApi({ proxyUrl: "http://proxy", voucher: "voucher", fetchImpl })
    await expect(api.platformBot!({ action: "create", requestId: "request", bots: [] })).rejects.toMatchObject({ code: "INVALID_REASONING_EFFORT", platformDetails: { itemIndex: 2, field: "reasoningEffort", allowedValues: ["low"] } })
    const error = await api.platformBot!({ action: "list" }).catch((error) => error)
    expect(error.platformDetails).not.toHaveProperty("credential")
    expect(error.platformDetails).not.toHaveProperty("ownerSecret")
  })
})

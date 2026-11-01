import { afterEach, describe, expect, it, vi } from "vitest"
import { createProxyServerApi } from "./proxyServerApi"

afterEach(() => vi.useRealTimers())
describe("platform proxy transport", () => {
  it("reuses the synchronous discovery/cache route without polling", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ source: "fresh_discovery", requestId: "disc", models: [] }))
    const api = createProxyServerApi({ proxyUrl: "http://proxy", voucher: "voucher", fetchImpl })
    expect(await api.platformMachine!({ action: "models", machineId: "m1", backendId: "codex", requestId: "disc", refresh: true })).toEqual({ source: "fresh_discovery", requestId: "disc", models: [] })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][0]).toBe("http://proxy/api/community/machines/m1/discover-models?wait=1")
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

it("posts cached and model-specific requests with a new correlation ID by default", async () => {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ source: "cached_report", models: [] }))
  const api = createProxyServerApi({ proxyUrl: "http://proxy", voucher: "voucher", fetchImpl })
  await api.platformMachine!({ action: "models", machineId: "m/1", backendId: "custom/backend", model: "provider/model" })
  await api.platformMachine!({ action: "models", machineId: "m/1", backendId: "custom/backend", model: "provider/model" })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(fetchImpl.mock.calls[0][0]).toBe("http://proxy/api/community/machines/m%2F1/discover-models?wait=1&model=provider%2Fmodel")
  const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(call[1]!.body as string))
  expect(bodies[0]).toEqual({ requestId: expect.any(String), runtimeId: "custom/backend" })
  expect(bodies[0].requestId).not.toBe(bodies[1].requestId)
})

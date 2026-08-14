import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

import { GET } from "./route"

describe("GET /api/daemon/latest-version", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the latest daemon package metadata", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.1.8" }),
    })

    const response = await GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: "0.1.8", package: "@alook/daemon" })
    expect(mockFetch).toHaveBeenCalledWith("https://registry.npmjs.org/@alook/daemon/latest")
  })

  it.each([
    { ok: false, json: async () => ({}) },
    { ok: true, json: async () => ({}) },
  ])("returns 502 for an unusable registry response", async (registryResponse) => {
    mockFetch.mockResolvedValue(registryResponse)

    const response = await GET()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "failed to fetch latest daemon version from npm" })
  })

  it("returns 502 when the registry request fails", async () => {
    mockFetch.mockRejectedValue(new Error("registry unavailable"))

    const response = await GET()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: "failed to fetch latest daemon version from npm",
    })
  })
})

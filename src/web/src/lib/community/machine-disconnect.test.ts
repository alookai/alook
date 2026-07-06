import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { forceCloseCommunityMachineByDoName } from "./machine-disconnect"

const originalFetch = globalThis.fetch
const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("forceCloseCommunityMachineByDoName", () => {
  it("service-binding path: posts /community-machine/<id>/force-close via WS_DO_WORKER", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ closed: 1 }), { status: 200 })
    )
    const env = { WS_DO_WORKER: { fetch: fetchMock } } as unknown as Env
    await forceCloseCommunityMachineByDoName(env, "a1b2c3d4e5f6")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // HTTP fallback must not fire when binding succeeds.
    expect(mockFetch).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("http://internal/community-machine/a1b2c3d4e5f6/force-close")
    expect((init as RequestInit)?.method).toBe("POST")
  })

  it("url-encodes the machine id segment", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }))
    const env = { WS_DO_WORKER: { fetch: fetchMock } } as unknown as Env
    await forceCloseCommunityMachineByDoName(env, "a1b2/with-slash")
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://internal/community-machine/a1b2%2Fwith-slash/force-close"
    )
  })

  it("HTTP fallback fires when WS_DO_WORKER.fetch throws (binding unavailable)", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding missing")
    })
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = {
      WS_DO_WORKER: { fetch: bindingFetch },
      DEV_WS_DO_URL: "http://dev-ws:8789",
    } as unknown as Env
    await forceCloseCommunityMachineByDoName(env, "a1b2c3d4e5f6")
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe("http://dev-ws:8789/community-machine/a1b2c3d4e5f6/force-close")
    expect(init.method).toBe("POST")
  })

  it("HTTP fallback fires when WS_DO_WORKER.fetch returns non-OK (5xx)", async () => {
    // Regression: pre-refactor, a 5xx from the binding also fell through to
    // the HTTP fallback. If the binding is reachable but degraded, we still
    // want to retry over HTTP rather than surface the 5xx to the caller.
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 500 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = {
      WS_DO_WORKER: { fetch: bindingFetch },
      DEV_WS_DO_URL: "http://dev-ws:8789",
    } as unknown as Env
    await forceCloseCommunityMachineByDoName(env, "a1b2c3d4e5f6")
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe("http://dev-ws:8789/community-machine/a1b2c3d4e5f6/force-close")
    expect(init.method).toBe("POST")
  })

  it("swallows fallback fetch errors without throwing", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding missing")
    })
    mockFetch.mockRejectedValue(new Error("network down"))
    const env = { WS_DO_WORKER: { fetch: bindingFetch } } as unknown as Env
    await expect(forceCloseCommunityMachineByDoName(env, "a1b2c3d4e5f6")).resolves.toBeUndefined()
  })

  // Guard: the module must delegate to the shared `wsDoFetch` helper.
  it("goes through the new helper (single wsDoFetch import, no ad-hoc fallback)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "machine-disconnect.ts"),
      "utf8",
    )
    expect(src).toMatch(/wsDoFetch/)
    expect(src).not.toMatch(/WS_DO_WORKER/)
    expect(src).not.toMatch(/DEV_WS_DO_URL/)
  })
})

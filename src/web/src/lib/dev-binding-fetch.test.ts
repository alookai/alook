import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import { Logger } from "@alook/shared"
import { fetchViaBindingOrDevFallback } from "./dev-binding-fetch"

const originalFetch = globalThis.fetch
const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()
const log = new Logger({ service: "test", level: "silent" })

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("fetchViaBindingOrDevFallback", () => {
  it("returns the binding response directly when it is OK", async () => {
    const bindingFetch = vi.fn(async () => new Response("ok", { status: 200 }))

    const res = await fetchViaBindingOrDevFallback(
      { fetch: bindingFetch },
      "http://dev:1234",
      "/x",
      { method: "POST" },
      { logPrefix: "test", log },
    )

    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledWith("http://internal/x", { method: "POST" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns the binding's 4xx as-is without trying the HTTP fallback", async () => {
    const bindingFetch = vi.fn(async () => new Response("nope", { status: 404 }))

    const res = await fetchViaBindingOrDevFallback(
      { fetch: bindingFetch },
      "http://dev:1234",
      "/x",
      { method: "POST" },
      { logPrefix: "test", log },
    )

    expect(res.status).toBe(404)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("falls back to the raw URL when the binding throws", async () => {
    const bindingFetch = vi.fn(async () => { throw new Error("no binding") })
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))

    const res = await fetchViaBindingOrDevFallback(
      { fetch: bindingFetch },
      "http://dev:1234",
      "/x",
      { method: "POST" },
      { logPrefix: "test", log },
    )

    expect(res.status).toBe(200)
    expect(String(mockFetch.mock.calls[0]![0])).toBe("http://dev:1234/x")
  })

  it("falls back to the raw URL on a binding 5xx", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))

    const res = await fetchViaBindingOrDevFallback(
      { fetch: bindingFetch },
      "http://dev:1234",
      "/x",
      { method: "POST" },
      { logPrefix: "test", log },
    )

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("goes straight to the fallback URL when no binding is passed", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))

    const res = await fetchViaBindingOrDevFallback(undefined, "http://dev:1234", "/x", { method: "GET" }, { logPrefix: "test", log })

    expect(res.status).toBe(200)
    expect(String(mockFetch.mock.calls[0]![0])).toBe("http://dev:1234/x")
  })

  it("rethrows when both the binding and the fallback fail", async () => {
    const bindingFetch = vi.fn(async () => { throw new Error("no binding") })
    mockFetch.mockRejectedValue(new Error("network down"))

    await expect(
      fetchViaBindingOrDevFallback({ fetch: bindingFetch }, "http://dev:1234", "/x", { method: "POST" }, { logPrefix: "test", log }),
    ).rejects.toThrow("network down")
  })
})

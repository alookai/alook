import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchPageHost, pageHostOrigin, pageServiceAuthorized, pageTicketHash } from "./page-viewer.server"

describe("Page host trust boundary", () => {
  it("allows only a configured HTTPS origin or local loopback without URL credentials or paths", () => {
    expect(pageHostOrigin("https://pages.example.invalid")).toBe("https://pages.example.invalid")
    expect(pageHostOrigin("http://localhost:8789")).toBe("http://localhost:8789")
    for (const url of [undefined, "http://remote.invalid", "https://a:b@remote.invalid", "https://remote.invalid/evil", "https://remote.invalid/?q=1", "javascript:alert(1)"]) {
      expect(pageHostOrigin(url)).toBeNull()
    }
  })

  it("checks the dedicated service credential and accepts only correctly sized opaque tickets", () => {
    const secret = "test-key-material-with-at-least-32-bytes"
    const req = (value: string) => new Request("https://alook.invalid", { headers: { authorization: value } })
    expect(pageServiceAuthorized(req(`Bearer ${secret}`), secret)).toBe(true)
    expect(pageServiceAuthorized(req(`Bearer ${secret}x`), secret)).toBe(false)
    expect(pageServiceAuthorized(req(`Bearer ${secret}`), undefined)).toBe(false)
    expect(pageServiceAuthorized(req("Bearer short"), "short")).toBe(false)
    expect(pageTicketHash("a".repeat(43))).toMatch(/^[0-9a-f]{64}$/)
    expect(pageTicketHash("a".repeat(42))).toBeNull()
    expect(pageTicketHash("?".repeat(43))).toBeNull()
  })
})


afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("Page host development fallback", () => {
  const init = { method: "POST", headers: { authorization: "Bearer synthetic-service-key" }, body: "{}" }

  it("never uses public fetch for HTTPS, even in development with an absent or failing binding", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const network = vi.fn()
    vi.stubGlobal("fetch", network)
    await expect(fetchPageHost(undefined, "https://pages.example.invalid", "/alook/import/art_test", init)).rejects.toThrow("service binding unavailable")
    const binding = { fetch: vi.fn(async () => new Response(null, { status: 503 })) }
    expect((await fetchPageHost(binding, "https://pages.example.invalid", "/alook/import/art_test", init)).status).toBe(503)
    binding.fetch.mockRejectedValueOnce(new Error("binding unavailable"))
    await expect(fetchPageHost(binding, "https://pages.example.invalid", "/alook/import/art_test", init)).rejects.toThrow("binding unavailable")
    expect(network).not.toHaveBeenCalled()
  })

  it("uses the binding for loopback in production and never falls back on a failure", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const network = vi.fn()
    vi.stubGlobal("fetch", network)
    await expect(fetchPageHost(undefined, "http://localhost:8795", "/alook/import/art_test", init)).rejects.toThrow("service binding unavailable")
    const binding = { fetch: vi.fn(async () => new Response(null, { status: 503 })) }
    expect((await fetchPageHost(binding, "http://localhost:8795", "/alook/import/art_test", init)).status).toBe(503)
    expect(network).not.toHaveBeenCalled()
  })

  it("permits development fallback only for exact loopback HTTP destinations", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const network = vi.fn(async (_request: Request) => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", network)
    for (const origin of ["http://localhost:8795", "http://127.0.0.1:8795", "http://[::1]:8795", "http://pages.qa.localhost:8795"]) {
      expect((await fetchPageHost(undefined, origin, "/alook/import/art_test", init)).status).toBe(204)
      expect(network.mock.calls.at(-1)![0].url).toBe(`${origin}/alook/import/art_test`)
    }
    network.mockClear()
    for (const origin of ["http://remote.invalid", "https://localhost:8795", "http://localhost:8795/path", "http://localhost:8795/"]) {
      await expect(fetchPageHost(undefined, origin, "/alook/import/art_test", init)).rejects.toThrow()
    }
    expect(network).not.toHaveBeenCalled()
  })

  it("retries a failed development loopback binding over HTTP but keeps a 4xx terminal", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const network = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", network)
    const binding = { fetch: vi.fn(async () => new Response(null, { status: 503 })) }
    expect((await fetchPageHost(binding, "http://localhost:8795", "/alook/import/art_test", init)).status).toBe(204)
    expect(network).toHaveBeenCalledOnce()
    network.mockClear()
    binding.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }))
    expect((await fetchPageHost(binding, "http://localhost:8795", "/alook/import/art_test", init)).status).toBe(403)
    expect(network).not.toHaveBeenCalled()
  })
})

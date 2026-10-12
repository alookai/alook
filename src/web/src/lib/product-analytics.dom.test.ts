import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { waitFor } from "@/test/react-dom-harness"
const mocks = vi.hoisted(() => ({ native: false, consent: null as string | null }))
vi.mock("@alook/shared", async original => ({ ...await original<typeof import("@alook/shared")>(), isTauri: () => mocks.native }))
vi.mock("@/lib/analytics-consent", () => ({ readAnalyticsConsent: () => mocks.consent }))
import { captureProductAnalytics } from "./product-analytics"

beforeEach(() => { document.cookie = "_ga=; Max-Age=0; Path=/"; mocks.native = false; mocks.consent = null; vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 }))) })
afterEach(() => vi.unstubAllGlobals())
describe("product analytics browser transport", () => {
  it("sends keepalive fixed events with a reusable mount nonce", async () => {
    await captureProductAnalytics({ event: "login_page_view" }, "fixed-mount-id")
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/community/analytics/product-events", expect.objectContaining({
      keepalive: true, credentials: "include", body: JSON.stringify({ event: "login_page_view", requestId: "fixed-mount-id" }),
    })))
  })
  it("seeds one browser id before delayed requests and reuses it on fast navigation", async () => {
    let resolve: (() => void) | undefined
    const pending = new Promise<void>(done => { resolve = done })
    const capturedCookies: string[] = []
    vi.mocked(fetch).mockImplementation(async () => { capturedCookies.push(document.cookie); await pending; return new Response(null, { status: 200 }) })
    const first = captureProductAnalytics({ event: "landing_cta_clicked", ctaName: "get_started" })
    const next = captureProductAnalytics({ event: "login_page_view" })
    expect(capturedCookies).toHaveLength(2)
    expect(capturedCookies[0]).toMatch(/_ga=GA1\.1\.\d+\.\d+/u)
    expect(capturedCookies[1]).toBe(capturedCookies[0])
    resolve!(); await Promise.all([first, next])
  })
  it("does not send from native or explicitly denied browsers", async () => {
    mocks.native = true; await captureProductAnalytics({ event: "login_page_view" })
    mocks.native = false; mocks.consent = "denied"; await captureProductAnalytics({ event: "login_page_view" })
    expect(fetch).not.toHaveBeenCalled()
  })
  it("isolates a rejected analytics request from product navigation", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"))
    await expect(captureProductAnalytics({ event: "onboarding_enter_clicked", serverId: "server" })).resolves.toBeUndefined()
  })
})

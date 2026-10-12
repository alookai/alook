import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent } from "@/test/react-dom-harness"
const mocks = vi.hoisted(() => ({ native: false, consent: null as string | null }))
vi.mock("@alook/shared", async original => ({ ...await original<typeof import("@alook/shared")>(), isTauri: () => mocks.native }))
vi.mock("@/lib/analytics-consent", async original => ({ ...await original<typeof import("@/lib/analytics-consent")>(), readAnalyticsConsent: () => mocks.consent }))
import { beginOnboardingAnalytics, captureOnboardingFirstMessage, captureProductAnalytics } from "./product-analytics"

beforeEach(() => {
  window.history.replaceState(null, "", "/sign-in")
  window.dataLayer = []
  document.getElementById("alook-product-events")?.remove()
  document.cookie = "_ga=; Max-Age=0; Path=/"
  sessionStorage.clear()
  mocks.native = false; mocks.consent = null
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => vi.unstubAllGlobals())
function loadFrame() {
  const frame = document.getElementById("alook-product-events") as HTMLIFrameElement
  const send = vi.fn()
  Object.defineProperty(frame.contentWindow, "sendProductEvent", { value: send, configurable: true })
  fireEvent.load(frame)
  return { frame, send }
}

describe("frontend product analytics", () => {
  it("uses only a static GA4 document and never the backend collection endpoint", async () => {
    await captureProductAnalytics({ event: "login_page_view" })
    const { frame, send } = loadFrame()
    expect(frame.getAttribute("src")).toBe("/analytics-events.html")
    expect(frame.referrerPolicy).toBe("no-referrer")
    expect(send).toHaveBeenCalledWith({ event: "login_page_view", params: {} })
    expect(fetch).not.toHaveBeenCalled()
  })
  it("reuses the existing public Google tag without loading another document", async () => {
    window.history.replaceState(null, "", "/")
    await captureProductAnalytics({ event: "landing_cta_clicked", ctaName: "get_started" })
    expect(Array.from(window.dataLayer![0])).toEqual(["event", "landing_cta_clicked", { cta_name: "get_started", send_to: "G-STBCL8F4ZY" }])
    expect(document.getElementById("alook-product-events")).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it("does not wait for the document or network before finishing the event call", async () => {
    await expect(captureProductAnalytics({ event: "onboarding_enter_clicked", serverId: "private-server" })).resolves.toBeUndefined()
    expect(document.getElementById("alook-product-events")?.getAttribute("data-ready")).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it("reuses normal browser identity and accepts repeated events without dedupe", async () => {
    document.cookie = "_ga=GA1.1.100.200; Path=/"
    await captureProductAnalytics({ event: "landing_cta_clicked", ctaName: "get_started" })
    const { send } = loadFrame()
    const identity = document.cookie
    await captureProductAnalytics({ event: "landing_cta_clicked", ctaName: "get_started" })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0])
    expect(document.cookie).toBe(identity)
  })
  it("does not pass private ids, tokens or unapproved dimension values to GA4", async () => {
    await captureProductAnalytics({ event: "onboarding_enter_clicked", serverId: "private-server" })
    const { send } = loadFrame()
    await captureProductAnalytics({ event: "invitation_link_visit", token: "private-token" })
    await captureProductAnalytics({ event: "sign_up", method: "private-email@example.test" })
    expect(JSON.stringify(send.mock.calls)).not.toContain("private-")
    expect(send.mock.calls.map(([event]) => event.params)).toEqual([{}, {}, {}])
  })
  it("does not load or send in native and explicitly denied browsers", async () => {
    mocks.native = true; await captureProductAnalytics({ event: "login_page_view" })
    mocks.native = false; mocks.consent = "denied"; await captureProductAnalytics({ event: "login_page_view" })
    expect(document.getElementById("alook-product-events")).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it("rechecks denial before a delayed document can send", async () => {
    await captureProductAnalytics({ event: "login_page_view" })
    mocks.consent = "denied"
    const { send } = loadFrame()
    expect(send).not.toHaveBeenCalled()
    expect(document.getElementById("alook-product-events")).toBeNull()
  })
  it("isolates a failing frontend sender from product navigation", async () => {
    await captureProductAnalytics({ event: "login_page_view" })
    const { send } = loadFrame()
    send.mockImplementation(() => { throw new Error("offline") })
    await expect(captureProductAnalytics({ event: "onboarding_enter_clicked", serverId: "server" })).resolves.toBeUndefined()
  })
  it("finishes without a backend fallback when the analytics document cannot attach", async () => {
    const append = vi.spyOn(document.body, "appendChild").mockImplementationOnce(() => { throw new Error("DOM insertion blocked") })
    try {
      await expect(captureProductAnalytics({ event: "onboarding_enter_clicked", serverId: "server" })).resolves.toBeUndefined()
      expect(append).toHaveBeenCalledOnce()
      expect(document.getElementById("alook-product-events")).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    } finally { append.mockRestore() }
  })
  it("reports only the current onboarding room's first successful message", () => {
    beginOnboardingAnalytics("owner", "onboarding-server")
    const { send } = loadFrame()
    captureOnboardingFirstMessage("owner", "other-server")
    captureOnboardingFirstMessage("other", "onboarding-server")
    expect(send).toHaveBeenCalledOnce()
    captureOnboardingFirstMessage("owner", "onboarding-server")
    captureOnboardingFirstMessage("owner", "onboarding-server")
    expect(send.mock.calls.map(([input]) => input.event)).toEqual(["onboarding_enter_clicked", "onboarding_first_message"])
  })
  it("allows another session or onboarding journey for the same user to emit again", () => {
    beginOnboardingAnalytics("owner", "server")
    const { send } = loadFrame()
    captureOnboardingFirstMessage("owner", "server")
    sessionStorage.clear()
    beginOnboardingAnalytics("owner", "server")
    captureOnboardingFirstMessage("owner", "server")
    expect(send.mock.calls.map(([input]) => input.event)).toEqual(["onboarding_enter_clicked", "onboarding_first_message", "onboarding_enter_clicked", "onboarding_first_message"])
  })
})

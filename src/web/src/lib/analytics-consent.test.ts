import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ANALYTICS_CONSENT_CHANGE_EVENT,
  analyticsConsentCookieValue,
  announceAnalyticsConsent,
  applyGoogleConsent,
  hasAnalyticsConsent,
  parseAnalyticsConsentCookie,
  persistAnalyticsConsent,
  readAnalyticsConsent,
} from "./analytics-consent"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("analytics consent browser contract", () => {
  it("accepts only the current version and bounded decisions", () => {
    expect(analyticsConsentCookieValue("granted")).toBe("v1.granted")
    expect(parseAnalyticsConsentCookie("v1.granted")).toBe("granted")
    expect(parseAnalyticsConsentCookie("v1.denied")).toBe("denied")
    expect(parseAnalyticsConsentCookie("v0.granted")).toBeNull()
    expect(parseAnalyticsConsentCookie("v1.maybe")).toBeNull()
  })

  it("reads the exact first-party cookie without accepting malformed values", () => {
    expect(readAnalyticsConsent("session=x; alook_analytics_consent=v1.granted; other=y")).toBe("granted")
    expect(hasAnalyticsConsent("alook_analytics_consent=v1.denied")).toBe(false)
    expect(readAnalyticsConsent("alook_analytics_consent=%E0%A4%A")).toBeNull()
    expect(readAnalyticsConsent("other=v1.granted")).toBeNull()
  })

  it("queues the exact Google Consent Mode command", () => {
    const browser = { dataLayer: [] as unknown[] }
    vi.stubGlobal("window", browser)

    applyGoogleConsent("granted", "default")

    expect(browser.dataLayer).toHaveLength(1)
    expect(browser.dataLayer[0]).toEqual([
      "consent",
      "default",
      {
        analytics_storage: "granted",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ])

    applyGoogleConsent("denied")

    expect(browser.dataLayer[1]).toEqual([
      "consent",
      "update",
      {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ])
  })

  it("persists only after the API confirms the same decision", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ decision: "granted" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))
    vi.stubGlobal("fetch", fetcher)

    await persistAnalyticsConsent("granted")

    expect(fetcher).toHaveBeenCalledWith("/api/privacy/analytics-consent", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "granted" }),
    })
  })

  it("rejects a mismatched API response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ decision: "denied" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )))
    await expect(persistAnalyticsConsent("granted")).rejects.toThrow("was not saved")
  })

  it("rejects a malformed API response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })))
    await expect(persistAnalyticsConsent("granted")).rejects.toThrow("was not saved")
  })

  it("announces the exact saved decision", () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal("window", { dispatchEvent })
    vi.stubGlobal("CustomEvent", class TestCustomEvent {
      type: string
      detail: unknown
      constructor(type: string, init: { detail: unknown }) {
        this.type = type
        this.detail = init.detail
      }
    })

    announceAnalyticsConsent("denied")

    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
      type: ANALYTICS_CONSENT_CHANGE_EVENT,
      detail: "denied",
    })
  })
})

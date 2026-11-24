import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ANALYTICS_CONSENT_CHANGE_EVENT,
  analyticsConsentCookieValue,
  announceAnalyticsConsent,
  applyGoogleConsent,
  bootstrapGoogleAnalytics,
  isPublicAnalyticsPath,
  updateGooglePageFields,
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
    expect(Object.prototype.toString.call(browser.dataLayer[0])).toBe("[object Arguments]")
    expect(Array.from(browser.dataLayer[0] as IArguments)).toEqual([
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

    expect(Array.from(browser.dataLayer[1] as IArguments)).toEqual([
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


  it.each([undefined, "", "v0.granted", "v1.invalid", "v1.denied", "v1.granted"])("boots from the original Cookie %s before measurement", value => {
    const browser = { location: new URL("https://alook.ai/pricing?private=query#fragment"), dataLayer: [] as unknown[] }
    vi.stubGlobal("window", browser)
    vi.stubGlobal("document", { cookie: value === undefined ? "" : `alook_analytics_consent=${value}`, referrer: "https://alook.ai/c/private?secret=referrer" })
    bootstrapGoogleAnalytics()
    expect(Reflect.get(browser, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    const decision = value === "v1.denied" ? "denied" : "granted"
    expect(browser.dataLayer.map(command => Array.from(command as IArguments))).toEqual([
      ["consent", "default", { analytics_storage: decision, ad_storage: decision, ad_user_data: decision, ad_personalization: "denied" }],
      ["set", { page_location: "https://alook.ai/pricing", page_referrer: "" }],
    ])
    browser.location = new URL("https://alook.ai/c/me")
    expect(Reflect.get(browser, "ga-disable-G-STBCL8F4ZY")).toBe(true)
  })

  it.each(["/", "/download", "/pricing", "/contact", "/privacy", "/templates", "/templates/public", "/blog", "/blog/public/child"])("retains public path %s", path => {
    expect(isPublicAnalyticsPath(path)).toBe(true)
  })

  it.each(["/c", "/c/me", "/sign-in", "/auth/callback", "/templates/public/child", "/pricing/extra"])("retains private path %s", path => {
    expect(isPublicAnalyticsPath(path)).toBe(false)
  })

  it.each(["https://outside.example/path?secret=external#private", "https://alook.ai/blog/public?secret=internal", "not a URL"])("sanitizes existing referrer %s", referrer => {
    const browser = { location: new URL("https://alook.ai/"), dataLayer: [] as unknown[] }
    vi.stubGlobal("window", browser)
    vi.stubGlobal("document", { referrer, cookie: "" })
    updateGooglePageFields("/templates/public?secret=query#fragment")
    expect(Array.from(browser.dataLayer[0] as IArguments)).toEqual(["set", {
      page_location: "https://alook.ai/templates/public",
      page_referrer: referrer === "not a URL" ? "" : referrer.split("?")[0],
    }])
    const count = browser.dataLayer.length
    for (const href of ["/c/me?secret=private", "https://outside.example/pricing", "http://["]) updateGooglePageFields(href)
    expect(browser.dataLayer).toHaveLength(count)
    expect(JSON.stringify(browser.dataLayer)).not.toMatch(/secret|fragment|page_view/)
  })

  it.each(["", "alook_analytics_consent=v1.denied"])("keeps only valid ad attribution fields with cookie %s", cookie => {
    const browser = { location: new URL("https://alook.ai/"), dataLayer: [] as unknown[] }
    vi.stubGlobal("window", browser)
    vi.stubGlobal("document", { referrer: "", cookie })
    updateGooglePageFields("/?gclid=Gcl_1&gbraid=Bra_1&wbraid=Wbra_1&gad_source=7&utm_medium=cpc&utm_campaign=Agent+tools&utm_content=private%40example.com&utm_unknown=private&token=private#fragment")
    expect(Array.from(browser.dataLayer[0] as IArguments)).toEqual(["set", {
      page_location: cookie ? "https://alook.ai/" : "https://alook.ai/?gclid=Gcl_1&gbraid=Bra_1&wbraid=Wbra_1&gad_source=7&utm_medium=cpc&utm_campaign=Agent+tools",
      page_referrer: "",
    }])
  })

  it("turns off ad consent at the start of a private route transition", () => {
    const browser = { location: new URL("https://alook.ai/"), dataLayer: [] as unknown[] }
    vi.stubGlobal("window", browser)
    vi.stubGlobal("document", { getElementById: () => ({}) })
    updateGooglePageFields("/c/channels/private?token=private-token")
    expect(browser.dataLayer.map(command => Array.from(command as IArguments))).toEqual([
      ["consent", "update", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }],
    ])
  })

  it.each(["/c", "/c/me"])("keeps Google disabled at private startup on %s even with a grant", path => {
    const browser = { location: new URL(`https://alook.ai${path}`), dataLayer: [] as unknown[] }
    vi.stubGlobal("window", browser)
    vi.stubGlobal("document", { cookie: "alook_analytics_consent=v1.granted" })
    bootstrapGoogleAnalytics()
    expect(Reflect.get(browser, "ga-disable-G-STBCL8F4ZY")).toBe(true)
    expect(browser.dataLayer.map(command => Array.from(command as IArguments))).toEqual([
      ["consent", "default", expect.objectContaining({ analytics_storage: "denied" })],
    ])
  })

  it("does not initialize browser measurement on the server", () => {
    vi.stubGlobal("window", undefined)
    expect(() => bootstrapGoogleAnalytics()).not.toThrow()
    expect(() => updateGooglePageFields("/pricing")).not.toThrow()
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

it.each(["/terms", "/compare", "/compare/alook-vs-myclaw", "/agents", "/agents/claude-code", "/tutorials", "/tutorials/first-agent", "/usecases", "/usecases/team-updates"])("recognizes the published public route %s", path => {
  expect(isPublicAnalyticsPath(path)).toBe(true)
})

it.each(["http://localhost:3000", "https://preview.alook.ai", "https://alook.ai.evil.test"])("disables production GA bootstrap on %s", origin => {
  const browser = { location: new URL(origin + "/pricing"), dataLayer: [] as unknown[] }
  vi.stubGlobal("window", browser)
  vi.stubGlobal("document", { cookie: "alook_analytics_consent=v1.granted", referrer: "" })
  bootstrapGoogleAnalytics()
  expect(Reflect.get(browser, "ga-disable-G-STBCL8F4ZY")).toBe(true)
})

it("keeps a direct visit referrer empty instead of inventing a home referral", () => {
  const browser = { location: new URL("https://alook.ai/tutorials"), dataLayer: [] as unknown[] }
  vi.stubGlobal("window", browser)
  vi.stubGlobal("document", { cookie: "", referrer: "" })
  updateGooglePageFields(browser.location.href)
  expect(Array.from(browser.dataLayer[0] as IArguments)).toEqual(["set", { page_location: "https://alook.ai/tutorials", page_referrer: "" }])
})

import { act, fireEvent, render, screen, waitFor, within } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const platform = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  isMobile: vi.fn(() => false),
}))

const route = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }))

vi.mock("@alook/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@alook/shared")>(),
  isTauri: platform.isTauri,
  isMobile: platform.isMobile,
}))

vi.mock("@next/third-parties/google", () => ({
  GoogleTagManager: ({ gtmId }: { gtmId: string }) => (
    <div data-testid="google-tag-manager" data-gtm-id={gtmId} />
  ),
}))

import { AnalyticsConsent, AnalyticsPreferenceControl } from "./analytics-consent"
import { bootstrapGoogleAnalytics } from "@/lib/analytics-consent"
import { tid } from "@/lib/community/testids"

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=", 1)[0]?.trim()
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`
  }
}

function successfulFetch(decision: "granted" | "denied") {
  return vi.fn(async () => {
    document.cookie = `alook_analytics_consent=v1.${decision}; Path=/`
    return new Response(JSON.stringify({ decision }), { status: 200, headers: { "Content-Type": "application/json" } })
  })
}


function installCookieStore() {
  const store = new EventTarget()
  vi.stubGlobal("cookieStore", store)
  const added = vi.spyOn(store, "addEventListener")
  const removed = vi.spyOn(store, "removeEventListener")
  const change = (changed: Array<{ name: string; value?: string }> = [], deleted: Array<{ name: string }> = []) => {
    const event = new Event("change")
    Object.assign(event, { changed, deleted })
    act(() => { store.dispatchEvent(event) })
  }
  return { store, added, removed, change }
}

function consentCommands() {
  return window.dataLayer!.map(command => Array.from(command as IArguments)).filter(command => command[0] === "consent")
}

beforeEach(() => {
  route.pathname = "/"
  window.history.replaceState({}, "", "/")
  clearCookies()
  platform.isTauri.mockReset().mockReturnValue(false)
  platform.isMobile.mockReset().mockReturnValue(false)
  window.dataLayer = []
  vi.stubGlobal("cookieStore", undefined)
  bootstrapGoogleAnalytics()
})

afterEach(() => {
  clearCookies()
  vi.unstubAllGlobals()
  delete window.dataLayer
  Reflect.deleteProperty(window, "ga-disable-G-STBCL8F4ZY")
})

describe("AnalyticsConsent", () => {
  it("preserves page layout while the floating banner is open and dismissed", async () => {
    vi.stubGlobal("fetch", successfulFetch("denied"))
    const layoutStyle = document.createElement("style")
    layoutStyle.textContent = `
      body { padding-bottom: 0px; }
      .hero-section, .workspace-shell { height: 100dvh; }
    `
    document.head.appendChild(layoutStyle)
    try {
      render(
        <>
          <main className="hero-section" data-testid="consent-hero" />
          <main className="workspace-shell" data-testid="consent-workspace" />
          <AnalyticsConsent />
        </>,
      )
      const banner = await screen.findByTestId(tid.analyticsConsentBanner)
      const expectPageLayout = () => {
        expect(getComputedStyle(document.body).paddingBottom).toBe("0px")
        expect(getComputedStyle(screen.getByTestId("consent-hero")).height).toBe("100dvh")
        expect(getComputedStyle(screen.getByTestId("consent-workspace")).height).toBe("100dvh")
      }
      expectPageLayout()
      fireEvent(window, new Event("resize"))
      expectPageLayout()
      fireEvent.click(within(banner).getByRole("button", { name: "Only necessary" }))
      await waitFor(() => {
        expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
      })
      expectPageLayout()
    } finally {
      layoutStyle.remove()
    }
  })

  it("loads public GTM with denied cookies and retains the first-visit banner", async () => {
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)
    expect(within(banner).getByText("Cookies are your choice")).toBeVisible()
    expect(within(banner).getByRole("button", { name: "Only necessary" })).toBeVisible()
    expect(within(banner).getByRole("button", { name: "Allow analytics" })).toBeVisible()
    expect(within(banner).getByTestId(tid.analyticsConsentAvatarCluster).querySelectorAll("svg"))
      .toHaveLength(3)
    expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it("hides the first-visit banner in native mobile clients", async () => {
    platform.isTauri.mockReturnValue(true)
    platform.isMobile.mockReturnValue(true)

    render(<AnalyticsConsent />)

    await waitFor(() => {
      expect(platform.isMobile).toHaveBeenCalled()
    })
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
  })

  it("keeps public GTM and enables Ahrefs after the API confirms a grant", async () => {
    const fetcher = successfulFetch("granted")
    vi.stubGlobal("fetch", fetcher)
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)

    fireEvent.click(within(banner).getByRole("button", { name: "Allow analytics" }))

    expect(await screen.findByTestId("google-tag-manager")).toHaveAttribute(
      "data-gtm-id",
      "GTM-56VHCCQZ",
    )
    expect(await screen.findByTestId(tid.ahrefsAnalyticsFrame)).toHaveAttribute("sandbox", "allow-scripts")
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    expect(Array.from(window.dataLayer!.at(-1) as IArguments)).toEqual([
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "granted", ad_storage: "denied" }),
    ])
    expect(fetcher).toHaveBeenCalledWith(
      "/api/privacy/analytics-consent",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ decision: "granted" }),
      }),
    )
  })

  it("stores a denial while retaining public GTM and excluding Ahrefs", async () => {
    vi.stubGlobal("fetch", successfulFetch("denied"))
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)

    fireEvent.click(within(banner).getByRole("button", { name: "Only necessary" }))

    await waitFor(() => {
      expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    })
    expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it("honors stored grant and denial choices on mount", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const granted = render(<AnalyticsConsent />)
    expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    const home = screen.getByTestId(tid.ahrefsAnalyticsFrame)
    for (const pathname of ["/c", "/c/me", "/c/channels/private/channel", "/sign-in", "/auth/callback"]) {
      route.pathname = pathname
      granted.rerender(<AnalyticsConsent />)
      expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
      expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    }
    route.pathname = "/pricing"
    granted.rerender(<AnalyticsConsent />)
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame)).not.toBe(home)
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame).getAttribute("srcdoc"))
      .toContain(`data-page-location="${window.location.origin}/pricing"`)
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    fireEvent(window, new CustomEvent("alook:analytics-consent-change", { detail: "denied" }))
    await waitFor(() => expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument())
    granted.unmount()

    clearCookies()
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    render(<AnalyticsConsent />)
    await waitFor(() => {
      expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    })
    expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
  })

  it("keeps the banner open and explains a save failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )))
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)
    fireEvent.click(within(banner).getByRole("button", { name: "Allow analytics" }))
    expect(await within(banner).findByRole("alert")).toHaveTextContent("Couldn’t save this choice")
    expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it("changes a stored preference from the Privacy control", async () => {
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    vi.stubGlobal("fetch", successfulFetch("granted"))
    render(
      <>
        <AnalyticsConsent />
        <AnalyticsPreferenceControl />
      </>,
    )
    const control = await screen.findByTestId(tid.analyticsPreferenceControl)
    expect(within(control).getByText(/Analytics cookies denied/u)).toBeVisible()

    fireEvent.click(within(control).getByRole("button", { name: "Allow analytics" }))

    expect(await within(control).findByText(/Analytics cookies allowed/u)).toBeVisible()
    expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
    expect(Array.from(window.dataLayer!.at(-1) as IArguments)).toEqual([
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "granted", ad_storage: "denied" }),
    ])
  })

  it("blocks already-loaded GA4 immediately on private history changes", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const view = render(<AnalyticsConsent />)
    await screen.findByTestId("google-tag-manager")
    expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    window.history.pushState({}, "", "/c/me?private=canary")
    expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(true)
    window.history.replaceState({}, "", "/pricing")
    expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    view.unmount()
    window.history.replaceState({}, "", "/")
  })

  it.each(["/blog", "/blog/public-article", "/pricing", "/contact"])("keeps %s measured", async pathname => {
    route.pathname = pathname
    window.history.replaceState({}, "", `${pathname}?private=canary`)
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    render(<AnalyticsConsent />)
    expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame).getAttribute("srcdoc"))
      .toContain(`data-page-location="${window.location.origin}${pathname}"`)
  })

  it("registers the root CookieStore listener before the mount reread and keeps one Google update owner", async () => {
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    const cookie = installCookieStore()
    cookie.added.mockImplementation((type, listener, options) => {
      document.cookie = "alook_analytics_consent=v1.granted; Path=/"
      EventTarget.prototype.addEventListener.call(cookie.store, type, listener, options)
    })
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    expect(await screen.findByTestId(tid.ahrefsAnalyticsFrame)).toBeInTheDocument()
    expect(cookie.added).toHaveBeenCalledOnce()
    expect(consentCommands()).toEqual([
      ["consent", "default", expect.objectContaining({ analytics_storage: "denied" })],
      ["consent", "update", expect.objectContaining({ analytics_storage: "granted" })],
    ])
  })

  it("rereads changed and deleted Cookies, rejects late values and deduplicates the original API event", async () => {
    const cookie = installCookieStore()
    const wake = vi.fn()
    window.addEventListener("alook:analytics-consent-change", wake)
    const view = render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    await screen.findByTestId(tid.analyticsConsentBanner)
    wake.mockClear()
    const initial = consentCommands().length
    cookie.change([{ name: "alook_analytics_consent_proof", value: "ignored" }])
    expect(consentCommands()).toHaveLength(initial)
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    cookie.change([{ name: "alook_analytics_consent", value: "v1.denied" }])
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    expect(screen.getByTestId(tid.analyticsPreferenceControl)).toHaveTextContent("Analytics cookies allowed")
    expect(wake).toHaveBeenCalledOnce()
    fireEvent(window, new CustomEvent("alook:analytics-consent-change", { detail: "granted" }))
    cookie.change([{ name: "alook_analytics_consent", value: "v1.granted" }])
    expect(consentCommands()).toHaveLength(initial + 1)
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    cookie.change([{ name: "alook_analytics_consent", value: "v1.granted" }])
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
    document.cookie = "alook_analytics_consent=; Max-Age=0; Path=/"
    cookie.change([], [{ name: "alook_analytics_consent" }])
    expect(screen.getByTestId(tid.analyticsConsentBanner)).toBeInTheDocument()
    expect(screen.getByTestId(tid.analyticsPreferenceControl)).toHaveTextContent("No choice saved — analytics cookies denied")
    document.cookie = "alook_analytics_consent=v0.granted; Path=/"
    cookie.change([{ name: "alook_analytics_consent", value: "v1.granted" }])
    expect(consentCommands()).toHaveLength(initial + 3)
    expect(consentCommands().slice(initial).map(command => (command[2] as { analytics_storage: string }).analytics_storage)).toEqual(["granted", "denied", "denied"])
    view.unmount()
    expect(cookie.removed).toHaveBeenCalledWith("change", cookie.added.mock.calls[0][1])
    const prior = consentCommands().length
    cookie.change([{ name: "alook_analytics_consent", value: "v1.granted" }])
    expect(consentCommands()).toHaveLength(prior)
    window.removeEventListener("alook:analytics-consent-change", wake)
  })

  it("uses the committed Cookie while JSON remains pending and preserves an eventual response error", async () => {
    const cookie = installCookieStore()
    let rejectJson!: (error: Error) => void
    const json = new Promise((_resolve, reject) => { rejectJson = reject })
    vi.stubGlobal("fetch", vi.fn(async () => {
      document.cookie = "alook_analytics_consent=v1.granted; Path=/"
      cookie.change([{ name: "alook_analytics_consent", value: "v1.granted" }])
      return { ok: true, json: () => json }
    }))
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    await screen.findByTestId(tid.analyticsConsentBanner)
    const control = screen.getByTestId(tid.analyticsPreferenceControl)
    fireEvent.click(within(control).getByRole("button", { name: "Allow analytics" }))
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    expect(control).toHaveTextContent("Analytics cookies allowed")
    expect(consentCommands().at(-1)).toEqual(["consent", "update", expect.objectContaining({ analytics_storage: "granted" })])
    await act(async () => rejectJson(new Error("response unavailable")))
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save this choice")
    expect(control).toHaveTextContent("Analytics cookies allowed")
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame)).toBeInTheDocument()
  })

  it.each(["focus", "pageshow", "visibilitychange"])("rereads on %s without promising unsupported cross-page notification", async type => {
    const view = render(<AnalyticsConsent />)
    await screen.findByTestId(tid.analyticsConsentBanner)
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    if (type === "visibilitychange") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
      fireEvent(document, new Event(type))
    } else fireEvent(window, new Event(type))
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    view.unmount()
    const count = consentCommands().length
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    fireEvent(window, new Event("focus"))
    fireEvent(window, new Event("pageshow"))
    fireEvent(document, new Event("visibilitychange"))
    expect(consentCommands()).toHaveLength(count)
    vi.restoreAllMocks()
  })

  it("retains Native defaults, detail updates, optional gates and immediate Cookie-based disabling", async () => {
    platform.isTauri.mockReturnValue(true)
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    window.dataLayer = []
    const cookie = installCookieStore()
    render(<AnalyticsConsent />)
    await screen.findByTestId("google-tag-manager")
    expect(cookie.added).not.toHaveBeenCalled()
    expect(consentCommands()[0]).toEqual(["consent", "default", expect.objectContaining({ analytics_storage: "granted" })])
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    fireEvent(window, new CustomEvent("alook:analytics-consent-change", { detail: "denied" }))
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(true)
    expect(consentCommands().at(-1)).toEqual(["consent", "update", expect.objectContaining({ analytics_storage: "denied" })])
  })

})

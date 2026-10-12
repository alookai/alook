import { act, fireEvent, render, screen, waitFor, within } from "@/test/react-dom-harness"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const platform = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  isMobile: vi.fn(() => false),
}))

const navigation = vi.hoisted(() => ({ reload: vi.fn() }))

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
  const change = () => {
    const event = new Event("change")
    Object.assign(event, { changed: [{ name: "alook_analytics_consent" }], deleted: [] })
    act(() => store.dispatchEvent(event))
  }
  return { change }
}

function consentCommands() {
  return window.dataLayer!.map(command => Array.from(command as IArguments)).filter(command => command[0] === "consent")
}

beforeEach(() => {
  const originalWindow = window
  navigation.reload.mockReset()
  vi.stubGlobal("window", new Proxy(originalWindow, {
    get: (target, key) => key === "location" ? new Proxy({}, {
      get: (_location, field) => field === "reload" ? navigation.reload : Reflect.get(originalWindow.location, field, originalWindow.location),
    }) : Reflect.get(target, key, target),
  }))
  route.pathname = "/"
  window.history.replaceState({}, "", "/")
  clearCookies()
  platform.isTauri.mockReset().mockReturnValue(false)
  platform.isMobile.mockReset().mockReturnValue(false)
  window.dataLayer = []
  vi.stubGlobal("cookieStore", undefined)
  bootstrapGoogleAnalytics()
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })))
})

afterEach(() => {
  clearCookies()
  vi.unstubAllGlobals()
  delete window.dataLayer
  Reflect.deleteProperty(window, "ga-disable-G-STBCL8F4ZY")
})

describe("AnalyticsConsent", () => {
  it.each(["/", "/privacy", "/blog/public-article"])("waits for default persistence before loading GTM on public %s without a choice UI", async pathname => {
    route.pathname = pathname
    window.history.replaceState({}, "", pathname)
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal("fetch", fetcher)
    render(<StrictMode><AnalyticsConsent /></StrictMode>)
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.analyticsPreferenceControl)).not.toBeInTheDocument()
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveAttribute("sandbox", "allow-scripts")
    expect(consentCommands().at(-1)?.[2]).toEqual(expect.objectContaining({ analytics_storage: "granted", ad_storage: "denied" }))
    await act(async () => {
      document.cookie = "alook_analytics_consent=v1.granted; Path=/"
      finish(new Response(JSON.stringify({ decision: "granted" })))
    })
    await screen.findByTestId("google-tag-manager")
  })

  it("honors a previous Privacy denial without resaving it", async () => {
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    render(<AnalyticsConsent />)
    expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(consentCommands().at(-1)?.[2]).toEqual(expect.objectContaining({ analytics_storage: "denied" }))
  })

  it("keeps public tracking and page layout when grant persistence fails", async () => {
    render(<><main style={{ height: "100dvh" }} data-testid="consent-page" /><AnalyticsConsent /></>)
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame)).toBeInTheDocument()
    expect(getComputedStyle(screen.getByTestId("consent-page")).height).toBe("100dvh")
    expect(document.cookie).not.toContain("alook_analytics_consent=")
    expect(document.cookie).not.toContain("_ga=")
  })

  it("does not resave an existing grant", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    render(<AnalyticsConsent />)
    expect(await screen.findByTestId(tid.ahrefsAnalyticsFrame)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["/c", "/c/me", "/c/channels/private/channel", "/sign-in"])("does not grant or load analytics directly on %s", async pathname => {
    route.pathname = pathname
    window.history.replaceState({}, "", pathname)
    clearCookies()
    bootstrapGoogleAnalytics()
    render(<AnalyticsConsent />)
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(document.cookie).toBe("")
  })

  it("removes public analytics and blocks Google synchronously when entering the product", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const view = render(<AnalyticsConsent />)
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    window.history.pushState({}, "", "/c/me?private=canary")
    expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(true)
    route.pathname = "/c/me"
    view.rerender(<AnalyticsConsent />)
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["focus", "pageshow", "visibilitychange"])("rereads an explicit denial on %s and disables optional public tracking", async type => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const view = render(<AnalyticsConsent />)
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    if (type === "visibilitychange") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
      fireEvent(document, new Event(type))
    } else fireEvent(window, new Event(type))
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(consentCommands().at(-1)?.[2]).toEqual(expect.objectContaining({ analytics_storage: "denied" }))
    expect(fetch).not.toHaveBeenCalled()
    view.unmount()
    vi.restoreAllMocks()
  })

  it("keeps the existing Privacy choices usable and preserves denial on reload", async () => {
    route.pathname = "/privacy"
    window.history.replaceState({}, "", "/privacy")
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    vi.stubGlobal("fetch", successfulFetch("denied"))
    const view = render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    const control = screen.getByTestId(tid.analyticsPreferenceControl)
    expect(within(control).getByTestId(tid.analyticsConsentAvatarCluster).querySelectorAll("svg")).toHaveLength(3)
    fireEvent.click(within(control).getByRole("button", { name: "Only necessary" }))
    await within(control).findByText(/Analytics cookies denied/u)
    expect(navigation.reload).toHaveBeenCalledOnce()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    view.unmount()
    const reload = render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    expect(screen.getByTestId(tid.analyticsPreferenceControl)).toHaveTextContent("Analytics cookies denied")
    expect(fetch).toHaveBeenCalledOnce()
    vi.stubGlobal("fetch", successfulFetch("granted"))
    fireEvent.click(screen.getByRole("button", { name: "Allow analytics" }))
    await screen.findByText(/Analytics cookies allowed/u)
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    reload.unmount()
  })

  it("saves an immediate Privacy denial after the pending automatic grant", async () => {
    route.pathname = "/privacy"
    let finish!: (response: Response) => void
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockImplementationOnce(successfulFetch("denied"))
    vi.stubGlobal("fetch", fetcher)
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: "Only necessary" }))
    expect(fetcher).toHaveBeenCalledOnce()
    await act(async () => {
      document.cookie = "alook_analytics_consent=v1.granted; Path=/"
      finish(new Response(JSON.stringify({ decision: "granted" })))
    })
    await screen.findByText(/Analytics cookies denied/u)
    expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).decision)).toEqual(["granted", "denied"])
    expect(document.cookie).toContain("v1.denied")
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it("shows a Privacy save error and can retry after automatic saving fails", async () => {
    route.pathname = "/privacy"
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: "Only necessary" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save this choice")
    expect(navigation.reload).not.toHaveBeenCalled()
    vi.stubGlobal("fetch", successfulFetch("denied"))
    fireEvent.click(screen.getByRole("button", { name: "Only necessary" }))
    await screen.findByText(/Analytics cookies denied/u)
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it.each(["/privacy", "/blog", "/c/me"])("synchronizes another tab's denial on %s without disrupting product drafts", pathname => {
    route.pathname = pathname
    window.history.replaceState({}, "", pathname)
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const cookie = installCookieStore()
    render(<AnalyticsConsent />)
    cookie.change()
    expect(navigation.reload).not.toHaveBeenCalled()
    const events = document.getElementById("alook-product-events") ?? document.createElement("iframe")
    events.id = "alook-product-events"
    document.body.appendChild(events)
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    cookie.change()
    fireEvent(window, new Event("focus"))
    fireEvent(window, new CustomEvent("alook:analytics-consent-change", { detail: "granted" }))
    expect(navigation.reload).toHaveBeenCalledTimes(pathname.startsWith("/c") ? 0 : 1)
    expect(document.getElementById("alook-product-events")).toBeNull()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it("keeps the native mobile exclusion", async () => {
    platform.isTauri.mockReturnValue(true)
    platform.isMobile.mockReturnValue(true)
    render(<AnalyticsConsent />)
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})

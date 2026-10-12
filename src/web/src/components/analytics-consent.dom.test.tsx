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
import { bootstrapGoogleAnalytics, isOptionalAnalyticsStartupLocked } from "@/lib/analytics-consent"
import { tid } from "@/lib/community/testids"

const browserWindow = window
let stopBootstrap = () => {}
let reloadDocument = vi.fn()
let replaceDocument = vi.fn()

function bootstrap() {
  stopBootstrap()
  stopBootstrap = bootstrapGoogleAnalytics()
}

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


function installCookieStore(beforeListening?: () => void) {
  stopBootstrap()
  window.dataLayer = []
  const store = new EventTarget()
  vi.stubGlobal("cookieStore", store)
  const added = vi.spyOn(store, "addEventListener")
  const removed = vi.spyOn(store, "removeEventListener")
  if (beforeListening) added.mockImplementation((type, listener, options) => {
    beforeListening()
    EventTarget.prototype.addEventListener.call(store, type, listener, options)
  })
  stopBootstrap = bootstrapGoogleAnalytics()
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

function installBroadcast() {
  class ConsentChannel extends EventTarget {
    static instances: ConsentChannel[] = []
    postMessage = vi.fn()
    close = vi.fn()
    constructor(readonly name: string) {
      super()
      ConsentChannel.instances.push(this)
    }
    receive(data: unknown) {
      act(() => this.dispatchEvent(new MessageEvent("message", { data })))
    }
  }
  vi.stubGlobal("BroadcastChannel", ConsentChannel)
  bootstrap()
  return ConsentChannel
}

function transition(type: "pagehide" | "pageshow", persisted: boolean) {
  const event = new Event(type)
  Object.assign(event, { persisted })
  fireEvent(window, event)
}

beforeEach(() => {
  route.pathname = "/"
  window.history.replaceState({}, "", "/")
  clearCookies()
  platform.isTauri.mockReset().mockReturnValue(false)
  platform.isMobile.mockReset().mockReturnValue(false)
  reloadDocument = vi.fn()
  replaceDocument = vi.fn()
  const location = new Proxy({}, {
    get: (_target, key) => {
      if (key === "reload") return reloadDocument
      if (key === "replace") return replaceDocument
      const value = Reflect.get(browserWindow.location, key, browserWindow.location)
      return typeof value === "function" ? value.bind(browserWindow.location) : value
    },
  })
  vi.stubGlobal("window", new Proxy(browserWindow, {
    get: (target, key) => {
      if (key === "location") return location
      if (key === "addEventListener" || key === "removeEventListener" || key === "dispatchEvent") return target[key].bind(target)
      return Reflect.get(target, key, target)
    },
  }))
  window.dataLayer = []
  vi.stubGlobal("cookieStore", undefined)
  bootstrap()
})

afterEach(() => {
  stopBootstrap()
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
    expect(banner).toHaveTextContent("Google receives limited page and feature signals across our website, even without analytics cookies. Pages use fixed categories, without chat content or private names, links and search terms. Allow analytics enables analytics cookies and other optional analytics. No ad tracking. Read our privacy details.")
    expect(within(banner).getByRole("button", { name: "Only necessary" })).toBeVisible()
    expect(within(banner).getByRole("button", { name: "Allow analytics" })).toBeVisible()
    expect(within(banner).getByTestId(tid.analyticsConsentAvatarCluster).querySelectorAll("svg"))
      .toHaveLength(3)
    expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it.each(["/sign-in", "/pricing"])("retains the original Native desktop banner on %s without requiring a choice", async pathname => {
    platform.isTauri.mockReturnValue(true)
    route.pathname = pathname
    window.history.replaceState({}, "", pathname)
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)

    render(<AnalyticsConsent />)

    const banner = await screen.findByTestId(tid.analyticsConsentBanner)
    expect(within(banner).getByText("Analytics, only if you want")).toBeVisible()
    expect(banner).toHaveTextContent("Optional analytics help us understand which parts of Alook are useful. No ad tracking. Read our privacy details.")
    expect(banner).not.toHaveTextContent("Google receives page and feature signals")
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(document.cookie).toBe("")
    expect(fetcher).not.toHaveBeenCalled()
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
    expect(reloadDocument).not.toHaveBeenCalled()
    expect(isOptionalAnalyticsStartupLocked()).toBe(false)
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
      expect(screen.getByTestId("google-tag-manager")).toBeInTheDocument()
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

  it("keeps the Web Google entry available across private history and Cookie changes", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const view = render(<AnalyticsConsent />)
    await screen.findByTestId("google-tag-manager")
    expect(Reflect.has(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    window.history.pushState({}, "", "/c/me?private=canary")
    expect(Reflect.has(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    window.history.replaceState({}, "", "/pricing")
    expect(Reflect.has(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    expect(Reflect.has(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    view.unmount()
    window.history.replaceState({}, "", "/")
  })

  it.each(["/c", "/c/invite/private-token", "/sign-in", "/auth/callback", "/unknown/private-resource"])("loads Web Google on %s for every Cookie choice while excluding Ahrefs", async pathname => {
    route.pathname = pathname
    window.history.replaceState({}, "", pathname)
    for (const cookie of ["", "v1.denied", "v1.granted"]) {
      clearCookies()
      if (cookie) document.cookie = `alook_analytics_consent=${cookie}; Path=/`
      const view = render(<AnalyticsConsent />)
      expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
      expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
      expect(Reflect.has(window, "ga-disable-G-STBCL8F4ZY")).toBe(false)
      view.unmount()
    }
  })

  it.each(["/c", "/sign-in", "/unknown/private-resource"])("retains Native private loading prohibition on %s even with a grant", async pathname => {
    const priorConsentCommands = consentCommands().length
    platform.isTauri.mockReturnValue(true)
    route.pathname = pathname
    window.history.replaceState({}, "", pathname)
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    render(<AnalyticsConsent />)
    await waitFor(() => expect(consentCommands()).toHaveLength(priorConsentCommands + 1))
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(Reflect.get(window, "ga-disable-G-STBCL8F4ZY")).toBe(true)
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
    const cookie = installCookieStore(() => {
      document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    })
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    expect(await screen.findByTestId(tid.ahrefsAnalyticsFrame)).toBeInTheDocument()
    expect(cookie.added).toHaveBeenCalledOnce()
    expect(consentCommands()).toEqual([
      ["consent", "default", expect.objectContaining({ analytics_storage: "granted" })],
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
    stopBootstrap()
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
    stopBootstrap()
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

  it("locks optional startup before the granted Google update can trigger a withdrawal", async () => {
    vi.stubGlobal("fetch", successfulFetch("granted"))
    const pushed = vi.spyOn(window.dataLayer!, "push")
    pushed.mockImplementation(command => {
      Array.prototype.push.call(window.dataLayer, command)
      const [kind, mode, fields] = Array.from(command as IArguments)
      if (kind === "consent" && mode === "update" && fields.analytics_storage === "granted") {
        document.cookie = "alook_analytics_consent=v1.denied; Path=/"
        fireEvent(window, new Event("focus"))
        expect(isOptionalAnalyticsStartupLocked()).toBe(true)
        expect(reloadDocument).not.toHaveBeenCalled()
      }
      return window.dataLayer!.length
    })
    render(<AnalyticsConsent />)
    fireEvent.click(await screen.findByTestId(tid.analyticsConsentAllow))
    await waitFor(() => expect(reloadDocument).toHaveBeenCalledOnce())
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(Reflect.has(window, "hj")).toBe(false)
    pushed.mockRestore()
  })

  it.each(["/privacy#analytics-choices", "/privacy?qa=consent#analytics-choices"])("confirms withdrawal before one reload and retains %s", async pathname => {
    route.pathname = "/privacy"
    window.history.replaceState({}, "", pathname)
    const href = window.location.href
    const historyLength = window.history.length
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const channels = installBroadcast()
    const channel = channels.instances[0]
    vi.stubGlobal("fetch", successfulFetch("denied"))
    reloadDocument.mockImplementation(() => {
      expect(isOptionalAnalyticsStartupLocked()).toBe(true)
      expect(consentCommands().at(-1)).toEqual(["consent", "update", expect.objectContaining({ analytics_storage: "denied" })])
      expect(channel.postMessage).toHaveBeenCalledWith({ kind: "analytics-consent-invalidated" })
    })
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    fireEvent.click(within(screen.getByTestId(tid.analyticsPreferenceControl)).getByTestId(tid.analyticsConsentNecessary))
    await waitFor(() => expect(reloadDocument).toHaveBeenCalledExactlyOnceWith())
    expect(replaceDocument).not.toHaveBeenCalled()
    expect(window.location.href).toBe(href)
    expect(window.history.length).toBe(historyLength)
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    channel.receive({ kind: "analytics-consent-invalidated", decision: "granted" })
    fireEvent(window, new Event("focus"))
    transition("pageshow", false)
    expect(reloadDocument).toHaveBeenCalledOnce()
    expect(channel.postMessage.mock.calls).toEqual([[{ kind: "analytics-consent-invalidated" }]])
  })

  it.each([true, false])("waits for withdrawal JSON and preserves confirmed=%s", async confirmed => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const cookie = installCookieStore()
    const channels = installBroadcast()
    let finish!: (value: unknown) => void
    const json = new Promise(resolve => { finish = resolve })
    vi.stubGlobal("fetch", vi.fn(async () => {
      document.cookie = "alook_analytics_consent=v1.denied; Path=/"
      cookie.change([{ name: "alook_analytics_consent", value: "v1.denied" }])
      return { ok: confirmed, json: () => json }
    }))
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    fireEvent.click(within(screen.getByTestId(tid.analyticsPreferenceControl)).getByTestId(tid.analyticsConsentNecessary))
    await waitFor(() => expect(screen.getByTestId(tid.analyticsPreferenceControl)).toHaveTextContent("Analytics cookies denied"))
    expect(isOptionalAnalyticsStartupLocked()).toBe(true)
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    expect(reloadDocument).not.toHaveBeenCalled()
    await act(async () => finish({ decision: "denied" }))
    if (confirmed) {
      expect(reloadDocument).toHaveBeenCalledOnce()
      expect(channels.instances[0].postMessage).toHaveBeenCalledOnce()
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save this choice")
      expect(reloadDocument).not.toHaveBeenCalled()
      expect(channels.instances[0].postMessage).not.toHaveBeenCalled()
    }
  })

  it("shows the real conflicting Cookie without announcing success or replacing", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const channels = installBroadcast()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ decision: "denied" }), { status: 200 })))
    render(<><AnalyticsConsent /><AnalyticsPreferenceControl /></>)
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    const control = screen.getByTestId(tid.analyticsPreferenceControl)
    fireEvent.click(within(control).getByTestId(tid.analyticsConsentNecessary))
    expect(await within(control).findByRole("alert")).toHaveTextContent("Couldn’t save this choice")
    expect(control).toHaveTextContent("Analytics cookies allowed")
    expect(reloadDocument).not.toHaveBeenCalled()
    expect(channels.instances[0].postMessage).not.toHaveBeenCalled()
  })

  it("keeps a first-visit failure visible when the real grant Cookie already took effect", async () => {
    const channels = installBroadcast()
    vi.stubGlobal("fetch", vi.fn(async () => {
      document.cookie = "alook_analytics_consent=v1.granted; Path=/"
      return new Response(JSON.stringify({ error: "response unavailable" }), { status: 503 })
    }))
    render(<AnalyticsConsent />)
    fireEvent.click(await screen.findByTestId(tid.analyticsConsentAllow))
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save this choice")
    expect(screen.getByRole("alert")).toHaveTextContent("Analytics cookies allowed")
    expect(screen.getByTestId(tid.analyticsConsentBanner)).toBeVisible()
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame)).toBeInTheDocument()
    expect(channels.instances[0].postMessage).not.toHaveBeenCalled()
    expect(reloadDocument).not.toHaveBeenCalled()
  })

  it("rereads a broadcast hint without trusting its value or echoing it", async () => {
    const channels = installBroadcast()
    const channel = channels.instances[0]
    const view = render(<AnalyticsConsent />)
    await screen.findByTestId(tid.analyticsConsentBanner)
    channel.receive({ kind: "analytics-consent-invalidated", decision: "granted" })
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    channel.receive({ kind: "unrelated" })
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    channel.receive({ kind: "analytics-consent-invalidated", decision: "denied" })
    await screen.findByTestId(tid.ahrefsAnalyticsFrame)
    expect(reloadDocument).not.toHaveBeenCalled()
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    channel.receive({ kind: "analytics-consent-invalidated", decision: "granted" })
    expect(reloadDocument).toHaveBeenCalledOnce()
    expect(channel.postMessage).not.toHaveBeenCalled()
    view.unmount()
    stopBootstrap()
    expect(channel.close).toHaveBeenCalledOnce()
    const previous = consentCommands().length
    channel.receive({ kind: "analytics-consent-invalidated" })
    expect(consentCommands()).toHaveLength(previous)
  })

  it.each([true, false])("handles a persisted page with prior public grant=%s and closes the channel", async granted => {
    if (granted) document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const channels = installBroadcast()
    render(<AnalyticsConsent />)
    await screen.findByTestId(granted ? tid.ahrefsAnalyticsFrame : tid.analyticsConsentBanner)
    transition("pagehide", true)
    expect(channels.instances[0].close).toHaveBeenCalledOnce()
    expect(reloadDocument).not.toHaveBeenCalled()
    transition("pageshow", true)
    expect(channels.instances).toHaveLength(2)
    expect(isOptionalAnalyticsStartupLocked()).toBe(granted)
    expect(reloadDocument).toHaveBeenCalledTimes(granted ? 1 : 0)
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    transition("pageshow", true)
    expect(reloadDocument).toHaveBeenCalledTimes(granted ? 1 : 0)
    transition("pagehide", false)
    expect(channels.instances[1].close).toHaveBeenCalledOnce()
  })

  it("preserves the Native response/event contract without Web broadcast or replacement", async () => {
    stopBootstrap()
    platform.isTauri.mockReturnValue(true)
    const channels = installBroadcast()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ decision: "granted" }), { status: 200 })))
    render(<AnalyticsConsent />)
    fireEvent.click(await screen.findByTestId(tid.analyticsConsentAllow))
    await screen.findByTestId("google-tag-manager")
    expect(channels.instances).toHaveLength(0)
    expect(reloadDocument).not.toHaveBeenCalled()
    expect(consentCommands().at(-1)).toEqual(["consent", "default", expect.objectContaining({ analytics_storage: "granted" })])
  })

})
